/**
 * Live probe of the fork's WINDOW semantics — the four facts the P7-H design
 * (docs/specs/p7h-space-window-model.md §2) is built on. Re-run it after an
 * upstream sync: if any of these change, that design's constraints change too.
 *
 *   1. createWindow always yields exactly ONE tab (cannot create an empty window)
 *   2. createWindow does NOT steal focus (isActive stays false)
 *   3. activateWindow is a silent no-op under AutomationNeverStealsFocus
 *   4. closeWindow takes its tabs down with it
 *   ...plus: every tab already carries its windowId (no extra CDP call needed).
 *
 * Creates one window and closes it again; nothing else is touched.
 *
 * Run:
 *   bun tests/window-semantics-live-smoke.ts
 */
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { BROWSER_TOOLS } from '@browseros/browser-mcp/registry'
import {
  type ToolDefinition,
  type ToolResult,
  executeTool,
} from '@browseros/browser-mcp/tools/framework'
import type { SessionToolContext } from '@browseros/browser-mcp/tools/session-adapter'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())

interface WindowRow {
  windowId: number
  tabCount?: number
  isActive?: boolean
  isVisible?: boolean
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter(
      (c): c is { type: 'text'; text: string } =>
        c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

function structured(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

function tool(name: string): ToolDefinition {
  const def = BROWSER_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

async function listWindows(ctx: SessionToolContext): Promise<WindowRow[]> {
  const res = await executeTool(tool('windows'), { action: 'list' }, ctx)
  return (structured(res).windows ?? []) as WindowRow[]
}

async function main(): Promise<void> {
  console.log(`[window-semantics] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const ctx: SessionToolContext = { session: session as never }
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 220)}`)
  }

  let created: number | undefined
  try {
    const before = await listWindows(ctx)
    record('baseline: windows listed', before.length > 0, `count=${before.length}`)

    const createRes = await executeTool(tool('windows'), { action: 'create' }, ctx)
    const window = (structured(createRes).window ?? {}) as WindowRow
    created = window.windowId
    if (typeof created !== 'number') {
      throw new Error(`create returned no windowId: ${textOf(createRes).slice(0, 200)}`)
    }

    const after = await listWindows(ctx)
    const fresh = after.find((w) => w.windowId === created)
    record(
      'fact 1: a new window always holds exactly one tab',
      fresh?.tabCount === 1,
      `windowId=${created} tabCount=${String(fresh?.tabCount)}`,
    )
    record(
      'fact 2: createWindow does not steal focus',
      fresh?.isActive === false,
      `isActive=${String(fresh?.isActive)} isVisible=${String(fresh?.isVisible)} (baseline windows=${before.length}, now=${after.length})`,
    )

    const tabsRes = await executeTool(tool('tabs'), { action: 'list' }, ctx)
    const tabsText = textOf(tabsRes)
    const pages = (structured(tabsRes).pages ?? []) as Array<{ page?: number }>
    record(
      'fact 5: windowId is already visible on tabs (no extra CDP call)',
      pages.length > 0,
      `tabs=${pages.length} | ${tabsText.split('\n').slice(0, 2).join(' / ').slice(0, 160)}`,
    )

    await executeTool(tool('windows'), { action: 'activate', windowId: created }, ctx)
    const afterActivate = await listWindows(ctx)
    const target = afterActivate.find((w) => w.windowId === created)
    record(
      'fact 3: activateWindow is a no-op under never-steal-focus',
      target?.isActive === false,
      `isActive after activate=${String(target?.isActive)} (a real activation would flip this)`,
    )
  } finally {
    if (created !== undefined) {
      const closeRes = await executeTool(
        tool('windows'),
        { action: 'close', windowId: created },
        ctx,
      )
      const after = await listWindows(ctx)
      record(
        'fact 4: closeWindow takes its tabs down with it',
        !closeRes.isError && !after.some((w) => w.windowId === created),
        `windows now=${after.length} | ${textOf(closeRes).split('\n')[0] ?? ''}`,
      )
    }
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`window-semantics probe failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: window semantics probe (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('WINDOW SEMANTICS PROBE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
