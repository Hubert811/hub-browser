import type { UnifiedPage } from '../../../page.js'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { getAuditSink } from '../../../audit/audit-log.js'
import { ownerOf } from '../../../space/task-space-manager.js'
import {
  clampTimeout,
  defineTool,
  errorResult,
  executeTool,
  textResult,
  type InnerCallHook,
  type InnerCallRecord,
  type ToolContext,
  type ToolDefinition,
} from './framework'
import {
  WORKER_SRC,
  type BridgeCall,
  type MainToWorkerMessage,
  type WorkerMessage,
} from './run-worker.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RUN_TIMEOUT_MS = 300_000

/**
 * P1-8 tool: routing — the MCP tools the run SDK exposes via
 * `browser.tool(name, args)` (deepdive §4 subset; the SDK already covers
 * the others as direct primitives: snapshot/act-family/goto/tabs).
 * `run` itself is deliberately absent (recursion guard).
 */
const RUN_TOOL_ALLOWLIST = new Set([
  'read',
  'grep',
  'wait',
  'screenshot',
  'evaluate',
  'download',
  'pdf',
  'upload',
  'tab_groups',
  'windows',
])

/**
 * Lazily indexes BROWSER_TOOLS by name. Dynamic import on purpose: registry
 * statically imports run.ts (BROWSER_TOOLS lists it), so a static back-import
 * creates a cycle whose registry-first load would read `run` in its TDZ.
 * By call time both modules are fully initialized, so the cycle is harmless.
 */
