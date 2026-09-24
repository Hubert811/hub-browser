/**
 * Live check for the gateway SHAPE production actually uses — M1 follow-up.
 *
 * The original P7-H1 smoke (`space-window-live-smoke.ts`) builds its gateway
 * with `gatewayFromPage(page)`. Every MCP path — stdio `hub --mcp` AND the
 * daemon's HTTP sessions — builds it with `gatewayFromProvider(browser)`
 * instead, and that function was missing the whole window family. Consequence:
 * per-space windows silently degraded to the legacy shared window for ALL agent
 * traffic while the smoke stayed green. This smoke closes that hole by using
 * the provider shape.
 *
 * Acceptance: a space created through a provider gateway still gets its OWN
 * window, a second tab joins it, and closing the space takes the window away.
 * Self-contained: temp ledger, own windows, restores the baseline count.
 *
 * Run:
 *   bun tests/space-window-provider-live-smoke.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { UnifiedBrowserFactory } from '../src/factory'
import {
  TaskSpaceManager,
  gatewayFromProvider,
} from '../src/space/task-space-manager'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())

interface WindowRow {
  windowId: number
  tabCount?: number
}

async function main(): Promise<void> {
  console.log(`[space-window-provider-live] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)

  // Browser-level CDP: this smoke destroys windows, so it must not count them
  // through a page session that can be renumbered or closed underneath it.
  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  // THE POINT OF THIS SMOKE: the production gateway shape.
  const factory = new UnifiedBrowserFactory()
  await factory.connect()
  const gateway = gatewayFromProvider(factory as never)

  record(
    'the provider gateway exposes the window family (the bug this pins)',
    typeof gateway.windowList === 'function' &&
      typeof gateway.windowCreate === 'function' &&
      typeof gateway.windowClose === 'function',
    `windowList=${typeof gateway.windowList} windowCreate=${typeof gateway.windowCreate} windowClose=${typeof gateway.windowClose}`,
  )

  const owner = 'space-window-provider-live'
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'spacewin-prov-')), 's.json'),
    gateway,
    persist: false,
  })

  const baseline = await listWindows()
  const created: string[] = []
  try {
    const a = await manager.create(owner, 'provider-A')
    created.push(a.id)
    await manager.openTabWithReuse(owner, a.id, 'https://example.com/')
    const aInfo = await manager.getSpace(a.id)
    const afterFirst = await listWindows()
    record(
      'a provider-gateway space creates its OWN window',
      aInfo.windowId !== undefined && afterFirst.length === baseline.length + 1,
      `spaceWindow=${String(aInfo.windowId)} windows=${baseline.length}->${afterFirst.length}`,
    )

    const b = await manager.create(owner, 'provider-B')
    created.push(b.id)
    await manager.openTabWithReuse(owner, b.id, 'https://example.org/')
    const bInfo = await manager.getSpace(b.id)
    record(
      'a second space lands in a DIFFERENT window',
      bInfo.windowId !== undefined && bInfo.windowId !== aInfo.windowId,
      `A=${String(aInfo.windowId)} B=${String(bInfo.windowId)}`,
    )

    await manager.openTabWithReuse(owner, a.id, 'https://example.net/')
    const aWindow = (await listWindows()).find((w) => w.windowId === aInfo.windowId)
    record(
      'the second tab joins the same window',
      aWindow?.tabCount === 2,
      `A.tabCount=${String(aWindow?.tabCount)}`,
    )

    const tabs = await manager.listTabs(a.id)
    const refs = (
      manager as unknown as {
        state: {
          spaces: Record<string, { tabs: Array<{ tabId?: number; windowId?: number }> }>
        }
      }
    ).state.spaces[a.id].tabs
    record(
      'every ledger ref records a native id AND its window (M2)',
      tabs.length === 2 &&
        tabs.every((t) => typeof t.tabId === 'number') &&
        refs.every((r) => r.windowId === aInfo.windowId),
      `tabs=${tabs.length} tabIds=[${tabs.map((t) => String(t.tabId)).join(',')}] window=${String(aInfo.windowId)}`,
    )
  } finally {
    for (const id of created) {
      await manager.closeSpace(owner, id, { keep: false }).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 600))
    const after = await listWindows()
    record(
      'cleanup: closing the spaces took their windows with them',
      after.length === baseline.length,
      `windows=${after.length} (baseline ${baseline.length})`,
    )
    await factory.close?.().catch?.(() => {})
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(
      `space window provider live failures: ${failed.map((f) => f.name).join(', ')}`,
    )
  }
  console.log(`PASS: space window provider live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error(
    'SPACE WINDOW PROVIDER LIVE SMOKE FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
