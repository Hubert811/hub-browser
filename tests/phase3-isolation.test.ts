/**
 * Phase 3.3 — Agent 级 Tab 隔离 in a real dual-identity scenario (unit level).
 *
 * Verifies the isolation property the way two parallel agents actually run:
 * two identities (simulating HUB_AGENT_ID=A / B) operating through the shared
 * TaskSpaceManager + the same tool surface (executeTool / guardToolAccess):
 *
 *  - A create space + open tab; B list 自己的 space 时看不到 A 的 space;
 *  - B 的 `tabs` 列表不包含 A 的标签;
 *  - B 对 A 的 pageId 做控制操作 (act/navigate/read) 被拒 ("is not in your space");
 *  - A 对自己的 space 正常操作; handoff 后 A 操作被拒 ("user is controlling"),
 *    confirmed takeOver 恢复;
 *  - 两个独立 manager 实例共享同一账本 (模拟两个 MCP 进程): 各自只看到自己的
 *    space/标签, 互相不能控制; 账本文件不被对方进程覆盖 (merge-on-save);
 *    close 不跨进程复活 (tombstone);
 *  - D3 (2026-08-03): identity 存在但无任何 space → tabs list 空 + 控制工具
 *    全部拒绝 (no-space); 只有 identity 缺失 (未识别 agent) 才保持开放世界.
 *
 * Run: bun test tests/phase3-isolation.test.ts
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskSpaceManager,
  type SpaceIdentity,
  type SpaceTabGateway,
  type TabLike,
} from '../src/space/task-space-manager.ts'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import {
  BROWSER_TOOLS,
  SPACE_TOOLS,
} from '../src/browser-mcp/src/tools/registry.ts'
import {
  createFakePage,
  makeContext,
  textOf,
} from '../src/browser-mcp/src/tools/test-helpers.ts'
import type { ToolContext } from '../src/browser-mcp/src/tools/framework.ts'

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'phase3-isolation-')), 'hub-spaces.json')
}

/** Deterministic in-memory browser (pageIds start at 100, user tab at pageId 1). */
function createFakeGateway(startPageId = 100): {
  tabs: TabLike[]
  gateway: SpaceTabGateway
} {
  let nextPageId = startPageId
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
  return (
    BROWSER_TOOLS.find((t) => t.name === name) ??
    SPACE_TOOLS.find((t) => t.name === name)
  )!
}

/** ToolContext for one identity, sharing the manager + gateway tabs. */
function ctxFor(
  identity: SpaceIdentity | undefined,
  manager: TaskSpaceManager,
  tabs: TabLike[],
  pageIdOverride?: number,
): ToolContext {
  const page = createFakePage({
    tabs: (async () => [...tabs]) as never,
    goto: (async () => {}) as never,
  })
  if (pageIdOverride !== undefined) {
    Object.defineProperty(page, 'pageId', { value: pageIdOverride })
  }
  return {
    ...makeContext(page, async () =>
      createFakePage({
        tabs: (async () => [...tabs]) as never,
        goto: (async () => {}) as never,
      }),
    ),
    identity,
    spaces: manager,
  }
}

function pageIdsOf(result: { content?: unknown } | undefined): number[] {
  const pages = (
    result?.structuredContent as { pages: Array<{ page: number }> } | undefined
  )?.pages
  return (pages ?? []).map((p) => p.page)
}

