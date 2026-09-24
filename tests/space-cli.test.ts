/**
 * Phase 3 — `opencli space` command group (3.6): create/list/current/switch/
 * handoff/takeover/close/finish against a temp ledger. No browser needed for
 * the ledger-only paths (keep:true).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

// These tests are ledger-only — a fast-failing bridge exercises the degradation
// path (no browser reachable) and daemon mode keeps the process alive
// (non-daemon CLI actions call process.exit() after a direct bridge). Mirrors
// the browser-command test convention in space-browser-cli.test.ts.
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
  it('finish keeps the labels you name and closes the rest (MCP parity)', async () => {
    // Same shared-registry fake as the recycle test: the CLI's gateway and the
    // setup manager must see the same live tabs.
    let next = 700
    const tabs: Array<{ pageId: number; targetId: string; url: string }> = []
    class FakeFinishPage {
      async newTab(url?: string) {
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
      connect: async () => new FakeFinishPage(),
    }
    ;(globalThis as any).__HubDaemonMode = true

    const { ledger, run } = makeRunner()
    const { TaskSpaceManager, gatewayFromPage } = await import(
      '../src/space/task-space-manager.ts'
    )
    const setup = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new FakeFinishPage()),
      persist: true,
    })
    const space = await setup.create('cli:local', 'finish-me')
    await setup.openTabWithReuse('cli:local', space.id, 'https://a.example/')
    await setup.openTabWithReuse('cli:local', space.id, 'https://b.example/')
    const rows = await setup.listTabs(space.id)
    const keepLabel = String(rows[0].label)
    const dropLabel = String(rows[1].label)

    // Keep exactly one label: the other tab closes, the space stays.
    const kept = JSON.parse(
      await run(['space', 'finish', space.id, '--keep', keepLabel, '--json']),
    ) as {
      closedSpace: boolean
      keptLabels: string[]
      closedLabels: string[]
    }
    expect(kept.keptLabels).toEqual([keepLabel])
    expect(kept.closedLabels).toEqual([dropLabel])
    expect(kept.closedSpace).toBe(false)
    expect(tabs.map((t) => t.url)).toEqual(['https://a.example/'])

    // Keep nothing: everything closes and the space leaves the ledger.
    const emptied = JSON.parse(
      await run(['space', 'finish', space.id, '--keep', '', '--json']),
    ) as { closedSpace: boolean; keptLabels: string[]; closedLabels: string[] }
    expect(emptied.closedSpace).toBe(true)
    expect(emptied.keptLabels).toEqual([])
    expect(emptied.closedLabels).toEqual([keepLabel])
    expect(tabs).toHaveLength(0)
  })

  it('finish keeps the labels you name and closes the rest (MCP parity)', async () => {
    // Same shared-registry fake as the recycle test: the CLI's gateway and the
    // setup manager must see the same live tabs.
    let next = 700
    const tabs: Array<{ pageId: number; targetId: string; url: string }> = []
    class FakeFinishPage {
      async newTab(url?: string) {
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
      connect: async () => new FakeFinishPage(),
    }
    ;(globalThis as any).__HubDaemonMode = true

    const { ledger, run } = makeRunner()
    const { TaskSpaceManager, gatewayFromPage } = await import(
      '../src/space/task-space-manager.ts'
    )
    const setup = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromPage(new FakeFinishPage()),
      persist: true,
    })
    const space = await setup.create('cli:local', 'finish-me')
    await setup.openTabWithReuse('cli:local', space.id, 'https://a.example/')
    await setup.openTabWithReuse('cli:local', space.id, 'https://b.example/')
    const rows = await setup.listTabs(space.id)
    const keepLabel = String(rows[0].label)
    const dropLabel = String(rows[1].label)

    // Keep exactly one label: the other tab closes, the space stays.
    const kept = JSON.parse(
      await run(['space', 'finish', space.id, '--keep', keepLabel, '--json']),
    ) as {
      closedSpace: boolean
      keptLabels: string[]
      closedLabels: string[]
    }
    expect(kept.keptLabels).toEqual([keepLabel])
    expect(kept.closedLabels).toEqual([dropLabel])
    expect(kept.closedSpace).toBe(false)
    expect(tabs.map((t) => t.url)).toEqual(['https://a.example/'])

    // Keep nothing: everything closes and the space leaves the ledger.
    const emptied = JSON.parse(
      await run(['space', 'finish', space.id, '--keep', '', '--json']),
    ) as { closedSpace: boolean; keptLabels: string[]; closedLabels: string[] }
    expect(emptied.closedSpace).toBe(true)
    expect(emptied.keptLabels).toEqual([])
    expect(emptied.closedLabels).toEqual([keepLabel])
    expect(tabs).toHaveLength(0)
  })

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