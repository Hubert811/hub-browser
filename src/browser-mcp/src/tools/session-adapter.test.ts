/**
 * Session-mode harness (方案 2) — simulates apps/server's tool-adapter.
 *
 * apps/server/src/agent/tool-adapter.ts (vendored, read-only) calls the fork
 * the old way:
 *
 *   import { BROWSER_TOOLS } from '@browseros/browser-mcp/registry'
 *   import { executeTool } from '@browseros/browser-mcp/tools/framework'
 *   ...
 *   executeTool(def, params, { session, signal })
 *
 * This test exercises exactly that surface with a fake BrowserSession: every
 * one of the 17 tools must run through the session→UnifiedPage bridge
 * (session-adapter.ts) without missing `page`/`pageFor`.
 */
import { describe, expect, it } from 'bun:test'
import { UnifiedPage } from '../../../page.js'
import {
  executeTool,
  type ToolDefinition,
  type ToolResult,
} from './framework'
import { BROWSER_TOOLS } from './registry'
import {
  contextFromSession,
  isSessionContext,
  pageFromSession,
  type SessionToolContext,
} from './session-adapter'
import { textOf } from './test-helpers'

/** Minimal BrowserSession-shaped fake covering what the 17 tools touch. */
function createFakeSession(): unknown {
  const pages = [
    {
      pageId: 1,
      targetId: 'target-1',
      tabId: 101,
      url: 'https://example.com/1',
      title: 'Page 1',
      isActive: true,
    },
    {
      pageId: 2,
      targetId: 'target-2',
      tabId: 102,
      url: 'https://example.com/2',
      title: 'Page 2',
      isActive: false,
    },
  ]

  const pageSession = {
    Runtime: {
      evaluate: async () => ({
        result: { value: '<html><body><h1>Hello</h1></body></html>' },
      }),
      disable: async () => {},
      enable: async () => {},
      callFunctionOn: async () => ({}),
    },
    Page: {
      addScriptToEvaluateOnNewDocument: async () => ({}),
      setDownloadBehavior: async () => {},
      getFrameTree: async () => ({
        frameTree: { frame: { id: 'f1', url: 'about:blank' }, childFrames: [] },
      }),
      on: (event: string, cb: (params: Record<string, unknown>) => void) => {
        // Auto-complete the download flow so `download` does not hang.
        if (event === 'downloadWillBegin') {
          queueMicrotask(() => cb({ guid: 'g1', suggestedFilename: 'fake.txt' }))
        }
        if (event === 'downloadProgress') {
          queueMicrotask(() => cb({ guid: 'g1', state: 'completed' }))
        }
        return () => {}
      },
    },
    DOM: { resolveNode: async () => ({ object: { objectId: 'o1' } }) },
  }

  const cdpResponses: Record<string, unknown> = {
    'Page.captureScreenshot': { data: 'aGVsbG8=' }, // base64("hello")
    'Page.printToPDF': { data: 'aGVsbG8=' },
    'History.getRecent': { entries: [] },
    'Browser.getTabGroups': { groups: [] },
    'Browser.getWindows': {
      windows: [{ windowId: 1, windowType: 'normal', tabCount: 2, isActive: true }],
    },
    'Browser.createWindow': { window: { windowId: 2 } },
  }

  return {
    pages: {
      list: async () => pages,
      getSession: async () => ({ session: pageSession, sessionId: 's1' }),
      getInfo: (pageId: number) => pages.find((p) => p.pageId === pageId),
      newPage: async () => 3,
      close: async () => {},
    },
    observe: () => ({
      snapshot: async () => ({
        text: 'hello page',
        refs: { byRef: new Map(), byLabel: new Map() },
      }),
      diff: async () => ({
        changed: false,
        text: 'no changes',
        refs: { byRef: new Map() },
      }),
    }),
    nav: () => ({ goto: async () => {} }),
    input: () => ({}),
    cdpJsonForPage: async (
      _pageId: number,
      method: string,
      _paramsJson: string,
    ) => cdpResponses[method] ?? {},
    protocol: { onSessionEvent: () => () => {} },
    dispose: async () => {},
  }
}

