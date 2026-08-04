/**
 * TabFreshness — `screenshot` tool canary + onWedged behavior.
 *
 *  - canary success → normal screenshot path.
 *  - canary timeout → default `onWedged:'hint'` returns the actionable
 *    tab-wedged error; opt-in `onWedged:'auto-recycle'` recycles the page's
 *    task space (close all tabs, reopen each URL fresh) and retries once on
 *    the fresh tab, degrading to the hint when wiring is missing.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskSpaceManager,
  gatewayFromPage,
  type SpaceIdentity,
  type SpaceTabGateway,
  type TabLike,
} from '../../../space/task-space-manager.ts'
import type { UnifiedPage } from '../../../page.js'
import { executeTool } from './framework'
import type { ToolContext } from './framework'
import { screenshot } from './screenshot'
import { createFakePage } from './test-helpers'

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

/** Shared in-memory tab registry backing both a page gateway and a page object. */
function tabRegistry() {
  let next = 300
  const tabs: TabLike[] = []
  const gateway: SpaceTabGateway = {
    newTab: async (url) => {
      const pageId = next++
      const targetId = `target-${pageId}`
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
  /** A UnifiedPage whose tab methods share this registry (usable as ctx.page). */
  function pageForRegistry(overrides: Partial<UnifiedPage> = {}): UnifiedPage {
    return createFakePage({
      newTab: (async (url?: string) =>
        gateway.newTab(url ?? 'about:blank')) as never,
      closeTab: (async (target: number | string) =>
        gateway.closeTab(target)) as never,
      tabs: (async () => [...tabs]) as never,
      selectTab: (async () => {}) as never,
      ...overrides,
    })
  }
  return { tabs, gateway, pageForRegistry }
}

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'shot-')), 'hub-spaces.json')
}

/** Wedged page: canary times out, real screenshot is never reached. */
function wedgedPage(): UnifiedPage {
  return createFakePage({
    canaryCapture: (async () => {
      throw new Error(
        'Canary screenshot failed: this tab’s capture pipeline is wedged',
      )
    }) as never,
    isScreenshotWedged: (() => true) as never,
    screenshot: (async () => {
      throw new Error('should not be reached (canary wedges first)')
    }) as never,
  })
}

