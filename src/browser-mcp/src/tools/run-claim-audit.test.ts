/**
 * P1-8 remaining blocks — pages.newPage claim + audit sub-rows (record).
 *
 * The run bridge's call() gate is now authorize → dispatch → effects →
 * record (mirroring BrowserOS BrowserBridge::call): a freshly opened page
 * is claimed into the caller's current space via onPageCreated so the very
 * next observe(newId) does not chain-reject with page-not-in-space,
 * opening a tab while the current space is user-held is rejected up front
 * (no tab opened), and every bridged primitive — rejected or not — lands
 * an audit sub-row in the result's `steps` (P2-2 groundwork).
 *
 * Also covers the tabs-tool claim fix: `tabs new` attributes the fresh tab
 * under the ownerOf key (convoId), not the bare agentId, so MCP clientInfo
 * identities (agentId !== convoId) do not silently open unowned tabs.
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
import { run } from './run'
import { tabs } from './tabs'
import { createFakePage, makeContext } from './test-helpers'
import type { InnerCallRecord, ToolContext } from './framework'

function createFakeGateway(): { tabs: TabLike[]; gateway: SpaceTabGateway } {
  // Starts at 1: createFakePage() builds the ctx.page with pageId 1, and the
  // tool-level guard checks that page's ownership — so the agent's first
  // opened tab must be page 1 for run() to even reach the primitives.
  let nextPageId = 1
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

const AGENT: SpaceIdentity = {
  agentId: 'mcp:claude-code',
  convoId: 'mcp:claude-code:claim',
  displayName: 'claude-code',
}

async function setup() {
  const fake = createFakeGateway()
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'run-claim-')), 's.json'),
    gateway: fake.gateway,
    persist: false,
  })
  const space = await manager.create(AGENT.convoId, 'claim-work')
  const foreign = await manager.create('other-agent', 'foreign-work')
  const ownTab = await manager.openTab(AGENT.convoId, space.id, 'https://own.example')
  const foreignTab = await manager.openTab('other-agent', foreign.id, 'https://foreign.example')
  return { fake, manager, space, ownTab, foreignTab }
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

async function runWith(ctx: ToolContext, code: string, timeout?: number) {
  const result = await executeTool(
    run,
    { code, ...(timeout && { timeout }) },
    ctx,
  )
  const structured = (result as
    | { structuredContent?: { value?: unknown; steps?: InnerCallRecord[] } }
    | undefined)?.structuredContent
  return {
    text: textOf(result),
    isError: result?.isError === true,
    value: structured?.value,
    steps: structured?.steps ?? [],
  }
}

describe('run pages.newPage claim (P1-8)', () => {
  it('claims the fresh tab into the caller’s space; observe(newId) does not chain-reject', async () => {
    const { fake, manager, ownTab } = await setup()
    const page = createFakePage({
      newTab: (async (url: string) => fake.gateway.newTab(url)) as never,
      tabs: (async () => [...fake.tabs]) as never,
      snapshot: async () => '[ref=e1] claimed page' as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }

    const out = await runWith(
      ctx,
      `const id = await browser.pages.newPage('https://claimed.example')
       const before = await browser.pages.list()
       const s = await browser.observe(id).snapshot()
       return { id, seen: before.map(t => t.pageId), text: s.text }`,
    )

    expect(out.isError).toBe(false)
    const newId = (out.value as { id: number }).id
    expect(newId).toBeGreaterThan(ownTab) // a genuinely fresh page
    // Chain does not reject: observe on the just-opened page works.
    expect((out.value as { text: string }).text).toContain('claimed page')
    // The fresh tab is in the ledger: the agent's own filter now sees it.
    const visible = await manager.filterTabsForAgent(AGENT.convoId, [
      { pageId: newId } as TabLike,
    ])
    expect(visible.map((t) => t.pageId)).toEqual([newId])
    // pages.list inside the same script saw own(1) + claimed(new) — not the
    // foreign tab, and not an unowned new tab that list would have dropped.
    expect((out.value as { seen: number[] }).seen).toContain(newId)
    expect((out.value as { seen: number[] }).seen).toContain(ownTab)
  })

  it('claims with the URL the script opened the tab with', async () => {
    const { fake, manager } = await setup()
    const page = createFakePage({
      newTab: (async (url: string) => fake.gateway.newTab(url)) as never,
      tabs: (async () => [...fake.tabs]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `const id = await browser.pages.newPage('https://url.example/x'); return id`,
    )
    expect(out.isError).toBe(false)
    const tab = fake.tabs.find((t) => t.pageId === (out.value as number))
    expect(tab?.url).toBe('https://url.example/x')
    const space = await manager.currentSpace(AGENT.convoId)
    expect(space?.tabIds.includes(out.value as number)).toBe(true)
  })

  it('rejects newPage up front while the current space is user-held (no tab opened)', async () => {
    const { fake, manager, space } = await setup()
    // Second space becomes the current one and is handed off.
    const held = await manager.create(AGENT.convoId, 'held-work')
    await manager.handOff(AGENT.convoId, held.id)
    expect(space).toBeDefined()

    const tabsBefore = fake.tabs.length
    const page = createFakePage({
      newTab: (async (url: string) => fake.gateway.newTab(url)) as never,
      tabs: (async () => [...fake.tabs]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `const id = await browser.pages.newPage('https://held.example'); return id`,
    )
    expect(out.isError).toBe(true)
    expect(out.text).toContain('user is controlling')
    // authorize runs before dispatch — no tab was opened in the browser.
    expect(fake.tabs.length).toBe(tabsBefore)
  })

  it('open-world newPage keeps the legacy no-claim behavior', async () => {
    const { fake } = await setup()
    const before = fake.tabs.length
    const page = createFakePage({
      newTab: (async (url: string) => fake.gateway.newTab(url)) as never,
      tabs: (async () => [...fake.tabs]) as never,
    })
    const ctx = makeContext(page) // no identity/spaces
    const out = await runWith(
      ctx,
      `const id = await browser.pages.newPage('https://open.example'); return id`,
    )
    expect(out.isError).toBe(false)
    expect(fake.tabs.length).toBe(before + 1)
  })
})

describe('run audit sub-rows (P1-8 record / P2-2 groundwork)', () => {
  it('records one sub-row per bridged primitive on success', async () => {
    const { fake, manager, ownTab } = await setup()
    const page = createFakePage({
      tabs: (async () => [...fake.tabs]) as never,
      snapshot: async () => '[ref=e1] ok' as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `await browser.pages.list()
       const s = await browser.observe(${ownTab}).snapshot()
       return s.text`,
    )
    expect(out.isError).toBe(false)
    expect(out.steps).toHaveLength(2)
    expect(out.steps[0]).toMatchObject({ tool: 'pages.list', ok: true })
    expect(out.steps[0].pageId).toBeUndefined()
    expect(typeof out.steps[0].durationMs).toBe('number')
    expect(out.steps[1]).toMatchObject({
      tool: 'observe.snapshot',
      pageId: ownTab,
      ok: true,
    })
  })

  it('records a failure sub-row (with error summary) for rejected primitives', async () => {
    const { manager, foreignTab } = await setup()
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `await browser.observe(${foreignTab}).snapshot(); return 'unreachable'`,
    )
    expect(out.isError).toBe(true)
    expect(out.steps).toHaveLength(1)
    expect(out.steps[0]).toMatchObject({
      tool: 'observe.snapshot',
      pageId: foreignTab,
      ok: false,
    })
    expect(out.steps[0].error).toContain('not in your space')
  })

  it('open-world runs carry no steps (legacy output shape)', async () => {
    const ctx = makeContext(createFakePage()) // no identity/spaces
    const out = await runWith(
      ctx,
      `const s = await browser.observe(1).snapshot(); return s.text`,
    )
    expect(out.isError).toBe(false)
    expect(out.steps).toEqual([])
  })
})

describe('tabs new claim under an MCP clientInfo identity (P1-5 漏网 fix)', () => {
  it('attributes the fresh tab under the ownerOf (convoId) key', async () => {
    const { fake, manager } = await setup()
    // agentId !== convoId — the pre-fix code looked up the current space by
    // agentId and silently skipped the claim for these identities.
    await manager.create(AGENT.convoId, 'tab-new-work')

    const page = createFakePage({
      newTab: (async (url: string) => fake.gateway.newTab(url)) as never,
      tabs: (async () => [...fake.tabs]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const result = await executeTool(tabs, { action: 'new', url: 'https://tabnew.example' }, ctx)
    expect(result?.isError).not.toBe(true)
    expect(textOf(result)).toContain('opened page')

    const opened = fake.tabs[fake.tabs.length - 1]
    const visible = await manager.filterTabsForAgent(AGENT.convoId, [opened])
    expect(visible).toHaveLength(1)
  })
})
