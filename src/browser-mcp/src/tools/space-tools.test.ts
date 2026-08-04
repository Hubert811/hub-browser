/**
 * Phase 3 — `space.*` tools + tab_groups per-space coloring (3.4/3.6 MCP side).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskSpaceManager,
  deterministicColor,
  type SpaceIdentity,
  type SpaceTabGateway,
  type TabLike,
} from '../../../space/task-space-manager.ts'
import { executeTool } from './framework'
import { BROWSER_TOOLS, SPACE_TOOLS } from './registry'
import { createFakePage, makeContext } from './test-helpers'
import type { ToolContext } from './framework'

function tool(name: string) {
  return SPACE_TOOLS.find((t) => t.name === name)!
}
function browserTool(name: string) {
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

const ALICE: SpaceIdentity = { agentId: 'alice' }

function freshManager() {
  return new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'space-tools-')), 's.json'),
    persist: false,
  })
}

function ctxFor(manager: TaskSpaceManager, page: ReturnType<typeof createFakePage>): ToolContext {
  return { ...makeContext(page), identity: ALICE, spaces: manager }
}

/** Stateful in-memory gateway for open_tab reuse tests. */
function reuseGateway(): { tabs: TabLike[]; gateway: SpaceTabGateway; opened: string[] } {
  let next = 50
  const tabs: TabLike[] = []
  const opened: string[] = []
  return {
    tabs,
    opened,
    gateway: {
      newTab: async (url) => {
        const pageId = next++
        const targetId = `t-${pageId}`
        tabs.push({ pageId, targetId, url, title: undefined })
        opened.push(url)
        return targetId
      },
      closeTab: async () => {},
      listTabs: async () => [...tabs],
    },
  }
}

