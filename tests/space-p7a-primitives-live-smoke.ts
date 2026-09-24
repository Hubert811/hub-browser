/**
 * P7-A primitives against a REAL browser + ledger.
 *
 * Why this smoke exists: these are the tools an agent uses to deal with the
 * USER's tabs — resolve a durable label, adopt a tab the user dragged in, hand
 * one back, ask where the user was, wait for control — and none of them had a
 * standing live test. `space.user_page` had NO automated coverage at all, and
 * the others were only unit-tested plus an ad-hoc manual run ("单测 + 临时真机").
 * Unit tests use a fake gateway, so they cannot catch the things that actually
 * go wrong here: a label resolving to the wrong live tab, `view=all` leaking the
 * user's url (P1-5), adopt/release fighting the ledger's identity anchors.
 *
 * Covers: space.page · space.adopt · space.release · space.user_page ·
 *         space.wait_for_control · space.close_tab (+ view=all identity-only)
 *
 * Run: BROWSEROS_CDP_PORT=9112 bun tests/space-p7a-primitives-live-smoke.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { resolveCdpPort } from '../src/cdp-port'

const HUB_BIN = join(process.cwd(), 'bin', 'hub.mjs')
const OWNER = 'p7a-primitives-probe'

interface WindowRow {
  windowId: number
  tabCount?: number
}
interface LiveTab {
  pageId: number
  tabId?: number
  targetId?: string
  windowId?: number
  url?: string
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
    // LISTEN only: `lsof -ti :PORT` also matches CLIENTS, including this very
    // process (it talks to the daemon), which killed the test instead.
    execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, {
      stdio: 'ignore',
    })
  } catch {
    /* nothing listening */
  }
}

