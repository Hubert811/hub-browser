import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SpaceGuardError,
  SpaceEventBus,
  SpaceEvent,
  TaskSpaceManager,
  defaultStoragePath,
  migrateLegacyLedger,
  type SpaceTabGateway,
  type TabLike,
} from './task-space-manager.ts'

/**
 * Deterministic in-memory browser used by the manager gateway.
 *
 * Tabs created through `newTab` get a stable `tabId` (= 1000 + pageId) so the
 * ledger anchors on the browser's own identity the way a real browser reports
 * it. Tab groups are deliberately NOT part of this fake: the space ↔ tab-group
 * projection was deleted (P7-F / D-P9), so the manager never touches them.
 */
function createFakeGateway(): {
  tabs: TabLike[]
  gateway: SpaceTabGateway
  opened: string[]
  closed: number[]
  activated: number[]
} {
  let nextPageId = 100
  const tabs: TabLike[] = []
  const opened: string[] = []
  const closed: number[] = []
  const activated: number[] = []

  return {
    tabs,
    opened,
    closed,
    activated,
    gateway: {
      newTab: async (url) => {
        const pageId = nextPageId++
        const targetId = `target-${pageId}`
        tabs.push({
          pageId,
          targetId,
          tabId: 1000 + pageId,
          url,
          title: undefined,
        })
        opened.push(url)
        return targetId
      },
      closeTab: async (target) => {
        const idx = tabs.findIndex(
          (t) => t.pageId === target || t.targetId === String(target),
        )
        if (idx >= 0) {
          closed.push(tabs[idx].pageId)
          tabs.splice(idx, 1)
        }
      },
      listTabs: async () => [...tabs],
      activate: async (target) => {
        activated.push(typeof target === 'number' ? target : Number(target))
      },
    },
  }
}

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'hub-spaces-')), 'hub-spaces.json')
}