describe('space.* tools', () => {
  it('space.create returns a space and sets it current', async () => {
    const manager = freshManager()
    const page = createFakePage()
    const result = await executeTool(
      tool('space.create'),
      { name: '搜索任务', taskId: 't-1' },
      ctxFor(manager, page),
    )
    expect(result.isError).toBeFalsy()
    const space = (result.structuredContent as { space: { id: string; name: string } }).space
    expect(space.name).toBe('搜索任务')
    expect((await manager.currentSpace('alice'))?.id).toBe(space.id)
  })

  it('space.use reuses the (owner, name) space', async () => {
    const manager = freshManager()
    const page = createFakePage()
    const first = await executeTool(tool('space.use'), { name: 'work' }, ctxFor(manager, page))
    const second = await executeTool(tool('space.use'), { name: 'work' }, ctxFor(manager, page))
    const s1 = (first.structuredContent as { space: { id: string }; reused: boolean }).space.id
    const s2 = (second.structuredContent as { space: { id: string }; reused: boolean })
    expect(s2.space.id).toBe(s1)
    expect(s2.reused).toBe(true)
  })

  it('space.open_tab opens a tab and returns its pageId', async () => {
    const gateway: SpaceTabGateway = {
      newTab: async () => 'target-77',
      closeTab: async () => {},
      listTabs: async () => [
        { pageId: 77, targetId: 'target-77', url: 'about:blank' },
      ],
    }
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'space-tools-')), 's.json'),
      gateway,
      persist: false,
    })
    const created = await manager.create('alice', 'work')
    const page = createFakePage({
      newTab: (async () => 'target-77') as never,
      tabs: (async () => [
        { pageId: 77, targetId: 'target-77', url: 'about:blank' },
      ]) as never,
    })
    const result = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com', background: true },
      ctxFor(manager, page),
    )
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { pageId: number; spaceId: string }).pageId).toBe(77)
    expect((await manager.getSpace(created.id)).tabIds).toEqual([77])
  })

  it('space.open_tab reuses the same URL by default: reused:true, same pageId, no duplicate', async () => {
    const { gateway } = reuseGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'space-tools-')), 's.json'),
      gateway,
      persist: false,
    })
    const created = await manager.create('alice', 'work')
    const page = createFakePage()
    const first = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com', background: true },
      ctxFor(manager, page),
    )
    const second = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com', background: true },
      ctxFor(manager, page),
    )
    expect(first.isError).toBeFalsy()
    expect(second.isError).toBeFalsy()
    const a = first.structuredContent as { pageId: number; reused: boolean }
    const b = second.structuredContent as { pageId: number; reused: boolean }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(b.pageId).toBe(a.pageId)
    expect((await manager.getSpace(created.id)).tabIds).toEqual([a.pageId])
    expect(textOf(first)).toContain('opened page')
    expect(textOf(second)).toContain('reused page')
  })

  it('space.open_tab with a different URL opens a new tab (reused:false)', async () => {
    const { gateway } = reuseGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'space-tools-')), 's.json'),
      gateway,
      persist: false,
    })
    const created = await manager.create('alice', 'work')
    const page = createFakePage()
    const first = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://a.example', background: true },
      ctxFor(manager, page),
    )
    const second = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://b.example', background: true },
      ctxFor(manager, page),
    )
    const a = first.structuredContent as { pageId: number; reused: boolean }
    const b = second.structuredContent as { pageId: number; reused: boolean }
    expect(b.reused).toBe(false)
    expect(b.pageId).not.toBe(a.pageId)
  })

  it('space.open_tab reuse:false forces a new tab for the same URL', async () => {
    const { gateway } = reuseGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'space-tools-')), 's.json'),
      gateway,
      persist: false,
    })
    const created = await manager.create('alice', 'work')
    const page = createFakePage()
    const first = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com', background: true, reuse: false },
      ctxFor(manager, page),
    )
    const second = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com', background: true, reuse: false },
      ctxFor(manager, page),
    )
    const a = first.structuredContent as { pageId: number; reused: boolean }
    const b = second.structuredContent as { pageId: number; reused: boolean }
    expect(b.reused).toBe(false)
    expect(b.pageId).not.toBe(a.pageId)
    expect((await manager.getSpace(created.id)).tabIds).toHaveLength(2)
  })

  it('space.open_tab origin+path mode reuses a same-origin+path tab', async () => {
    const { gateway } = reuseGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'space-tools-')), 's.json'),
      gateway,
      persist: false,
    })
    const created = await manager.create('alice', 'work')
    const page = createFakePage()
    const first = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com/docs?a=1', background: true, reuse: 'origin+path' },
      ctxFor(manager, page),
    )
    const second = await executeTool(
      tool('space.open_tab'),
      { spaceId: created.id, url: 'https://example.com/docs?a=2', background: true, reuse: 'origin+path' },
      ctxFor(manager, page),
    )
    const a = first.structuredContent as { pageId: number; reused: boolean }
    const b = second.structuredContent as { pageId: number; reused: boolean }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(b.pageId).toBe(a.pageId)
  })

  it('space.list / space.current / space.switch', async () => {
    const manager = freshManager()
    const s1 = await manager.create('alice', 'one')
    const s2 = await manager.create('alice', 'two')
    const page = createFakePage()

    const list = await executeTool(tool('space.list'), {}, ctxFor(manager, page))
    expect((list.structuredContent as { count: number }).count).toBe(2)

    const current = await executeTool(tool('space.current'), {}, ctxFor(manager, page))
    expect((current.structuredContent as { space: { id: string } }).space.id).toBe(s2.id)

    const switched = await executeTool(tool('space.switch'), { spaceId: s1.id }, ctxFor(manager, page))
    expect((switched.structuredContent as { switched: string }).switched).toBe(s1.id)
    expect((await manager.currentSpace('alice'))?.id).toBe(s1.id)
  })

  it('space.close_tab / space.close (keep) / space.handoff / space.takeover / space.claim', async () => {
    const manager = freshManager()
    const s1 = await manager.create('alice', 'one')
    const s2 = await manager.create('alice', 'two')
    const page = createFakePage()

    const handoff = await executeTool(tool('space.handoff'), { spaceId: s1.id }, ctxFor(manager, page))
    expect((handoff.structuredContent as { space: { ownership: string } }).space.ownership).toBe('agentDelegatedToUser')

    // takeover without confirmed: rejected.
    const blocked = await executeTool(tool('space.takeover'), { spaceId: s1.id }, ctxFor(manager, page))
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('requires user confirmation')

    const taken = await executeTool(tool('space.takeover'), { spaceId: s1.id, confirmed: true }, ctxFor(manager, page))
    expect((taken.structuredContent as { space: { ownership: string } }).space.ownership).toBe('agent')

    const claim = await executeTool(tool('space.claim'), { spaceId: s2.id }, ctxFor(manager, page))
    expect((claim.structuredContent as { space: { id: string } }).space.id).toBe(s2.id)
    expect((await manager.currentSpace('alice'))?.id).toBe(s2.id)

    const closed = await executeTool(tool('space.close'), { spaceId: s1.id, keep: true }, ctxFor(manager, page))
    expect(closed.isError).toBeFalsy()
    expect((closed.structuredContent as { closed: string }).closed).toBe(s1.id)
  })

  it('space tools error clearly when the server has no spaces wiring', async () => {
    const page = createFakePage()
    const ctx = makeContext(page)
    const result = await executeTool(tool('space.create'), { name: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not configured')
  })
})

