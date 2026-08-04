/**
 * D8 — legacy-space auto-reap (unified TTL scheme).
 *
 * Tier 1: empty space (tabs.length === 0) idle past emptyTtl (default 24h)
 *   → ledger eviction at construction / explicit reapExpiredSpaces().
 * Tier 2: agent-owned space idle past spaceTtl (default 7d), any tab count
 *   → ledger eviction + best-effort tab/group close.
 * user-held spaces are never reaped; missing lastActiveAt is skipped.
 *
 * Covers: constructor load-time sweep, explicit reapExpiredSpaces(), env/opt
 * off-switch, pointer/tombstone/disk sync, write-only-on-eviction, restore()
 * no longer refreshing lastActiveAt, and fire-and-forget tab/group close.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskSpaceManager,
  type SpaceTabGateway,
  type TabLike,
} from '../src/space/task-space-manager.ts'

const DAY = 24 * 60 * 60 * 1000
const now = (): number => Date.now()

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'hub-reap-')), 'hub-spaces.json')
}

/** Minimal gateway with optional close/tabGroupClose spies. */
function createReapGateway(opts?: {
  closed?: number[]
  closedGroups?: string[]
  closeThrowsFor?: Set<number>
  tabGroupCloseThrows?: boolean
}): SpaceTabGateway {
  const closed = opts?.closed ?? []
  const closedGroups = opts?.closedGroups ?? []
  return {
    newTab: async () => 1,
    listTabs: async () => [] as TabLike[],
    closeTab: async (target) => {
      const id = Number(target)
      closed.push(id)
      if (opts?.closeThrowsFor?.has(id)) throw new Error(`close failed for ${id}`)
    },
    tabGroupList: async () => [],
    tabGroupCreate: async () => ({ groupId: 'g-1', tabIds: [], title: '' }),
    tabGroupAddTabs: async () => {},
    tabGroupUpdate: async () => ({}),
    tabGroupClose: async (groupId) => {
      closedGroups.push(groupId)
      if (opts?.tabGroupCloseThrows) throw new Error('group close failed')
    },
  }
}

describe('D8 legacy-space auto-reap — Tier 1 (empty spaces, emptyTtl)', () => {
  it('evicts an empty space idle past emptyTtl at construction; keeps a fresh one', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          old1: {
            id: 'old1',
            name: 'stale empty',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 2 * DAY, // > 24h
            tabs: [],
          },
          fresh1: {
            id: 'fresh1',
            name: 'fresh empty',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 1000,
            lastActiveAt: t - 1000, // < 24h
            tabs: [],
          },
        },
        currentSpaceByOwner: { 'agent-a': 'old1' },
      }),
    )

    const logs: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '))
    let manager: TaskSpaceManager
    try {
      manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
    } finally {
      console.log = origLog
    }

    // `space list` (manager.listSpaces) must not show the reaped space.
    const spaces = await manager.listSpaces('agent-a')
    expect(spaces.map((s) => s.id)).toEqual(['fresh1'])
    expect(
      logs.some((l) =>
        /\[hub-spaces\] reaped space old1 "stale empty" \(tier 1, age \d+ms, owner agent-a, tabs 0\)/.test(
          l,
        ),
      ),
    ).toBe(true)
  })

  it('evicts an empty space once it crosses a custom emptyTtlMs', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          aged: {
            id: 'aged',
            name: 'aged empty',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - DAY,
            lastActiveAt: t - 5000,
            tabs: [],
          },
        },
      }),
    )
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      persist: false,
      reap: { emptyTtlMs: 1000 }, // 5s old > 1s ttl → evicted
    })
    expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
  })
})