/** Minimal HTTP MCP client (the daemon's Streamable HTTP face). */
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
      signal: AbortSignal.timeout(30000),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    for (const line of text.split('\n')) {
      const trimmed = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!trimmed.startsWith('{')) continue
      const msg = JSON.parse(trimmed) as Record<string, unknown>
      if (msg.id === undefined) continue
      if (msg.error) throw new Error(`rpc ${method}: ${JSON.stringify(msg.error)}`)
      return msg
    }
    throw new Error(`rpc ${method}: no JSON-RPC payload in response`)
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
  console.log(`[space-p7a] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]
  const listTabs = async (): Promise<LiveTab[]> =>
    (await session.pages.list()) as never

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 250)}`)
  }

  const baselineWindows = (await listWindows()).length
  const root = mkdtempSync(join(tmpdir(), 'space-p7a-'))
  const daemonPort = await freePort()
  let daemon: ChildProcess | undefined
  let foreignTabId: number | undefined
  let spaceId = ''

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

    const created = await mcp.call('space.create', { name: 'p7a-primitives' })
    spaceId = String((created.structured.space as { id?: string })?.id ?? '')
    record('space.create', spaceId !== '', `spaceId=${spaceId.slice(0, 8)}`)

    // ── space.open_tab → a managed tab with a durable label ──
    const opened = await mcp.call('space.open_tab', {
      spaceId,
      url: 'https://example.com/?p7a=agent',
    })
    const agentPageId = Number(
      (opened.structured as { pageId?: number }).pageId ??
        (opened.structured.tab as { pageId?: number })?.pageId,
    )
    const managed = await mcp.call('space.list_tabs', { spaceId })
    const agentRow = (
      managed.structured.tabs as Array<{ pageId: number; label?: string; url?: string }>
    ).find((t) => t.pageId === agentPageId)
    record(
      'space.open_tab gives the tab a durable label',
      agentPageId > 0 && typeof agentRow?.label === 'string',
      `pageId=${agentPageId} label=${agentRow?.label}`,
    )

    // ── space.page: durable label → live tab (never live-tested before) ──
    const byLabel = await mcp.call('space.page', {
      spaceId,
      label: String(agentRow?.label),
    })
    const resolved = byLabel.structured as { pageId?: number; url?: string }
    record(
      'space.page resolves the label to the LIVE tab',
      byLabel.isError !== true &&
        resolved.pageId === agentPageId &&
        String(resolved.url).includes('p7a=agent'),
      `pageId=${resolved.pageId} url=${resolved.url}`,
    )

    const unknown = await mcp.call('space.page', { spaceId, label: 'p99' })
    record(
      'space.page reports an unknown label instead of guessing',
      unknown.isError === true || unknown.text.toLowerCase().includes('p99'),
      `isError=${unknown.isError} text=${JSON.stringify(unknown.text.slice(0, 80))}`,
    )

    // ── the USER's tab: injected straight into the space's window ──
    const spaceWindow = (await listWindows()).find((w) => w.tabCount !== undefined)
    const windows = await listWindows()
    // The space's window is the newest one (created lazily by open_tab).
    const spaceWindowId = windows.map((w) => w.windowId).sort((a, b) => b - a)[0]
    const injected = (await session.cdpJson(
      'Browser.createTab',
      JSON.stringify({ url: 'https://example.com/?p7a=user', windowId: spaceWindowId }),
    )) as { tab?: { tabId?: number } }
    await new Promise((r) => setTimeout(r, 1200))
    const foreignTabId0 = injected?.tab?.tabId
    foreignTabId = (await listTabs()).find((t) => t.tabId === foreignTabId0)?.pageId
    record(
      'setup: a tab the ledger does not know sits in the space window',
      typeof foreignTabId === 'number' && typeof spaceWindow !== 'undefined',
      `foreignPageId=${foreignTabId} window=${spaceWindowId}`,
    )

    // ── view=all: identity-only, and it must NOT leak the user's url (P1-5) ──
    const all = await mcp.call('space.list_tabs', { spaceId, view: 'all' })
    const rows = (all.structured.tabs ?? []) as Array<{
      pageId: number
      unmanaged?: boolean
      url?: string
      title?: string
    }>
    const foreignRow = rows.find((t) => t.pageId === foreignTabId)
    record(
      'view=all shows the unmanaged tab as identity-only (no url/title)',
      foreignRow?.unmanaged === true &&
        foreignRow.url === undefined &&
        foreignRow.title === undefined,
      `row=${JSON.stringify(foreignRow)}`,
    )

    // ── space.adopt: the user's tab joins the ledger ──
    const adopted = await mcp.call('space.adopt', { spaceId, page: foreignTabId })
    const afterAdopt = (await mcp.call('space.list_tabs', { spaceId })).structured
      .tabs as Array<{ pageId: number; label?: string; openedBy?: string }>
    const adoptedRow = afterAdopt.find((t) => t.pageId === foreignTabId)
    record(
      'space.adopt brings the user tab into the ledger with a label',
      adopted.isError !== true && typeof adoptedRow?.label === 'string',
      `isError=${adopted.isError} label=${adoptedRow?.label} openedBy=${adoptedRow?.openedBy}`,
    )

    // ── space.release: back to the user, tab NOT closed ──
    const released = await mcp.call('space.release', {
      spaceId,
      page: foreignTabId,
    })
    await new Promise((r) => setTimeout(r, 600))
    const afterRelease = (await mcp.call('space.list_tabs', { spaceId })).structured
      .tabs as Array<{ pageId: number }>
    const stillAlive = (await listTabs()).some((t) => t.pageId === foreignTabId)
    record(
      'space.release hands the tab back without closing it',
      released.isError !== true &&
        !afterRelease.some((t) => t.pageId === foreignTabId) &&
        stillAlive,
      `isError=${released.isError} inLedger=${afterRelease.some((t) => t.pageId === foreignTabId)} alive=${stillAlive}`,
    )

    // ── the rule that protects the user: an agent's OWN tab cannot be released ──
    const illegal = await mcp.call('space.release', { spaceId, page: agentPageId })
    record(
      'space.release REFUSES a tab the agent opened (must be closed instead)',
      illegal.isError === true,
      `isError=${illegal.isError} text=${JSON.stringify(illegal.text.slice(0, 100))}`,
    )

    // ── handoff → takeover → user_page: the one place the user's url shows ──
    await mcp.call('space.handoff', { spaceId })
    const taken = await mcp.call('space.takeover', { spaceId, confirmed: true })
    const userPage = await mcp.call('space.user_page', { spaceId })
    const captured = userPage.structured as { url?: string; label?: string }
    record(
      'space.user_page reports the tab captured at the handoff boundary',
      taken.isError !== true &&
        userPage.isError !== true &&
        typeof captured.url === 'string' &&
        captured.url.length > 0,
      `url=${captured.url} label=${captured.label}`,
    )

    // ── wait_for_control: a timeout is a RESULT, not an error ──
    const waited = await mcp.call('space.wait_for_control', {
      spaceId,
      timeout: 800,
      interval: 150,
    })
    record(
      'space.wait_for_control returns {timedOut} as a result, not an error',
      waited.isError !== true &&
        waited.structured.timedOut === true &&
        typeof waited.structured.waitedMs === 'number',
      `timedOut=${waited.structured.timedOut} waitedMs=${waited.structured.waitedMs} ownership=${waited.structured.ownership}`,
    )

    // ── close_tab: the tab goes away AND leaves the ledger ──
    const closed = await mcp.call('space.close_tab', { spaceId, pageId: agentPageId })
    await new Promise((r) => setTimeout(r, 800))
    const afterClose = (await mcp.call('space.list_tabs', { spaceId })).structured
      .tabs as Array<{ pageId: number }>
    record(
      'space.close_tab closes the tab and drops it from the ledger',
      closed.isError !== true && !afterClose.some((t) => t.pageId === agentPageId),
      `isError=${closed.isError} inLedger=${afterClose.some((t) => t.pageId === agentPageId)}`,
    )
  } finally {
    if (spaceId) {
      await mcpSafe(daemonPort, spaceId)
    }
    // The injected tab is foreign by construction: close it ourselves.
    if (foreignTabId !== undefined) {
      const tab = (await listTabs()).find((t) => t.pageId === foreignTabId)
      if (tab?.tabId !== undefined) {
        await session
          .cdpJson('Browser.closeTab', JSON.stringify({ tabId: tab.tabId }))
          .catch(() => {})
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
      after === baselineWindows,
      `windows=${after} (baseline ${baselineWindows})`,
    )
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`space P7-A primitives failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(
    `PASS: space P7-A primitives live smoke (${results.length}/${results.length})`,
  )
}

/** Best-effort: close the probe's space through a fresh MCP session. */
async function mcpSafe(port: number, spaceId: string): Promise<void> {
  try {
    const mcp = openSession(port)
    await mcp.initialize()
    await mcp.call('space.finish', { spaceId, keep: [] })
  } catch {
    /* the daemon may already be gone */
  }
}

main().catch((err) => {
  console.error(
    'SPACE P7-A PRIMITIVES FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
