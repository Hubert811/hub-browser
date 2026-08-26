/**
 * P1-8 / P0-2 — run SDK primitives pass the space guard.
 *
 * The run worker's bridged calls now flow through authorizeCall(): a
 * page-scoped primitive (observe/input/nav/pages.close/getInfo) on a page
 * outside the caller's space is rejected, pages.list() results are
 * filtered to the caller's own tabs, and the cross-page cdp Target.*
 * escape hatch is denied. Open-world callers (no identity) are unchanged.
 *
 * Uses a real TaskSpaceManager over a fake gateway, mirroring
 * space-guard.test.ts.
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
import { createFakePage, makeContext } from './test-helpers'
import type { ToolContext } from './framework'

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
  convoId: 'mcp:claude-code:run-guard',
  displayName: 'claude-code',
}

async function setup() {
  const fake = createFakeGateway()
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'run-guard-')), 's.json'),
    gateway: fake.gateway,
    persist: false,
  })
  // The agent owns one space with one tab (pageId from the fake gateway).
  const space = await manager.create(AGENT.convoId, 'run-work')
  const foreign = await manager.create('other-agent', 'foreign-work')
  const ownTab = await manager.openTab(AGENT.convoId, space.id, 'https://own.example')
  const foreignTab = await manager.openTab('other-agent', foreign.id, 'https://foreign.example')
  return { fake, manager, ownTab, foreignTab }
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

async function runWith(
  ctx: ToolContext,
  code: string,
  timeout?: number,
) {
  const result = await executeTool(
    run,
    { code, ...(timeout && { timeout }) },
    ctx,
  )
  return {
    text: textOf(result),
    isError: result?.isError === true,
    value: (result as { structuredContent?: { value?: unknown } } | undefined)
      ?.structuredContent?.value,
  }
}

describe('run SDK primitives pass the space guard (P1-8/P0-2)', () => {
  it('rejects observe() on a page outside the caller\'s space', async () => {
    const { manager, foreignTab } = await setup()
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(ctx, `const s = await browser.observe(${foreignTab}).snapshot(); return s.text`)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('not in your space')
  })

  it('allows observe() on a page inside the caller\'s space', async () => {
    const { manager, ownTab } = await setup()
    const page = createFakePage({
      snapshot: async () => `[ref=e1] button "Go" on page ${ownTab}` as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(ctx, `const s = await browser.observe(${ownTab}).snapshot(); return s.text`)
    expect(out.isError).toBe(false)
    expect(out.value).toContain('button "Go"')
  })

  it('rejects input() and pages.close() on foreign pages', async () => {
    const { manager, foreignTab } = await setup()
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const clickOut = await runWith(
      ctx,
      `await browser.input(${foreignTab}).click('e1'); return 'clicked'`,
    )
    expect(clickOut.isError).toBe(true)
    expect(clickOut.text).toContain('not in your space')

    const closeOut = await runWith(
      ctx,
      `await browser.pages.close(${foreignTab}); return 'closed'`,
    )
    expect(closeOut.isError).toBe(true)
    expect(closeOut.text).toContain('not in your space')
  })

  it('filters pages.list() down to the caller\'s own tabs', async () => {
    const { fake, manager, ownTab, foreignTab } = await setup()
    const page = createFakePage({
      tabs: async () => [...fake.tabs] as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(ctx, `const t = await browser.pages.list(); return t.map(x => x.pageId)`)
    expect(out.isError).toBe(false)
    // Only the agent's own tab; the foreign agent's tab never leaks.
    expect(out.value).toEqual([ownTab])
    expect(out.value).not.toContain(foreignTab)
  })

  it('denies the cross-page cdp Target.* escape hatch', async () => {
    const { manager } = await setup()
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `await browser.cdp('Target.createTarget', { url: 'about:blank' }); return 'opened'`,
    )
    expect(out.isError).toBe(true)
    expect(out.text).toContain('Target.*')
  })

  it('open-world callers (no identity) keep the legacy unguarded behavior', async () => {
    const { foreignTab } = await setup()
    const page = createFakePage({
      snapshot: async () => '[ref=e1] button "Any"' as never,
    })
    const ctx = makeContext(page) // no identity/spaces
    const out = await runWith(ctx, `const s = await browser.observe(${foreignTab}).snapshot(); return s.text`)
    expect(out.isError).toBe(false)
    expect(out.value).toContain('button "Any"')
  })
})