describe('D8 legacy-space auto-reap — Tier 2 (idle agent spaces, spaceTtl)', () => {
  it('evicts an agent space with tabs idle past spaceTtl; user-held exempt; missing lastActiveAt skipped', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          staleAgent: {
            id: 'staleAgent',
            name: 'stale agent',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 8 * DAY, // > 7d
            tabs: [{ pageId: 101, url: 'https://a.example' }],
          },
          noStamp: {
            id: 'noStamp',
            name: 'no stamp',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            // lastActiveAt intentionally missing (legacy data)
            tabs: [{ pageId: 103, url: 'https://c.example' }],
          },
          freshAgent: {
            id: 'freshAgent',
            name: 'fresh agent',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 1000,
            lastActiveAt: t - 1000,
            tabs: [{ pageId: 104, url: 'https://d.example' }],
          },
          userHeld: {
            id: 'userHeld',
            name: 'user held',
            owner: 'user-1',
            ownership: 'user',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 30 * DAY, // very old, but user-held → never reaped
            tabs: [{ pageId: 105, url: 'https://e.example' }],
          },
        },
        currentSpaceByOwner: { 'agent-a': 'staleAgent', 'user-1': 'userHeld' },
      }),
    )

    // persist:true so the sweep's ledger eviction lands on disk — the raw
    // ledger is the only place we can observe `noStamp` (missing lastActiveAt
    // survives reap, but the public SpaceInfo serializer toInfo() requires a
    // valid date, so listSpaces() would throw on such a legacy record).
    const manager = new TaskSpaceManager({ storagePath: ledger, persist: true })
    // staleAgent reaped; noStamp (missing lastActiveAt) + freshAgent kept.
    const raw = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, unknown>
      deletedSpaces?: string[]
    }
    expect(raw.spaces.staleAgent).toBeUndefined()
    expect(raw.spaces.noStamp).toBeDefined()
    expect(raw.spaces.freshAgent).toBeDefined()
    expect(raw.spaces.userHeld).toBeDefined()
    expect(raw.deletedSpaces).toContain('staleAgent')
    // user-held never reaped (public API works on well-formed records).
    await expect(manager.getSpace('userHeld')).resolves.toMatchObject({
      id: 'userHeld',
    })
    await expect(manager.getSpace('freshAgent')).resolves.toMatchObject({
      id: 'freshAgent',
    })
  })

  it('Tier 2 also catches an empty agent space when emptyTtl is set above spaceTtl', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          emptyStale: {
            id: 'emptyStale',
            name: 'empty but old',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 8 * DAY,
            tabs: [],
          },
        },
      }),
    )
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      persist: false,
      reap: { emptyTtlMs: 10 * DAY, spaceTtlMs: 7 * DAY },
    })
    expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
  })
})

describe('D8 legacy-space auto-reap — off switch', () => {
  it('HUB_SPACE_REAP=off disables the load-time sweep', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          old1: {
            id: 'old1',
            name: 'stale',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 2 * DAY,
            tabs: [],
          },
        },
      }),
    )
    const saved = process.env.HUB_SPACE_REAP
    process.env.HUB_SPACE_REAP = 'off'
    try {
      const manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
      expect((await manager.listSpaces('agent-a')).map((s) => s.id)).toEqual([
        'old1',
      ])
    } finally {
      if (saved === undefined) delete process.env.HUB_SPACE_REAP
      else process.env.HUB_SPACE_REAP = saved
    }
  })

  it('reap.enabled:false disables the load-time sweep', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          old1: {
            id: 'old1',
            name: 'stale',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 2 * DAY,
            tabs: [],
          },
        },
      }),
    )
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      persist: false,
      reap: { enabled: false },
    })
    expect((await manager.listSpaces('agent-a')).map((s) => s.id)).toEqual([
      'old1',
    ])
  })

  it('honors HUB_SPACE_EMPTY_TTL_MS / HUB_SPACE_TTL_MS env overrides', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          aged: {
            id: 'aged',
            name: 'aged',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - DAY,
            lastActiveAt: t - 5000,
            tabs: [{ pageId: 101, url: 'https://a.example' }],
          },
        },
      }),
    )
    const savedEmpty = process.env.HUB_SPACE_EMPTY_TTL_MS
    const savedSpace = process.env.HUB_SPACE_TTL_MS
    process.env.HUB_SPACE_EMPTY_TTL_MS = '1'
    process.env.HUB_SPACE_TTL_MS = '1'
    try {
      const manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
      expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
    } finally {
      if (savedEmpty === undefined) delete process.env.HUB_SPACE_EMPTY_TTL_MS
      else process.env.HUB_SPACE_EMPTY_TTL_MS = savedEmpty
      if (savedSpace === undefined) delete process.env.HUB_SPACE_TTL_MS
      else process.env.HUB_SPACE_TTL_MS = savedSpace
    }
  })
})