describe('TaskSpaceManager — lifecycle (3.1)', () => {
  it('create allocates an id, sets it current, emits space.created', async () => {
    const events: string[] = []
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      events: new SpaceEventBus(),
      persist: false,
    })
    manager.events?.on('space.created', (e) => events.push(`${e.type}:${e.spaceId}`))

    const space = await manager.create('agent-a', '搜索任务', 'task-1')
    expect(space.id).toBeTruthy()
    expect(space.name).toBe('搜索任务')
    expect(space.taskId).toBe('task-1')
    expect(space.owner).toBe('agent-a')
    expect(space.ownership).toBe('agent')
    expect(space.tabIds).toEqual([])

    const current = await manager.currentSpace('agent-a')
    expect(current?.id).toBe(space.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toContain('space.created')
  })

  it('useOrCreateTaskSpace reuses the (owner, name) pair', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const first = await manager.useOrCreateTaskSpace('agent-a', 'work')
    const second = await manager.useOrCreateTaskSpace('agent-a', 'work')
    expect(second.id).toBe(first.id)
    expect((await manager.listSpaces('agent-a')).length).toBe(1)
    // Same name under a different owner creates a separate space.
    const other = await manager.useOrCreateTaskSpace('agent-b', 'work')
    expect(other.id).not.toBe(first.id)
  })

  it('openTab opens a background tab, attributes it, listTabs returns it', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const pageId = await manager.openTab(
      'agent-a',
      space.id,
      'https://example.com',
      { background: true },
    )
    expect(typeof pageId).toBe('number')
    expect(fake.opened).toEqual(['https://example.com'])

    const tabs = await manager.listTabs(space.id)
    expect(tabs.map((t) => t.pageId)).toEqual([pageId])
    expect(tabs[0].url).toBe('https://example.com')
    expect((await manager.getSpace(space.id)).tabIds).toEqual([pageId])
  })

  it('listTabs prunes tabs closed externally from the ledger', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const p1 = await manager.openTab('agent-a', space.id, 'https://a.example')
    const p2 = await manager.openTab('agent-a', space.id, 'https://b.example')
    // User closes p1 manually in the browser.
    fake.tabs.splice(
      fake.tabs.findIndex((t) => t.pageId === p1),
      1,
    )
    const tabs = await manager.listTabs(space.id)
    expect(tabs.map((t) => t.pageId)).toEqual([p2])
    expect((await manager.getSpace(space.id)).tabIds).toEqual([p2])
  })

  it('switch changes the current space and rejects user-held spaces', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const s1 = await manager.create('agent-a', 'one')
    const s2 = await manager.create('agent-a', 'two')
    expect((await manager.currentSpace('agent-a'))?.id).toBe(s2.id)
    await manager.switch('agent-a', s1.id)
    expect((await manager.currentSpace('agent-a'))?.id).toBe(s1.id)

    await manager.handOff('agent-a', s1.id)
    await manager.confirmUserControl('agent-a', s1.id)
    await expect(manager.switch('agent-a', s1.id)).rejects.toMatchObject({
      code: 'user-controlling',
    })
  })

  it('closeTab closes in the browser and cleans the ledger', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const pageId = await manager.openTab('agent-a', space.id, 'https://x.example')
    await manager.closeTab('agent-a', space.id, pageId)
    expect(fake.closed).toEqual([pageId])
    expect((await manager.getSpace(space.id)).tabIds).toEqual([])
  })

  it('closeSpace closes every tab, cleans the ledger, and reassigns current', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const s1 = await manager.create('agent-a', 'one')
    const s2 = await manager.create('agent-a', 'two')
    await manager.openTab('agent-a', s1.id, 'https://a.example')
    await manager.openTab('agent-a', s1.id, 'https://b.example')
    await manager.switch('agent-a', s1.id)
    await manager.closeSpace('agent-a', s1.id, { keep: false })
    expect(fake.closed.sort()).toEqual([100, 101])
    expect((await manager.currentSpace('agent-a'))?.id).toBe(s2.id)
    await expect(manager.getSpace(s1.id)).rejects.toMatchObject({
      code: 'space-not-found',
    })
  })

  it('closeSpace with keep:true leaves the tabs open', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.closeSpace('agent-a', space.id, { keep: true })
    expect(fake.closed).toEqual([])
    expect(fake.tabs).toHaveLength(1)
  })

  it('closeSpace falls back to exact-URL matching when the ledger pageId is stale (bug #8)', async () => {
    // Direct-connect repro: the open process recorded ledger pageIds 100/101,
    // but the close process's PageManager renumbered the live tabs (102/103),
    // so gw.closeTab(100) throws "Tab not found" and each tab must be located
    // by URL from the live list instead.
    let nextPageId = 100
    const live: TabLike[] = []
    const closeCalls: Array<number | string> = []
    const gateway: SpaceTabGateway = {
      newTab: async (url) => {
        const pageId = nextPageId++
        live.push({ pageId, targetId: `target-${pageId}`, url })
        return pageId
      },
      closeTab: async (target) => {
        closeCalls.push(target)
        const idx = live.findIndex(
          (t) =>
            t.pageId === target ||
            t.tabId === target ||
            t.targetId === String(target),
        )
        if (idx < 0) throw new Error('Tab not found') // stale/renumbered pageId
        live.splice(idx, 1)
      },
      listTabs: async () => [...live],
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.openTab('agent-a', space.id, 'https://b.example')

    // Simulate the close process's PageManager renumbering both live tabs.
    const staleA = live[0].pageId
    const staleB = live[1].pageId
    live[0].pageId = nextPageId++
    live[1].pageId = nextPageId++
    const liveA = live[0].pageId
    const liveB = live[1].pageId

    // Pre-M2 ledger refs carry no targetId. The stable-identity close is then
    // unavailable, so bug #8's fallback runs: the stale pageId is attempted
    // first (and throws), then the live tab is matched by exact URL.
    const refs = (
      manager as unknown as {
        state: { spaces: Record<string, { tabs: Array<{ targetId?: string }> }> }
      }
    ).state.spaces[space.id].tabs
    for (const ref of refs) delete ref.targetId

    await manager.closeSpace('agent-a', space.id, { keep: false })

    // Per tab: the stale ledger pageId was attempted first (and threw), then
    // the live tab was matched by exact URL and closed via its live pageId.
    expect(closeCalls).toEqual([staleA, liveA, staleB, liveB])
    expect(live).toHaveLength(0)
    await expect(manager.getSpace(space.id)).rejects.toMatchObject({
      code: 'space-not-found',
    })
  })

  it('closeSpace skips a tab that cannot be closed (stale id, no URL match) and still clears the ledger', async () => {
    let nextPageId = 100
    const live: TabLike[] = []
    const gateway: SpaceTabGateway = {
      newTab: async (url) => {
        const pageId = nextPageId++
        live.push({ pageId, targetId: `target-${pageId}`, url })
        return pageId
      },
      closeTab: async () => {
        throw new Error('Tab not found')
      },
      listTabs: async () => [...live],
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://x.example')
    // The close process sees a renumbered tab at a different URL — no URL
    // match, so the close is skipped but the ledger entry is still dropped.
    live[0].pageId = 200
    live[0].url = 'https://other.example'

    await manager.closeSpace('agent-a', space.id, { keep: false })

    expect(live).toHaveLength(1) // browser tab stays open (close failed)
    await expect(manager.getSpace(space.id)).rejects.toMatchObject({
      code: 'space-not-found',
    })
  })

  it('closeTab swallows a browser close failure and still cleans the ledger (bug #8)', async () => {
    let nextPageId = 100
    const live: TabLike[] = []
    const gateway: SpaceTabGateway = {
      newTab: async (url) => {
        const pageId = nextPageId++
        live.push({ pageId, targetId: `target-${pageId}`, url })
        return pageId
      },
      closeTab: async () => {
        throw new Error('Tab not found')
      },
      listTabs: async () => [],
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const pageId = await manager.openTab('agent-a', space.id, 'https://x.example')
    await expect(manager.closeTab('agent-a', space.id, pageId)).resolves.toBeUndefined()
    expect((await manager.getSpace(space.id)).tabIds).toEqual([])
  })

  it('closeTab URL-fallback closes a renumbered live tab (bug #8)', async () => {
    let nextPageId = 100
    const live: TabLike[] = []
    const closeCalls: Array<number | string> = []
    const gateway: SpaceTabGateway = {
      newTab: async (url) => {
        const pageId = nextPageId++
        live.push({ pageId, targetId: `target-${pageId}`, url })
        return pageId
      },
      closeTab: async (target) => {
        closeCalls.push(target)
        const idx = live.findIndex(
          (t) =>
            t.pageId === target ||
            t.tabId === target ||
            t.targetId === String(target),
        )
        if (idx < 0) throw new Error('Tab not found')
        live.splice(idx, 1)
      },
      listTabs: async () => [...live],
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const ledgerPageId = await manager.openTab('agent-a', space.id, 'https://x.example')
    const livePageId = nextPageId++
    live[0].pageId = livePageId // renumber (direct-connect PageManager)

    // Pre-M2 ref (no targetId) → the stable-identity close is unavailable and
    // the pageId-then-URL fallback has to find the renumbered live tab.
    const refs = (
      manager as unknown as {
        state: { spaces: Record<string, { tabs: Array<{ targetId?: string }> }> }
      }
    ).state.spaces[space.id].tabs
    for (const ref of refs) delete ref.targetId

    await manager.closeTab('agent-a', space.id, ledgerPageId)

    expect(closeCalls).toEqual([ledgerPageId, livePageId])
    expect(live).toHaveLength(0)
    expect((await manager.getSpace(space.id)).tabIds).toEqual([])
  })

  it('restore re-opens agent-owned space tabs by URL with new page ids', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    fake.tabs.splice(0, 1) // tab disappeared (restart)
    const restored = await manager.restore()
    expect(restored).toBe(1)
    const tabs = await manager.listTabs(space.id)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe('https://a.example')
    expect(tabs[0].pageId).toBeGreaterThanOrEqual(101)
  })

  it('persists to a JSON file and reloads on a new manager instance', async () => {
    const ledger = tempLedger()
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://persist.example')
    manager.dispose()
    expect(existsSync(ledger)).toBe(true)
    const raw = JSON.parse(readFileSync(ledger, 'utf-8'))
    // SPACE_STORAGE_VERSION — v4 (P7-F dropped the tab-group projection).
    expect(raw.version).toBe(4)
    expect(raw.spaces[space.id]).toBeDefined()
    // P7-F: the projection field is gone from the persisted record.
    expect(raw.spaces[space.id]).not.toHaveProperty('tabGroupId')

    const reloaded = new TaskSpaceManager({ storagePath: ledger })
    expect((await reloaded.currentSpace('agent-a'))?.id).toBe(space.id)
    const tabs = await reloaded.listTabs(space.id)
    expect(tabs.map((t) => t.url)).toEqual(['https://persist.example'])
  })
})

describe('storage v4 — tab-group projection migration (P7-F / D-P9)', () => {
  it('a v1 ledger carrying tabGroupId loads as the current version with the field dropped', async () => {
    const ledger = tempLedger()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          s1: {
            id: 's1',
            name: 'legacy',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: 1,
            lastActiveAt: 2,
            tabs: [{ pageId: 7, url: 'https://a.example' }],
            // The dropped v1 projection field.
            tabGroupId: 'grp-1',
          },
        },
        currentSpaceByOwner: { 'agent-a': 's1' },
      }),
      'utf-8',
    )

    const manager = new TaskSpaceManager({
      storagePath: ledger,
      persist: true,
      // The fixture's timestamps are epoch-old; the D8 sweep must not eat it.
      reap: { enabled: false },
    })
    // Read side: the space survives intact, the projection field does not.
    const space = await manager.getSpace('s1')
    expect(space.id).toBe('s1')
    expect(space.tabIds).toEqual([7])
    expect(
      (space as unknown as Record<string, unknown>).tabGroupId,
    ).toBeUndefined()

    // Write side: stamped current-version with the field gone.
    manager.dispose()
    const raw = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      version: number
      spaces: Record<string, Record<string, unknown>>
      currentSpaceByOwner: Record<string, string>
    }
    expect(raw.version).toBe(4)
    expect(raw.spaces.s1.tabGroupId).toBeUndefined()
    expect(raw.spaces.s1.name).toBe('legacy')
    expect(raw.currentSpaceByOwner['agent-a']).toBe('s1')

    // Idempotent: loading the migrated file again changes nothing.
    const again = new TaskSpaceManager({
      storagePath: ledger,
      persist: true,
      reap: { enabled: false },
    })
    expect((await again.getSpace('s1')).tabIds).toEqual([7])
    again.dispose()
    const raw2 = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      version: number
      spaces: Record<string, Record<string, unknown>>
    }
    expect(raw2).toEqual(raw)
  })

  it('a current-version ledger round-trips unchanged (migration is a no-op)', async () => {
    const ledger = tempLedger()
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    manager.dispose()
    const before = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      version: number
      spaces: Record<string, Record<string, unknown>>
    }
    expect(before.version).toBe(4)
    expect(before.spaces[space.id]).not.toHaveProperty('tabGroupId')

    const reloaded = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    expect((await reloaded.getSpace(space.id)).tabIds).toHaveLength(1)
    reloaded.dispose()
    const after = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      version: number
      spaces: Record<string, Record<string, unknown>>
    }
    expect(after.version).toBe(4)
    expect(Object.keys(after.spaces)).toEqual([space.id])
    expect(after.spaces[space.id]).not.toHaveProperty('tabGroupId')
  })
})

