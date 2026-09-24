/**
 * Live check for P7-H2 — window LIFECYCLE around a space.
 *
 *   1. closeSpace closes the space's own window in one call
 *   2. …but NEVER when that window holds a tab that is not ours (a tab the user
 *      dragged in must survive) — the ledger's tab goes, theirs stays
 *   3. recycle closes the old window and reopens into a fresh one
 *   4. transferTab physically moves the tab into the target space's window
 *
 * Self-contained: temp ledger, its own spaces/windows, and it closes the foreign
 * tab it injects. Asserts the browser window count returns to the baseline.
 *
 * Run:
 *   bun tests/space-window-lifecycle-live-smoke.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import {
  TaskSpaceManager,
  gatewayFromPage,
} from '../src/space/task-space-manager'
import { pageFromSession } from '@browseros/browser-mcp/tools/session-adapter'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())

interface WindowRow {
  windowId: number
  tabCount?: number
}

async function main(): Promise<void> {
  console.log(`[space-window-lifecycle] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const active = (await session.pages.list()) as unknown as Array<{
    pageId: number
    isActive?: boolean
  }>
  const pageId = active.find((p) => p.isActive)?.pageId ?? active[0]?.pageId
  if (typeof pageId !== 'number') throw new Error('no page to bind')
  const page = pageFromSession(session, pageId)

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  const listWindows = async (): Promise<WindowRow[]> =>
    (await page.windowList()) as unknown as WindowRow[]

  const owner = 'space-window-lifecycle'
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'spacelife-live-')), 's.json'),
    gateway: gatewayFromPage(page as never),
    persist: false,
  })

  const baseline = await listWindows()
  const spaces: string[] = []
  let injectedTab: number | undefined

  try {
    // ── 2. a foreign tab in the space's window blocks the window close ──
    const a = await manager.create(owner, 'life-a')
    spaces.push(a.id)
    const aTab = await manager.openTab(owner, a.id, 'https://example.com/?life=a')
    const aWindow = (await manager.getSpace(a.id)).windowId
    // Inject an unledgered tab into that window (stands in for the user's tab).
    const injected = (await page.cdp('Browser.createTab', {
      url: 'https://example.com/?life=user',
      windowId: aWindow,
    })) as { tab?: { tabId?: number } }
    await new Promise((r) => setTimeout(r, 400))
    const afterInject = await listWindows()
    const injectedWindow = afterInject.find((w) => w.windowId === aWindow)
    record(
      'setup: a tab that is not in the ledger now lives in the space window',
      injectedWindow?.tabCount === 2,
      `window=${String(aWindow)} tabCount=${String(injectedWindow?.tabCount)} injectedTabId=${String(injected?.tab?.tabId)}`,
    )

    await manager.closeSpace(owner, a.id, { keep: false })
    spaces.splice(spaces.indexOf(a.id), 1)
    await new Promise((r) => setTimeout(r, 400))
    const afterClose = await listWindows()
    const survivor = afterClose.find((w) => w.windowId === aWindow)
    const liveTabs = (await page.tabs()) as unknown as Array<{
      pageId: number
      windowId?: number
    }>
    const foreignSurvived = liveTabs.some(
      (t) => t.windowId === aWindow && t.pageId !== aTab,
    )
    record(
      'closeSpace keeps the window alive while a foreign tab is inside',
      survivor !== undefined && foreignSurvived && !liveTabs.some((t) => t.pageId === aTab),
      `windowAlive=${survivor !== undefined} foreignTabSurvived=${foreignSurvived} ownTabGone=${!liveTabs.some((t) => t.pageId === aTab)}`,
    )
    injectedTab = liveTabs.find((t) => t.windowId === aWindow)?.pageId

    // ── 1. an entirely-owned window collapses to one closeWindow ──
    const b = await manager.create(owner, 'life-b')
    spaces.push(b.id)
    await manager.openTab(owner, b.id, 'https://example.com/?life=b')
    const bWindow = (await manager.getSpace(b.id)).windowId
    await manager.closeSpace(owner, b.id, { keep: false })
    spaces.splice(spaces.indexOf(b.id), 1)
    await new Promise((r) => setTimeout(r, 400))
    const bGone = !(await listWindows()).some((w) => w.windowId === bWindow)
    record('closeSpace closes an entirely-owned window', bGone, `window=${String(bWindow)} gone=${bGone}`)

    // ── 3. recycle reopens into a fresh window ──
    const c = await manager.create(owner, 'life-c')
    spaces.push(c.id)
    await manager.openTab(owner, c.id, 'https://example.com/?life=c')
    const cFirst = (await manager.getSpace(c.id)).windowId
    await manager.recycleSpaceTabs(owner, c.id)
    const cSecond = (await manager.getSpace(c.id)).windowId
    const cTabs = await manager.listTabs(c.id)
    record(
      'recycle reopens into a freshly created window',
      typeof cSecond === 'number' && cSecond !== cFirst && cTabs.length === 1,
      `first=${String(cFirst)} second=${String(cSecond)} tabs=${cTabs.length}`,
    )

    // ── 4. transferTab physically moves the tab ──
    const d = await manager.create(owner, 'life-d')
    spaces.push(d.id)
    const dTab = await manager.openTab(owner, d.id, 'https://example.com/?life=d')
    await manager.transferTab(owner, { pageId: dTab, toSpaceId: c.id })
    await new Promise((r) => setTimeout(r, 300))
    const movedTabs = (await page.tabs()) as unknown as Array<{
      pageId: number
      windowId?: number
    }>
    const movedInto = movedTabs.find((t) => t.pageId === dTab)?.windowId
    record(
      'transferTab moves the physical tab into the target space window',
      movedInto === cSecond,
      `tab=${String(dTab)} window=${String(movedInto)} target=${String(cSecond)}`,
    )
  } finally {
    // The injected tab is foreign by construction: close it ourselves.
    if (injectedTab !== undefined) {
      await (page as unknown as { closeTab?: (t: number) => Promise<void> })
        .closeTab?.(injectedTab)
        .catch(() => {})
    }
    for (const id of spaces) {
      await manager.closeSpace(owner, id, { keep: false }).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 600))
    const after = await listWindows()
    record(
      'cleanup: browser window count is back to the baseline',
      after.length === baseline.length,
      `windows=${after.length} (baseline ${baseline.length})`,
    )
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`space window lifecycle failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: space window lifecycle live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('SPACE WINDOW LIFECYCLE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