describe('tab_groups per-space coloring (3.4)', () => {
  it('create defaults title to the space name and color to a deterministic color', async () => {
    const manager = freshManager()
    const space = await manager.create('alice', '搜索任务')
    // The page must belong to the space first (guard rejects unowned pages).
    await manager.recordTabForCurrentSpace('alice', 7, 'https://a.example')
    const page = createFakePage({
      tabs: (async () => [
        { pageId: 7, tabId: 71, targetId: 't7', url: 'https://a.example' },
      ]) as never,
      tabGroupList: (async () => []) as never,
      cdp: (async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Browser.createTabGroup') {
          return {
            group: {
              groupId: 'g-1',
              windowId: 1,
              title: params?.title ?? undefined,
              color: params?.color ?? undefined,
              collapsed: false,
              tabIds: params?.tabIds ?? [],
            },
          }
        }
        return {}
      }) as never,
    })
    const result = await executeTool(
      browserTool('tab_groups'),
      { action: 'create', pages: [7] },
      ctxFor(manager, page),
    )
    expect(result.isError).toBeFalsy()
    const group = (result.structuredContent as { group: { title?: string; color?: string } }).group
    expect(group.title).toBe('搜索任务')
    expect(group.color).toBe(deterministicColor(space.id))
  })

  it('list annotates groups with the owning space_id (additive)', async () => {
    const manager = freshManager()
    const space = await manager.create('alice', 'work')
    await manager.recordTabForCurrentSpace('alice', 7, 'https://a.example')
    const page = createFakePage({
      tabs: (async () => [
        { pageId: 7, tabId: 71, targetId: 't7', url: 'https://a.example' },
      ]) as never,
      tabGroupList: (async () => [
        { groupId: 'g-1', windowId: 1, title: 'Work', color: 'blue', collapsed: false, tabIds: [71] },
      ]) as never,
    })
    const result = await executeTool(browserTool('tab_groups'), { action: 'list' }, ctxFor(manager, page))
    expect(result.isError).toBeFalsy()
    const groups = (result.structuredContent as { groups: Array<Record<string, unknown>> }).groups
    expect(groups[0].space_id).toBe(space.id)
    // Existing keys are preserved.
    expect(groups[0].groupId).toBe('g-1')
  })
})

describe('space.recycle — TabFreshness 整组回收原语 (MCP)', () => {
  it('recycles every tab of the (default current) space and returns the old→new pageId mapping', async () => {
    // Stateful registry where closeTab actually removes the tab (unlike the
    // shared reuseGateway helper, which treats close as a no-op).
    let next = 300
    const tabs: TabLike[] = []
    const gateway: SpaceTabGateway = {
      newTab: async (url) => {
        const pageId = next++
        const targetId = `t-${pageId}`
        tabs.push({ pageId, targetId, url, title: undefined })
        return targetId
      },
      closeTab: async (target) => {
        const idx = tabs.findIndex(
          (t) => t.pageId === target || t.targetId === String(target),
        )
        if (idx >= 0) tabs.splice(idx, 1)
      },
      listTabs: async () => [...tabs],
    }
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'space-recycle-')), 's.json'),
      gateway,
      persist: false,
    })
    const space = await manager.create('alice', 'work')
    const t1 = await manager.openTabWithReuse('alice', space.id, 'https://a.example/', {
      background: true,
    })
    const t2 = await manager.openTabWithReuse('alice', space.id, 'https://b.example/', {
      background: true,
    })

    // ctx.page exposes the same registry so gatewayFromPage(ctx.page) drives
    // the recycle over the same tabs the ledger sees.
    const page = createFakePage({
      newTab: (async (url?: string) => gateway.newTab(url ?? 'about:blank')) as never,
      closeTab: (async (target: number | string) => gateway.closeTab(target)) as never,
      tabs: (async () => [...tabs]) as never,
      selectTab: (async () => {}) as never,
    })
    const result = await executeTool(
      tool('space.recycle'),
      {},
      ctxFor(manager, page),
    )

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      spaceId: string
      recycled: number
      tabs: Array<{ oldPageId: number; newPageId: number; url: string; reused: boolean }>
    }
    expect(sc.spaceId).toBe(space.id)
    expect(sc.recycled).toBe(2)
    expect(sc.tabs.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ])
    expect(sc.tabs[0].oldPageId).toBe(t1.pageId)
    expect(sc.tabs[0].newPageId).not.toBe(t1.pageId)
    expect(sc.tabs[1].oldPageId).toBe(t2.pageId)
    expect(sc.tabs[1].newPageId).not.toBe(t2.pageId)

    // Ledger points at the fresh tabs with the same URLs.
    const ledger = await manager.listTabs(space.id)
    expect(ledger.map((t) => t.url)).toEqual([
      'https://a.example/',
      'https://b.example/',
    ])
    expect(ledger.map((t) => t.pageId)).toEqual(sc.tabs.map((t) => t.newPageId))
    expect(textOf(result)).toContain('recycled 2 tab(s)')
    expect(textOf(result)).toContain('https://a.example/ -> page')
  })

  it('rejects a user-held space with the standard guard error', async () => {
    const manager = freshManager()
    const space = await manager.create('alice', 'work')
    await manager.handOff('alice', space.id)
    await manager.confirmUserControl('alice', space.id)
    const page = createFakePage()
    const result = await executeTool(
      tool('space.recycle'),
      { spaceId: space.id },
      ctxFor(manager, page),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('user is controlling')
  })
})