describe('openTab URL reuse — ego openOrReuseTab semantics', () => {
  it('default exact: same URL reuses the open tab instead of opening a duplicate', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTab('agent-a', space.id, 'https://example.com')
    const second = await manager.openTab('agent-a', space.id, 'https://example.com')
    expect(second).toBe(first)
    expect(fake.opened).toEqual(['https://example.com'])
    expect((await manager.getSpace(space.id)).tabIds).toEqual([first])
  })

  it('different URL opens a new tab', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTab('agent-a', space.id, 'https://a.example')
    const second = await manager.openTab('agent-a', space.id, 'https://b.example')
    expect(second).not.toBe(first)
    expect(fake.opened).toEqual(['https://a.example', 'https://b.example'])
    expect(fake.activated).toEqual([]) // no reuse → nothing to activate
  })

  it('openTabWithReuse reports reused:false for a new tab and reused:true on a hit', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://example.com',
      {},
    )
    expect(first.reused).toBe(false)
    const second = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://example.com',
      {},
    )
    expect(second).toEqual({
      pageId: first.pageId,
      reused: true,
      // P7-A durable label + the tab's CDP targetId ride on the result too
      // (the CLI needs targetId to rebind to a tab in the space's own window).
      label: first.label,
      targetId: first.targetId,
    })
  })

  it('reuse:false forces a new tab even for the same URL', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://example.com',
      { reuse: false },
    )
    const second = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://example.com',
      { reuse: false },
    )
    expect(second.pageId).not.toBe(first.pageId)
    expect(second.reused).toBe(false)
    expect(fake.opened).toHaveLength(2)
  })

  it('exact mode normalizes hrefs (trailing slash) via sameRestoreUrl', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTab('agent-a', space.id, 'https://example.com')
    const second = await manager.openTab('agent-a', space.id, 'https://example.com/')
    expect(second).toBe(first)
    expect(fake.opened).toEqual(['https://example.com'])
  })

  it('origin mode reuses across paths but not across origins', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const a = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://a.example/x',
      { reuse: 'origin' },
    )
    const b = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://a.example/y',
      { reuse: 'origin' },
    )
    expect(b.pageId).toBe(a.pageId)
    expect(b.reused).toBe(true)
    const c = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://other.example/x',
      { reuse: 'origin' },
    )
    expect(c.pageId).not.toBe(a.pageId)
    expect(fake.opened).toEqual(['https://a.example/x', 'https://other.example/x'])
  })

  it('origin+path mode ignores query/hash but not the path', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const a = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://a.example/path?x=1',
      { reuse: 'origin+path' },
    )
    const b = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://a.example/path?x=2#frag',
      { reuse: 'origin+path' },
    )
    expect(b.pageId).toBe(a.pageId)
    expect(b.reused).toBe(true)
    const c = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://a.example/other',
      { reuse: 'origin+path' },
    )
    expect(c.pageId).not.toBe(a.pageId)
    const d = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://b.example/path',
      { reuse: 'origin+path' },
    )
    expect(d.pageId).not.toBe(a.pageId)
  })

  it('includes mode matches a URL substring', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const a = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://example.com/docs/guide',
      { reuse: 'includes' },
    )
    const b = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'example.com/docs',
      { reuse: 'includes' },
    )
    expect(b.pageId).toBe(a.pageId)
    expect(b.reused).toBe(true)
  })

  it('only reuses tabs of the same space (other spaces are invisible)', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const s1 = await manager.create('agent-a', 'one')
    const s2 = await manager.create('agent-a', 'two')
    const inS1 = await manager.openTab('agent-a', s1.id, 'https://example.com')
    const inS2 = await manager.openTab('agent-a', s2.id, 'https://example.com')
    expect(inS2).not.toBe(inS1)
    expect(fake.opened).toHaveLength(2)
    expect((await manager.getSpace(s1.id)).tabIds).toEqual([inS1])
    expect((await manager.getSpace(s2.id)).tabIds).toEqual([inS2])
  })

  it('externally-closed tabs never participate in matching', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTab('agent-a', space.id, 'https://example.com')
    // Closed in the browser behind the manager's back.
    fake.tabs.splice(
      fake.tabs.findIndex((t) => t.pageId === first),
      1,
    )
    const second = await manager.openTab('agent-a', space.id, 'https://example.com')
    expect(second).not.toBe(first)
    expect(fake.opened).toEqual(['https://example.com', 'https://example.com'])
  })

  it('a reuse hit switches to the existing tab (activate) and touches lastActiveAt', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTab('agent-a', space.id, 'https://example.com')
    const before = (await manager.getSpace(space.id)).lastActiveAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await manager.openTabWithReuse(
      'agent-a',
      space.id,
      'https://example.com',
      {},
    )
    expect(second.reused).toBe(true)
    expect(fake.activated).toEqual([first])
    const after = (await manager.getSpace(space.id)).lastActiveAt
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('activation failure is best-effort and does not fail the reuse', async () => {
    const fake = createFakeGateway()
    fake.gateway.activate = async () => {
      throw new Error('boom')
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const first = await manager.openTab('agent-a', space.id, 'https://example.com')
    const second = await manager.openTab('agent-a', space.id, 'https://example.com')
    expect(second).toBe(first)
  })
})

