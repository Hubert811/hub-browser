/**
 * `act` and `grep` against a REAL page.
 *
 * Why this smoke exists: `act` is the interaction primitive every task goes
 * through (click / fill / type / press / select / scroll), and it had **zero**
 * live coverage — only unit tests with fakes. The things that actually break
 * here are exactly the ones a fake cannot show: whether the AX ref channel
 * resolves a real element, whether `fill` batches a whole form, whether
 * `expect` re-fires until an anchor appears, and whether the settled diff tells
 * the truth. `grep` (page text search) is in the same position.
 *
 * The page is a LOCAL file: deterministic, no network, no login. (The rest of
 * the suite depends on example.com, which is unreachable from this machine
 * right now — `chrome-error://chromewebdata/`.)
 *
 * Run: BROWSEROS_CDP_PORT=9112 bun tests/act-grep-live-smoke.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { resolveCdpPort } from '../src/cdp-port'

const HUB_BIN = join(process.cwd(), 'bin', 'hub.mjs')
const OWNER = 'act-grep-probe'

interface WindowRow {
  windowId: number
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

function killPort(port: number): void {
  try {
    // LISTEN only — `lsof -ti :PORT` also matches CLIENTS, including this test.
    execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, {
      stdio: 'ignore',
    })
  } catch {
    /* nothing listening */
  }
}

/** A page with a form, a button that mutates the DOM, and greppable prose. */
function fixtureHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>act fixture</title></head>
<body>
  <h1>Act fixture</h1>
  <p id="prose">The quick brown fox jumps over the lazy dog. ZEBRAFISH marker.</p>
  <form id="form">
    <label for="name">Name</label>
    <input id="name" name="name" type="text" />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" />
    <label for="plan">Plan</label>
    <select id="plan" name="plan">
      <option value="free">Free</option>
      <option value="pro">Pro</option>
    </select>
    <button id="submit" type="button">Submit</button>
  </form>
  <div id="out">idle</div>
  <script>
    document.getElementById('submit').addEventListener('click', function () {
      var name = document.getElementById('name').value;
      var plan = document.getElementById('plan').value;
      document.getElementById('out').textContent = 'submitted:' + name + ':' + plan;
    });
  </script>
