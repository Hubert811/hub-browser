/**
 * P2-1 — session-end space sweep ("task ends → tabs close").
 *
 * Layer 1 (unit): TaskSpaceManager.closeSpacesOwnedBy — owner scoping, keep
 * semantics, tombstones, tab/group close.
 *
 * Layer 2 (integration): the real `hub --mcp` stdio server as a child
 * process — its session-scoped spaces (per-process convoId, P1-3) are closed
 * when the client disconnects. HUB_SESSION_END_SPACES matrix: close (default)
 * / off. Stable HUB_AGENT_ID identities are never swept (by wiring, not by
 * timing — hub.mjs skips the tracking entirely for them).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:net'
import {
  TaskSpaceManager,
  type SpaceTabGateway,
  type TabLike,
} from '../src/space/task-space-manager.ts'

function tempLedger(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'hub-spaces.json')
}

function sweepGateway(opts?: {
  closed?: number[]
  closedGroups?: string[]
}): SpaceTabGateway {
  const closed = opts?.closed ?? []
  const closedGroups = opts?.closedGroups ?? []
  return {
    newTab: async () => 1,
    listTabs: async () => [] as TabLike[],
    closeTab: async (target) => {
      closed.push(Number(target))
    },
    tabGroupList: async () => [],
    tabGroupCreate: async () => ({ groupId: 'g-1', tabIds: [], title: '' }),
    tabGroupAddTabs: async () => {},
    tabGroupUpdate: async () => ({}),
    tabGroupClose: async (groupId) => {
      closedGroups.push(groupId)
    },
  }
}

describe('closeSpacesOwnedBy (P2-1 unit face)', () => {
  it('closes every space of the owner — tabs, group, ledger, tombstone — and only theirs', async () => {
    const ledger = tempLedger('hub-sess-unit-')
    const gw = sweepGateway()
    const manager = new TaskSpaceManager({ storagePath: ledger, gateway: gw })
    const mine1 = await manager.create('mcp:probe:s1', 'task one')
    const mine2 = await manager.create('mcp:probe:s1', 'task two')
    const other = await manager.create('other-agent', 'not mine')
    const closedTabs: number[] = []
    const closedGroups: string[] = []
    // Wire spy gateway for the close calls.
    const spyGw = sweepGateway({ closed: closedTabs, closedGroups: closedGroups })
    await manager.recordTabForCurrentSpace('mcp:probe:s1', 11, 'https://a.example/1')
    await manager.recordTabForCurrentSpace('mcp:probe:s1', 12, 'https://a.example/2')
    await manager.recordTabForCurrentSpace('other-agent', 99, 'https://b.example/')

    const closed = await manager.closeSpacesOwnedBy('mcp:probe:s1', undefined, spyGw)
    expect(closed.sort()).toEqual([mine1.id, mine2.id].sort())
    // Tabs of the swept spaces closed; the other owner's untouched.
    expect(closedTabs.sort()).toEqual([11, 12].sort())
    // Ledger: owner's spaces gone with tombstones, other's intact.
    const state = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(Object.keys(state.spaces)).toEqual([other.id])
    expect((state.deletedSpaces ?? []).sort()).toEqual([mine1.id, mine2.id].sort())
  })

  it('keep:true evicts the ledger but leaves tabs open (review semantics)', async () => {
    const ledger = tempLedger('hub-sess-unit-')
    const manager = new TaskSpaceManager({ storagePath: ledger })
    await manager.create('mcp:probe:s2', 'reviewed')
    await manager.recordTabForCurrentSpace('mcp:probe:s2', 21, 'https://keep.example/')
    const closedTabs: number[] = []
    const spyGw = sweepGateway({ closed: closedTabs })

    const closed = await manager.closeSpacesOwnedBy('mcp:probe:s2', { keep: true }, spyGw)
    expect(closed.length).toBe(1)
    expect(closedTabs).toEqual([])
    const state = JSON.parse(readFileSync(ledger, 'utf-8'))
    expect(Object.keys(state.spaces)).toEqual([])
    expect((state.deletedSpaces ?? []).length).toBe(1)
  })

  it('an owner with no spaces is a no-op', async () => {
    const manager = new TaskSpaceManager({ storagePath: tempLedger('hub-sess-unit-') })
    await expect(manager.closeSpacesOwnedBy('nobody-here')).resolves.toEqual([])
  })
})

// ── Layer 2: real stdio server child process ────────────────────────────────

const REPO_ROOT = process.cwd()
const HUB_BIN = join(REPO_ROOT, 'bin', 'hub.mjs')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function readLedger(path: string): { spaces: Record<string, unknown>; deletedSpaces?: string[] } {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await delay(150)
  }
}

async function runSessionScenario(mode: string): Promise<void> {
  const ledger = tempLedger('hub-sess-mcp-')
  const cdpPort = await freePort() // dead port: no BrowserOS needed for space.*
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [HUB_BIN, '--mcp'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HUB_SPACES_FILE: ledger,
      HUB_SPACE_REAP: 'off',
      HUB_AUDIT: 'off',
      ...(mode !== 'default' && { HUB_SESSION_END_SPACES: mode }),
      BROWSEROS_CDP_PORT: String(cdpPort),
    },
  })
  const client = new Client({ name: 'session-close-probe', version: '1.0.0' })
  await client.connect(transport)
  const created = (await client.callTool({
    name: 'space.create',
    arguments: { name: 'session-sweep-probe' },
  })) as { isError?: boolean }
  expect(created.isError).not.toBe(true)
  // The session identity resolved on that call; the ledger now holds one
  // session-scoped space.
  expect(Object.keys(readLedger(ledger).spaces)).toHaveLength(1)

  // Disconnect (stdin end on the server side) and let the sweep settle.
  // The sweep lands within ~150ms of the disconnect (default case measured
  // at ~120ms); for the off case 2.5s is plenty to prove it never fires.
  await client.close()
  const swept = await waitFor(
    () => (Object.keys(readLedger(ledger).spaces).length === 0 ? true : undefined),
    mode === 'default' ? 8000 : 2500,
  )
  if (mode === 'default') {
    expect(swept).toBe(true)
    expect((readLedger(ledger).deletedSpaces ?? []).length).toBeGreaterThanOrEqual(1)
  } else {
    // off: the space survives the disconnect (D8 TTL remains the backstop).
    expect(swept).toBeUndefined()
    expect(existsSync(ledger)).toBe(true)
    expect(Object.keys(readLedger(ledger).spaces)).toHaveLength(1)
  }
}

describe('hub --mcp session-end sweep (P2-1 integration)', () => {
  it('default: closes the session-scoped spaces when the client disconnects', async () => {
    await runSessionScenario('default')
  })

  it('HUB_SESSION_END_SPACES=off leaves the spaces to the D8 TTL', async () => {
    await runSessionScenario('off')
  })
})
