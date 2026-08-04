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