describe('ownership state machine (3.2)', () => {
  it('handOff: agent → agentDelegatedToUser and blocks agent operations', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const space = await manager.create('agent-a', 'work')
    await manager.handOff('agent-a', space.id)
    expect((await manager.getSpace(space.id)).ownership).toBe(
      'agentDelegatedToUser',
    )
    await expect(
      manager.openTab('agent-a', space.id, 'https://x.example'),
    ).rejects.toMatchObject({ code: 'user-controlling' })
  })

  it('takeOver without confirmation throws needs-confirmation', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const space = await manager.create('agent-a', 'work')
    await manager.handOff('agent-a', space.id)
    await expect(manager.takeOver('agent-a', space.id)).rejects.toMatchObject({
      code: 'needs-confirmation',
    })
    expect((await manager.getSpace(space.id)).ownership).toBe(
      'agentDelegatedToUser',
    )
  })

  it('confirmUserControl: agentDelegatedToUser → user; takeOver (confirmed) restores agent', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: createFakeGateway().gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.handOff('agent-a', space.id)
    const userHeld = await manager.confirmUserControl('agent-a', space.id)
    expect(userHeld.ownership).toBe('user')

    await expect(
      manager.openTab('agent-a', space.id, 'https://x.example'),
    ).rejects.toMatchObject({ code: 'user-controlling' })

    const taken = await manager.takeOver('agent-a', space.id, {
      confirmed: true,
    })
    expect(taken.ownership).toBe('agent')
    const opened = await manager.openTab('agent-a', space.id, 'https://ok.example')
    expect(typeof opened).toBe('number')
  })

  it('claimTaskSpace claims a user-held space (with confirmation) and selects it', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const s1 = await manager.create('agent-a', 'one')
    const s2 = await manager.create('agent-a', 'two')
    await manager.handOff('agent-a', s1.id)
    await manager.confirmUserControl('agent-a', s1.id)
    // Without confirmation: rejected.
    await expect(manager.claimTaskSpace('agent-a', s1.id)).rejects.toMatchObject({
      code: 'needs-confirmation',
    })
    const claimed = await manager.claimTaskSpace('agent-a', s1.id, {
      confirmed: true,
    })
    expect(claimed.ownership).toBe('agent')
    expect((await manager.currentSpace('agent-a'))?.id).toBe(s1.id)
  })

  it('closeSpace on a user-held space requires claiming first', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const space = await manager.create('agent-a', 'work')
    await manager.handOff('agent-a', space.id)
    await manager.confirmUserControl('agent-a', space.id)
    await expect(manager.closeSpace('agent-a', space.id)).rejects.toMatchObject({
      code: 'user-controlling',
    })
  })

  it('emits the space.* event sequence', async () => {
    const events: string[] = []
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      events: new SpaceEventBus(),
      persist: false,
    })
    manager.events?.on('space.created', (e) => events.push(e.type))
    manager.events?.on('space.handoff_requested', (e) => events.push(e.type))
    manager.events?.on('space.interrupted', (e) => events.push(e.type))
    manager.events?.on('space.agent_active', (e) => events.push(e.type))
    manager.events?.on('space.closed', (e) => events.push(e.type))

    const space = await manager.create('agent-a', 'work')
    await manager.handOff('agent-a', space.id)
    await manager.confirmUserControl('agent-a', space.id)
    await manager.takeOver('agent-a', space.id, { confirmed: true })
    await manager.closeSpace('agent-a', space.id, { keep: true })
    expect(events).toEqual([
      'space.created',
      'space.handoff_requested',
      'space.interrupted',
      'space.agent_active',
      'space.closed',
    ])
  })

  it('switch emits space.switched with name/owner', async () => {
    const events: Array<{ type: string; spaceId: string; name?: string }> = []
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      events: new SpaceEventBus(),
      persist: false,
    })
    manager.events?.on('space.switched', (e) =>
      events.push({ type: e.type, spaceId: e.spaceId, name: e.name }),
    )

    const first = await manager.create('agent-a', 'first')
    const second = await manager.create('agent-a', 'second')
    expect(events).toHaveLength(0)

    const switched = await manager.switch('agent-a', second.id)
    expect(switched.id).toBe(second.id)
    expect(events).toEqual([
      { type: 'space.switched', spaceId: second.id, name: 'second' },
    ])
  })

  it('useOrCreateTaskSpace reuse emits space.switched (current space changed)', async () => {
    const events: string[] = []
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      events: new SpaceEventBus(),
      persist: false,
    })
    manager.events?.on('space.switched', (e) => events.push(e.type))

    const first = await manager.useOrCreateTaskSpace('agent-a', 'work')
    // First call creates → space.created only.
    expect(events).toEqual([])
    events.length = 0

    // Reuse switches current back to the existing space.
    await manager.useOrCreateTaskSpace('agent-b', 'work')
    await manager.useOrCreateTaskSpace('agent-a', 'work')
    expect(events).toEqual(['space.switched'])
    expect((await manager.currentSpace('agent-a'))?.id).toBe(first.id)
  })
})

describe('agent-level tab isolation guard (3.3)', () => {
  it('filterTabsForAgent: agent A only sees tabs of its own space (B/user tabs invisible)', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: createFakeGateway().gateway,
      persist: false,
    })
    const aSpace = await manager.create('agent-a', 'a-work')
    const bSpace = await manager.create('agent-b', 'b-work')
    await manager.openTab('agent-a', aSpace.id, 'https://a.example')
    await manager.openTab('agent-b', bSpace.id, 'https://b.example')

    const live = [
      { pageId: 1, url: 'https://user.example', title: 'User' },
      { pageId: 100, url: 'https://a.example', title: 'A' },
      { pageId: 101, url: 'https://b.example', title: 'B' },
    ]
    const aSees = await manager.filterTabsForAgent('agent-a', live)
    expect(aSees.map((t) => t.pageId)).toEqual([100])

    const bSees = await manager.filterTabsForAgent('agent-b', live)
    expect(bSees.map((t) => t.pageId)).toEqual([101])
  })

  it('D3 no-space: an agent without any space sees an empty list and every page is rejected', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const live = [
      { pageId: 1, url: 'https://user.example' },
      { pageId: 2, url: 'https://other.example' },
    ]
    // tabs list filter → empty (no legacy open-world listing).
    expect(await manager.filterTabsForAgent('agent-x', live)).toEqual([])
    // page control → rejected with no-space.
    await expect(manager.assertPageControllable('agent-x', 1)).rejects.toMatchObject({
      code: 'no-space',
    })
    // tabs new guard → rejected with no-space too (space is the precondition).
    await expect(
      manager.assertCurrentSpaceAgentControllable('agent-x'),
    ).rejects.toMatchObject({ code: 'no-space' })
  })

  it('D3 three-phase: no space → no-space; own space, foreign page → page-not-in-space; own page → passes', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: createFakeGateway().gateway,
      persist: false,
    })
    // Phase 1: no space yet → every page rejected with no-space.
    await expect(manager.assertPageControllable('agent-a', 1)).rejects.toMatchObject({
      code: 'no-space',
    })
    await expect(manager.assertPagesControllable('agent-a', [1, 2])).rejects.toMatchObject({
      code: 'no-space',
    })

    // Phase 2: after creating a space, a page outside the agent's space is
    // rejected with page-not-in-space (guard keeps working as before).
    const aSpace = await manager.create('agent-a', 'a-work')
    const bSpace = await manager.create('agent-b', 'b-work')
    const aTab = await manager.openTab('agent-a', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('agent-b', bSpace.id, 'https://b.example')
    await expect(manager.assertPageControllable('agent-a', bTab)).rejects.toMatchObject({
      code: 'page-not-in-space',
      pageId: bTab,
    })

    // Phase 3: the agent's own page passes.
    await expect(manager.assertPageControllable('agent-a', aTab)).resolves.toBeUndefined()
    // tabs new guard passes when the agent has an agent-controlled current space.
    await expect(
      manager.assertCurrentSpaceAgentControllable('agent-a'),
    ).resolves.toBeUndefined()
  })

  it('assertPageControllable rejects pages outside the agent\u2019s space', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: createFakeGateway().gateway,
      persist: false,
    })
    const aSpace = await manager.create('agent-a', 'a-work')
    const bSpace = await manager.create('agent-b', 'b-work')
    const aTab = await manager.openTab('agent-a', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('agent-b', bSpace.id, 'https://b.example')

    await expect(manager.assertPageControllable('agent-a', aTab)).resolves.toBeUndefined()
    await expect(manager.assertPageControllable('agent-a', bTab)).rejects.toMatchObject({
      code: 'page-not-in-space',
      pageId: bTab,
    })
    let caught: SpaceGuardError | undefined
    try {
      await manager.assertPageControllable('agent-a', bTab)
    } catch (e) {
      caught = e as SpaceGuardError
    }
    expect(caught?.message).toContain('is not in your space')
  })

  it('assertPageControllable rejects while the owning space is user-held', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: createFakeGateway().gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const tab = await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.handOff('agent-a', space.id)
    await manager.confirmUserControl('agent-a', space.id)
    await expect(manager.assertPageControllable('agent-a', tab)).rejects.toMatchObject({
      code: 'user-controlling',
    })
  })

  it('recordTabForCurrentSpace attributes a fresh tab to the current space', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger(), persist: false })
    const space = await manager.create('agent-a', 'work')
    const ok = await manager.recordTabForCurrentSpace(
      'agent-a',
      42,
      'about:blank',
    )
    expect(ok).toBe(true)
    expect((await manager.getSpace(space.id)).tabIds).toEqual([42])
  })

})

