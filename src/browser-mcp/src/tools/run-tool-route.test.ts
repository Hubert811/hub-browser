/**
 * P1-8 tool: routing — `browser.tool(name, args)` dispatches whitelisted
 * MCP tools (read/grep/wait/screenshot/evaluate/download/pdf/upload/
 * tab_groups/windows) through the same executeTool pipeline the MCP surface
 * uses, so the space guard re-runs inside (idempotent) and every routed
 * call lands an audit sub-row named `tool:<name>`.
 *
 * `run` itself is not routable (recursion guard); tools already covered by
 * direct SDK primitives (snapshot/act/goto/tabs) stay on those primitives.
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
  convoId: 'mcp:claude-code:tool-route',
  displayName: 'claude-code',
}

async function setup() {
  const fake = createFakeGateway()
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'run-tool-')), 's.json'),
    gateway: fake.gateway,
    persist: false,
  })
  const space = await manager.create(AGENT.convoId, 'route-work')
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

describe('run tool: routing (P1-8)', () => {
  it('routes read through executeTool and returns structuredContent + text', async () => {
    const { fake, manager, ownTab } = await setup()
    const page = createFakePage({
      tabs: (async () => [...fake.tabs]) as never,
      evaluate: (async () => '# Routed read content') as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `const r = await browser.tool('read', { page: ${ownTab} }); return r`,
    )
    expect(out.isError).toBe(false)
    const value = out.value as { page: number; contentLength: number; text: string }
    expect(value.page).toBe(ownTab)
    expect(value.contentLength).toBeGreaterThan(0)
    // The page text is attached so scripts can consume it directly.
    expect(value.text).toContain('# Routed read content')
  })

  it('re-runs the space guard inside executeTool — foreign pages reject', async () => {
    const { manager, foreignTab } = await setup()
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `await browser.tool('read', { page: ${foreignTab} }); return 'unreachable'`,
    )
    expect(out.isError).toBe(true)
    expect(out.text).toContain('not in your space')
  })

  it('routes page-less browser tools (windows)', async () => {
    const { manager } = await setup()
    const page = createFakePage({
      windowList: (async () => [
        { windowId: 7, windowType: 'normal', tabCount: 2, isActive: true },
      ]) as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `const r = await browser.tool('windows', { action: 'list' }); return r.windows[0].windowId`,
    )
    expect(out.isError).toBe(false)
    expect(out.value).toBe(7)
  })

  it('rejects tools outside the allowlist (run recursion guard / direct-primitive overlap)', async () => {
    const { manager } = await setup()
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const recursion = await runWith(
      ctx,
      `await browser.tool('run', { code: 'return 1' }); return 'unreachable'`,
    )
    expect(recursion.isError).toBe(true)
    expect(recursion.text).toContain('is not exposed')

    const direct = await runWith(
      ctx,
      `await browser.tool('snapshot', { page: 1 }); return 'unreachable'`,
    )
    expect(direct.isError).toBe(true)
    expect(direct.text).toContain('is not exposed')
  })

  it('audit sub-rows name routed tools tool:<name> with the page id', async () => {
    const { fake, manager, ownTab } = await setup()
    const page = createFakePage({
      tabs: (async () => [...fake.tabs]) as never,
      evaluate: (async () => '# audited') as never,
    })
    const ctx: ToolContext = {
      ...makeContext(page),
      identity: AGENT,
      spaces: manager,
    }
    const out = await runWith(
      ctx,
      `await browser.tool('read', { page: ${ownTab} }); return 'done'`,
    )
    expect(out.isError).toBe(false)
    expect(out.steps).toHaveLength(1)
    expect(out.steps[0]).toMatchObject({
      tool: 'tool:read',
      pageId: ownTab,
      ok: true,
    })
  })

  it('open-world tool routing works without identity (legacy guard-free path)', async () => {
    const page = createFakePage({
      windowList: (async () => [
        { windowId: 3, windowType: 'normal', tabCount: 1 },
      ]) as never,
    })
    const ctx = makeContext(page) // no identity/spaces
    const out = await runWith(
      ctx,
      `const r = await browser.tool('windows', { action: 'list' }); return r.count`,
    )
    expect(out.isError).toBe(false)
    expect(out.value).toBe(1)
    // No hook installed → no audit sub-rows, legacy shape.
    expect(out.steps).toEqual([])
  })
})
