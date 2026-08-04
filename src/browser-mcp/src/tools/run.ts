import type { UnifiedPage } from '../../../page.js'
import { z } from 'zod'
import { defineTool, errorResult, textResult } from './framework'
import type { ToolContext } from './framework'

const DEFAULT_TIMEOUT_MS = 30_000

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...injected: unknown[]) => Promise<unknown>

const DESCRIPTION = `Run JavaScript against the \`browser\` SDK in the server runtime for multi-step flows and data extraction that would otherwise take many tool calls. \`console.log\` is captured; \`return\` a value to read it back; exceptions come back as a result, not a thrown error.

Available as \`browser\` (backed by hub-browser's UnifiedPage):
  browser.pages.list() / newPage(url) / close(pageId) / getInfo(pageId)
  browser.observe(pageId).snapshot()  -> { text, refs }
  browser.observe(pageId).diff()      -> { text, added, removed, changed }
  browser.observe(pageId).resolveRef(ref)
  browser.input(pageId).click(ref) / fill(ref,value) / type(text) / press(key) / hover(ref) / selectOption(ref,value) / scroll(dir,amount,ref?)
  browser.nav(pageId).goto(url) / back() / forward() / reload()
  browser.cdp(method, params?)   // page-scoped raw CDP escape hatch
Refs (eN) come from a snapshot's text/refs.`

interface RunOutcome {
  ok: boolean
  value: unknown
  logs: string[]
  error?: Error
}

