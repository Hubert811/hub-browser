/**
 * Live CDP smoke for 方案 2 — real BrowserSession over port 9110.
 *
 * Mirrors apps/server/src/main.ts session construction exactly:
 *
 *   const cdp = new CdpBackend({ port })
 *   await cdp.connect()
 *   const session = new BrowserSession(cdp)   // (apps/server uses new Browser(cdp).session)
 *
 * then runs tabs / navigate / snapshot / tabs close through the fork's
 * executeTool with the vendored `{ session }` ctx (bridged by
 * session-adapter.ts). Creates its own tab and closes it, so the operator's
 * browser is left as found.
 *
 * Run:
 *   BROWSEROS_CDP_PORT=9110 bun tests/session-mode-live-smoke.ts
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

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter(
      (c): c is { type: 'text'; text: string } =>
        c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

function tool(name: string): ToolDefinition {
  const def = BROWSER_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

async function main(): Promise<void> {
  console.log(`[live-smoke] connecting CDP 9110...`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const ctx: SessionToolContext = { session: session as never }
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 300)}`)
  }

  let createdPage: number | undefined
  try {
    // 1. tabs list (browser-level; must resolve via the bridge)
    const tabsRes = await executeTool(tool('tabs'), { action: 'list' }, ctx)
    record(
      'tabs list',
      !tabsRes.isError,
      `pages=${(tabsRes.structuredContent as { pages?: unknown[] })?.pages?.length ?? '?'} | ${textOf(tabsRes).split('\n')[0] ?? ''}`,
    )

    // 2. tabs new (prove page mutation through the bridge)
    const newRes = await executeTool(tool('tabs'), { action: 'new' }, ctx)
    const newPage = (newRes.structuredContent as { page?: number })?.page
    record('tabs new', !newRes.isError && typeof newPage === 'number', `page=${newPage}`)
    if (typeof newPage !== 'number') throw new Error('tabs new returned no page id')
    createdPage = newPage

    // 3. navigate the new tab to about:blank
    const navRes = await executeTool(
      tool('navigate'),
      { page: createdPage, action: 'url', url: 'about:blank' },
      ctx,
    )
    const url = (navRes.structuredContent as { url?: string })?.url
    record('navigate', !navRes.isError, `url=${url}`)

    // 4. snapshot the new tab
    const snapRes = await executeTool(tool('snapshot'), { page: createdPage }, ctx)
    const snapLen = textOf(snapRes).length
    record('snapshot', !snapRes.isError && snapLen > 0, `chars=${snapLen}`)
  } finally {
    // 5. clean up our tab
    if (createdPage !== undefined) {
      try {
        const closeRes = await executeTool(tool('tabs'), { action: 'close', page: createdPage }, ctx)
        record('tabs close (cleanup)', !closeRes.isError, textOf(closeRes).split('\n')[0] ?? '')
      } catch (err) {
        console.error('[live-smoke] cleanup close failed:', err)
      }
    }
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`live smoke failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: live session-mode smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('LIVE SMOKE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
