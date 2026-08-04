/**
 * Live CDP smoke for TabFreshness 修正版 (2026-08-03).
 * Requires real Chrome on BROWSEROS_CDP_PORT (default 9110).
 *
 * Run: BROWSEROS_CDP_PORT=9110 bun tests/tabfreshness-live-smoke.ts
 *
 * Covers the mandatory live checks:
 *   - space.recycle: same URLs reopened on NEW pageIds, browser tab count
 *     unchanged, ledger updated
 *   - screenshot canary normal path: canaryCapture on a healthy tab returns
 *     quickly and does NOT false-positive — a real screenshot still succeeds
 *     after the canary (and on the recycled fresh tab)
 *
 * The wedge-hint / auto-recycle paths are covered by unit tests (faked wedged
 * capture pipeline); constructing a genuinely wedged tab requires accumulating
 * navigation+input on one tab until the renderer capture pipeline sticks,
 * which is not deterministic enough for a smoke.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { UnifiedBrowserFactory } from '../src/factory.ts'
import {
  TaskSpaceManager,
  gatewayFromProvider,
} from '../src/space/task-space-manager.ts'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')
const ledger = path.join(os.tmpdir(), `hub-tabfresh-${Date.now()}.json`)

async function main(): Promise<void> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 300)}`)
  }

  const factory = new UnifiedBrowserFactory()
  const manager = new TaskSpaceManager({
    storagePath: ledger,
    gateway: gatewayFromProvider(factory),
  })
  const identity = { agentId: 'tabfresh-smoke-agent', displayName: 'tabfresh smoke' }
  try {
    const page = await factory.connect({ cdpEndpoint: `http://127.0.0.1:${port}` })
    const space = await manager.create(identity.agentId, `tabfresh-${Date.now()}`)

    const urlA = 'https://example.com/'
    const urlB = 'https://example.org/'
    const before = (await page.tabs()).length

    // 1. Open two tabs in the space.
    const a = await manager.openTabWithReuse(identity.agentId, space.id, urlA, {
      background: true,
    })
    const b = await manager.openTabWithReuse(identity.agentId, space.id, urlB, {
      background: true,
    })

    // 2. Canary on a healthy tab: fast, no false positive.
    const pageA = await factory.connect({ pageId: a.pageId })
    const canaryMs = await pageA.canaryCapture(2500)
    record(
      'canary on fresh tab succeeds quickly (no false positive)',
      typeof canaryMs === 'number' && canaryMs < 2500,
      `${canaryMs}ms`,
    )
    record('canary did NOT mark the healthy tab wedged', pageA.isScreenshotWedged() === false, '')

    // 3. Real screenshot still succeeds after the canary.
    const data = await pageA.screenshot({ format: 'jpeg' })
    record(
      'screenshot after canary still succeeds',
      typeof data === 'string' && data.length > 100,
      `jpeg ${data.length} chars`,
    )

    // 4. Recycle: same URLs, new pageIds, tab count unchanged.
    const mid = (await page.tabs()).length
    const result = await manager.recycleSpaceTabs(identity.agentId, space.id)
    const after = (await page.tabs()).length
    record('recycle returned 2 tabs', result.recycled === 2, `recycled=${result.recycled}`)
    record(
      'recycle preserved the URLs',
      result.tabs.map((t) => t.url).sort().join('|') === [urlA, urlB].sort().join('|'),
      result.tabs.map((t) => t.url).join(','),
    )
    record(
      'recycle assigned NEW pageIds (old closed, fresh opened)',
      result.tabs[0].newPageId !== a.pageId && result.tabs[1].newPageId !== b.pageId,
      `${a.pageId},${b.pageId} -> ${result.tabs.map((t) => t.newPageId).join(',')}`,
    )
    record(
      'browser tab count unchanged after recycle',
      after === mid,
      `before=${mid} after=${after}`,
    )

    const ledgerTabs = await manager.listTabs(space.id)
    record(
      'ledger updated to the new pageIds with same URLs',
      ledgerTabs.map((t) => t.pageId).sort((x, y) => x - y).join(',') ===
        result.tabs.map((t) => t.newPageId).sort((x, y) => x - y).join(',') &&
        ledgerTabs.map((t) => t.url).sort().join('|') === [urlA, urlB].sort().join('|'),
      ledgerTabs.map((t) => `${t.pageId}:${t.url}`).join(', '),
    )

    // 5. Canary + screenshot on the recycled (fresh) tab — still no false positive.
    const recycledPage = await factory.connect({ pageId: result.tabs[0].newPageId })
    const canaryMs2 = await recycledPage.canaryCapture(2500)
    const data2 = await recycledPage.screenshot({ format: 'jpeg' })
    record(
      'canary + screenshot succeed on the recycled tab',
      typeof canaryMs2 === 'number' && canaryMs2 < 2500 &&
        typeof data2 === 'string' && data2.length > 100,
      `canary ${canaryMs2}ms, jpeg ${data2.length} chars`,
    )

    // Cleanup: close every tab we opened, restore the original count.
    for (const t of result.tabs) {
      try {
        await manager.closeTab(identity.agentId, space.id, t.newPageId)
      } catch {
        /* best-effort */
      }
    }
    const cleaned = (await page.tabs()).length
    record('cleanup restored the original tab count', cleaned === before, `before=${before} after=${cleaned}`)
    await manager.closeSpace(identity.agentId, space.id, { keep: true })
  } finally {
    try {
      await manager.dispose()
    } catch {
      /* best-effort */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`)
  if (failed.length > 0) process.exit(1)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('smoke failed:', err)
    process.exit(1)
  })