describe('Phase 3.3 dual-identity isolation (unit)', () => {
  it('shared manager — A/B 并行: B 看不到 A 的 space/tab, 控制 A 的 page 被拒; A 同样看不到 B', async () => {
    const gw = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: gw.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'agent-a' }
    const bob: SpaceIdentity = { agentId: 'agent-b' }

    // A create space + open tab; B create own space + open tab (并行操作).
    const aSpace = await manager.create('agent-a', 'alice-work')
    const bSpace = await manager.create('agent-b', 'bob-work')
    const aTab = await manager.openTab('agent-a', aSpace.id, 'https://a.example')
    const bTab = await manager.openTab('agent-b', bSpace.id, 'https://b.example')
    // A user-owned tab that belongs to no space.
    gw.tabs.push({ pageId: 1, url: 'https://user.example' })

    const ctxA = ctxFor(alice, manager, gw.tabs)
    const ctxB = ctxFor(bob, manager, gw.tabs)

    // B 的 space.list 只含自己的 space.
    const bList = await executeTool(tool('space.list'), {}, ctxB)
    expect(bList.isError).toBeFalsy()
    const bSpaces = (bList.structuredContent as { spaces: Array<{ id: string }> }).spaces
    expect(bSpaces.map((s) => s.id)).toEqual([bSpace.id])
    expect(bSpaces.map((s) => s.id)).not.toContain(aSpace.id)

    // B 的 tabs 列表不包含 A 的标签 (也不包含用户标签).
    const bTabs = await executeTool(tool('tabs'), { action: 'list' }, ctxB)
    expect(bTabs.isError).toBeFalsy()
    expect(pageIdsOf(bTabs)).toEqual([bTab])
    expect(pageIdsOf(bTabs)).not.toContain(aTab)
    expect(pageIdsOf(bTabs)).not.toContain(1)

    // B 对 A 的 pageId 做控制操作 (act/navigate/read) 全部被拒.
    for (const [name, args] of [
      ['navigate', { page: aTab, action: 'url', url: 'https://evil.example' }],
      ['act', { page: aTab, kind: 'click', ref: 'e1' }],
      ['read', { page: aTab, format: 'text' }],
    ] as const) {
      const result = await executeTool(tool(name), { ...args }, ctxB)
      expect(result.isError, `${name} should be rejected for B`).toBe(true)
      expect(textOf(result), `${name}`).toContain('is not in your space')
    }

    // B 对自己的 tab 正常操作.
    const bOwn = await executeTool(
      tool('navigate'),
      { page: bTab, action: 'url', url: 'https://b.example/next' },
      ctxB,
    )
    expect(bOwn.isError).toBeFalsy()

    // A 的视角对称: tabs 只含自己的标签, 控制 B 的 page 被拒, 自己的正常.
    const aTabs = await executeTool(tool('tabs'), { action: 'list' }, ctxA)
    expect(pageIdsOf(aTabs)).toEqual([aTab])
    expect(pageIdsOf(aTabs)).not.toContain(bTab)

    const aOnB = await executeTool(tool('snapshot'), { page: bTab }, ctxA)
    expect(aOnB.isError).toBe(true)
    expect(textOf(aOnB)).toContain('is not in your space')

    const aOwn = await executeTool(tool('snapshot'), { page: aTab }, ctxA)
    expect(aOwn.isError).toBeFalsy()
  })

  it('handoff → A 操作被拒 ("user is controlling"), confirmed takeover 恢复', async () => {
    const gw = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: gw.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'agent-a' }
    const space = await manager.create('agent-a', 'alice-work')
    const aTab = await manager.openTab('agent-a', space.id, 'https://a.example')
    const ctx = ctxFor(alice, manager, gw.tabs)

    const before = await executeTool(tool('read'), { page: aTab, format: 'text' }, ctx)
    expect(before.isError).toBeFalsy()

    await manager.handOff('agent-a', space.id)
    for (const [name, args] of [
      ['navigate', { page: aTab, action: 'url', url: 'https://x.example' }],
      ['read', { page: aTab, format: 'text' }],
      ['act', { page: aTab, kind: 'click', ref: 'e1' }],
    ] as const) {
      const blocked = await executeTool(tool(name), { ...args }, ctx)
      expect(blocked.isError, `${name} should be user-controlling`).toBe(true)
      expect(textOf(blocked), `${name}`).toContain('user is controlling')
    }

    // takeover 不带 confirmed 被状态机拒绝 (needs-confirmation).
    const noConfirm = await executeTool(tool('space.takeover'), { spaceId: space.id }, ctx)
    expect(noConfirm.isError).toBe(true)
    expect(textOf(noConfirm)).toContain('requires user confirmation')

    // 明确确认后恢复.
    const taken = await executeTool(
      tool('space.takeover'),
      { spaceId: space.id, confirmed: true },
      ctx,
    )
    expect(taken.isError).toBeFalsy()
    const resumed = await executeTool(tool('read'), { page: aTab, format: 'text' }, ctx)
    expect(resumed.isError).toBeFalsy()
  })

  it('D3: 无 identity 保持开放世界; identity 存在但零 space → 空列表 + 全部拒绝', async () => {
    const gw = createFakeGateway()
    gw.tabs.push({ pageId: 1, url: 'https://user.example' })
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: gw.gateway,
      persist: false,
    })

    // 1) identity undefined (未识别 agent) → 保持 legacy 开放世界 (全量可见).
    const legacy = ctxFor(undefined, manager, gw.tabs)
    const list = await executeTool(tool('tabs'), { action: 'list' }, legacy)
    expect(list.isError).toBeFalsy()
    expect(pageIdsOf(list)).toEqual([1])

    const nav = await executeTool(
      tool('navigate'),
      { page: 1, action: 'url', url: 'https://user.example/2' },
      legacy,
    )
    expect(nav.isError).toBeFalsy()

    // 2) D3: identity 存在但没有 space → tabs list 空、控制工具全部拒绝 (no-space).
    const ghost: SpaceIdentity = { agentId: 'no-space-agent' }
    const ghostCtx = ctxFor(ghost, manager, gw.tabs)
    const list2 = await executeTool(tool('tabs'), { action: 'list' }, ghostCtx)
    expect(list2.isError).toBeFalsy()
    expect(pageIdsOf(list2)).toEqual([])
    const nav2 = await executeTool(
      tool('navigate'),
      { page: 1, action: 'url', url: 'https://user.example/3' },
      ghostCtx,
    )
    expect(nav2.isError).toBe(true)
    expect(textOf(nav2)).toContain('no space')
  })

  it('run 工具: 默认页 (ctx.page) 不在自己 space 时被 guard 拒绝', async () => {
    const gw = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: gw.gateway,
      persist: false,
    })
    const alice: SpaceIdentity = { agentId: 'agent-a' }
    const space = await manager.create('agent-a', 'alice-work')
    const aTab = await manager.openTab('agent-a', space.id, 'https://a.example')

    // ctx.page 绑定到别人的 page (999) → run 无 page 参数时被拒.
    const alienCtx = ctxFor(alice, manager, gw.tabs, 999)
    const rejected = await executeTool(tool('run'), { code: 'return 1' }, alienCtx)
    expect(rejected.isError).toBe(true)
    expect(textOf(rejected)).toContain('is not in your space')

    // ctx.page 绑定到自己的 tab → guard 放行 (handler 不执行真实浏览器逻辑).
    const ownCtx = ctxFor(alice, manager, gw.tabs, aTab)
    const passed = await executeTool(tool('run'), { code: 'return 1' }, ownCtx)
    expect(textOf(passed)).not.toContain('is not in your space')
  })

  it('两个独立 manager 共享一个账本 (模拟两个 MCP 进程): 隔离成立 + 账本不被覆盖 + close 不复活', async () => {
    const ledger = tempLedger()
    const gwA = createFakeGateway(100)
    const gwB = createFakeGateway(200)
    const managerA = new TaskSpaceManager({ storagePath: ledger, gateway: gwA.gateway })
    const managerB = new TaskSpaceManager({ storagePath: ledger, gateway: gwB.gateway })

    // A 进程: create space + open tab.
    const aSpace = await managerA.create('agent-a', 'alice-work')
    const aTab = await managerA.openTab('agent-a', aSpace.id, 'https://a.example')
    // B 进程: 各自 create space + open tab (B 启动时账本里已经有 A 的 space).
    const bSpace = await managerB.create('agent-b', 'bob-work')
    const bTab = await managerB.openTab('agent-b', bSpace.id, 'https://b.example')

    // 合并写入: 共享账本同时保留两个进程的 space (不再 last-writer-wins 互相覆盖).
    const raw = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, { owner: string }>
      currentSpaceByOwner: Record<string, string>
    }
    expect(raw.spaces[aSpace.id]).toBeTruthy()
    expect(raw.spaces[bSpace.id]).toBeTruthy()
    expect(raw.currentSpaceByOwner['agent-a']).toBe(aSpace.id)
    expect(raw.currentSpaceByOwner['agent-b']).toBe(bSpace.id)

    // B 的 space.list 只含自己的 space (即使 B 的内存里有 A 的 space).
    const bSpaces = await managerB.listSpaces('agent-b')
    expect(bSpaces.map((s) => s.id)).toEqual([bSpace.id])
    expect(bSpaces.map((s) => s.id)).not.toContain(aSpace.id)

    // B (fresh, 未 reload) 的 tabs 过滤: 只有自己的标签.
    const bTabList = await managerB.filterTabsForAgent('agent-b', [
      { pageId: aTab, url: 'https://a.example' },
      { pageId: bTab, url: 'https://b.example' },
      { pageId: 1, url: 'https://user.example' },
    ])
    expect(bTabList.map((t) => t.pageId)).toEqual([bTab])

    // B 控制 A 的 page 被拒 (fresh 与 reload 两种内存状态).
    await expect(
      managerB.assertPageControllable('agent-b', aTab),
    ).rejects.toMatchObject({ code: 'page-not-in-space' })

    managerB.reload()
    await expect(
      managerB.assertPageControllable('agent-b', aTab),
    ).rejects.toMatchObject({ code: 'page-not-in-space' })
    const bTabsAfterReload = await managerB.filterTabsForAgent('agent-b', [
      { pageId: aTab, url: 'https://a.example' },
      { pageId: bTab, url: 'https://b.example' },
    ])
    expect(bTabsAfterReload.map((t) => t.pageId)).toEqual([bTab])

    // A 对自己的 space 正常; A 关闭 space 后, B reload 也看不到它 (tombstone 跨进程生效).
    await managerA.closeSpace('agent-a', aSpace.id, { keep: true })
    managerB.reload()
    const bAfterClose = await managerB.listSpaces('agent-b')
    expect(bAfterClose.map((s) => s.id)).toEqual([bSpace.id])
    const raw2 = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, unknown>
    }
    expect(raw2.spaces[aSpace.id]).toBeUndefined()
  })
})
