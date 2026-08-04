/**
 * Minimal MCP smoke test for the @hub/browser-mcp fork.
 *
 * Boots createBrowserMcpServer against the REAL UnifiedBrowserFactory and
 * exercises tabs / navigate / snapshot / read / evaluate through the same
 * registration wrapper an MCP client would hit. Also probes windows/history
 * (browser-domain CDP) to surface any session-routing issues.
 *
 * Run:
 *   BROWSEROS_CDP_PORT=9110 bun run src/browser-mcp/smoke-mcp.ts
 */
import { UnifiedBrowserFactory } from '../../factory.ts'
import { createBrowserMcpServer } from './mcp-server.ts'

type Registered = {
  _registeredTools: Record<
    string,
    {
      handler: (args: Record<string, unknown>) => Promise<{
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
        structuredContent?: unknown
      }>
    }
  >
}

const port = process.env.BROWSEROS_CDP_PORT ?? '9110'
console.log(`[smoke] CDP port ${port}`)

const browser = new UnifiedBrowserFactory()
const server = createBrowserMcpServer({
  name: 'hub-browser-smoke',
  title: 'hub-browser MCP smoke',
  version: '0.0.1',
  browser,
}) as unknown as Registered

const registered = server._registeredTools
const tools = Object.keys(registered).sort()
console.log(`[smoke] registered ${tools.length} tools: ${tools.join(', ')}`)

function textOf(res: { content?: Array<{ type: string; text?: string }> }) {
  return (res.content ?? [])
    .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

const results: Array<{ name: string; pass: boolean; detail: string }> = []
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 400)}`)
}

try {
  // 1. tabs list
  const tabs = await registered.tabs.handler({ action: 'list' })
  const pages = ((tabs?.structuredContent ?? {}) as { pages?: Array<{ page: number }> }).pages ?? []
  record('tabs list', !tabs?.isError && pages.length > 0, `pages: ${pages.length} | ${textOf(tabs).split('\n')[0] ?? ''}`)
  const pageId = pages[0]?.page ?? 1

  // 2. navigate to example.com
  const nav = await registered.navigate.handler({ page: pageId, action: 'url', url: 'https://example.com' })
  record('navigate', !nav?.isError, `url=${(nav?.structuredContent as { url?: string })?.url ?? '?'} | ${textOf(nav).split('\n')[0] ?? ''}`)

  // 3. snapshot
  const snap = await registered.snapshot.handler({ page: pageId })
  const snapLen = textOf(snap).length
  record('snapshot', !snap?.isError && snapLen > 0, `chars=${snapLen}`)

  // 4. read (markdown)
  const read = await registered.read.handler({ page: pageId, format: 'markdown' })
  record('read', !read?.isError, `contentLength=${(read?.structuredContent as { contentLength?: number })?.contentLength ?? '?'}`)

  // 5. evaluate
  const evalRes = await registered.evaluate.handler({ page: pageId, code: 'return document.title' })
  record('evaluate', !evalRes?.isError, `value=${JSON.stringify((evalRes?.structuredContent as { value?: unknown })?.value)}`)

  // 6. windows list (browser-domain CDP over the page-scoped UnifiedPage.cdp)
  const windows = await registered.windows.handler({ action: 'list' })
  record('windows list', !windows?.isError, `count=${(windows?.structuredContent as { count?: number })?.count ?? '?'} | ${textOf(windows).split('\n')[0] ?? ''}`)

  // 7. history (browser-domain CDP)
  const hist = await registered.history.handler({ maxResults: 3 })
  record('history', !hist?.isError, `count=${(hist?.structuredContent as { count?: number })?.count ?? '?'}`)

  // 8. diff (needs a prior snapshot on the same cached page instance)
  const diff = await registered.diff.handler({ page: pageId })
  record('diff', !diff?.isError, `changed=${(diff?.structuredContent as { changed?: boolean })?.changed}`)
} catch (err) {
  record('smoke run', false, `threw: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exit(1)
