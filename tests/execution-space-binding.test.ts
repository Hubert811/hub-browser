/**
 * 修复 3 — adapter commands → current space (execution.js space binding).
 *
 * Covers the contract of `bindAdapterPageToSpace` (exported from
 * src/opencli-engine/execution.js):
 *   1. with a current space → openTabWithReuse is invoked and the command's
 *      tab lands in the space ledger (bug #2/#6), page handle follows;
 *   2. same URL twice → the space tab is reused, not duplicated;
 *   3. D3: without a space → throws SpaceGuardError('no-space') and the
 *      command never runs (no legacy active-tab fallback);
 *   4. binding failure (manager/gateway/openTab throws) → graceful fallback
 *      to the original page, never crashes (no-space is NOT fallback-eligible);
 *   5. resolved pageId differs from the input page → rebind via
 *      browser.connect({ pageId }) (mock manager + mock page);
 *   6. no usable target URL → no binding;
 *   7. domain-only fallback → `https://<domain>` when there is no preNav URL;
 *   8. runtime.js browserSession passes the browser instance to the callback.
 *
 * No real browser is involved — pages/managers/factories are fakes or a real
 * TaskSpaceManager over a temp ledger file.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindAdapterPageToSpace,
  syncBoundTabUrl,
} from '../src/opencli-engine/execution.js'
import { browserSession } from '../src/opencli-engine/runtime.js'
import { TaskSpaceManager } from '../src/space/task-space-manager.ts'
import type { TabLike } from '../src/space/task-space-manager.ts'

const dirs: string[] = []

function tempStoragePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-space-bind-'))
  dirs.push(dir)
  return join(dir, 'hub-spaces.json')
}

/**
 * UnifiedPage-like fake: newTab/selectTab self-rebind `session` (like the real
 * page object), so the helper's normal path sees pageId === pageIdOf(page).
 */
function fakePage(opts: { id?: number; url?: string } = {}): any {
  const initialId = opts.id ?? 7
  let pageId = initialId
  let next = 100
  const tabs: TabLike[] = [
    {
      pageId,
      targetId: `target-${pageId}`,
      url: opts.url ?? 'https://legacy.example/',
      title: undefined,
      isActive: true,
    },
  ]
  return {
    get session() {
      return `page-${pageId}`
    },
    getCurrentUrl: async () => opts.url ?? 'https://legacy.example/',
    goto: async () => {},
    selectTab: async (target: number | string) => {
      const t = tabs.find(
        (x) => x.pageId === target || x.targetId === String(target),
      )
      if (t) pageId = t.pageId
    },
    closeTab: async () => {},
    tabs: async () => [...tabs],
    newTab: async (url: string) => {
      const newPageId = next++
      const targetId = `target-${newPageId}`
      tabs.push({ pageId: newPageId, targetId, url, title: undefined })
      pageId = newPageId // mimic UnifiedPage.newTab self-rebind
      return targetId
    },
  }
}

/** Factory whose connect() records opts and returns a fresh bound page. */
function trackingFactory() {
  const connects: Array<Record<string, unknown>> = []
  const factory = {
    connects,
    connect: async (opts: Record<string, unknown>) => {
      connects.push(opts)
      return { session: `page-${opts?.pageId}`, rebound: true }
    },
    close: async () => {},
  }
  return factory
}