describe('D8 legacy-space auto-reap — ledger integrity + persistence', () => {
  it('eviction clears the owner current pointer, appends a tombstone, and persists to disk', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          old1: {
            id: 'old1',
            name: 'stale',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 2 * DAY,
            tabs: [],
          },
          other: {
            id: 'other',
            name: 'other',
            owner: 'agent-b',
            ownership: 'agent',
            createdAt: t - 1000,
            lastActiveAt: t - 1000,
            tabs: [],
          },
        },
        currentSpaceByOwner: { 'agent-a': 'old1', 'agent-b': 'other' },
      }),
    )

    const manager = new TaskSpaceManager({ storagePath: ledger, persist: true })
    // In-memory: reaped space gone + owner current pointer cleared.
    expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
    expect(await manager.currentSpace('agent-a')).toBeUndefined()
    // Disk: synced (persist:true) — space removed, tombstone appended.
    const raw = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, unknown>
      deletedSpaces?: string[]
      currentSpaceByOwner: Record<string, string>
    }
    expect(raw.spaces.old1).toBeUndefined()
    expect(raw.spaces.other).toBeDefined()
    expect(raw.deletedSpaces).toContain('old1')
    expect(raw.currentSpaceByOwner['agent-a']).toBeUndefined()
    expect(raw.currentSpaceByOwner['agent-b']).toBe('other')
  })

  it('persist:false evicts in memory without touching the disk', async () => {
    const ledger = tempLedger()
    const t = now()
    const state = {
      version: 1,
      spaces: {
        old1: {
          id: 'old1',
          name: 'stale',
          owner: 'agent-a',
          ownership: 'agent',
          createdAt: t - 30 * DAY,
          lastActiveAt: t - 2 * DAY,
          tabs: [],
        },
      },
      currentSpaceByOwner: { 'agent-a': 'old1' },
    }
    const before = JSON.stringify(state)
    writeFileSync(ledger, before)

    const manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
    expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
    // Disk untouched (persist:false semantics — in-memory state only).
    expect(readFileSync(ledger, 'utf-8')).toBe(before)
  })

  it('does not write the ledger when nothing is evicted (mtime + content unchanged)', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          fresh: {
            id: 'fresh',
            name: 'fresh',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 1000,
            lastActiveAt: t - 1000,
            tabs: [],
          },
        },
        currentSpaceByOwner: { 'agent-a': 'fresh' },
        deletedSpaces: [],
      }),
    )
    const beforeContent = readFileSync(ledger, 'utf-8')
    const beforeMtime = statSync(ledger).mtimeMs

    const manager = new TaskSpaceManager({ storagePath: ledger, persist: true })
    // Explicit pass too — still nothing to evict.
    const result = await manager.reapExpiredSpaces()
    expect(result.evicted).toEqual([])

    expect(readFileSync(ledger, 'utf-8')).toBe(beforeContent)
    expect(statSync(ledger).mtimeMs).toBe(beforeMtime)
  })
})

