/**
 * P1-5 — tri-bucket tab ownership (mine / user / other-agent).
 *
 * `tabs list view=all` returns every live tab annotated with its ownership
 * from the caller's point of view. Non-mine tabs are identity-only
 * (pageId + ownership + the owning space's name): url/title are stripped,
 * so an agent learns WHO holds a tab, not WHAT is in it (D3's leakage
 * boundary stays intact). Operating on non-mine tabs remains rejected by
 * the existing guards — visibility is not operability.
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
import { tabs } from './tabs'
import { createFakePage, makeContext } from './test-helpers'

function createFakeGateway(): { tabs: TabLike[]; gateway: SpaceTabGateway } {
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
  convoId: 'mcp:claude-code:tri',
  displayName: 'claude-code',
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

async function setup() {
  const fake = createFakeGateway()
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'tri-bucket-')), 's.json'),
    gateway: fake.gateway,
    persist: false,
  })
  const mine = await manager.create(AGENT.convoId, 'my-work')
  const other = await manager.create('other-agent', 'their-work')
  const mineTab = await manager.openTab(AGENT.convoId, mine.id, 'https://mine.example')
  const otherTab = await manager.openTab('other-agent', other.id, 'https://secret.example')

  // A live tab list containing: own tab, foreign tab, and an unspace'd tab
  // (opened by the human directly in the browser).
  const live: TabLike[] = [
    { pageId: mineTab, url: 'https://mine.example', title: 'Mine' },
    { pageId: otherTab, url: 'https://secret.example', title: 'Secret' },
    { pageId: 999, url: 'https://user.example', title: 'User' },
  ]
  const page = createFakePage({ tabs: async () => [...live] as never })
  const ctx = { ...makeContext(page), identity: AGENT, spaces: manager }
  return { fake, manager, mineTab, otherTab, ctx, live }
}

describe('tri-bucket ownership (P1-5)', () => {
  it('classifyTabsForAgent annotates mine / other-agent / user and strips non-mine detail', async () => {
    const { manager, otherTab, live } = await setup()
    const classified = await manager.classifyTabsForAgent(AGENT.convoId, live)

    const mineEntry = classified.find((c) => c.pageId === 1)
    expect(mineEntry?.ownership).toBe('mine')
    expect(mineEntry?.url).toBe('https://mine.example')

    const otherEntry = classified.find((c) => c.pageId === otherTab)
    expect(otherEntry?.ownership).toBe('other-agent')
    expect(otherEntry?.ownerLabel).toBe('their-work')
    expect(otherEntry?.url).toBeUndefined()
    expect(otherEntry?.title).toBeUndefined()

    const userEntry = classified.find((c) => c.pageId === 999)
    expect(userEntry?.ownership).toBe('user')
    expect(userEntry?.url).toBeUndefined()
  })

  it('a handed-off space becomes user-owned in the view', async () => {
    const { manager, live } = await setup()
    // Hand the agent's space off to the user, then re-classify.
    const mineSpace = (await manager.listSpaces(AGENT.convoId))[0]
    await manager.handOff(AGENT.convoId, mineSpace.id)
    const classified = await manager.classifyTabsForAgent(AGENT.convoId, live)
    const handedOff = classified.find((c) => c.pageId === 1)
    expect(handedOff?.ownership).toBe('user')
    expect(handedOff?.url).toBeUndefined()
  })

  it('tabs list view=all returns the tri-bucket view without leaking urls', async () => {
    const { ctx, otherTab } = await setup()
    const result = await executeTool(tabs, { action: 'list', view: 'all' }, ctx)
    const text = textOf(result)
    const structured = (result as { structuredContent?: any }).structuredContent

    expect(result?.isError).not.toBe(true)
    expect(text).toContain('https://mine.example')
    expect(text).toContain('other-agent')
    expect(text).toContain('their-work')
    expect(text).toContain('user')
    // The foreign tab's url/title never leak.
    expect(text).not.toContain('secret.example')
    expect(text).not.toContain('Secret')

    const pages = structured?.pages as Array<Record<string, unknown>>
    const other = pages.find((p) => p.page === otherTab)
    expect(other?.ownership).toBe('other-agent')
    expect(other?.ownerLabel).toBe('their-work')
    expect(other?.url).toBeUndefined()
  })

  it('tabs list default view stays the owned-only filter (D3 unchanged)', async () => {
    const { ctx } = await setup()
    const result = await executeTool(tabs, { action: 'list' }, ctx)
    const text = textOf(result)
    expect(text).toContain('https://mine.example')
    expect(text).not.toContain('other-agent')
    expect(text).not.toContain('https://user.example')
  })

  it('visibility is not operability: closing a foreign tab is still rejected', async () => {
    const { ctx, otherTab } = await setup()
    const result = await executeTool(
      tabs,
      { action: 'close', page: otherTab },
      ctx,
    )
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('not in your space')
  })
})