function ledgerSpaces(storagePath: string): Record<string, any> {
  if (!existsSync(storagePath)) return {}
  return JSON.parse(readFileSync(storagePath, 'utf-8')).spaces ?? {}
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ZHIHU_CMD = {
  site: 'zhihu',
  name: 'hot',
  domain: 'zhihu.com',
  navigateBefore: 'https://zhihu.com',
}

describe('bindAdapterPageToSpace — adapter command → current space', () => {
  it('with a current space, calls openTabWithReuse and attributes the tab to the space', async () => {
    const storagePath = tempStoragePath()
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    const space = await setup.create('agent-a', 'space A')

    const page = fakePage({ id: 7 })
    const factory = trackingFactory()
    const out = await bindAdapterPageToSpace({
      page,
      browser: factory,
      cdpEndpoint: 'ws://cdp/',
      cmd: ZHIHU_CMD,
      agentId: 'agent-a',
      storagePath,
    })

    expect(out.bound).toBe(true)
    expect(out.space?.id).toBe(space.id)
    // The page handle self-rebound to the newly opened tab (like UnifiedPage).
    expect(out.page).toBe(page)
    expect(page.session).toBe('page-100')
    // Self-rebinding path needs no separate connect() rebind.
    expect(factory.connects).toEqual([])

    // The tab is attributed to the space ledger (bug #2/#6: owned + closable).
    const spaces = ledgerSpaces(storagePath)
    expect(spaces[space.id].tabs).toEqual([
      { pageId: 100, targetId: 'target-100', url: 'https://zhihu.com', restored: false },
    ])
    expect(spaces[space.id].owner).toBe('agent-a')
  })

  it('reuses an already-attributed tab for the same URL instead of duplicating it', async () => {
    const storagePath = tempStoragePath()
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    const space = await setup.create('agent-a', 'space A')

    const page = fakePage({ id: 7 })
    const factory = trackingFactory()
    const opts = {
      page,
      browser: factory,
      cdpEndpoint: 'ws://cdp/',
      cmd: ZHIHU_CMD,
      agentId: 'agent-a',
      storagePath,
    }

    const first = await bindAdapterPageToSpace(opts)
    const second = await bindAdapterPageToSpace(opts)

    expect(first.bound).toBe(true)
    expect(second.bound).toBe(true)
    // Still exactly one space tab — second call reused pageId 100.
    const spaces = ledgerSpaces(storagePath)
    expect(spaces[space.id].tabs).toHaveLength(1)
    expect(spaces[space.id].tabs[0].pageId).toBe(100)
    expect(factory.connects).toEqual([])
  })

  it('D3: without a space the command is rejected with no-space (no legacy fallback)', async () => {
    const storagePath = tempStoragePath()
    const page = fakePage({ id: 7 })
    const factory = trackingFactory()
    await expect(
      bindAdapterPageToSpace({
        page,
        browser: factory,
        cdpEndpoint: 'ws://cdp/',
        cmd: ZHIHU_CMD,
        agentId: 'ghost',
        storagePath,
      }),
    ).rejects.toMatchObject({
      name: 'SpaceGuardError',
      code: 'no-space',
    })
    // Nothing was bound, opened, or written to the ledger.
    expect(page.session).toBe('page-7')
    expect(factory.connects).toEqual([])
    expect(ledgerSpaces(storagePath)).toEqual({})
  })

  it('D3: mock manager with currentSpace === null rejects the command (no-space)', async () => {
    const calls: Array<unknown[]> = []
    const manager = {
      currentSpace: async (agentId: string) => {
        calls.push(['currentSpace', agentId])
        return null
      },
      openTabWithReuse: async () => {
        throw new Error('openTabWithReuse must not be called')
      },
    }
    const page = fakePage({ id: 7 })
    const connects: Array<Record<string, unknown>> = []
    const browser = {
      connect: async (opts: Record<string, unknown>) => {
        connects.push(opts)
        return { session: 'page-1' }
      },
    }
    await expect(
      bindAdapterPageToSpace({
        page,
        browser,
        cdpEndpoint: 'ws://cdp/',
        cmd: ZHIHU_CMD,
        agentId: 'ghost',
        manager,
      }),
    ).rejects.toMatchObject({
      name: 'SpaceGuardError',
      code: 'no-space',
    })
    expect(calls).toEqual([['currentSpace', 'ghost']])
    expect(page.session).toBe('page-7')
    expect(connects).toEqual([])
  })

  it('falls back to the original page when space binding fails (never crashes)', async () => {
    const storagePath = tempStoragePath()
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    await setup.create('agent-a', 'space A')

    const page = fakePage({ id: 7 })
    page.newTab = async () => {
      throw new Error('boom: browser refused to open a tab')
    }
    const factory = trackingFactory()
    const out = await bindAdapterPageToSpace({
      page,
      browser: factory,
      cdpEndpoint: 'ws://cdp/',
      cmd: ZHIHU_CMD,
      agentId: 'agent-a',
      storagePath,
    })

    expect(out.bound).toBe(false)
    expect(out.page).toBe(page)
    expect(page.session).toBe('page-7')
    expect(factory.connects).toEqual([])
    // No partial ledger write: the failed open left no tab behind.
    const spaces = ledgerSpaces(storagePath)
    expect(spaces[Object.keys(spaces)[0]].tabs).toEqual([])
  })

  it('rebinds to the space tab via browser.connect when the resolved pageId differs (mock manager/page)', async () => {
    const page = {
      session: 'page-7',
      getCurrentUrl: async () => 'https://legacy.example/',
      newTab: async () => 'target-9',
      tabs: async () => [
        { pageId: 9, targetId: 'target-9', url: 'https://zhihu.com' },
      ],
      selectTab: async () => {},
      closeTab: async () => {},
    }
    const calls: Array<unknown[]> = []
    const manager = {
      currentSpace: async (agentId: string) => {
        calls.push(['currentSpace', agentId])
        return {
          id: 'space-1',
          name: 's',
          owner: agentId,
          ownership: 'agent',
          createdAt: '',
          lastActiveAt: '',
          tabIds: [],
        }
      },
      openTabWithReuse: async (
        owner: string,
        spaceId: string,
        url: string,
        opts: unknown,
        gateway: unknown,
      ) => {
        calls.push(['openTabWithReuse', owner, spaceId, url, opts, typeof gateway])
        return { pageId: 42, reused: false }
      },
    }
    const boundPage = { session: 'page-42', rebound: true }
    const connects: Array<Record<string, unknown>> = []
    const browser = {
      connect: async (opts: Record<string, unknown>) => {
        connects.push(opts)
        return boundPage
      },
    }

    const out = await bindAdapterPageToSpace({
      page,
      browser,
      cdpEndpoint: 'ws://cdp/',
      cmd: ZHIHU_CMD,
      agentId: 'agent-b',
      manager,
    })

    expect(out.bound).toBe(true)
    expect(out.space?.id).toBe('space-1')
    expect(out.page).toBe(boundPage)
    expect(out.pageId).toBe(42)
    expect(out.agentId).toBe('agent-b')
    expect(out.manager).toBe(manager)
    expect(calls[0]).toEqual(['currentSpace', 'agent-b'])
    expect(calls[1][0]).toBe('openTabWithReuse')
    expect(calls[1][1]).toBe('agent-b')
    expect(calls[1][2]).toBe('space-1')
    expect(calls[1][3]).toBe('https://zhihu.com')
    // bug #20: domain-root binding targets reuse any same-origin tab (upstream
    // opencli persistent semantics) instead of exact-URL matching, which never
    // hit the deep page URL the previous run navigated to.
    expect(calls[1][4]).toEqual({ background: false, reuse: 'origin' })
    expect(calls[1][5]).toBe('object') // gatewayFromPage(page) passed through
    expect(connects).toEqual([{ pageId: 42, cdpEndpoint: 'ws://cdp/' }])
  })

  it('skips binding when no target URL can be resolved (even with a current space)', async () => {
    const storagePath = tempStoragePath()
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    await setup.create('agent-a', 'space A')

    const page = fakePage({ id: 7 })
    page.getCurrentUrl = async () => null
    const factory = trackingFactory()
    const out = await bindAdapterPageToSpace({
      page,
      browser: factory,
      cdpEndpoint: 'ws://cdp/',
      cmd: { site: 'x', name: 'y' }, // no navigateBefore, no domain
      agentId: 'agent-a',
      storagePath,
    })

    expect(out.bound).toBe(false)
    expect(out.page).toBe(page)
    expect(factory.connects).toEqual([])
    expect(ledgerSpaces(storagePath)[Object.keys(ledgerSpaces(storagePath))[0]].tabs).toEqual([])
  })

  it('falls back to https://<domain> when there is no preNav URL', async () => {
    const storagePath = tempStoragePath()
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    const space = await setup.create('agent-a', 'space A')

    const page = fakePage({ id: 7 })
    const factory = trackingFactory()
    const out = await bindAdapterPageToSpace({
      page,
      browser: factory,
      cdpEndpoint: 'ws://cdp/',
      cmd: { site: 'imdb', name: 'bestsellers', domain: 'www.imdb.com' },
      agentId: 'agent-a',
      storagePath,
    })

    expect(out.bound).toBe(true)
    expect(out.page).toBe(page)
    const spaces = ledgerSpaces(storagePath)
    expect(spaces[space.id].tabs[0].url).toBe('https://www.imdb.com')
  })
})

describe('browserSession — passes the browser instance to the callback', () => {
  it('lets the callback rebind on the same underlying connection', async () => {
    const browser = {
      connects: [] as Array<Record<string, unknown>>,
      async connect(opts: Record<string, unknown>) {
        this.connects.push(opts)
        return { session: 'page-1' }
      },
      closed: false,
      async close() {
        this.closed = true
      },
    }
    const Factory = function () {
      return browser
    }
    let sawBrowser: unknown
    const result = await browserSession(
      Factory as never,
      async (_page: unknown, b: unknown) => {
        sawBrowser = b
        return 'done'
      },
      { cdpEndpoint: 'ws://cdp/' },
    )
    expect(result).toBe('done')
    expect(sawBrowser).toBe(browser)
    expect(browser.connects[0]).toMatchObject({ cdpEndpoint: 'ws://cdp/' })
    expect(browser.closed).toBe(true)
  })
})

describe('syncBoundTabUrl — ledger URL sync after adapter navigation (bug #7)', () => {
  it('updates the ledger URL for a bound space tab (mock manager/page)', async () => {
    const calls: Array<unknown[]> = []
    const binding = {
      bound: true,
      space: { id: 'space-1', name: 's', owner: 'agent-a' },
      pageId: 42,
      agentId: 'agent-a',
      manager: {
        updateTabUrl: async (
          owner: string,
          spaceId: string,
          pageId: number,
          url: string,
        ) => {
          calls.push([owner, spaceId, pageId, url])
          return true
        },
      },
    }
    const page = { getCurrentUrl: async () => 'https://zhihu.com/hot' }
    const ok = await syncBoundTabUrl(binding, page)
    expect(ok).toBe(true)
    expect(calls).toEqual([
      ['agent-a', 'space-1', 42, 'https://zhihu.com/hot'],
    ])
  })

  it('is a no-op without a space binding (no updateTabUrl call)', async () => {
    const calls: Array<unknown[]> = []
    const manager = {
      updateTabUrl: async (..._args: unknown[]) => {
        calls.push(_args)
        return true
      },
    }
    expect(
      await syncBoundTabUrl(
        { bound: false, pageId: undefined, manager },
        { getCurrentUrl: async () => 'https://zhihu.com/hot' },
      ),
    ).toBe(false)
    expect(await syncBoundTabUrl(undefined, {})).toBe(false)
    expect(
      await syncBoundTabUrl(
        { bound: true, space: { id: 's' }, pageId: undefined, manager },
        {},
      ),
    ).toBe(false)
    expect(calls).toEqual([])
  })

  it('swallows manager failures (never throws, returns false)', async () => {
    const binding = {
      bound: true,
      space: { id: 'space-1' },
      pageId: 42,
      agentId: 'agent-a',
      manager: {
        updateTabUrl: async () => {
          throw new Error('boom: ledger write failed')
        },
      },
    }
    await expect(
      syncBoundTabUrl(binding, { getCurrentUrl: async () => 'https://zhihu.com/hot' }),
    ).resolves.toBe(false)
  })

  it('falls back to the active-page object url when getCurrentUrl is absent', async () => {
    const calls: Array<unknown[]> = []
    const binding = {
      bound: true,
      space: { id: 'space-1' },
      pageId: 7,
      agentId: 'agent-a',
      manager: {
        updateTabUrl: async (...args: unknown[]) => {
          calls.push(args)
          return true
        },
      },
    }
    const page = { getActivePage: () => ({ url: 'https://bilibili.com/video/1' }) }
    const ok = await syncBoundTabUrl(binding, page)
    expect(ok).toBe(true)
    expect(calls).toEqual([
      ['agent-a', 'space-1', 7, 'https://bilibili.com/video/1'],
    ])
  })

  it('end-to-end: bound adapter command → syncBoundTabUrl writes the new URL to the space ledger', async () => {
    const storagePath = tempStoragePath()
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    const space = await setup.create('agent-a', 'space A')

    const page = fakePage({ id: 7 })
    const factory = trackingFactory()
    const binding = await bindAdapterPageToSpace({
      page,
      browser: factory,
      cdpEndpoint: 'ws://cdp/',
      cmd: ZHIHU_CMD,
      agentId: 'agent-a',
      storagePath,
    })
    expect(binding.bound).toBe(true)
    expect(typeof binding.pageId).toBe('number')
    expect(binding.manager).toBeInstanceOf(TaskSpaceManager)

    // The adapter command navigated the bound tab (simulated): the page now
    // reports a URL the ledger does not know yet.
    page.getCurrentUrl = async () => 'https://zhihu.com/hot'
    const ok = await syncBoundTabUrl(binding, page)
    expect(ok).toBe(true)

    const spaces = ledgerSpaces(storagePath)
    expect(spaces[space.id].tabs).toHaveLength(1)
    expect(spaces[space.id].tabs[0].url).toBe('https://zhihu.com/hot')
  })
})

describe('bug 2 — failed adapter command still syncs the bound tab URL (catch path)', () => {
  it('executeCommand catch path calls syncBoundTabUrl and the ledger URL updates before the error rethrows', async () => {
    const storagePath = tempStoragePath()
    // Space owned by the CLI identity, persisted to the shared ledger.
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    const space = await setup.create('agent-a', 'space A')

    // Fake BrowserOS neo session over a shared tab registry. The singleton
    // (__HubBrowserFactory) seam lets UnifiedBrowserFactory.connect() reuse
    // this session without any real CDP connection.
    const tabs: Array<{
      pageId: number
      targetId: string
      tabId: string
      url: string
      isActive: boolean
    }> = [
      {
        pageId: 7,
        targetId: 'target-7',
        tabId: 'tab-7',
        url: 'https://legacy.example/',
        isActive: true,
      },
    ]
    let nextId = 100
    const session = {
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => {
          if (expression === 'navigator.userAgent') {
            return {
              result: {
                value:
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
              },
            }
          }
          if (expression.includes('getHighEntropyValues')) {
            return {
              result: {
                value: {
                  platform: 'macOS',
                  platformVersion: '26.5.2',
                  architecture: 'arm',
                  bitness: '64',
                  model: '',
                  uaFullVersion: '148.0.7974.97',
                },
              },
            }
          }
          if (expression === 'window.location.href') {
            // The browser's ACTUAL url after the (failed) adapter navigation.
            return { result: { value: 'https://zhihu.com/question/1' } }
          }
          return { result: { value: undefined } }
        },
      },
      Emulation: { setUserAgentOverride: async () => ({}) },
      Page: { addScriptToEvaluateOnNewDocument: async () => ({}) },
    }
    const fakeSession = {
      pages: {
        list: async () => tabs.map((t) => ({ ...t })),
        newPage: async (url: string) => {
          const pageId = nextId++
          tabs.push({
            pageId,
            targetId: `target-${pageId}`,
            tabId: `tab-${pageId}`,
            url,
            isActive: false,
          })
          return pageId
        },
        getSession: async (pageId: number) => ({
          sessionId: `s-${pageId}`,
          session,
        }),
        getInfo: (pageId: number) => tabs.find((t) => t.pageId === pageId),
      },
      cdpJsonForPage: async (_pageId: number, method: string) => {
        switch (method) {
          case 'Browser.getTabGroups':
            return { groups: [] }
          case 'Browser.createTabGroup':
            return { group: { groupId: 'g-1', tabIds: [] } }
          default:
            return {}
        }
      },
    }
    ;(globalThis as any).__HubBrowserFactory = {
      _cdp: {},
      _session: fakeSession,
    }
    process.env.HUB_SPACES_FILE = storagePath
    process.env.HUB_AGENT_ID = 'agent-a'
    try {
      const { executeCommand } = await import('../src/opencli-engine/execution.js')
      const failingCmd = {
        site: 'zhihu',
        name: 'fail-once',
        domain: 'zhihu.com',
        navigateBefore: false,
        browser: true,
        args: [] as Array<Record<string, unknown>>,
        func: async () => {
          throw new Error('boom: extraction failed')
        },
      }
      // The original error must propagate unchanged.
      await expect(executeCommand(failingCmd, {})).rejects.toThrow(
        'boom: extraction failed',
      )

      // The bound tab in the ledger now carries the browser's actual URL
      // (bug #7 catch path) — exact-reuse on a retry will match it.
      const spaces = ledgerSpaces(storagePath)
      const tab = spaces[space.id].tabs[0]
      expect(tab.pageId).toBe(100)
      expect(tab.url).toBe('https://zhihu.com/question/1')
    } finally {
      delete (globalThis as any).__HubBrowserFactory
      delete process.env.HUB_SPACES_FILE
      delete process.env.HUB_AGENT_ID
    }
  })
})
