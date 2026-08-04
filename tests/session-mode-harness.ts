/**
 * Session-mode harness for 方案 2 — proves apps/server resolves to the fork.
 *
 * This file imports the fork through the exact specifiers apps/server's
 * vendored tool-adapter.ts uses:
 *
 *   @browseros/browser-mcp/registry
 *   @browseros/browser-mcp/tools/framework
 *   @browseros/browser-mcp/output-file
 *
 * Resolution lands on the fork via the `node_modules/@browseros/browser-mcp`
 * symlink (recreated by the root postinstall). The bridge
 * (src/browser-mcp/src/tools/session-adapter.ts) lets the fork's `executeTool`
 * accept the old `{ session }` ctx, so the 17 tools run unchanged.
 *
 * Run: `bun tests/session-mode-harness.ts` from the hub-browser root.
 */
import { BROWSER_TOOLS } from '@browseros/browser-mcp/registry'
import {
  type ToolDefinition,
  type ToolResult,
  executeTool,
} from '@browseros/browser-mcp/tools/framework'
import {
  contextFromSession,
  type SessionToolContext,
} from '@browseros/browser-mcp/tools/session-adapter'
import { withBrowserOutputFileAccess } from '@browseros/browser-mcp/output-file'

const FORK_ROOT = new URL('../src/browser-mcp/', import.meta.url).pathname

/** apps/server builds a real BrowserSession; here we fake the surface tools touch. */
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
  ]
  const pageSession = {
    Runtime: {
      evaluate: async () => ({
        result: { value: '<html><body><h1>Hello</h1></body></html>' },
      }),
      disable: async () => {},
      enable: async () => {},
    },
    Page: {
      addScriptToEvaluateOnNewDocument: async () => ({}),
      setDownloadBehavior: async () => {},
      on: (event: string, cb: (params: Record<string, unknown>) => void) => {
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
    'Page.captureScreenshot': { data: 'aGVsbG8=' },
    'Page.printToPDF': { data: 'aGVsbG8=' },
    'History.getRecent': { entries: [] },
    'Browser.getTabGroups': { groups: [] },
    'Browser.getWindows': {
      windows: [{ windowId: 1, windowType: 'normal', tabCount: 1, isActive: true }],
    },
    'Browser.createWindow': { window: { windowId: 2 } },
  }
  return {
    pages: {
      list: async () => pages,
      getSession: async () => ({ session: pageSession, sessionId: 's1' }),
      getInfo: (pageId: number) => pages.find((p) => p.pageId === pageId),
      newPage: async () => 2,
      close: async () => {},
    },
    observe: () => ({
      snapshot: async () => ({
        text: 'hello page',
        refs: { byRef: new Map(), byLabel: new Map() },
      }),
      diff: async () => ({ changed: false, text: 'no changes' }),
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

async function main(): Promise<void> {
  console.log('--- 方案 2 session-mode harness ---')

  // 1. Resolution proof: the vendored specifier must land on the fork.
  const resolved = await import.meta.resolve(
    '@browseros/browser-mcp/tools/framework',
  )
  const isFork = resolved.includes('/src/browser-mcp/')
  console.log(`resolved @browseros/browser-mcp/tools/framework -> ${resolved}`)
  if (!isFork) {
    throw new Error(`resolution is not the fork: ${resolved}`)
  }

  // 2. Context bridge proof.
  const session = createFakeSession()
  const ctx = await contextFromSession({ session: session as never })
  console.log(
    `bridge ctx -> page=${typeof ctx.page} pageFor=${typeof ctx.pageFor} tabs=${(await ctx.page.tabs()).length}`,
  )

  // 3. Run all 17 tools exactly the way apps/server's tool-adapter does:
  //    withBrowserOutputFileAccess(undefined, () => executeTool(def, args, { session, signal })).
  const failures: string[] = []
  for (const def of BROWSER_TOOLS as readonly ToolDefinition[]) {
    const args = SESSION_ARGS[def.name]
    if (!args) throw new Error(`missing harness args for ${def.name}`)
    const signal = AbortSignal.timeout(30_000)
    const toolCtx: SessionToolContext = { session: session as never, signal }
    const result: ToolResult = await withBrowserOutputFileAccess(undefined, () =>
      executeTool(def, args, toolCtx),
    )
    const ok = Array.isArray(result?.content)
    const status = result?.isError ? 'ERR' : 'ok '
    console.log(`  [${status}] ${def.name}`)
    if (!ok) failures.push(def.name)
  }

  if (failures.length > 0) {
    throw new Error(`tools missing results: ${failures.join(', ')}`)
  }
  console.log(`PASS: ${BROWSER_TOOLS.length}/17 tools ran in session mode via the fork.`)
}

main().catch((err) => {
  console.error('HARNESS FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
