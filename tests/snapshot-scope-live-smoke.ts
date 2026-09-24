/**
 * Live CDP smoke for P7-B snapshot work — S1 viewport scope, S2 root focus, C2
 * folded compound probe.
 *
 * Serves its own page (tall body, a select, and two CROSS-ORIGIN iframes — one in
 * view, one far below the fold) on a random localhost port, drives hub's own MCP
 * tools through the session bridge, and closes the tab it created, so the
 * operator's browser is left as found.
 *
 * What only a live browser can prove (the stub tests cannot):
 *   - DOMSnapshot layout bounds really are page coordinates, i.e. after
 *     scrolling, a viewport capture shows the BOTTOM marker and drops the TOP one;
 *   - an off-viewport iframe is skipped without fetching its frame's AX tree;
 *   - a cross-origin (OOPIF) frame in view is still stitched;
 *   - the folded compound probe returns units + extras from one call.
 *
 * Run:
 *   bun tests/snapshot-scope-live-smoke.ts
 *   BROWSEROS_CDP_PORT=9112 bun tests/snapshot-scope-live-smoke.ts
 */
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { BROWSER_TOOLS } from '@browseros/browser-mcp/registry'
import {
  type ToolDefinition,
  type ToolResult,
  executeTool,
} from '@browseros/browser-mcp/tools/framework'
import type { SessionToolContext } from '@browseros/browser-mcp/tools/session-adapter'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter(
      (c): c is { type: 'text'; text: string } =>
        c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

function structured(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

function tool(name: string): ToolDefinition {
  const def = BROWSER_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

const SPACER = 1800

function pageHtml(boundPort: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>hub scope probe</title>
<style>body{margin:0;font:14px system-ui}.spacer{height:${SPACER}px}iframe{width:320px;height:150px;border:1px solid #ccc}</style>
</head><body>
<h1>TOP</h1>
<button id="top-marker">TOP-MARKER</button>
<select id="pick" aria-label="Pick a city"><option>北京</option><option>上海</option><option>广州</option></select>
<iframe src="http://localhost:${boundPort}/frame?label=TOP-FRAME-BUTTON"></iframe>
<div class="spacer"></div>
<h1>MIDDLE</h1>
<div class="spacer"></div>
<button id="bottom-marker">BOTTOM-MARKER</button>
<iframe src="http://localhost:${boundPort}/frame?label=BOTTOM-FRAME-BUTTON"></iframe>
<div class="spacer"></div>
</body></html>`
}

function frameHtml(label: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head>
<body><button id="inner">${label}</button></body></html>`
}

async function main(): Promise<void> {
  let boundPort = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const body =
        url.pathname === '/frame'
          ? frameHtml(url.searchParams.get('label') ?? 'FRAME-BUTTON')
          : pageHtml(boundPort)
      return new Response(body, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
  boundPort = server.port
  const pageUrl = `http://127.0.0.1:${boundPort}/`
  console.log(`[p7b-live] serving ${pageUrl} (CDP ${port})`)

  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const ctx: SessionToolContext = { session: session as never }
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  let createdPage: number | undefined
  try {
    const newRes = await executeTool(tool('tabs'), { action: 'new' }, ctx)
    createdPage = structured(newRes).page as number
    if (typeof createdPage !== 'number') {
      throw new Error(`tabs new returned no page: ${textOf(newRes).slice(0, 200)}`)
    }
    const navRes = await executeTool(
      tool('navigate'),
      { page: createdPage, action: 'url', url: pageUrl },
      ctx,
    )
    record('navigate to probe page', !navRes.isError, String(structured(navRes).url))

    const full = await executeTool(
      tool('snapshot'),
      { page: createdPage, scope: 'full_page' },
      ctx,
    )
    const fullText = textOf(full)
    record(
      'full_page sees both markers + both frames',
      ['TOP-MARKER', 'BOTTOM-MARKER', 'TOP-FRAME-BUTTON', 'BOTTOM-FRAME-BUTTON'].every(
        (m) => fullText.includes(m),
      ),
      `lines=${fullText.split('\n').length} scope=${String(structured(full).scope)}`,
    )
    record(
      'full_page echoes its scope',
      structured(full).scope === 'full_page',
      String(structured(full).scope),
    )
    record(
      'C2: select carries compound + DOM unit from one probe',
      /\[ref=e\d+\] \[compound: select, 3 options, current: .+, e\.g\. .+\] → select#pick \[sel="#pick"\]/.test(
        fullText,
      ),
      (fullText.split('\n').find((l) => l.includes('#pick')) ?? '(no select line)').trim(),
    )

    const viewport = await executeTool(
      tool('snapshot'),
      { page: createdPage, scope: 'viewport' },
      ctx,
    )
    const viewportText = textOf(viewport)
    record(
      'S1: viewport keeps in-view nodes + stitches the in-view OOPIF',
      viewportText.includes('TOP-MARKER') && viewportText.includes('TOP-FRAME-BUTTON'),
      `lines=${viewportText.split('\n').length}`,
    )
    record(
      'S1: viewport drops below-fold nodes and skips their frames',
      !viewportText.includes('BOTTOM-MARKER') &&
        !viewportText.includes('BOTTOM-FRAME-BUTTON'),
      `below-fold hits=${Number(viewportText.includes('BOTTOM-MARKER')) + Number(viewportText.includes('BOTTOM-FRAME-BUTTON'))}`,
    )
    record(
      'S1: viewport capture is smaller than full_page',
      viewportText.split('\n').length < fullText.split('\n').length,
      `${viewportText.split('\n').length} < ${fullText.split('\n').length}`,
    )

    const scrollRes = await executeTool(
      tool('evaluate'),
      {
        page: createdPage,
        code: "document.getElementById('bottom-marker').scrollIntoView({block:'center'}); return [window.scrollY, document.body.scrollHeight]",
      },
      ctx,
    )
    const scrollInfo = JSON.stringify(structured(scrollRes))
    const scrolled = await executeTool(
      tool('snapshot'),
      { page: createdPage, scope: 'viewport' },
      ctx,
    )
    const scrolledText = textOf(scrolled)
    record(
      'S1: after scrolling, viewport shows the BOTTOM marker (page coordinates verified)',
      scrolledText.includes('BOTTOM-MARKER') && !scrolledText.includes('TOP-MARKER'),
      `evaluate=${scrollInfo.slice(0, 120)} hasBottom=${scrolledText.includes('BOTTOM-MARKER')} hasTop=${scrolledText.includes('TOP-MARKER')} | ${scrolledText.replace(/\n/g, ' ⏎ ').slice(0, 400)}`,
    )

    // S2 — scroll back and focus the select's subtree using a ref from the
    // capture immediately before it (a ref only lives until the next capture).
    await executeTool(
      tool('evaluate'),
      { page: createdPage, code: 'window.scrollTo(0, 0); return window.scrollY' },
      ctx,
    )
    const topViewport = await executeTool(
      tool('snapshot'),
      { page: createdPage, scope: 'viewport' },
      ctx,
    )
    const topText = textOf(topViewport)
    const refMatch = /\[ref=(e\d+)\][^\n]*#pick/.exec(topText)
    if (!refMatch) {
      record(
        'S2: select ref available for root focus',
        false,
        topText.replace(/\n/g, ' ⏎ ').slice(0, 300),
      )
    } else {
      const rootRef = refMatch[1]
      const rooted = await executeTool(
        tool('snapshot'),
        { page: createdPage, root: rootRef },
        ctx,
      )
      const rootedText = textOf(rooted)
      record(
        'S2: root focus renders only that subtree',
        !rooted.isError &&
          rootedText.includes('#pick') &&
          !rootedText.includes('TOP-MARKER'),
        `root=${rootRef} isError=${String(rooted.isError)} lines=${rootedText.split('\n').length} echo=${String(structured(rooted).root)} | ${rootedText.replace(/\n/g, ' ⏎ ').slice(0, 240)}`,
      )
      record(
        'S2: root focus still carries the folded compound extras',
        rootedText.includes('[compound: select'),
        (rootedText.split('\n').find((l) => l.includes('#pick')) ?? '').trim(),
      )
    }
  } finally {
    if (createdPage !== undefined) {
      const closeRes = await executeTool(
        tool('tabs'),
        { action: 'close', page: createdPage },
        ctx,
      )
      record(
        'cleanup: probe tab closed',
        !closeRes.isError,
        textOf(closeRes).split('\n')[0] ?? '',
      )
    }
    await session.dispose?.()
    await cdp.disconnect()
    server.stop(true)
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`P7-B live smoke failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: P7-B live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('P7-B LIVE SMOKE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