describe('restore idempotency — Phase 3 A (auto-restore at daemon/MCP start)', () => {
  it('restore is idempotent within one process: a second call never duplicates tabs', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    // Tab still live: first restore re-attaches the pending ref (no new tab).
    expect(await manager.restore()).toBe(1)
    const tabCount = fake.tabs.length
    // Second restore: everything is already restored → nothing to do.
    expect(await manager.restore()).toBe(0)
    expect(fake.tabs.length).toBe(tabCount)
    expect(fake.opened.length).toBe(1) // only the original openTab, no duplicates
  })

  it('restore across a "restart" re-attaches still-open tabs by URL and never opens duplicates', async () => {
    const ledger = tempLedger()
    const fake = createFakeGateway()
    const manager1 = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    const space = await manager1.create('agent-a', 'work')
    await manager1.openTab('agent-a', space.id, 'https://a.example')
    await manager1.openTab('agent-a', space.id, 'https://b.example')
    manager1.dispose()

    // New daemon process → new connection → PageManager reassigns pageIds by
    // tab order, and the user may have other tabs open.
    const fake2 = createFakeGateway()
    fake2.tabs.push(
      { pageId: 1, targetId: 'user-target', url: 'https://user.example', title: 'User' },
      { pageId: 101, targetId: 't101', url: 'https://a.example', title: 'A' },
      { pageId: 102, targetId: 't102', url: 'https://b.example', title: 'B' },
    )
    const manager2 = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake2.gateway,
      persist: false,
    })
    const restored = await manager2.restore()
    expect(restored).toBe(2) // both pending refs reconciled
    expect(fake2.opened).toEqual([]) // no duplicate opens
    const tabs = await manager2.listTabs(space.id)
    expect(tabs.map((t) => t.pageId).sort()).toEqual([101, 102])
    expect(tabs.map((t) => t.url).sort()).toEqual([
      'https://a.example',
      'https://b.example',
    ])
    // The user tab is untouched by restore.
    expect(fake2.tabs.find((t) => t.pageId === 1)?.url).toBe('https://user.example')
  })

  it('tabs added after a restore are pending and reconciled exactly once on the next restore', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.restore() // a.example now restored
    const cPage = await manager.openTab('agent-a', space.id, 'https://c.example') // pending
    // Simulate restart: a.example still open, c.example closed in Chrome.
    fake.tabs.splice(
      fake.tabs.findIndex((t) => t.pageId === cPage),
      1,
    )
    expect(await manager.restore()).toBe(1) // only c.example re-opened
    const tabs = await manager.listTabs(space.id)
    expect(tabs.map((t) => t.url).sort()).toEqual([
      'https://a.example',
      'https://c.example',
    ])
    expect(fake.tabs.filter((t) => t.url === 'https://a.example')).toHaveLength(1)
  })

  it('restore persists restored markers so a fresh manager skips re-restoring live tabs', async () => {
    const ledger = tempLedger()
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.restore()
    manager.dispose()

    const raw = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(raw.spaces[space.id].restoredAt).toBeGreaterThan(0)
    expect(raw.spaces[space.id].tabs[0].restored).toBe(true)

    // Brand-new manager (fresh daemon process) with the same live tabs: restore
    // must not open a duplicate tab.
    const fake2 = createFakeGateway()
    fake2.tabs.push(...fake.tabs.map((t) => ({ ...t })))
    const manager2 = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake2.gateway,
      persist: false,
    })
    expect(await manager2.restore()).toBe(0)
    expect(fake2.opened).toEqual([])
    expect((await manager2.listTabs(space.id)).map((t) => t.url)).toEqual([
      'https://a.example',
    ])
  })
})

describe('F16 — restore zombie-renderer health gate', () => {
  it('a tab whose probe fails is never adopted: the ref re-opens by URL instead', async () => {
    const fake = createFakeGateway()
    const probeCalls: number[] = []
    fake.gateway.probeTab = async (target) => {
      probeCalls.push(typeof target === 'number' ? target : Number(target))
      return false // every live tab is a zombie
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    const zombiePageId = fake.tabs[0].pageId

    expect(await manager.restore()).toBe(1) // re-opened, not re-attached
    const tabs = await manager.listTabs(space.id)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].pageId).not.toBe(zombiePageId) // points at the fresh tab
    // The zombie itself is left alone (never closed by restore)…
    expect(fake.tabs.some((t) => t.pageId === zombiePageId)).toBe(true)
    // …and the fresh duplicate is the recovery path.
    expect(fake.opened).toEqual(['https://a.example', 'https://a.example'])
  })

  it('a healthy tab is adopted normally when the probe answers true', async () => {
    const fake = createFakeGateway()
    fake.gateway.probeTab = async () => true
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    expect(await manager.restore()).toBe(1) // re-attached the live tab
    expect(fake.opened).toEqual(['https://a.example']) // no duplicate open
    expect((await manager.listTabs(space.id)).map((t) => t.url)).toEqual([
      'https://a.example',
    ])
  })

  it('the probe runs at most once per tab across match strategies', async () => {
    const fake = createFakeGateway()
    const probeCalls: number[] = []
    fake.gateway.probeTab = async (target) => {
      probeCalls.push(typeof target === 'number' ? target : Number(target))
      return false
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.restore()
    // The same zombie is considered by targetId, pageId and url strategies —
    // the cache must collapse that to one probe.
    expect(probeCalls).toHaveLength(1)
  })

  it('a tab that is still loading skips the probe entirely (busy ≠ dead)', async () => {
    const fake = createFakeGateway()
    let probed = 0
    fake.gateway.probeTab = async () => {
      probed++
      return false // would wrongly reject — but must not be consulted
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    fake.tabs[0].isLoading = true
    expect(await manager.restore()).toBe(1) // adopted by targetId
    expect(probed).toBe(0)
    expect(fake.opened).toEqual(['https://a.example']) // no duplicate
  })

  it('a previously-restored tab that turns zombie is pruned from the ledger', async () => {
    const fake = createFakeGateway()
    let healthy = true
    fake.gateway.probeTab = async () => healthy
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://a.example')
    await manager.restore() // adopted while healthy

    healthy = false // renderer hangs later
    await manager.restore() // zombie: not adoptable → restored-ref pruned
    expect(await manager.listTabs(space.id)).toEqual([])
    // The tab still exists in the browser — restore never destroys tabs.
    expect(fake.tabs.some((t) => t.url === 'https://a.example')).toBe(true)
  })
})

describe('recycleSpaceTabs — TabFreshness 整组回收原语', () => {
  it('closes every tab and reopens each URL with a new pageId, preserving URLs and the space record', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work', 'task-1')
    const t1 = await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/', {
      background: true,
    })
    const t2 = await manager.openTabWithReuse('agent-a', space.id, 'https://example.org/', {
      background: true,
    })
    expect(fake.tabs).toHaveLength(2)

    const events: string[] = []
    manager.events?.on('space.tabs_recycled', (e) =>
      events.push(`${e.type}:${e.spaceId}:${e.urls}`),
    )

    const result = await manager.recycleSpaceTabs('agent-a', space.id)

    expect(result.recycled).toBe(2)
    expect(result.failed).toBeUndefined()
    expect(result.tabs.map((t) => t.url)).toEqual([
      'https://example.com/',
      'https://example.org/',
    ])
    // Old tabs closed in the browser, fresh ones opened (new pageIds).
    expect(fake.closed).toEqual([t1.pageId, t2.pageId])
    expect(result.tabs[0].newPageId).not.toBe(t1.pageId)
    expect(result.tabs[1].newPageId).not.toBe(t2.pageId)
    expect(result.tabs.every((t) => t.reused === false)).toBe(true)
    expect(fake.tabs).toHaveLength(2)

    // Ledger updated to the new pageIds with the same URLs.
    const ledger = await manager.listTabs(space.id)
    expect(ledger.map((t) => t.url)).toEqual([
      'https://example.com/',
      'https://example.org/',
    ])
    expect(ledger.map((t) => t.pageId)).toEqual(
      result.tabs.map((t) => t.newPageId),
    )
    expect(ledger.map((t) => t.pageId)).not.toContain(t1.pageId)

    // Space record itself is preserved (id/name/taskId/owner/ownership).
    const info = await manager.getSpace(space.id)
    expect(info.id).toBe(space.id)
    expect(info.name).toBe('work')
    expect(info.taskId).toBe('task-1')
    expect(info.owner).toBe('agent-a')
    expect(info.ownership).toBe('agent')

    expect(events).toEqual([`space.tabs_recycled:${space.id}:2`])
  })

  it('preserves the tab count when the same URL appears twice (duplicates force fresh tabs)', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'dup')
    await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/', {
      reuse: false,
    })
    await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/', {
      reuse: false,
    })
    expect(fake.tabs).toHaveLength(2)

    const result = await manager.recycleSpaceTabs('agent-a', space.id)
    expect(result.recycled).toBe(2)
    expect(result.tabs[0].newPageId).not.toBe(result.tabs[1].newPageId)
    expect(fake.tabs).toHaveLength(2)
    expect((await manager.listTabs(space.id)).map((t) => t.url)).toEqual([
      'https://example.com/',
      'https://example.com/',
    ])
  })

  it('a failed close is reused by the exact-mode reopen instead of duplicated', async () => {
    const fake = createFakeGateway()
    const stub = fake.gateway
    const originalClose = stub.closeTab
    stub.closeTab = async (target) => {
      // First close fails (browser hiccup); the second succeeds.
      if (fake.closed.length === 0) {
        fake.closed.push(999) // mark a failed attempt without removing the tab
        throw new Error('close failed')
      }
      return originalClose(target)
    }
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: stub,
      persist: false,
    })
    const space = await manager.create('agent-a', 'flaky')
    const t1 = await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/', {
      background: true,
    })
    const result = await manager.recycleSpaceTabs('agent-a', space.id)
    expect(result.recycled).toBe(1)
    // The old tab survived the failed close and was reused (no duplicate).
    expect(result.tabs[0].newPageId).toBe(t1.pageId)
    expect(result.tabs[0].reused).toBe(true)
    expect(fake.tabs).toHaveLength(1)
  })

  it('rejects a non-owner', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await expect(
      manager.recycleSpaceTabs('agent-b', space.id),
    ).rejects.toMatchObject({ code: 'not-space-owner' })
  })

  it('rejects a user-held space', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.handOff('agent-a', space.id)
    await manager.confirmUserControl('agent-a', space.id)
    await expect(
      manager.recycleSpaceTabs('agent-a', space.id),
    ).rejects.toMatchObject({ code: 'user-controlling' })
  })

  it('throws no-gateway when no browser gateway is configured', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await expect(
      manager.recycleSpaceTabs('agent-a', space.id),
    ).rejects.toMatchObject({ code: 'no-gateway' })
  })

  it('recycle resets per-tab health telemetry for the fresh tabs', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const t1 = await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/')
    expect(manager.tabHealthFor(t1.pageId)?.ops).toBe(1)

    await manager.recycleSpaceTabs('agent-a', space.id)
    // Old tab stats cleared, fresh tab recorded with 1 op (the reopen).
    expect(manager.tabHealthFor(t1.pageId)).toBeUndefined()
    const tabs = await manager.listTabs(space.id)
    expect(tabs[0].ops).toBe(1)
    expect(typeof tabs[0].ageMs).toBe('number')
  })
})