let toolIndexPromise: Promise<Map<string, ToolDefinition>> | undefined
function loadToolIndex(): Promise<Map<string, ToolDefinition>> {
  toolIndexPromise ??= import('./registry').then(
    (m) => new Map(m.BROWSER_TOOLS.map((def) => [def.name, def])),
  )
  return toolIndexPromise
}

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
  browser.tool(name, args)          // routable MCP tools: read/grep/wait/screenshot/evaluate/download/pdf/upload/tab_groups/windows
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
      .describe('Max run time in ms (default 30000, capped at 300000).'),
  }).strict(),
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
    // Syntax check only — never execute agent code on the main thread
    // (a synchronous `while (true) {}` used to freeze the whole daemon
    // under the old `new AsyncFunction` + Promise.race design).
    try {
      new AsyncFunction('browser', 'console', `"use strict";\n${args.code}`)
    } catch (err) {
      return errorResult(
        `run: syntax error - ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const logs: string[] = []
    const browserSdk = await createUnifiedBrowserSdk(ctx)
    const timeoutMs = clampTimeout(
      args.timeout,
      DEFAULT_TIMEOUT_MS,
      MAX_RUN_TIMEOUT_MS,
    )
    // P2-2 groundwork — audit sub-rows land here until the SQLite sink
    // arrives; they are attached to the result (steps) so a failed run
    // keeps its trail too.
    const audit: InnerCallRecord[] = []
    const outcome = await executeInWorker(
      args.code,
      browserSdk,
      timeoutMs,
      logs,
      ctx.signal,
      makeInnerCallHook(ctx, audit),
      (ctx.page as unknown as { pageId?: number }).pageId,
    )
    const steps = audit.length > 0 ? { steps: audit } : {}
    if (outcome.ok) {
      const value = jsonSafeValue(outcome.value)
      return textResult(format(outcome), {
        ok: true,
        ...(value !== undefined && { value }),
        logs: outcome.logs,
        ...steps,
      })
    }
    return {
      ...errorResult(format(outcome)),
      structuredContent: {
        ok: false,
        logs: outcome.logs,
        error: outcome.error?.message,
        ...steps,
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
    /**
     * P1-8 tool: routing — dispatch a whitelisted MCP tool through the same
     * executeTool pipeline the MCP surface uses (guard runs again inside,
     * idempotent and harmless). Errors throw so scripts can try/catch; the
     * resolved value is the tool's structuredContent with its text payload
     * attached as `text`.
     */
    async tool(
      name: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> {
      if (!RUN_TOOL_ALLOWLIST.has(name)) {
        throw new Error(
          `run: browser.tool("${name}") is not exposed; available: ${[...RUN_TOOL_ALLOWLIST].join(', ')}`,
        )
      }
      const def = (await loadToolIndex()).get(name)
      if (!def) throw new Error(`run: browser.tool("${name}") is not registered`)
      const result = await executeTool(def, args ?? {}, ctx)
      const text = result.content
        .map((item) => (item.type === 'text' ? item.text : ''))
        .join('\n')
        .trim()
      if (result.isError) {
        // P1-4 (phase C): propagate the structured error contract through the
        // thrown script-facing Error — code rides on the message head (and as
        // .code/.hint properties) so scripts can branch on platform codes.
        const sc = (result.structuredContent ?? {}) as Record<string, unknown>
        const code = typeof sc.code === 'string' ? sc.code : undefined
        const hint = typeof sc.hint === 'string' ? sc.hint : undefined
        const err = new Error(
          `run: browser.tool("${name}") failed: ${code !== undefined ? `[${code}] ` : ''}${text}`,
        ) as Error & { code?: string; hint?: string }
        if (code !== undefined) err.code = code
        if (hint !== undefined) err.hint = hint
        throw err
      }
      return { ...(result.structuredContent as object | undefined), text }
    },
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

/**
 * Executes agent code inside a worker thread.
 *
 * The script runs against the worker-side SDK facade (run-worker.ts); every
 * SDK call and console line crosses the postMessage bridge. The timeout
 * fires `worker.terminate()`, which kills even a synchronous infinite loop —
 * the main thread (and the daemon) stays responsive. An aborted ctx.signal
 * terminates the worker too (executeTool only races the handler promise;
 * without this the worker would linger until done/timeout).
 */
function executeInWorker(
  code: string,
  sdk: unknown,
  timeoutMs: number,
  logs: string[],
  signal?: AbortSignal,
  hook?: InnerCallHook,
  /** ctx.page's page id — the audit pageId for the page-bound `cdp` primitive. */
  defaultPageId?: number,
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const worker = new Worker(WORKER_SRC, { eval: true })

    const onAbort = () => {
      const error = new Error('run aborted')
      error.name = 'AbortError'
      finish({ ok: false, value: undefined, logs, error })
    }

    const finish = (outcome: RunOutcome) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      resolve(outcome)
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'log') {
        logs.push(msg.line)
        return
      }
      if (msg.type === 'call') {
        resolveCall(sdk, msg.calls, hook, defaultPageId)
          .then((value) =>
            postCallResult(worker, {
              type: 'call-result',
              callId: msg.callId,
              ok: true,
              value,
            }),
          )
          .catch((err) =>
            postCallResult(worker, {
              type: 'call-result',
              callId: msg.callId,
              ok: false,
              error: errorInfo(err),
            }),
          )
        return
      }
      if (msg.type === 'done') {
        if (msg.ok === true) {
          finish({ ok: true, value: msg.value, logs })
        } else {
          finish({
            ok: false,
            value: undefined,
            logs,
            error: new Error(msg.error?.message ?? 'run failed'),
          })
        }
      }
    })

    worker.on('error', (err) => {
      finish({ ok: false, value: undefined, logs, error: err })
    })

    // Worker died without reporting done (crash / external kill).
    worker.on('exit', () => {
      finish({
        ok: false,
        value: undefined,
        logs,
        error: new Error('run: worker exited unexpectedly'),
      })
    })

    timer = setTimeout(() => {
      finish({
        ok: false,
        value: undefined,
        logs,
        error: new Error(`run exceeded ${timeoutMs}ms and was terminated`),
      })
    }, timeoutMs)

    worker.postMessage({ type: 'start', code })
  })
}

/**
 * P1-8 — builds the per-primitive gate hook for the run SDK bridge from
 * the tool context. Without identity+spaces (open-world) no hook is
 * installed and primitives keep the legacy unguarded behavior.
 *
 * `onPageCreated` claims a freshly opened tab into the caller's current
 * space (mirrors `tabs new` / space.open_tab attribution). A failed claim
 * throws with a cleanup hint instead of silently leaving an unowned tab
 * that the very next observe() would chain-reject on.
 */
function makeInnerCallHook(
  ctx: ToolContext,
  audit: InnerCallRecord[],
): InnerCallHook | undefined {
  const { identity, spaces } = ctx
  if (!identity || !spaces) return undefined
  const owner = ownerOf(identity)
  return {
    assertPage: (pageId) => spaces.assertPageControllable(owner, pageId),
    assertCanOpenTab: () => spaces.assertCurrentSpaceAgentControllable(owner),
    onPageCreated: async (pageId, url) => {
      const claimed = await spaces.recordTabForCurrentSpace(owner, pageId, url)
      if (!claimed) {
        throw new Error(
          `run: opened page ${pageId} but could not attribute it to your current space; close it with browser.pages.close(${pageId})`,
        )
      }
    },
    annotatePages: (tabs) => spaces.filterTabsForAgent(owner, tabs),
    record: async (rec) => {
      audit.push(rec)
      // P2-2 — same sub-row as the in-result `steps`, persisted as an audit
      // child row linked to this run's dispatch (parent_dispatch_id).
      getAuditSink().recordDispatch({
        ...(ctx.dispatchId && { parentDispatchId: ctx.dispatchId }),
        ...(identity && {
          convoId: ownerOf(identity),
          agentLabel: identity.displayName ?? identity.agentId,
        }),
        source: 'run',
        toolName: rec.tool,
        ...(rec.pageId !== undefined && { pageId: rec.pageId }),
        durationMs: rec.durationMs,
        ok: rec.ok,
        ...(rec.error !== undefined && { error: rec.error.slice(0, 200) }),
      })
    },
  }
}

/**
 * Resolves a bridged call sequence against the main-thread browser SDK —
 * the run bridge's call() gate (P1-4 phase B), mirroring BrowserOS
 * `BrowserBridge::call`: authorize → dispatch → effects → record.
 *
 * Each step is `{ name, args }`: `args === null` means a plain property
 * access, otherwise the property is invoked with args and awaited. This
 * is where chained calls (`browser.observe(1).snapshot()`) are replayed.
 *
 * authorize: page-scoped sequences (observe/input/nav with a pageId,
 * pages.close/getInfo) pass hook.assertPage, `pages.newPage` passes
 * hook.assertCanOpenTab; `cdp` is page-bound (the tool-level guard already
 * covers ctx.page) but the cross-page `Target.*` domains are denied.
 *
 * effects: `pages.list()` results are filtered through hook.annotatePages
 * so foreign tabs never leak; `pages.newPage` claims the fresh tab via
 * hook.onPageCreated (before the script can touch it — otherwise the very
 * next observe(newId) chain-rejects with page-not-in-space).
 *
 * record: every attempt (rejected or not) lands one audit sub-row via
 * hook.record (P2-2 groundwork; see InnerCallRecord).
 */
async function resolveCall(
  sdk: unknown,
  calls: BridgeCall[],
  hook?: InnerCallHook,
  defaultPageId?: number,
): Promise<unknown> {
  const record = makeCallRecorder(calls, hook, defaultPageId)
  try {
    if (hook) await authorizeCall(calls, hook)
    let cur: any = sdk
    for (const step of calls) {
      if (typeof step?.name !== 'string' || !(step.name in Object(cur))) {
        throw new Error(`run: unknown browser SDK property "${String(step?.name)}"`)
      }
      cur = cur[step.name]
      if (step.args !== null) cur = await cur(...step.args)
    }
    if (hook && isPagesList(calls) && Array.isArray(cur)) {
      cur = await hook.annotatePages(cur)
    }
    if (hook && isPagesNewPage(calls) && typeof cur === 'number') {
      record.pageId = cur
      await hook.onPageCreated(cur, newPageUrlOf(calls))
    }
    await record.finish(true)
    return cur
  } catch (err) {
    await record.finish(false, err)
    throw err
  }
}

/**
 * Builds the audit sub-row recorder for one bridged call. Failures record
 * too, so a rejected authorize/dispatch leaves the same trail a successful
 * one does. Never throws (the audit sink must not break the bridge) and is
 * a no-op without a hook (open-world callers keep the legacy output).
 */
function makeCallRecorder(
  calls: BridgeCall[],
  hook: InnerCallHook | undefined,
  defaultPageId?: number,
) {
  const started = Date.now()
  // Audit tool name: `tool:<name>` for routed MCP tools, else the primitive
  // path (`observe.snapshot`, `pages.newPage`, `cdp`, ...).
  const tool =
    calls[0]?.name === 'tool' && typeof calls[0].args?.[0] === 'string'
      ? `tool:${calls[0].args[0]}`
      : calls.map((step) => step.name).join('.')
  let pageId = targetPageIdOf(calls, defaultPageId)
  return {
    set pageId(value: number | undefined) {
      pageId = value
    },
    async finish(ok: boolean, error?: unknown): Promise<void> {
      if (!hook) return
      try {
        await hook.record({
          tool,
          ...(pageId !== undefined && { pageId }),
          ok,
          durationMs: Date.now() - started,
          ...(error !== undefined && {
            error: error instanceof Error ? error.message : String(error),
          }),
        })
      } catch {
        // The audit sink must never break the bridged call.
      }
    },
  }
}

/** Best-effort pageId extraction from a bridged call sequence (audit sub-rows). */
function targetPageIdOf(
  calls: BridgeCall[],
  defaultPageId?: number,
): number | undefined {
  const first = calls[0]
  const second = calls[1]
  if (
    (first?.name === 'observe' || first?.name === 'input' || first?.name === 'nav') &&
    typeof first.args?.[0] === 'number'
  ) {
    return first.args[0]
  }
  if (first?.name === 'pages' && typeof second?.args?.[0] === 'number') {
    return second.args[0]
  }
  // Routed MCP tools carry their page arg inside the args object (guarded
  // idempotently inside executeTool).
  if (first?.name === 'tool' && typeof first.args?.[1] === 'object' && first.args[1] !== null) {
    const page = (first.args[1] as Record<string, unknown>).page
    if (typeof page === 'number') return page
    return undefined
  }
  if (first?.name === 'cdp') return defaultPageId
  return undefined
}

/** Throws when the bridged call sequence is not allowed for this caller. */
async function authorizeCall(
  calls: BridgeCall[],
  hook: InnerCallHook,
): Promise<void> {
  const first = calls[0]
  const second = calls[1]
  if (!first) return

  // Page-scoped families: observe(pageId)/input(pageId)/nav(pageId).
  if (
    (first.name === 'observe' || first.name === 'input' || first.name === 'nav') &&
    typeof first.args?.[0] === 'number'
  ) {
    await hook.assertPage(first.args[0] as number)
    return
  }

  // pages.close(pageId) / pages.getInfo(pageId).
  if (
    first.name === 'pages' &&
    (second?.name === 'close' || second?.name === 'getInfo') &&
    typeof second?.args?.[0] === 'number'
  ) {
    await hook.assertPage(second.args[0] as number)
    return
  }

  // pages.newPage(url?) — guard mirrors `tabs new`: the caller must own a
  // controllable current space; the fresh tab is claimed right after
  // dispatch (onPageCreated) so observe(newId) does not chain-reject.
  if (first.name === 'pages' && second?.name === 'newPage') {
    await hook.assertCanOpenTab()
    return
  }

  // cdp is page-bound (ctx.page, guarded at tool level) but Target.*
  // domains can reach across pages — deny them.
  if (first.name === 'cdp' && typeof first.args?.[0] === 'string') {
    const method = first.args[0] as string
    if (method.startsWith('Target.')) {
      throw new Error(
        'run: browser.cdp() does not allow Target.* domains (cross-page escape hatch); use browser.pages.newPage/close instead',
      )
    }
  }

  // `tool` needs no up-front branch here: executeTool re-runs
  // guardToolAccess for the routed tool (idempotent, mirrors the official
  // script_hook routing) — a foreign page rejects inside the dispatch with
  // the same 'not in your space' trail.
}

function isPagesList(calls: BridgeCall[]): boolean {
  return calls[0]?.name === 'pages' && calls[1]?.name === 'list'
}

function isPagesNewPage(calls: BridgeCall[]): boolean {
  return calls[0]?.name === 'pages' && calls[1]?.name === 'newPage'
}

function newPageUrlOf(calls: BridgeCall[]): string | undefined {
  return typeof calls[1]?.args?.[0] === 'string' ? (calls[1].args[0] as string) : undefined
}

function postCallResult(worker: Worker, msg: MainToWorkerMessage): void {
  try {
    worker.postMessage(msg)
  } catch {
    // Value not cloneable (or the worker is already gone): degrade to a
    // string summary so the script gets an answer instead of a hang.
    try {
      if (msg.type === 'call-result' && msg.ok) {
        worker.postMessage({
          type: 'call-result',
          callId: msg.callId,
          ok: true,
          value: safeStringify(msg.value),
        })
      }
    } catch {
      // Worker terminated: drop silently.
    }
  }
}

function errorInfo(err: unknown): {
  message: string
  name: string
  code?: string
  hint?: string
} {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; hint?: unknown }
    return {
      message: err.message,
      name: err.name,
      // P1-4 (phase C): structured contract fields ride along (undefined for
      // plain errors — the worker only reattaches what's present).
      ...(typeof e.code === 'string' && { code: e.code }),
      ...(typeof e.hint === 'string' && { hint: e.hint }),
    }
  }
  return { message: String(err), name: 'Error' }
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
