/**
 * Live check for P7-H1 — a space gets its OWN browser window.
 *
 * Acceptance from docs/specs/p7h-space-window-model.md §7: two spaces land in
 * two different windows, a second tab joins the space's window, and closing the
 * space takes the window with it (Chromium destroys a window with its last tab).
 *
 * Self-contained: uses a temp ledger, creates its own windows and closes them
 * again, then asserts the browser window count is back to the baseline.
 *
 * Run:
 *   bun tests/space-window-live-smoke.ts
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
  console.log(`[space-window-live] CDP ${port}`)
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

  const owner = 'space-window-live'
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'spacewin-live-')), 's.json'),
    gateway: gatewayFromPage(page as never),
    persist: false,
  })

  const baseline = await listWindows()
  record('baseline: window count', true, `windows=${baseline.length}`)

  const createdSpaces: string[] = []
  try {
    const a = await manager.create(owner, 'win-probe-a')
    createdSpaces.push(a.id)
    await manager.openTab(owner, a.id, 'https://example.com/?win=a1')
    const aInfo = await manager.getSpace(a.id)
    record(
      'space A: first tab created its own window',
      typeof aInfo.windowId === 'number' && (await listWindows()).length === baseline.length + 1,
      `spaceWindow=${String(aInfo.windowId)} windows=${(await listWindows()).length}`,
    )

    const b = await manager.create(owner, 'win-probe-b')
    createdSpaces.push(b.id)
    await manager.openTab(owner, b.id, 'https://example.com/?win=b1')
    const bInfo = await manager.getSpace(b.id)
    record(
      'space B: landed in a DIFFERENT window (the acceptance criterion)',
      typeof bInfo.windowId === 'number' &&
        bInfo.windowId !== aInfo.windowId &&
        (await listWindows()).length === baseline.length + 2,
      `A=${String(aInfo.windowId)} B=${String(bInfo.windowId)} windows=${(await listWindows()).length}`,
    )

    await manager.openTab(owner, a.id, 'https://example.com/?win=a2')
    const windows = await listWindows()
    const aWindow = windows.find((w) => w.windowId === aInfo.windowId)
    record(
      'space A: the second tab joined its window (no new window)',
      windows.length === baseline.length + 2 && aWindow?.tabCount === 2,
      `windows=${windows.length} A.tabCount=${String(aWindow?.tabCount)}`,
    )

    const aTabs = await manager.listTabs(a.id)
    record(
      'ledger: every tab records its window',
      aTabs.length === 2 &&
        aTabs.every((t) => {
          const ref = (
            manager as unknown as {
              state: { spaces: Record<string, { tabs: Array<{ pageId: number; windowId?: number }> }> }
            }
          ).state.spaces[a.id].tabs.find((x) => x.pageId === t.pageId)
          return ref?.windowId === aInfo.windowId
        }),
      `tabs=${aTabs.length} window=${String(aInfo.windowId)}`,
    )
  } finally {
    for (const id of createdSpaces) {
      await manager.closeSpace(owner, id, { keep: false }).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 500))
    const after = await listWindows()
    record(
      'cleanup: closing the spaces took their windows with them',
      after.length === baseline.length,
      `windows=${after.length} (baseline ${baseline.length})`,
    )
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`space window live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: space window live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('SPACE WINDOW LIVE SMOKE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
