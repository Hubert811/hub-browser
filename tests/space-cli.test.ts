/**
 * Phase 3 — `opencli space` command group (3.6): create/list/current/switch/
 * handoff/takeover/close against a temp ledger. No browser needed (keep:true).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

// bug 1 (D5): the space read commands (list/current/switch) now consult the
// browser gateway so tab-group edits reconcile before answering. These tests
// are ledger-only — a fast-failing bridge exercises the degradation path
// (no gateway → sync no-op, output unchanged) and daemon mode keeps the
// process alive (non-daemon CLI actions call process.exit() after a direct
// bridge). Mirrors the browser-command test convention in
// space-browser-cli.test.ts.
class FailingBridge {
  async connect(): Promise<never> {
    throw new Error('no browser in ledger-only test')
  }
  async close() {}
}

afterEach(() => {
  delete (globalThis as any).__HubBrowserBridgeOverride
  delete (globalThis as any).__HubBrowserFactory
  delete (globalThis as any).__HubDaemonMode
})

function makeRunner() {
  const ledger = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'space-cli-')),
    'hub-spaces.json',
  )
  ;(globalThis as any).__HubBrowserBridgeOverride = FailingBridge
  ;(globalThis as any).__HubDaemonMode = true
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  return {
    ledger,
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        process.env.HUB_SPACES_FILE = ledger
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    },
  }
}

describe('opencli space command group (3.6)', () => {
  it('create → list → current → handoff → takeover → close', async () => {
    const { run } = makeRunner()

    const created = await run(['space', 'create', '搜索任务', '--json'])
    const spaceId = (JSON.parse(created) as { space: { id: string } }).space.id
    expect(spaceId).toBeTruthy()

    const list = await run(['space', 'list'])
    expect(list).toContain(spaceId)
    expect(list).toContain('搜索任务')

    const current = await run(['space', 'current', '--json'])
    expect((JSON.parse(current) as { space: { id: string } }).space.id).toBe(spaceId)

    const handoff = await run(['space', 'handoff', spaceId])
    expect(handoff).toContain('handed off')

    // takeover: the user typing the command is the confirmation.
    const takeover = await run(['space', 'takeover', spaceId])
    expect(takeover).toContain('now controls')

    const closed = await run(['space', 'close', spaceId, '--keep', '--json'])
    expect((JSON.parse(closed) as { closed: string }).closed).toBe(spaceId)

    const after = await run(['space', 'current'])
    expect(after).toContain('no current space')
  })

  it('errors on unknown space ids', async () => {
    const { run } = makeRunner()
    const out = await run(['space', 'switch', 'does-not-exist'])
    expect(out).toContain('space not found')
  })
})

describe('opencli space refresh — TabFreshness 整组回收原语 (CLI)', () => {
  it('recycles every tab: same URLs, new pageIds, space record preserved', async () => {
    // Shared in-memory tab registry backing both the CLI's browser gateway
    // (via the injected __HubBrowserFactory singleton) and the setup manager.
    let next = 500
    const tabs: Array<{
      pageId: number
      targetId: string
      url: string
      title?: string
    }> = []
    class FakeRefreshPage {
      async newTab(url?: string, opts?: { background?: boolean }) {
        const pageId = next++
        const targetId = `target-${pageId}`
        tabs.push({ pageId, targetId, url: url ?? 'about:blank' })
        return targetId
      }
      async closeTab(target: number | string) {
        const idx = tabs.findIndex(
          (t) => t.pageId === target || t.targetId === String(target),
        )
        if (idx >= 0) tabs.splice(idx, 1)
      }
      async tabs() {
        return [...tabs]
      }
      async selectTab() {}
      async close() {}
    }
    ;(globalThis as any).__HubBrowserFactory = {
      _cdp: {},
      _session: {},
      connect: async () => new FakeRefreshPage(),
    }
    ;(globalThis as any).__HubDaemonMode = true

    const { ledger, run } = makeRunner()
    // Setup: create the space + two tabs through a manager that shares the
    // same fake registry AND the CLI's ledger file.
    const { TaskSpaceManager, gatewayFromPage } = await import(
      '../src/space/task-space-manager.ts'
    )
    const setup = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new FakeRefreshPage()),
      persist: true,
    })
    const space = await setup.create('cli:local', 'refresh-me')
    const t1 = await setup.openTabWithReuse(
      'cli:local',
      space.id,
      'https://a.example/',
      { background: true },
    )
    const t2 = await setup.openTabWithReuse(
      'cli:local',
      space.id,
      'https://b.example/',
      { background: true },
    )
    expect(tabs).toHaveLength(2)

    const out = await run(['space', 'refresh', space.id, '--json'])
    const parsed = JSON.parse(out) as {
      spaceId: string
      recycled: number
      tabs: Array<{ oldPageId: number; newPageId: number; url: string; reused: boolean }>
    }

    expect(parsed.spaceId).toBe(space.id)
    expect(parsed.recycled).toBe(2)
    expect(parsed.tabs.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ])
    expect(parsed.tabs[0].oldPageId).toBe(t1.pageId)
    expect(parsed.tabs[0].newPageId).not.toBe(t1.pageId)
    expect(parsed.tabs[1].oldPageId).toBe(t2.pageId)
    expect(parsed.tabs[1].newPageId).not.toBe(t2.pageId)
    // Same number of live browser tabs (closed old, opened new).
    expect(tabs).toHaveLength(2)

    // A fresh manager reading the same ledger sees the recycled tabs.
    const check = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new FakeRefreshPage()),
      persist: false,
    })
    const after = await check.listTabs(space.id)
    expect(after.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ])
    expect(after.map((t) => t.pageId)).toEqual(
      parsed.tabs.map((t) => t.newPageId),
    )
    const info = await check.getSpace(space.id)
    expect(info.name).toBe('refresh-me')
    expect(info.ownership).toBe('agent')

    delete (globalThis as any).__HubBrowserFactory
    delete (globalThis as any).__HubDaemonMode
  })
})

// ── bug 1 (D5) — CLI read paths carry the browser gateway ──────────────────
// `space current`/`space list`/`space switch`/`browser tab list` construct the
// manager with a browser gateway so raw tab-group edits (拖入/拖出) reconcile
// into the ledger before answering. Without a gateway the reads degrade
// gracefully (no sync, same output as before).
describe('bug 1 — CLI read paths sync tab-group drag-ins via the gateway', () => {
  /** Fake BrowserClaw page with D5 tab-group support (shared registry). */
  class TabGroupPage {
    constructor(private browser: TabGroupBrowser) {}
    async tabs() {
      return this.browser.tabs.map((t) => ({ ...t }))
    }
    async newTab(url?: string) {
      const tab = this.browser.newTab(url ?? 'about:blank')
      return tab.targetId
    }
    async closeTab() {}
    async selectTab() {}
    async tabGroupList() {
      return this.browser.groups.map((g) => ({ ...g, tabIds: [...g.tabIds] }))
    }
    async tabGroupCreate(pages: number[], title?: string) {
      const tabIds = pages.map((pid) => {
        const t = this.browser.tabs.find((x) => x.pageId === pid)
        if (!t) throw new Error(`Page ${pid} not found`)
        return t.tabId
      })
      const group = {
        groupId: `g-${this.browser.nextGroupId++}`,
        title: title ?? '',
        color: 'grey',
        tabIds,
      }
      this.browser.groups.push(group)
      return group
    }
    async tabGroupUpdate() {
      return undefined
    }
    async tabGroupClose() {}
  }

  class TabGroupBrowser {
    tabs: Array<{
      pageId: number
      targetId: string
      tabId: string
      url: string
      isActive?: boolean
    }> = []
    groups: Array<{
      groupId: string
      title: string
      color: string
      tabIds: string[]
    }> = []
    nextPageId = 100
    nextGroupId = 1
    async connect() {
      return new TabGroupPage(this)
    }
    newTab(url: string) {
      const pageId = this.nextPageId++
      const tab = {
        pageId,
        targetId: `target-${pageId}`,
        tabId: `tab-${pageId}`,
        url,
        isActive: false,
      }
      this.tabs.push(tab)
      return tab
    }
  }

  it('space current + space list sync a raw-CDP drag-in (mock gateway)', async () => {
    const { ledger, run } = makeRunner()
    const browser = new TabGroupBrowser()

    // Setup: create the space + one attributed tab through a manager that
    // shares the SAME fake browser registry and the CLI's ledger file.
    const { TaskSpaceManager, gatewayFromPage } = await import(
      '../src/space/task-space-manager.ts'
    )
    const setup = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new TabGroupPage(browser)),
      persist: true,
    })
    const space = await setup.create('cli:local', 'sync-me')
    await setup.openTabWithReuse('cli:local', space.id, 'https://a.example/', {
      background: true,
    })
    expect(browser.tabs).toHaveLength(1)
    expect(browser.groups).toHaveLength(1)
    const groupId = browser.groups[0].groupId

    // Raw CDP outside the manager: createTab + addTabsToGroup (拖入).
    const dragged = browser.newTab('https://b.example/')
    browser.groups[0].tabIds.push(dragged.tabId)

    // CLI gateway comes from the daemon-singleton seam (spaceGatewayFromBrowser).
    ;(globalThis as any).__HubBrowserFactory = {
      _cdp: {},
      _session: {},
      connect: async () => browser.connect(),
    }

    // bug 1: `space current` reconciles the drag-in before answering.
    const current = await run(['space', 'current', '--json'])
    const cur = JSON.parse(current) as {
      space: { id: string; tabIds: number[]; tabGroupId?: string }
    }
    expect(cur.space.id).toBe(space.id)
    expect(cur.space.tabIds).toHaveLength(2)
    expect(cur.space.tabIds).toEqual(expect.arrayContaining([dragged.pageId]))
    // bug 3: tabGroupId 透出 (SpaceInfo serialization).
    expect(cur.space.tabGroupId).toBe(groupId)

    // `space list` reconciles too.
    const list = await run(['space', 'list', '--json'])
    const parsed = JSON.parse(list) as {
      spaces: Array<{ id: string; tabIds: number[] }>
      count: number
    }
    const listed = parsed.spaces.find((s) => s.id === space.id)!
    expect(listed.tabIds).toHaveLength(2)

    // `space switch` still works with a gateway present.
    const switched = await run(['space', 'switch', space.id, '--json'])
    expect(switched).toContain(space.id)

    delete (globalThis as any).__HubBrowserFactory
  })

  it('browser tab list also reconciles via the connected page gateway', async () => {
    const { ledger, run } = makeRunner()
    const browser = new TabGroupBrowser()

    const { TaskSpaceManager, gatewayFromPage } = await import(
      '../src/space/task-space-manager.ts'
    )
    const setup = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new TabGroupPage(browser)),
      persist: true,
    })
    const space = await setup.create('cli:local', 'tablist-sync')
    await setup.openTabWithReuse('cli:local', space.id, 'https://a.example/', {
      background: true,
    })
    const dragged = browser.newTab('https://b.example/')
    browser.groups[0].tabIds.push(dragged.tabId)

    // browser tab list connects its own page (via the bridge override); the
    // connected page doubles as the manager gateway for the sync.
    class TabGroupBridge {
      async connect() {
        return browser.connect()
      }
    }
    ;(globalThis as any).__HubBrowserBridgeOverride = TabGroupBridge

    const listed = await run(['browser', '--session', 'smoke', 'tab', 'list'])
    const tabs = JSON.parse(listed) as Array<{ pageId: number; url: string }>
    expect(tabs.map((t) => t.pageId)).toEqual(
      expect.arrayContaining([dragged.pageId]),
    )
    expect(tabs).toHaveLength(2)

    delete (globalThis as any).__HubBrowserBridgeOverride
  })

  it('no gateway → reads degrade: no sync, same ledger, command still succeeds', async () => {
    const { ledger, run } = makeRunner()
    const browser = new TabGroupBrowser()

    const { TaskSpaceManager, gatewayFromPage } = await import(
      '../src/space/task-space-manager.ts'
    )
    const setup = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new TabGroupPage(browser)),
      persist: true,
    })
    const space = await setup.create('cli:local', 'degrade-me')
    await setup.openTabWithReuse('cli:local', space.id, 'https://a.example/', {
      background: true,
    })
    // Drag-in happens, but this CLI run has NO browser gateway (FailingBridge).
    const dragged = browser.newTab('https://b.example/')
    browser.groups[0].tabIds.push(dragged.tabId)

    // No __HubBrowserFactory here — spaceGatewayFromBrowser() degrades to
    // gateway undefined; the read must still succeed with the unsynced ledger.
    const current = await run(['space', 'current', '--json'])
    const cur = JSON.parse(current) as { space: { id: string; tabIds: number[] } }
    expect(cur.space.id).toBe(space.id)
    expect(cur.space.tabIds).toHaveLength(1)

    const list = await run(['space', 'list', '--json'])
    const parsed = JSON.parse(list) as {
      spaces: Array<{ id: string; tabIds: number[] }>
      count: number
    }
    expect(parsed.spaces.find((s) => s.id === space.id)!.tabIds).toHaveLength(1)
  })
})