describe('TabFreshness health telemetry — in-memory ops/ageMs', () => {
  it('openTabWithReuse records +1 per open and per reuse hit; closeTab clears', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const { pageId } = await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/')
    expect(manager.tabHealthFor(pageId)?.ops).toBe(1)
    let tabs = await manager.listTabs(space.id)
    expect(tabs[0].ops).toBe(1)
    expect(typeof tabs[0].ageMs).toBe('number')

    // Same-URL reuse hit → +1.
    await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/')
    expect(manager.tabHealthFor(pageId)?.ops).toBe(2)
    tabs = await manager.listTabs(space.id)
    expect(tabs[0].ops).toBe(2)

    // closeTab clears the stats.
    await manager.closeTab('agent-a', space.id, pageId)
    expect(manager.tabHealthFor(pageId)).toBeUndefined()
    tabs = await manager.listTabs(space.id)
    expect(tabs).toHaveLength(0)
  })

  it('telemetry is not persisted to the ledger file', async () => {
    const ledger = tempLedger()
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTabWithReuse('agent-a', space.id, 'https://example.com/')
    manager.dispose()

    const raw = JSON.parse(readFileSync(ledger, 'utf-8'))
    const tab = raw.spaces[space.id].tabs[0]
    expect(tab).not.toHaveProperty('ops')
    expect(tab).not.toHaveProperty('ageMs')
    // targetId (stable tab anchor, pageId-drift fix), label/openedBy (P7-A) and
    // tabId (M2 browser SessionID anchor) are legal persisted fields; ops/ageMs
    // telemetry must still never persist.
    expect(Object.keys(tab).sort()).toEqual([
      'label',
      'openedBy',
      'pageId',
      'restored',
      'tabId',
      'targetId',
      'url',
    ])
  })
})