export const run = defineTool({
  name: 'run',
  description: DESCRIPTION,
  input: z.object({
    code: z
      .string()
      .describe(
        'Async-capable JS body. Use top-level await; `return` a value.',
      ),
    timeout: z
      .number()
      .optional()
      .describe('Max run time in ms (default 30000).'),
  }),
  output: z.object({
    ok: z.boolean(),
    value: z.unknown().optional(),
    logs: z.array(z.string()),
    error: z.string().optional(),
  }),
  annotations: {
    title: 'Run browser SDK script',
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    let fn: (...injected: unknown[]) => Promise<unknown>
    try {
      fn = new AsyncFunction(
        'browser',
        'console',
        `"use strict";\n${args.code}`,
      )
    } catch (err) {
      return errorResult(
        `run: syntax error - ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const logs: string[] = []
    const captured = makeConsole(logs)
    const browserSdk = await createUnifiedBrowserSdk(ctx)
    const outcome = await execute(
      fn,
      browserSdk,
      captured,
      args.timeout ?? DEFAULT_TIMEOUT_MS,
      logs,
    )
    if (outcome.ok) {
      const value = jsonSafeValue(outcome.value)
      return textResult(format(outcome), {
        ok: true,
        ...(value !== undefined && { value }),
        logs: outcome.logs,
      })
    }
    return {
      ...errorResult(format(outcome)),
      structuredContent: {
        ok: false,
        logs: outcome.logs,
        error: outcome.error?.message,
      },
    }
  },
})

/** Builds the `browser` SDK injected into `run` scripts over UnifiedPage. */
async function createUnifiedBrowserSdk(ctx: ToolContext): Promise<unknown> {
  const pageFor = (pageId: number) => ctx.pageFor(pageId)
  const tabsOf = async (page: UnifiedPage): Promise<any[]> =>
    (await page.tabs()) as any[]

  const findPage = async (
    pageId: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const tabs = await tabsOf(ctx.page)
    return tabs.find((tab) => tab.pageId === pageId)
  }

  const observe = (pageId: number) => ({
    async snapshot(): Promise<{ text: string; refs: { byRef: Map<string, unknown> } }> {
      const page = await pageFor(pageId)
      const text = String((await page.snapshot()) ?? '')
      return { text, refs: { byRef: extractRefs(text) } }
    },
    async diff(): Promise<unknown> {
      const page = await pageFor(pageId)
      return page.diff()
    },
    async resolveRef(ref: string): Promise<unknown> {
      const snapshot = await observe(pageId).snapshot()
      return snapshot.refs.byRef.get(ref) ?? null
    },
  })

  const input = (pageId: number) => ({
    async click(ref: string): Promise<void> {
      await (await pageFor(pageId)).click(ref)
    },
    async fill(ref: string, value: string): Promise<void> {
      await (await pageFor(pageId)).fillText(ref, value)
    },
    async type(text: string): Promise<void> {
      await (await pageFor(pageId)).nativeType(text)
    },
    async press(key: string): Promise<void> {
      await (await pageFor(pageId)).pressKey(key)
    },
    async hover(ref: string): Promise<void> {
      await (await pageFor(pageId)).hover(ref)
    },
    async selectOption(ref: string, value: string): Promise<unknown> {
      return (await pageFor(pageId)).selectOption(ref, value)
    },
    async scroll(
      direction: 'up' | 'down' | 'left' | 'right',
      amount: number,
      ref?: string,
    ): Promise<void> {
      const page = await pageFor(pageId)
      if (ref) await page.scrollTo(ref)
      else await page.scroll(direction, amount * 100)
    },
  })

  const nav = (pageId: number) => ({
    async goto(url: string): Promise<void> {
      await (await pageFor(pageId)).goto(url)
    },
    async back(): Promise<void> {
      await (await pageFor(pageId)).cdp('Page.goBack')
    },
    async forward(): Promise<void> {
      await (await pageFor(pageId)).cdp('Page.goForward')
    },
    async reload(): Promise<void> {
      await (await pageFor(pageId)).cdp('Page.reload', { ignoreCache: false })
    },
  })

  return {
    pages: {
      list: () => tabsOf(ctx.page),
      async newPage(url?: string): Promise<number> {
        const targetId = await ctx.page.newTab(url ?? 'about:blank')
        const tabs = await tabsOf(ctx.page)
        const info = tabs.find((tab) => tab.targetId === targetId)
        if (info?.pageId !== undefined) return info.pageId
        throw new Error('run: new tab opened but page id could not be resolved.')
      },
      async close(pageId: number): Promise<void> {
        await ctx.page.closeTab(pageId)
      },
      getInfo: (pageId: number) => findPage(pageId),
    },
    observe,
    input,
    nav,
    async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
      return ctx.page.cdp(method, params ?? {})
    },
  }
}

/** Parses `[ref=eN]` markers from a snapshot text into a minimal refs map. */
function extractRefs(text: string): Map<string, unknown> {
  const byRef = new Map<string, unknown>()
  const pattern = /\[ref=(e\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (!byRef.has(match[1])) byRef.set(match[1], { ref: match[1] })
  }
  return byRef
}

/** Runs injected agent code and converts script failures into tool results. */
async function execute(
  fn: (...injected: unknown[]) => Promise<unknown>,
  browser: unknown,
  console: Console,
  timeoutMs: number,
  logs: string[],
): Promise<RunOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`run exceeded ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    const value = await Promise.race([fn(browser, console), timeout])
    return { ok: true, value, logs }
  } catch (err) {
    return {
      ok: false,
      value: undefined,
      logs,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function makeConsole(logs: string[]): Console {
  const sink =
    (level: string) =>
    (...parts: unknown[]) => {
      logs.push(
        `${level}${parts.map((part) => (typeof part === 'string' ? part : safeStringify(part))).join(' ')}`,
      )
    }
  return {
    log: sink(''),
    info: sink(''),
    warn: sink('warn: '),
    error: sink('error: '),
    debug: sink(''),
  } as unknown as Console
}

function format(outcome: RunOutcome): string {
  const sections: string[] = []
  if (outcome.error) {
    sections.push(`error: ${outcome.error.message}`)
  } else {
    sections.push('ok')
    if (outcome.value !== undefined) {
      sections.push(`return: ${safeStringify(outcome.value)}`)
    }
  }
  if (outcome.logs.length > 0) {
    sections.push(`logs:\n${outcome.logs.join('\n')}`)
  }
  return sections.join('\n')
}

function safeStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function jsonSafeValue(value: unknown): unknown {
  const seen = new WeakSet<object>()
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value, (_key, next) => {
      if (typeof next === 'bigint') return next.toString()
      if (typeof next === 'function' || typeof next === 'symbol') {
        return String(next)
      }
      if (typeof next === 'number' && !Number.isFinite(next)) return null
      if (typeof next === 'object' && next !== null) {
        if (seen.has(next)) return '[Circular]'
        seen.add(next)
      }
      return next
    })
  } catch {
    return safeStringify(value)
  }
  return encoded === undefined ? undefined : JSON.parse(encoded)
}