/** Args that make each tool run (page required everywhere it is in the schema). */
const SESSION_ARGS: Record<string, Record<string, unknown>> = {
  tabs: { action: 'list' },
  tab_groups: { action: 'list' },
  history: { maxResults: 10 },
  navigate: { page: 1, action: 'url', url: 'https://example.com/1' },
  snapshot: { page: 1 },
  diff: { page: 1 },
  act: { page: 1, kind: 'click', ref: 'e1' },
  download: { page: 1, ref: 'e1' },
  upload: { page: 1, ref: 'e1', files: ['/tmp/fake-upload.txt'] },
  read: { page: 1, format: 'text' },
  grep: { page: 1, pattern: 'hello', over: 'ax' },
  screenshot: { page: 1, format: 'jpeg' },
  pdf: { page: 1 },
  wait: { page: 1, for: 'time', value: 0 },
  windows: { action: 'list' },
  evaluate: { page: 1, code: 'return 1 + 1' },
  run: { code: 'return "ok"' },
}

describe('session→UnifiedPage bridge (方案 2, apps/server compatibility)', () => {
  it('isSessionContext distinguishes the vendored session shape', () => {
    const session = createFakeSession()
    const page = pageFromSession(session as never, 1)
    expect(isSessionContext({ session: session as never })).toBe(true)
    expect(
      isSessionContext({
        page,
        pageFor: async () => page,
      }),
    ).toBe(false)
  })

  it('contextFromSession builds a working page/pageFor over the session', async () => {
    const session = createFakeSession()
    const ctx = await contextFromSession({ session: session as never })
    expect(ctx.page).toBeInstanceOf(UnifiedPage)
    expect(ctx.pageFor).toBeFunction()
    expect(await ctx.page.tabs()).toHaveLength(2)
    const page2 = await ctx.pageFor(2)
    expect(page2).toBeInstanceOf(UnifiedPage)
    // Active page on the session is page 1.
    expect((await ctx.page.tabs())[0]).toMatchObject({ pageId: 1, isActive: true })
  })

  it('runs every BROWSER_TOOL with a session ctx (apps/server style)', async () => {
    const session = createFakeSession()
    expect(BROWSER_TOOLS).toHaveLength(17)

    for (const def of BROWSER_TOOLS as readonly ToolDefinition[]) {
      const args = SESSION_ARGS[def.name]
      expect(args, `missing harness args for tool ${def.name}`).toBeDefined()

      const ctx: SessionToolContext = { session: session as never }
      const result: ToolResult = await executeTool(def, args, ctx)

      expect(result, `tool ${def.name}`).toBeDefined()
      expect(Array.isArray(result.content), `tool ${def.name} content`).toBe(
        true,
      )

      // The session bridge must have provided a page: a missing page/pageFor
      // would have thrown out of executeTool instead of producing a result.
      const text = textOf(result)
      expect(typeof text, `tool ${def.name} text`).toBe('string')
    }
  })

  it('session-mode tools that need page-bound work actually succeed', async () => {
    const session = createFakeSession()
    const ctx: SessionToolContext = { session: session as never }

    const snap = await executeTool(
      BROWSER_TOOLS.find((t) => t.name === 'snapshot')!,
      { page: 1 },
      ctx,
    )
    expect(snap.isError).toBeFalsy()
    expect(textOf(snap)).toContain('hello page')

    const nav = await executeTool(
      BROWSER_TOOLS.find((t) => t.name === 'navigate')!,
      { page: 1, action: 'url', url: 'https://example.com/1' },
      ctx,
    )
    expect(nav.isError).toBeFalsy()

    const tabs = await executeTool(
      BROWSER_TOOLS.find((t) => t.name === 'tabs')!,
      { action: 'list' },
      ctx,
    )
    expect(tabs.isError).toBeFalsy()
    expect(textOf(tabs)).toContain('Page 1')

    const evalResult = await executeTool(
      BROWSER_TOOLS.find((t) => t.name === 'evaluate')!,
      { page: 1, code: 'return 1 + 1' },
      ctx,
    )
    expect(evalResult.isError).toBeFalsy()
  })
})