describe('方案 C — user-data root + legacy ledger migration', () => {
  const ORIG = process.env.BROWSEROS_DIR

  afterEach(() => {
    if (ORIG === undefined) delete process.env.BROWSEROS_DIR
    else process.env.BROWSEROS_DIR = ORIG
  })

  it('defaultStoragePath resolves to ~/.hub/state/hub-spaces.json without BROWSEROS_DIR', () => {
    delete process.env.BROWSEROS_DIR
    expect(defaultStoragePath()).toBe(
      join(homedir(), '.hub', 'state', 'hub-spaces.json'),
    )
  })

  it('defaultStoragePath honors a BROWSEROS_DIR override', () => {
    process.env.BROWSEROS_DIR = '/tmp/custom-root'
    expect(defaultStoragePath()).toBe(
      join('/tmp/custom-root', 'state', 'hub-spaces.json'),
    )
  })

  it('defaultStoragePath ignores empty/whitespace BROWSEROS_DIR and falls back to ~/.hub', () => {
    process.env.BROWSEROS_DIR = '   '
    expect(defaultStoragePath()).toBe(
      join(homedir(), '.hub', 'state', 'hub-spaces.json'),
    )
  })

  it('migrateLegacyLedger folds the legacy ledger into the new path and keeps the old file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-migrate-'))
    const legacy = join(dir, 'old', 'hub-spaces.json')
    const target = join(dir, 'new', 'state', 'hub-spaces.json')
    mkdirSync(join(dir, 'old'), { recursive: true })
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        spaces: {
          s1: {
            id: 's1',
            name: '旧空间',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: 1,
            lastActiveAt: 2,
            tabs: [],
          },
          s2: {
            id: 's2',
            name: '已删除',
            owner: 'agent-b',
            ownership: 'agent',
            createdAt: 1,
            lastActiveAt: 2,
            tabs: [],
          },
        },
        currentSpaceByOwner: { 'agent-a': 's1' },
        deletedSpaces: ['s2'],
      }),
      'utf-8',
    )

    const migrated = migrateLegacyLedger(target, legacy)
    expect(migrated).toBe(true)
    // New ledger exists with legacy content merged (deleted space filtered).
    expect(existsSync(target)).toBe(true)
    const raw = JSON.parse(readFileSync(target, 'utf-8'))
    expect(raw.spaces).toHaveProperty('s1')
    expect(raw.spaces).not.toHaveProperty('s2')
    expect(raw.currentSpaceByOwner['agent-a']).toBe('s1')
    // v4 (M5) drops `deletedSpaces`: the ids it named are applied on read, so
    // `s2` is gone from `spaces` and the tombstone list itself is not written.
    expect(raw.deletedSpaces).toBeUndefined()
    // Legacy file preserved — never deleted.
    expect(existsSync(legacy)).toBe(true)
  })

  it('migrateLegacyLedger is a no-op when the legacy ledger is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-migrate-'))
    const target = join(dir, 'state', 'hub-spaces.json')
    const missingLegacy = join(dir, 'no-such', 'hub-spaces.json')
    expect(migrateLegacyLedger(target, missingLegacy)).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  it('migrateLegacyLedger is a no-op when the new ledger already exists (never overwrites)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-migrate-'))
    const legacy = join(dir, 'hub-spaces.json')
    const target = join(dir, 'new', 'hub-spaces.json')
    mkdirSync(join(dir, 'old'), { recursive: true })
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      legacy,
      JSON.stringify({ version: 1, spaces: { old: {} }, deletedSpaces: [] }),
      'utf-8',
    )
    writeFileSync(target, '{"version":1,"spaces":{"fresh":{"id":"fresh"}},"deletedSpaces":[]}', 'utf-8')

    expect(migrateLegacyLedger(target, legacy)).toBe(false)
    const raw = JSON.parse(readFileSync(target, 'utf-8'))
    // Existing new content untouched.
    expect(raw.spaces).toHaveProperty('fresh')
    expect(raw.spaces).not.toHaveProperty('old')
  })

  it('TaskSpaceManager does not auto-migrate when an explicit (temp) storagePath is used', async () => {
    // Explicit temp storagePath opts out of the default-path migration — the
    // ledger must never be polluted with legacy content (neither a fake legacy
    // fixture here nor the real ~/.opencli ledger that may exist on this machine).
    const dir = mkdtempSync(join(tmpdir(), 'hub-migrate-'))
    const temp = join(dir, 'ledger.json')
    const fakeLegacy = join(dir, 'legacy', 'hub-spaces.json')
    mkdirSync(join(dir, 'legacy'), { recursive: true })
    writeFileSync(fakeLegacy, '{"version":1,"spaces":{"legacy-site":{"id":"legacy-site"}},"deletedSpaces":[]}', 'utf-8')
    const manager = new TaskSpaceManager({ storagePath: temp, persist: true })
    const space = await manager.create('agent-a', 'work')
    manager.dispose()
    const raw = JSON.parse(readFileSync(temp, 'utf-8'))
    // Only the space created in this test — legacy content was never folded in.
    expect(Object.keys(raw.spaces)).toEqual([space.id])
    expect(raw.spaces).not.toHaveProperty('legacy-site')
  })
})

describe('updateTabUrl — ledger URL sync after in-browser navigation (bug #7)', () => {
  it('updates the matching tab url (+ lastActiveAt) and returns true', async () => {
    const ledger = tempLedger()
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake.gateway,
      persist: true,
    })
    const space = await manager.create('agent-a', 'work')
    const pageId = await manager.openTab('agent-a', space.id, 'https://old.example')
    // Simulate the browser actually navigating the tab (adapter command path):
    // live tab URL moves, then the ledger is synced to match.
    fake.tabs[0].url = 'https://zhihu.com/hot'
    const updated = await manager.updateTabUrl(
      'agent-a',
      space.id,
      pageId,
      'https://zhihu.com/hot',
    )
    expect(updated).toBe(true)
    // Live list and persisted ledger now agree on the new URL.
    const tabs = await manager.listTabs(space.id)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].pageId).toBe(pageId)
    expect(tabs[0].url).toBe('https://zhihu.com/hot')
    const raw = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(raw.spaces[space.id].tabs[0].url).toBe('https://zhihu.com/hot')
    // lastActiveAt moved forward (wait for the clock to advance).
    const before = (await manager.getSpace(space.id)).lastActiveAt
    await new Promise((r) => setTimeout(r, 2))
    await manager.updateTabUrl('agent-a', space.id, pageId, 'https://zhihu.com/hot#x')
    const after = (await manager.getSpace(space.id)).lastActiveAt
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('is idempotent — repeated updates keep exactly one tab and never duplicate', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const pageId = await manager.openTab('agent-a', space.id, 'https://old.example')
    fake.tabs[0].url = 'https://zhihu.com/hot'
    await manager.updateTabUrl('agent-a', space.id, pageId, 'https://zhihu.com/hot')
    const second = await manager.updateTabUrl(
      'agent-a',
      space.id,
      pageId,
      'https://zhihu.com/hot',
    )
    expect(second).toBe(true)
    const tabs = await manager.listTabs(space.id)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe('https://zhihu.com/hot')
  })

  it('no-op returns false when the pageId matches no tab (never creates one)', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    await manager.openTab('agent-a', space.id, 'https://old.example')
    const updated = await manager.updateTabUrl(
      'agent-a',
      space.id,
      999999,
      'https://zhihu.com/hot',
    )
    expect(updated).toBe(false)
    const tabs = await manager.listTabs(space.id)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe('https://old.example')
  })

  it('no-op returns false for a missing or foreign-owned space (never throws)', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'work')
    const pageId = await manager.openTab('agent-a', space.id, 'https://old.example')
    expect(
      await manager.updateTabUrl('agent-a', 'no-such-space', pageId, 'https://x.example'),
    ).toBe(false)
    expect(
      await manager.updateTabUrl('agent-b', space.id, pageId, 'https://x.example'),
    ).toBe(false)
    const tabs = await manager.listTabs(space.id)
    expect(tabs[0].url).toBe('https://old.example')
  })
})

describe('mergeWithDisk — currentSpaceByOwner residue (bug #10)', () => {
  it('close then merge never resurrects a pointer to the deleted space', async () => {
    const ledger = tempLedger()
    // Process A: creates s1, persists current = s1 on disk.
    const a = new TaskSpaceManager({ storagePath: ledger, persist: true })
    const s1 = await a.create('agent-a', 'one')
    a.dispose()
    const rawA = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(rawA.currentSpaceByOwner['agent-a']).toBe(s1.id)

    // Process B: loads disk (s1 + stale pointer), closes s1. Its in-memory
    // pointer is removed, but disk still holds the stale id — merge-on-save
    // must filter it, not resurrect it.
    const b = new TaskSpaceManager({ storagePath: ledger, persist: true })
    await b.closeSpace('agent-a', s1.id, { keep: true })
    b.dispose()

    const rawB = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(rawB.spaces[s1.id]).toBeUndefined()
    expect(rawB.currentSpaceByOwner['agent-a']).toBeUndefined()
    // v4 (M5) no longer writes a tombstone list; the space is simply absent.
    expect(rawB.deletedSpaces).toBeUndefined()
  })

  it('merge keeps live pointers (space still exists) and drops only stale ones', async () => {
    const ledger = tempLedger()
    // Disk state: s1 (agent-a) + s2 (agent-b), both referenced as current.
    const a = new TaskSpaceManager({ storagePath: ledger, persist: true })
    const s1 = await a.create('agent-a', 'one')
    const s2 = await a.create('agent-b', 'two')
    a.dispose()

    // Process B knows only agent-a: it closes s1, then a merge must keep
    // agent-b's disk pointer (unseen space survives) while dropping agent-a's
    // now-stale pointer to the deleted s1.
    const b = new TaskSpaceManager({ storagePath: ledger, persist: true })
    await b.closeSpace('agent-a', s1.id, { keep: true })
    b.dispose()

    const raw = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(raw.spaces[s2.id]).toBeDefined()
    expect(raw.spaces[s1.id]).toBeUndefined()
    expect(raw.currentSpaceByOwner['agent-b']).toBe(s2.id)
    expect(raw.currentSpaceByOwner['agent-a']).toBeUndefined()
  })
})