</body></html>`
}

function openSession(port: number) {
  let sessionId = ''
  let nextId = 1
  const rpc = async (
    method: string,
    params?: unknown,
  ): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(60000),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    for (const line of text.split('\n')) {
      const trimmed = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!trimmed.startsWith('{')) continue
      return JSON.parse(trimmed) as Record<string, unknown>
    }
    return {}
  }
  return {
    async initialize(): Promise<void> {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: OWNER, version: '1' },
      })
      await rpc('notifications/initialized')
    },
    async call(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<{ structured: Record<string, unknown>; text: string; isError: boolean }> {
      const msg = await rpc('tools/call', { name, arguments: args })
      if (msg.error !== undefined) {
        return { structured: {}, text: JSON.stringify(msg.error), isError: true }
      }
      const result = msg.result as
        | {
            structuredContent?: Record<string, unknown>
            content?: Array<{ text?: string }>
            isError?: boolean
          }
        | undefined
      return {
        structured: result?.structuredContent ?? {},
        text: result?.content?.map((c) => c.text ?? '').join('\n') ?? '',
        isError: result?.isError === true,
      }
    },
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())
  console.log(`[act-grep] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 250)}`)
  }

  const baseline = (await listWindows()).length
  const root = mkdtempSync(join(tmpdir(), 'act-grep-'))
  const fixture = join(root, 'fixture.html')
  writeFileSync(fixture, fixtureHtml(), 'utf-8')
  const daemonPort = await freePort()
  let daemon: ChildProcess | undefined
  let spaceId = ''
  let pageId = 0

  try {
    daemon = spawn(process.execPath, [HUB_BIN], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_DAEMON: 'true',
        HUB_DAEMON_PORT: String(daemonPort),
        HUB_SPACES_FILE: join(root, 'hub-spaces.json'),
        HUB_AUDIT_DB: join(root, 'audit.db'),
        BROWSEROS_DIR: root,
        BROWSEROS_CDP_PORT: String(port),
        HUB_AGENT_ID: OWNER,
        HUB_SPACE_REAP: 'off',
        HUB_DAEMON_IDLE_TIMEOUT: '180000',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = Date.now() + 15000
    let healthy = false
    while (Date.now() < deadline && !healthy) {
      try {
        healthy = (
          await fetch(`http://127.0.0.1:${daemonPort}/health`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    record('daemon is up', healthy, `http://127.0.0.1:${daemonPort}/health`)
    if (!healthy) throw new Error('daemon did not start')

    const mcp = openSession(daemonPort)
    await mcp.initialize()

    const created = await mcp.call('space.create', { name: 'act-grep' })
    spaceId = String((created.structured.space as { id?: string })?.id ?? '')
    const opened = await mcp.call('space.open_tab', {
      spaceId,
      url: `file://${fixture}`,
      background: false,
    })
    pageId = Number((opened.structured as { pageId?: number }).pageId)
    await new Promise((r) => setTimeout(r, 800))
    record(
      'setup: a local fixture page is open inside the space',
      spaceId !== '' && pageId > 0,
      `space=${spaceId.slice(0, 8)} pageId=${pageId}`,
    )

    // ── snapshot: real refs from a real AX tree ──
    const snap = await mcp.call('snapshot', { page: pageId })
    const snapText = snap.text
    const refOf = (needle: string): string | undefined => {
      const line = snapText
        .split('\n')
        .find((l) => l.includes(needle) && /\[ref=/.test(l))
      return line?.match(/\[ref=([^\]]+)\]/)?.[1]
    }
    const nameRef = refOf('Name')
    const planRef = refOf('Plan')
    const submitRef = refOf('Submit')
    record(
      'snapshot yields refs for the form controls',
      Boolean(nameRef && submitRef),
      `name=${nameRef} plan=${planRef} submit=${submitRef}`,
    )

    // ── act fill: batch a whole form in one call ──
    const filled = await mcp.call('act', {
      page: pageId,
      kind: 'fill',
      fields: [
        { ref: nameRef, value: 'Ada Lovelace' },
        ...(planRef ? [{ ref: planRef, value: 'pro' }] : []),
      ],
    })
    const nameValue = await mcp.call('evaluate', {
      page: pageId,
      code: "document.getElementById('name').value",
    })
    record(
      'act fill writes the real input value',
      filled.isError !== true && nameValue.text.includes('Ada Lovelace'),
      `isError=${filled.isError} value=${JSON.stringify(nameValue.text.slice(0, 60))}`,
    )

    // ── act click with an expect anchor: the effect is verified, not assumed ──
    const clicked = await mcp.call('act', {
      page: pageId,
      kind: 'click',
      ref: submitRef,
      expect: { text: 'submitted:Ada Lovelace', attempts: 3, timeoutMs: 3000 },
    })
    const outText = await mcp.call('evaluate', {
      page: pageId,
      code: "document.getElementById('out').textContent",
    })
    record(
      'act click fires the handler and the expect anchor confirms it',
      clicked.isError !== true && outText.text.includes('submitted:Ada Lovelace'),
      `anchorSeen=${clicked.structured.anchorSeen} out=${JSON.stringify(outText.text.slice(0, 60))}`,
    )

    // ── an anchor that never appears must report honestly, not throw ──
    const missed = await mcp.call('act', {
      page: pageId,
      kind: 'click',
      ref: submitRef,
      expect: { text: 'THIS-ANCHOR-NEVER-APPEARS', attempts: 2, timeoutMs: 800 },
    })
    record(
      'act reports anchorSeen:false instead of pretending success',
      missed.structured.anchorSeen === false && typeof missed.structured.attempts === 'number',
      `anchorSeen=${missed.structured.anchorSeen} attempts=${missed.structured.attempts} fired=${missed.structured.fired}`,
    )

    // ── grep: page text search without a full dump ──
    const grepped = await mcp.call('grep', { page: pageId, pattern: 'ZEBRAFISH' })
    record(
      'grep finds text on the live page',
      grepped.isError !== true && /zebrafish/i.test(grepped.text),
      `text=${JSON.stringify(grepped.text.slice(0, 120))}`,
    )
    const greppedMiss = await mcp.call('grep', { page: pageId, pattern: 'NO-SUCH-TOKEN-42' })
    record(
      'grep reports no match without failing the call',
      greppedMiss.isError !== true && !/NO-SUCH-TOKEN-42/.test(greppedMiss.text.replace(/pattern[^\n]*/i, '')),
      `text=${JSON.stringify(greppedMiss.text.slice(0, 120))}`,
    )

    // ── a ref from a foreign page must be refused, not acted on ──
    const foreign = await mcp.call('act', {
      page: pageId,
      kind: 'click',
      ref: 'e9999',
    })
    record(
      'act refuses an unknown ref instead of clicking something arbitrary',
      foreign.isError === true,
      `isError=${foreign.isError} text=${JSON.stringify(foreign.text.slice(0, 100))}`,
    )
  } finally {
    if (spaceId) {
      try {
        const mcp = openSession(daemonPort)
        await mcp.initialize()
        await mcp.call('space.finish', { spaceId, keep: [] })
      } catch {
        /* daemon may already be gone */
      }
    }
    await new Promise((r) => setTimeout(r, 800))
    killPort(daemonPort)
    try {
      daemon?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    const after = (await listWindows()).length
    record(
      'cleanup: browser window count is back to the baseline',
      after === baseline,
      `windows=${after} (baseline ${baseline})`,
    )
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`act/grep live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: act + grep live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('ACT/GREP LIVE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