describe('screenshot tool — TabFreshness canary + onWedged', () => {
  it('canary success → normal screenshot succeeds', async () => {
    let canaryRan = 0
    const page = createFakePage({
      canaryCapture: (async () => {
        canaryRan++
        return 3
      }) as never,
      screenshot: (async () => 'aGVsbG8=') as never, // "hello"
    })
    const result = await executeTool(
      screenshot,
      { page: 1 },
      { page, pageFor: async () => page },
    )
    expect(result.isError).toBeFalsy()
    expect(canaryRan).toBe(1)
    expect(result.structuredContent).toMatchObject({ page: 1, format: 'jpeg' })
    expect(result.content).toHaveLength(1)
  })

  it("canary:false skips the probe and still detects a wedge via isScreenshotWedged()", async () => {
    let canaryRan = 0
    const page = createFakePage({
      canaryCapture: (async () => {
        canaryRan++
        return 0
      }) as never,
      screenshot: (async () => {
        throw new Error('Screenshot failed: capture pipeline is wedged')
      }) as never,
      isScreenshotWedged: (() => true) as never,
    })
    const result = await executeTool(
      screenshot,
      { page: 1, canary: false },
      { page, pageFor: async () => page },
    )
    expect(canaryRan).toBe(0)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(
      '[hint: tab-wedged -> open a fresh tab via space.open_tab or tabs new',
    )
  })

  it('canary timeout + default onWedged:hint → actionable tab-wedged error', async () => {
    const page = wedgedPage()
    const result = await executeTool(
      screenshot,
      { page: 1 },
      { page, pageFor: async () => page },
    )
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('capture pipeline is wedged')
    expect(text).toContain(
      '[hint: tab-wedged -> open a fresh tab via space.open_tab or tabs new',
    )
  })

  it('explicit onWedged:hint behaves like the default', async () => {
    const page = wedgedPage()
    const result = await executeTool(
      screenshot,
      { page: 1, onWedged: 'hint' },
      { page, pageFor: async () => page },
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('[hint: tab-wedged')
  })

  it('onWedged:auto-recycle without task-space wiring falls back to the hint', async () => {
    const page = wedgedPage()
    const result = await executeTool(
      screenshot,
      { page: 1, onWedged: 'auto-recycle' },
      { page, pageFor: async () => page }, // no identity/spaces
    )
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('[hint: tab-wedged')
    expect(text).toContain('auto-recycle skipped')
  })

  it('onWedged:auto-recycle recycles the page space and retries once on the fresh tab', async () => {
    const reg = tabRegistry()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: reg.gateway,
      persist: false,
    })
    const space = await manager.create('alice', 'work')
    const first = await manager.openTabWithReuse(
      'alice',
      space.id,
      'https://example.com/',
      { background: true },
    )
    const second = await manager.openTabWithReuse(
      'alice',
      space.id,
      'https://example.org/',
      { background: true },
    )
    const firstPage = reg.pageForRegistry({
      canaryCapture: (async () => {
        throw new Error('Canary screenshot failed: capture pipeline is wedged')
      }) as never,
      isScreenshotWedged: (() => true) as never,
    })
    let retriedOn: number | undefined
    const freshPage = createFakePage({
      screenshot: (async () => 'ZnJlc2gtc2NyZWVuc2hvdA==') as never, // fresh screenshot
      isScreenshotWedged: (() => false) as never,
    })
    const ctx: ToolContext = {
      page: firstPage,
      pageFor: async (pageId) => {
        // The initial lookup returns the wedged page (canary times out); the
        // post-recycle retry resolves the NEW pageId to the healthy fresh page.
        if (pageId === first.pageId) return firstPage
        retriedOn = pageId
        return freshPage
      },
      identity: ALICE,
      spaces: manager,
    }

    const result = await executeTool(
      screenshot,
      { page: first.pageId, onWedged: 'auto-recycle' },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      page: number
      recycled: { spaceId: string; fromPage: number; page: number; recycled: number }
    }
    // Recycle closed both tabs and reopened them; the retry landed on the fresh
    // tab for the first URL with a NEW page id.
    expect(sc.page).toBe(sc.recycled.page)
    expect(sc.recycled.spaceId).toBe(space.id)
    expect(sc.recycled.fromPage).toBe(first.pageId)
    expect(sc.recycled.page).not.toBe(first.pageId)
    expect(sc.recycled.recycled).toBe(2)
    expect(retriedOn).toBe(sc.recycled.page)

    // The space ledger now points at the fresh tabs (same URLs, new page ids).
    const ledger = await manager.listTabs(space.id)
    expect(ledger.map((t) => t.url)).toEqual([
      'https://example.com/',
      'https://example.org/',
    ])
    expect(ledger.map((t) => t.pageId)).not.toContain(first.pageId)
    expect(ledger.map((t) => t.pageId)).not.toContain(second.pageId)
    // Both original tabs were closed in the browser and two fresh ones opened.
    expect(reg.tabs).toHaveLength(2)
  })

  it('D3: an agent with no space is rejected by the guard before the canary', async () => {
    // D3 (2026-08-03): space is a hard precondition — the agent owns no space,
    // so the guard rejects the screenshot call before the canary ever runs
    // (no legacy open world, no auto-recycle hint path for no-space agents).
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: gatewayFromPage(createFakePage()),
      persist: false,
    })
    const page = wedgedPage()
    const result = await executeTool(
      screenshot,
      { page: 99, onWedged: 'auto-recycle' },
      { page, pageFor: async () => page, identity: ALICE, spaces: manager },
    )
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('no space')
    expect(text).not.toContain('[hint: tab-wedged')
  })

  it('a page outside any space while isolation is active is rejected by the guard before the canary', async () => {
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      gateway: gatewayFromPage(createFakePage()),
      persist: false,
    })
    await manager.create('alice', 'work') // isolation active; page 99 not in it
    const page = wedgedPage()
    const result = await executeTool(
      screenshot,
      { page: 99, onWedged: 'auto-recycle' },
      { page, pageFor: async () => page, identity: ALICE, spaces: manager },
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not in your space')
  })
})
