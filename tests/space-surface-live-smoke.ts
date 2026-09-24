/**
 * Live sweep of the space surface that the other smokes do NOT cover together:
 * two spaces in parallel, the window-scoped unmanaged view, adopt/release on a
 * tab the user dragged in, space.switch's window targeting, transferTab's
 * physical move, and recycle.
 *
 * Uses the PRODUCTION gateway shape (`gatewayFromProvider`) — the original
 * P7-H1 smoke used `gatewayFromPage`, which is how the missing window family in
 * `gatewayFromProvider` stayed invisible for a whole round.
 *
 * Self-contained and defensive about cleanup: it records the browser's baseline
 * windows/tabs and closes anything it added, even when an assertion fails.
 *
 * Run:
 *   bun tests/space-surface-live-smoke.ts
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
  isUnmanagedTab,
} from '../src/space/task-space-manager'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())

interface WindowRow {
  windowId: number
  tabCount?: number
}

async function main(): Promise<void> {
  console.log(`[space-surface-live] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)

  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]
  const listTargets = async (): Promise<Array<{ id: string; url: string }>> => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const all = (await res.json()) as Array<{ id: string; type: string; url: string }>
    return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }))
  }
  const closeTarget = async (id: string): Promise<void> => {
    try {
      await fetch(`http://127.0.0.1:${port}/json/close/${id}`)
    } catch {
      /* already gone */
    }
  }
  const createTab = async (
    url: string,
    windowId?: number,
  ): Promise<{ tabId?: number } | undefined> => {
    const res = (await session.cdpJson(
      'Browser.createTab',
      JSON.stringify({ url, ...(windowId !== undefined ? { windowId } : {}) }),
    )) as { tab?: { tabId?: number } }
    return res?.tab
  }

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  const baselineWindows = (await listWindows()).map((w) => w.windowId)
  const baselineTargets = new Set((await listTargets()).map((t) => t.id))

  const factory = new UnifiedBrowserFactory()
  await factory.connect()
  const owner = 'space-surface-live'
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'spacesurf-live-')), 's.json'),
    gateway: gatewayFromProvider(factory as never),
    persist: false,
  })

  const spaces: string[] = []
  try {
    // ── two spaces in parallel ──
    const a = await manager.create(owner, 'surf-A')
    spaces.push(a.id)
    const aTab = await manager.openTabWithReuse(owner, a.id, 'https://example.com/?surf=a')
    const aWin = (await manager.getSpace(a.id)).windowId

    const b = await manager.create(owner, 'surf-B')
    spaces.push(b.id)
    await manager.openTabWithReuse(owner, b.id, 'https://example.com/?surf=b')
    const bWin = (await manager.getSpace(b.id)).windowId

    record(
      'two spaces get two different windows',
      aWin !== undefined && bWin !== undefined && aWin !== bWin,
      `A=${String(aWin)} B=${String(bWin)}`,
    )

    const aTabs = await manager.listTabs(a.id)
    const bTabs = await manager.listTabs(b.id)
    record(
      'listings are isolated: neither space sees the other',
      aTabs.length === 1 &&
        bTabs.length === 1 &&
        aTabs[0].label === 'p1' &&
        bTabs[0].label === 'p1' &&
        aTabs[0].url.includes('surf=a') &&
        bTabs[0].url.includes('surf=b'),
      `A=[${aTabs.map((t) => t.url).join(',')}] B=[${bTabs.map((t) => t.url).join(',')}]`,
    )

    // ── the unmanaged view: a tab the user "dragged" into A's window ──
    await createTab('https://example.com/?surf=user', aWin)
    await new Promise((r) => setTimeout(r, 400))

    const listing = await manager.listTabsWithUnmanaged(a.id)
    const strangers = listing.tabs.filter(isUnmanagedTab)
    record(
      'view=all reports the dragged-in tab, identity-only',
      listing.scope === 'window' &&
        strangers.length === 1 &&
        !('url' in (strangers[0] as object)) &&
        !('title' in (strangers[0] as object)),
      `scope=${listing.scope} unmanaged=${strangers.length} keys=[${Object.keys(strangers[0] ?? {}).join(',')}]`,
    )
    record(
      'the stranger is NOT visible to the plain (managed) listing',
      (await manager.listTabs(a.id)).length === 1,
      `managed=${(await manager.listTabs(a.id)).length}`,
    )

    // ── adopt → release round-trip on that tab ──
    const adopted = await manager.adoptTab(owner, strangers[0].pageId, {
      spaceId: a.id,
    })
    record(
      'adopt brings it under management with origin unknown',
      adopted.label === 'p2' && adopted.openedBy === 'unknown',
      `label=${String(adopted.label)} openedBy=${String(adopted.openedBy)}`,
    )

    let releaseRefused = false
    try {
      await manager.releaseTab(owner, a.id, { label: 'p1' })
    } catch (err) {
      releaseRefused = (err as { code?: string }).code === 'tab-agent-owned'
    }
    record(
      'release refuses the agent-created tab (ego rule)',
      releaseRefused,
      `refused=${releaseRefused}`,
    )

    const released = await manager.releaseTab(owner, a.id, { label: 'p2' })
    record(
      'release hands the adopted tab back without closing it',
      released.label === 'p2' &&
        (await manager.listTabs(a.id)).length === 1 &&
        (await listWindows()).some((w) => w.windowId === aWin),
      `label=${String(released.label)}`,
    )

    // ── space.switch: new tabs must follow the CURRENT space's window ──
    await manager.switch(owner, b.id)
    const switched = await manager.openTabWithReuse(
      owner,
      b.id,
      'https://example.com/?surf=b2',
    )
    const bTabsNow = await manager.listTabs(b.id)
    const bTabWindows = (
      manager as unknown as {
        state: { spaces: Record<string, { tabs: Array<{ pageId: number; windowId?: number }> }> }
      }
    ).state.spaces[b.id].tabs
    record(
      'a second tab in B joins B\'s own window',
      bTabsNow.length === 2 && bTabWindows.every((t) => t.windowId === bWin),
      `tabs=${bTabsNow.length} windows=[${bTabWindows.map((t) => String(t.windowId)).join(',')}] B=${String(bWin)}`,
    )

    // ── transferTab: the physical tab follows the ownership change ──
    await manager.transferTab(owner, { pageId: aTab.pageId, toSpaceId: b.id })
    await new Promise((r) => setTimeout(r, 400))
    const movedRef = (
      manager as unknown as {
        state: { spaces: Record<string, { tabs: Array<{ pageId: number; windowId?: number }> }> }
      }
    ).state.spaces[b.id].tabs.find((t) => t.pageId === aTab.pageId)
    record(
      'transferTab moves the physical tab into the target window',
      movedRef?.windowId === bWin,
      `tab=${aTab.pageId} window=${String(movedRef?.windowId)} target=${String(bWin)}`,
    )

    // ── recycle: fresh window, same URLs ──
    const before = (await manager.getSpace(b.id)).windowId
    const recycled = await manager.recycleSpaceTabs(owner, b.id)
    await new Promise((r) => setTimeout(r, 400))
    const after = (await manager.getSpace(b.id)).windowId
    record(
      'recycle reopens into a freshly created window',
      recycled.recycled === 3 && after !== undefined && after !== before,
      `recycled=${recycled.recycled} ${String(before)} -> ${String(after)}`,
    )
  } finally {
    for (const id of spaces) {
      await manager.closeSpace(owner, id, { keep: false }).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 500))
    // Defensive: close anything this smoke added, whatever happened above.
    for (const t of await listTargets()) {
      if (!baselineTargets.has(t.id)) await closeTarget(t.id)
    }
    await new Promise((r) => setTimeout(r, 600))
    for (const w of await listWindows()) {
      if (!baselineWindows.includes(w.windowId)) {
        try {
          await session.cdpJson(
            'Browser.closeWindow',
            JSON.stringify({ windowId: w.windowId }),
          )
        } catch {
          /* already gone */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
    const after = await listWindows()
    record(
      'cleanup: browser is back to its baseline windows',
      after.length === baselineWindows.length,
      `windows=${after.length} (baseline ${baselineWindows.length})`,
    )
    await factory.close?.().catch?.(() => {})
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`space surface live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: space surface live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error(
    'SPACE SURFACE LIVE SMOKE FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
