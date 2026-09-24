/**
 * The browser tools that had NO live coverage: tab_groups, upload, pdf.
 *
 * Why these: `tab_groups` is the one most likely to have rotted — P7-F deleted
 * the space ↔ tab-group projection, and the tool used to be that projection's
 * implementation surface, so four of its five actions (create/update/ungroup/
 * close) were only unit-tested against fakes. `upload` and `pdf` touch the
 * filesystem through CDP (DOM.setFileInputFiles / Page.printToPDF), which is
 * exactly where a fake proves nothing.
 *
 * The page is a LOCAL file:// fixture: deterministic, no network, no login.
 *
 * Run: BROWSEROS_CDP_PORT=9112 bun tests/browser-io-groups-live-smoke.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { resolveCdpPort } from '../src/cdp-port'

const HUB_BIN = join(process.cwd(), 'bin', 'hub.mjs')
const OWNER = 'io-groups-probe'

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
    execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, {
      stdio: 'ignore',
    })
  } catch {
    /* nothing listening */
  }
}

function fixtureHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>io fixture</title></head>
<body>
  <h1>io fixture</h1>
  <input id="picker" type="file" />
  <div id="picked">none</div>
  <script>
    document.getElementById('picker').addEventListener('change', function (e) {
      document.getElementById('picked').textContent = 'files:' + e.target.files.length;
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
  console.log(`[browser-io] CDP ${port}`)
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
  const root = mkdtempSync(join(tmpdir(), 'browser-io-'))
  const fixture = join(root, 'fixture.html')
  writeFileSync(fixture, fixtureHtml(), 'utf-8')
  const uploadSrc = join(root, 'upload-me.txt')
  writeFileSync(uploadSrc, 'payload-for-upload', 'utf-8')
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
    const created = await mcp.call('space.create', { name: 'browser-io' })
    spaceId = String((created.structured.space as { id?: string })?.id ?? '')
    const opened = await mcp.call('space.open_tab', {
      spaceId,
      url: `file://${fixture}`,
      background: false,
    })
    pageId = Number((opened.structured as { pageId?: number }).pageId)
    await new Promise((r) => setTimeout(r, 800))
    record('setup: fixture page in the space', spaceId !== '' && pageId > 0, `pageId=${pageId}`)

    // ── upload: set a real file on a real <input type="file"> ──
    const snap = await mcp.call('snapshot', { page: pageId })
    const pickerRef = snap.text
      .split('\n')
      .find((l) => /file|picker/i.test(l) && /\[ref=/.test(l))
      ?.match(/\[ref=([^\]]+)\]/)?.[1]
    const uploaded = await mcp.call('upload', {
      page: pageId,
      ref: pickerRef,
      file: uploadSrc,
    })
    const picked = await mcp.call('evaluate', {
      page: pageId,
      code: "return document.getElementById('picker').files.length + ':' + (document.getElementById('picker').files[0]?.name ?? '')",
    })
    record(
      'upload sets the file input to a real local file',
      uploaded.isError !== true && /1:upload-me\.txt/.test(picked.text),
      `isError=${uploaded.isError} input=${JSON.stringify(picked.text.slice(-60))}`,
    )

    // ── pdf: print the page and land a real file ──
    const pdf = await mcp.call('pdf', { page: pageId })
    const pdfPath = String((pdf.structured as { path?: string }).path ?? '')
    const pdfBytes = Number((pdf.structured as { bytes?: number }).bytes ?? 0)
    record(
      'pdf prints the page to a real file',
      pdf.isError !== true &&
        pdfPath !== '' &&
        existsSync(pdfPath) &&
        statSync(pdfPath).size > 0 &&
        pdfBytes > 0,
      `path=${pdfPath.slice(-40)} bytes=${pdfBytes} onDisk=${pdfPath ? existsSync(pdfPath) : false}`,
    )

    // ── tab_groups: the tool P7-F left behind ──
    const groupsBefore = await mcp.call('tab_groups', { action: 'list' })
    record(
      'tab_groups list answers',
      groupsBefore.isError !== true,
      `text=${JSON.stringify(groupsBefore.text.slice(0, 100))}`,
    )

    const grouped = await mcp.call('tab_groups', {
      action: 'create',
      pages: [pageId],
      title: 'io-group',
    })
    const groupId = String(
      (grouped.structured as { groupId?: string }).groupId ??
        grouped.text.match(/group\D*(\d+)/i)?.[1] ??
        '',
    )
    const afterCreate = await mcp.call('tab_groups', { action: 'list' })
    record(
      'tab_groups create groups a real tab',
      grouped.isError !== true && /io-group/.test(afterCreate.text),
      `groupId=${groupId} list=${JSON.stringify(afterCreate.text.slice(0, 120))}`,
    )

    const updated = await mcp.call('tab_groups', {
      action: 'update',
      groupId,
      title: 'io-group-renamed',
      color: 'blue',
    })
    const afterUpdate = await mcp.call('tab_groups', { action: 'list' })
    record(
      'tab_groups update renames the group',
      updated.isError !== true && /io-group-renamed/.test(afterUpdate.text),
      `isError=${updated.isError} list=${JSON.stringify(afterUpdate.text.slice(0, 120))}`,
    )

    const ungrouped = await mcp.call('tab_groups', {
      action: 'ungroup',
      pages: [pageId],
    })
    const afterUngroup = await mcp.call('tab_groups', { action: 'list' })
    record(
      'tab_groups ungroup removes the tab from its group',
      ungrouped.isError !== true && !/io-group-renamed/.test(afterUngroup.text),
      `isError=${ungrouped.isError} list=${JSON.stringify(afterUngroup.text.slice(0, 120))}`,
    )

    // The guard: a group that holds none of MY tabs must not be editable.
    const foreign = await mcp.call('tab_groups', {
      action: 'update',
      groupId: '999999',
      title: 'hijack',
    })
    record(
      'tab_groups refuses a group that is not ours',
      foreign.isError === true,
      `isError=${foreign.isError} text=${JSON.stringify(foreign.text.slice(0, 110))}`,
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
    throw new Error(`browser io/groups live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: browser io + tab_groups live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('BROWSER IO/GROUPS LIVE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