describe('D8 restore() must not refresh lastActiveAt unconditionally', () => {
  function gatewayWithTabs(tabs: TabLike[]): SpaceTabGateway {
    return {
      newTab: async () => 1,
      listTabs: async () => [...tabs],
      closeTab: async () => {},
      tabGroupList: async () => [],
      tabGroupCreate: async () => ({ groupId: 'g-1', tabIds: [], title: '' }),
      tabGroupAddTabs: async () => {},
      tabGroupUpdate: async () => ({}),
    }
  }

  it('leaves lastActiveAt untouched for a space that was not reconciled this round', async () => {
    const ledger = tempLedger()
    const t = now()
    const staleAt = t - 8 * DAY
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          s1: {
            id: 's1',
            name: 'stale',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: staleAt,
            lastActiveAt: staleAt,
            restoredAt: staleAt,
            tabs: [{ pageId: 101, url: 'https://a.example', restored: true }],
          },
        },
        currentSpaceByOwner: { 'agent-a': 's1' },
      }),
    )
    const fake = gatewayWithTabs([
      { pageId: 101, targetId: 't101', url: 'https://a.example', title: 'A' },
    ])
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake,
      persist: false,
      reap: { enabled: false },
    })
    const restored = await manager.restore()
    expect(restored).toBe(0) // nothing pending → nothing reconciled
    const info = await manager.getSpace('s1')
    expect(Date.parse(info.lastActiveAt)).toBe(staleAt)
  })

  it('refreshes lastActiveAt only for a space that was actually reconciled (pending→restored)', async () => {
    const ledger = tempLedger()
    const t = now()
    const staleAt = t - 8 * DAY
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          pending: {
            id: 'pending',
            name: 'pending',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: staleAt,
            lastActiveAt: staleAt,
            tabs: [{ pageId: 101, url: 'https://a.example' }], // pending
          },
          clean: {
            id: 'clean',
            name: 'clean',
            owner: 'agent-b',
            ownership: 'agent',
            createdAt: staleAt,
            lastActiveAt: staleAt,
            restoredAt: staleAt,
            tabs: [{ pageId: 102, url: 'https://b.example', restored: true }],
          },
        },
        currentSpaceByOwner: { 'agent-a': 'pending', 'agent-b': 'clean' },
      }),
    )
    const fake = gatewayWithTabs([
      { pageId: 101, targetId: 't101', url: 'https://a.example', title: 'A' },
      { pageId: 102, targetId: 't102', url: 'https://b.example', title: 'B' },
    ])
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake,
      persist: false,
      reap: { enabled: false },
    })
    const restored = await manager.restore()
    expect(restored).toBe(1) // only the pending ref reconciled
    const pendingInfo = await manager.getSpace('pending')
    const cleanInfo = await manager.getSpace('clean')
    expect(Date.parse(pendingInfo.lastActiveAt)).toBeGreaterThan(staleAt)
    expect(Date.parse(cleanInfo.lastActiveAt)).toBe(staleAt)
  })

  it('refreshes lastActiveAt when a stale ref is pruned during restore', async () => {
    const ledger = tempLedger()
    const t = now()
    const staleAt = t - 8 * DAY
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          pruned: {
            id: 'pruned',
            name: 'pruned',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: staleAt,
            lastActiveAt: staleAt,
            restoredAt: staleAt,
            // restored earlier, but the tab is gone from Chrome now → pruned
            tabs: [{ pageId: 101, url: 'https://a.example', restored: true }],
          },
        },
        currentSpaceByOwner: { 'agent-a': 'pruned' },
      }),
    )
    const fake = gatewayWithTabs([]) // live list is empty → ref pruned
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway: fake,
      persist: false,
      reap: { enabled: false },
    })
    const restored = await manager.restore()
    expect(restored).toBe(0) // prunes don't count toward reconciled
    const info = await manager.getSpace('pruned')
    expect(info.tabIds).toEqual([])
    expect(Date.parse(info.lastActiveAt)).toBeGreaterThan(staleAt)
  })
})

describe('D8 legacy-space auto-reap — best-effort tab/group close', () => {
  it('Tier 2 eviction closes tabs and the tab group through the gateway, swallowing errors', async () => {
    const ledger = tempLedger()
    const t = now()
    const closed: number[] = []
    const closedGroups: string[] = []
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          s1: {
            id: 's1',
            name: 'stale agent',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 8 * DAY,
            tabs: [
              { pageId: 101, url: 'https://a.example' },
              { pageId: 102, url: 'https://b.example' },
            ],
            tabGroupId: 'grp-1',
          },
        },
        currentSpaceByOwner: { 'agent-a': 's1' },
      }),
    )
    const gateway = createReapGateway({
      closed,
      closedGroups,
      closeThrowsFor: new Set([102]),
      tabGroupCloseThrows: true,
    })
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      gateway,
      persist: false,
      reap: { enabled: false },
    })
    // Explicit reap must resolve and evict even though closes fail.
    const result = await manager.reapExpiredSpaces(gateway)
    expect(result.evicted).toHaveLength(1)
    expect(result.evicted[0]).toMatchObject({
      spaceId: 's1',
      name: 'stale agent',
      owner: 'agent-a',
      tier: 2,
      tabs: 2,
    })
    expect(result.evicted[0].ageMs).toBeGreaterThan(7 * DAY)
    // Let the fire-and-forget closes settle; errors are swallowed.
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toEqual([101, 102])
    expect(closedGroups).toEqual(['grp-1'])
    // Ledger eviction is authoritative regardless of browser failures.
    expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
  })

  it('with no gateway only the ledger is evicted (tabs stay, no error)', async () => {
    const ledger = tempLedger()
    const t = now()
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        spaces: {
          s1: {
            id: 's1',
            name: 'stale agent',
            owner: 'agent-a',
            ownership: 'agent',
            createdAt: t - 30 * DAY,
            lastActiveAt: t - 8 * DAY,
            tabs: [{ pageId: 101, url: 'https://a.example' }],
          },
        },
        currentSpaceByOwner: { 'agent-a': 's1' },
      }),
    )
    const manager = new TaskSpaceManager({
      storagePath: ledger,
      persist: false,
      reap: { enabled: false },
    })
    const result = await manager.reapExpiredSpaces()
    expect(result.evicted).toHaveLength(1)
    expect((await manager.listSpaces('agent-a'))).toHaveLength(0)
  })
})
