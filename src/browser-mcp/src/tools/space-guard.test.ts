/**
 * Phase 3 — agent-level tab isolation through executeTool.
 *
 * These tests exercise the guard wired into executeTool (framework.ts) with a
 * real TaskSpaceManager: tabs list filtering, control-tool rejection
 * ("page not in your space"), user-held rejection ("user is controlling"),
 * cross-agent rejection, and `tabs new` attribution.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskSpaceManager,
  type SpaceIdentity,
  type SpaceTabGateway,
  type TabLike,
} from '../../../space/task-space-manager.ts'
import { executeTool } from './framework'
import { BROWSER_TOOLS } from './registry'
import { createFakePage, makeContext } from './test-helpers'
import type { ToolContext } from './framework'

function createFakeGateway(): { tabs: TabLike[]; gateway: SpaceTabGateway } {
  let nextPageId = 100
  const tabs: TabLike[] = []
  return {
    tabs,
    gateway: {
      newTab: async (url) => {
        const pageId = nextPageId++
        const targetId = `target-${pageId}`
        tabs.push({ pageId, targetId, url })
        return targetId
      },
      closeTab: async (target) => {
        const idx = tabs.findIndex(
          (t) => t.pageId === target || t.targetId === String(target),
        )
        if (idx >= 0) tabs.splice(idx, 1)
      },
      listTabs: async () => [...tabs],
    },
  }
}

function tool(name: string) {
  return BROWSER_TOOLS.find((t) => t.name === name)!
}

function textOf(result: { content?: unknown } | undefined): string {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
}

describe('agent-level tab isolation (3.3) — through executeTool', () => {
  it('tabs list is filtered to the agent\u2019s own space', async () => {
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'alice' }
    const bob: SpaceIdentity = { agentId: 'bob' }
    const aSpace = await manager.create('alice', 'a-work')
    const bSpace = await manager.create('bob', 'b-work')
    const aTab = await manager.openTab('alice', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('bob', bSpace.id, 'https://b.example')
    gateway.tabs.push({ pageId: 1, url: 'https://user.example' })

    const page = createFakePage({ tabs: (async () => [...gateway.tabs]) as never })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: alice,
      spaces: manager,
    }

    const result = await executeTool(tool('tabs'), { action: 'list' }, ctx)
    expect(result.isError).toBeFalsy()
    const pages = (result.structuredContent as { pages: Array<{ page: number }> }).pages
    expect(pages.map((p) => p.page)).toEqual([aTab])
    expect(pages.map((p) => p.page)).not.toContain(bTab)
    expect(pages.map((p) => p.page)).not.toContain(1)
  })

  it('control tools reject pages outside the agent\u2019s space with "page not in your space"', async () => {
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'alice' }
    const aSpace = await manager.create('alice', 'a-work')
    const aTab = await manager.openTab('alice', aSpace.id, 'https://a.example')
    gateway.tabs.push({ pageId: 999, url: 'https://other.example' })

    const page = createFakePage({
      goto: (async () => {}) as never,
      tabs: (async () => [...gateway.tabs]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: alice,
      spaces: manager,
    }

    for (const [name, args] of [
      ['navigate', { page: 999, action: 'url', url: 'https://evil.example' }],
      ['snapshot', { page: 999 }],
      ['act', { page: 999, kind: 'click', ref: 'e1' }],
      ['read', { page: 999, format: 'text' }],
      ['evaluate', { page: 999, code: 'return 1' }],
      ['tabs', { action: 'close', page: 999 }],
    ] as const) {
      const result = await executeTool(tool(name), { ...args }, ctx)
      expect(result.isError, `${name} should be rejected`).toBe(true)
      expect(textOf(result), `${name}`).toContain('is not in your space')
    }

    // The agent's own tab still works.
    const ok = await executeTool(tool('navigate'), { page: aTab, action: 'url', url: 'https://a.example/next' }, ctx)
    expect(ok.isError).toBeFalsy()
  })

  it('agent A cannot operate tabs inside agent B\u2019s space', async () => {
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'alice' }
    const bob: SpaceIdentity = { agentId: 'bob' }
    const aSpace = await manager.create('alice', 'a-work')
    const bSpace = await manager.create('bob', 'b-work')
    const aTab = await manager.openTab('alice', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('bob', bSpace.id, 'https://b.example')

    const page = createFakePage({ tabs: (async () => [...gateway.tabs]) as never })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: alice,
      spaces: manager,
    }

    const result = await executeTool(tool('snapshot'), { page: bTab }, ctx)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('is not in your space')
    expect(textOf(result)).not.toContain('user is controlling')

    const own = await executeTool(tool('snapshot'), { page: aTab }, ctx)
    expect(own.isError).toBeFalsy()
  })

  it('tab_groups update/close on a foreign group are rejected (real-run P1-1 hole, 2026-08-22)', async () => {
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'alice' }
    const bob: SpaceIdentity = { agentId: 'bob' }
    const aSpace = await manager.create('alice', 'a-work')
    const bSpace = await manager.create('bob', 'b-work')
    const aTab = await manager.openTab('alice', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('bob', bSpace.id, 'https://b.example')

    // The guard maps groupId → tabIds → pageIds, so the fake tabs carry a
    // tabId (real CDP tabs do) and tabGroupList returns the CDP shape.
    const groupFor = (id: string, tabId: number) => ({ groupId: id, tabIds: [tabId] })
    const updated: string[] = []
    const closed: string[] = []
    const page = createFakePage({
      tabs: (async () =>
        gateway.tabs.map((t) => ({ ...t, tabId: t.pageId }))) as never,
      tabGroupList: (async () => [
        { ...groupFor('g-a', aTab), title: 'a' },
        { ...groupFor('g-b', bTab), title: 'b' },
      ]) as never,
      tabGroupUpdate: (async (groupId: string, opts: unknown) => {
        if (groupId !== 'g-a' && groupId !== 'g-b') {
          throw new Error(`Unknown tab group ${groupId}`)
        }
        updated.push(groupId)
        const tabIds = groupId === 'g-a' ? [aTab] : [bTab]
        return { groupId, tabIds, ...(opts as object) }
      }) as never,
      tabGroupClose: (async (groupId: string) => {
        closed.push(groupId)
      }) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: alice,
      spaces: manager,
    }

    // Pre-fix these calls addressed the group by groupId only and sailed
    // through guardToolAccess (its tab_groups branch keyed on args.pages).
    const upd = await executeTool(
      tool('tab_groups'),
      { action: 'update', groupId: 'g-b', title: 'hack' },
      ctx,
    )
    expect(upd.isError).toBe(true)
    expect(textOf(upd)).toContain('is not in your space')

    const cls = await executeTool(
      tool('tab_groups'),
      { action: 'close', groupId: 'g-b' },
      ctx,
    )
    expect(cls.isError).toBe(true)
    expect(textOf(cls)).toContain('is not in your space')

    // The guard fired before dispatch — the handler never touched the group.
    expect(updated).toEqual([])
    expect(closed).toEqual([])

    // Own group still updates fine.
    const own = await executeTool(
      tool('tab_groups'),
      { action: 'update', groupId: 'g-a', title: 'renamed' },
      ctx,
    )
    expect(own.isError).toBeFalsy()
    expect(updated).toEqual(['g-a'])

    // Unknown group ids fall through to the handler's native error (the
    // guard only rejects what it can prove is foreign).
    const unknown = await executeTool(
      tool('tab_groups'),
      { action: 'update', groupId: 'g-nope', title: 'x' },
      ctx,
    )
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).not.toContain('is not in your space')
  })

  it('tab_groups update on the SAME agent\u2019s other space is rejected (space-level finalization, 2026-08-24)', async () => {
    // The real-run repro shape: one agent, two spaces. The original
    // groupId-branch fix used the agent-level assertPagesControllable, which
    // waved this through (both spaces belong to the same owner). The
    // finalized guard is space-level: a group is the CURRENT space's D5
    // projection, so members of another space — even the same agent's — are
    // off-limits.
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const solo: SpaceIdentity = { agentId: 'solo' }
    const first = await manager.create('solo', 'first-work')
    const firstTab = await manager.openTab('solo', first.id, 'https://first.example')
    const second = await manager.create('solo', 'second-work') // becomes current
    await manager.openTab('solo', second.id, 'https://second.example')

    const updated: string[] = []
    const page = createFakePage({
      tabs: (async () =>
        gateway.tabs.map((t) => ({ ...t, tabId: t.pageId }))) as never,
      tabGroupList: (async () => [
        { groupId: 'g-first', tabIds: [firstTab], title: 'first' },
      ]) as never,
      tabGroupUpdate: (async (groupId: string, opts: unknown) => {
        updated.push(groupId)
        return { groupId, ...(opts as object) }
      }) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: solo,
      spaces: manager,
    }

    // Agent-level check (pre-finalization) allowed this: both spaces are
    // solo's. Space-level rejects: firstTab belongs to `first`, not the
    // current space `second`.
    const upd = await executeTool(
      tool('tab_groups'),
      { action: 'update', groupId: 'g-first', title: 'hack' },
      ctx,
    )
    expect(upd.isError).toBe(true)
    expect(textOf(upd)).toContain('is not in your space')
    expect(updated).toEqual([])
  })

  it('handoff → agent operations fail with "user is controlling"; confirmed takeover restores them', async () => {
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'alice' }
    const space = await manager.create('alice', 'work')
    const tab = await manager.openTab('alice', space.id, 'https://a.example')

    const page = createFakePage({
      goto: (async () => {}) as never,
      tabs: (async () => [...gateway.tabs]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: alice,
      spaces: manager,
    }

    await manager.handOff('alice', space.id)
    const blocked = await executeTool(tool('navigate'), { page: tab, action: 'url', url: 'https://x.example' }, ctx)
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('user is controlling')

    // Takeover without confirmation is refused by the state machine.
    await expect(manager.takeOver('alice', space.id)).rejects.toMatchObject({
      code: 'needs-confirmation',
    })
    await manager.takeOver('alice', space.id, { confirmed: true })
    const resumed = await executeTool(tool('navigate'), { page: tab, action: 'url', url: 'https://a.example/next' }, ctx)
    expect(resumed.isError).toBeFalsy()
  })

  it('tabs new attributes the fresh tab to the current space; rejected while user-held', async () => {
    const gateway = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      gateway: gateway.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'alice' }
    const space = await manager.create('alice', 'work')

    const page = createFakePage({
      newTab: (async () => 'target-200') as never,
      tabs: (async () => [
        ...gateway.tabs,
        { pageId: 200, targetId: 'target-200', url: 'about:blank' },
      ]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: alice,
      spaces: manager,
    }

    const result = await executeTool(tool('tabs'), { action: 'new', url: 'https://fresh.example' }, ctx)
    expect(result.isError).toBeFalsy()
    // The fresh tab is attributed and visible in a subsequent list.
    expect((await manager.getSpace(space.id)).tabIds).toContain(200)

    await manager.handOff('alice', space.id)
    await manager.confirmUserControl('alice', space.id)
    const blocked = await executeTool(tool('tabs'), { action: 'new', url: 'https://blocked.example' }, ctx)
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('user is controlling')
  })

  it('D3: an agent without a space gets an empty tabs list and every page operation is rejected', async () => {
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'guard-')), 's.json'),
      persist: false,
    })
    const ghost: SpaceIdentity = { agentId: 'no-space-agent' }
    const page = createFakePage({
      goto: (async () => {}) as never,
      tabs: (async () => [
        { pageId: 1, url: 'https://user.example', title: 'User' },
      ]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: ghost,
      spaces: manager,
    }

    // tabs list → empty (no legacy open-world listing).
    const list = await executeTool(tool('tabs'), { action: 'list' }, ctx)
    expect(list.isError).toBeFalsy()
    expect(
      (list.structuredContent as { pages: Array<{ page: number }> }).pages.map((p) => p.page),
    ).toEqual([])

    // tabs new → rejected with no-space (space is the precondition for new tabs too).
    const newTab = await executeTool(
      tool('tabs'),
      { action: 'new', url: 'https://fresh.example' },
      ctx,
    )
    expect(newTab.isError).toBe(true)
    expect(textOf(newTab)).toContain('no space')

    // Page-targeted control tools → rejected with no-space.
    for (const [name, args] of [
      ['navigate', { page: 1, action: 'url', url: 'https://user.example/2' }],
      ['snapshot', { page: 1 }],
      ['act', { page: 1, kind: 'click', ref: 'e1' }],
      ['read', { page: 1, format: 'text' }],
      ['evaluate', { page: 1, code: 'return 1' }],
      ['tabs', { action: 'close', page: 1 }],
    ] as const) {
      const result = await executeTool(tool(name), { ...args }, ctx)
      expect(result.isError, `${name} should reject for a no-space agent`).toBe(true)
      expect(textOf(result), `${name}`).toContain('no space')
    }
  })
})