// ─── P1-6: space invariants (固化) ─────────────────────────────────
// A page belongs to at most one space; a space never lists a page twice;
// closed spaces never revive. These hold across every ownership-changing
// path: open/close/handoff/takeover/restore/reconcile/recordTab.

interface InvariantSpace {
  id: string
  tabs: Array<{ pageId: number }>
}

function assertOwnershipInvariants(manager: TaskSpaceManager): void {
  const spaces = Object.values(
    (manager as unknown as { state: { spaces: Record<string, InvariantSpace> } }).state.spaces,
  )
  const ownerOfPage = new Map<number, string>()
  for (const space of spaces) {
    const seenInSpace = new Set<number>()
    for (const tab of space.tabs) {
      expect(
        seenInSpace.has(tab.pageId),
        `space ${space.id} lists page ${tab.pageId} twice`,
      ).toBe(false)
      seenInSpace.add(tab.pageId)
      expect(
        ownerOfPage.has(tab.pageId),
        `page ${tab.pageId} belongs to both space ${ownerOfPage.get(tab.pageId)} and ${space.id}`,
      ).toBe(false)
      ownerOfPage.set(tab.pageId, space.id)
    }
  }
}

describe('P1-6 space invariants', () => {
  it('unique page ownership holds across the standard lifecycle', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const aSpace = await manager.create('agent-a', 'a-work')
    const bSpace = await manager.create('agent-b', 'b-work')
    await manager.openTab('agent-a', aSpace.id, 'https://a.example')
    await manager.openTab('agent-b', bSpace.id, 'https://b.example')
    await manager.openTab('agent-a', aSpace.id, 'https://a2.example')
    await manager.closeTab('agent-a', aSpace.id, (await manager.listTabs(aSpace.id))[0].pageId)
    await manager.handOff('agent-a', aSpace.id)
    await manager.takeOver('agent-a', aSpace.id, { confirmed: true })
    await manager.restore()
    assertOwnershipInvariants(manager)
  })

  it('another space\'s tab is never adopted implicitly — only transferTab moves ownership', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const aSpace = await manager.create('agent-a', 'a-work')
    const bSpace = await manager.create('agent-b', 'b-work')
    const aTab = await manager.openTab('agent-a', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('agent-b', bSpace.id, 'https://b.example')

    // P7-F / D-P9: nothing observes tab-group membership any more, so no
    // reconcile pass can move a tab between ledgers — the reads below are
    // pure and must leave both ledgers exactly as they were.
    await manager.currentSpace('agent-a')
    await manager.listSpaces('agent-a')
    await manager.assertPageControllable('agent-b', bTab)
    assertOwnershipInvariants(manager)
    expect((await manager.listTabs(aSpace.id)).map((t) => t.pageId)).not.toContain(bTab)
    expect((await manager.listTabs(bSpace.id)).map((t) => t.pageId)).toContain(bTab)

    // Cross-owner transferTab is tab theft — refused (escalate instead).
    await expect(
      manager.transferTab('agent-a', { pageId: bTab, toSpaceId: aSpace.id }),
    ).rejects.toThrow(SpaceGuardError)

    // Same-owner transfer (agent-b moves its own tab between its spaces) works.
    const bSpace2 = await manager.create('agent-b', 'b-work-2')
    const res = await manager.transferTab('agent-b', {
      pageId: bTab,
      toSpaceId: bSpace2.id,
    })
    expect(res.fromSpaceId).toBe(bSpace.id)
    expect(res.toSpaceId).toBe(bSpace2.id)
    assertOwnershipInvariants(manager)
    expect((await manager.listTabs(bSpace.id)).map((t) => t.pageId)).not.toContain(bTab)
    expect((await manager.listTabs(bSpace2.id)).map((t) => t.pageId)).toContain(bTab)
    expect((await manager.listTabs(aSpace.id)).map((t) => t.pageId)).toContain(aTab)
  })

  it('recordTabForCurrentSpace refuses a tab that already belongs to another space', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const aSpace = await manager.create('agent-a', 'a-work')
    const bSpace = await manager.create('agent-b', 'b-work')
    const bTab = await manager.openTab('agent-b', bSpace.id, 'https://b.example')
    void aSpace

    // agent-a tries to attribute agent-b's tab to its own current space.
    const ok = await manager.recordTabForCurrentSpace('agent-a', bTab, 'https://b.example')
    expect(ok).toBe(false)
    assertOwnershipInvariants(manager)
    expect((await manager.listTabs(bSpace.id)).map((t) => t.pageId)).toContain(bTab)

    // Recording an unowned tab still works.
    const fresh = 901
    fake.tabs.push({ pageId: fresh, targetId: 'target-901', url: 'https://fresh.example' })
    const ok2 = await manager.recordTabForCurrentSpace('agent-a', fresh, 'https://fresh.example')
    expect(ok2).toBe(true)
    assertOwnershipInvariants(manager)
  })

  it('closed spaces never revive (useOrCreate opens a fresh space)', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      persist: false,
    })
    const first = await manager.create('agent-a', 'recurring-work')
    // keep:true closes the ledger only (no gateway needed in this test).
    await manager.closeSpace('agent-a', first.id, { keep: true })
    const second = await manager.useOrCreateTaskSpace('agent-a', 'recurring-work')
    expect(second.id).not.toBe(first.id)
    const ids = Object.keys(
      (manager as unknown as { state: { spaces: Record<string, unknown> } }).state.spaces,
    )
    expect(ids).not.toContain(first.id)
    expect(ids).toContain(second.id)
  })
})


// P1-7 方向 B: transferTab — the ONLY ledger ownership-transfer path.
describe('transferTab (explicit ownership transfer)', () => {
  it('claims an unowned tab into the current space', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'claim-work')
    await manager.openTab('agent-a', space.id, 'https://a.example')

    // A human tab (unowned) exists in the browser.
    const human = 400
    fake.tabs.push({
      pageId: human,
      targetId: 'target-400',
      tabId: 1400,
      url: 'https://human.example',
      title: undefined,
    })

    const res = await manager.transferTab('agent-a', { pageId: human })
    expect(res.fromSpaceId).toBeNull()
    expect(res.toSpaceId).toBe(space.id)
    expect((await manager.listTabs(space.id)).map((t) => t.pageId)).toContain(human)
    // The live tab's stable identity + url were picked up from the gateway
    // (no group projection any more — the ledger entry is the whole effect).
    expect(
      (await manager.listTabs(space.id)).find((t) => t.pageId === human)?.targetId,
    ).toBe('target-400')
  })

  it('no current space → no-space guard rejection (create first)', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    await expect(
      manager.transferTab('agent-a', { pageId: 1 }),
    ).rejects.toThrow(SpaceGuardError)
  })

  it('idempotent: transferring a tab already in the target space is a no-op', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create('agent-a', 'idem-work')
    const p1 = await manager.openTab('agent-a', space.id, 'https://a.example')
    const res = await manager.transferTab('agent-a', { pageId: p1, toSpaceId: space.id })
    expect(res.fromSpaceId).toBeNull()
    expect(res.toSpaceId).toBe(space.id)
    expect((await manager.listTabs(space.id)).map((t) => t.pageId)).toEqual([p1])
  })
})
