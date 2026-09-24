/**
 * Live smoke for the CONTROL handoff surface over the daemon's MCP face:
 * handoff → claim (with/without confirmation) → waitForControl → the legacy
 * `space.close`.
 *
 * These are the P7-A promises that only had unit coverage, and the ones where
 * ego and hub deliberately differ: ego's `claimTaskSpace` has NO enforced
 * approval gate (measured live: it handed over a user space on a mistaken
 * call), while hub requires `confirmed: true`. This pins hub's side.
 *
 * Self-contained: temp daemon, temp ledger, its own space; closes everything
 * and checks the browser is back to its baseline.
 *
 * Run:
 *   bun tests/space-control-live-smoke.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { resolveCdpPort } from '../src/cdp-port'

const cdpPort = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())
const HUB_BIN = join(process.cwd(), 'bin', 'hub.mjs')

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

interface WindowRow {
  windowId: number
}

async function main(): Promise<void> {
  console.log(`[space-control-live] CDP ${cdpPort}`)
  const cdp = new CdpBackend({ port: cdpPort })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]
  const listTargets = async (): Promise<Array<{ id: string; url: string }>> => {
    const all = (await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    ).json()) as Array<{ id: string; type: string; url: string }>
    return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }))
  }

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  const baselineWindows = (await listWindows()).map((w) => w.windowId)
  const baselineTargets = new Set((await listTargets()).map((t) => t.id))
  const root = mkdtempSync(join(tmpdir(), 'space-control-live-'))
  const port = await freePort()
  let daemon: ChildProcess | undefined

  // ── minimal MCP-over-HTTP client ──
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
      signal: AbortSignal.timeout(20000),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    for (const line of text.split('\n')) {
      const trimmed = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!trimmed.startsWith('{')) continue
      const msg = JSON.parse(trimmed) as Record<string, unknown>
      if (msg.id !== undefined) return msg
    }
    return {}
  }
  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError?: boolean; structured: Record<string, unknown>; text: string }> => {
    const msg = await rpc('tools/call', { name, arguments: args })
    const result = (msg.result ?? {}) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
      content?: Array<{ type: string; text?: string }>
    }
    return {
      isError: result.isError,
      structured: result.structuredContent ?? {},
      text: (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n'),
    }
  }

  let spaceId = ''
  try {
    daemon = spawn(process.execPath, [HUB_BIN], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_DAEMON: 'true',
        HUB_DAEMON_PORT: String(port),
        HUB_AGENT_ID: 'control-probe',
        HUB_SPACES_FILE: join(root, 'hub-spaces.json'),
        HUB_AUDIT_DB: join(root, 'audit.db'),
        BROWSEROS_DIR: root,
        BROWSEROS_CDP_PORT: String(cdpPort),
        HUB_SPACE_REAP: 'off',
        HUB_DAEMON_IDLE_TIMEOUT: '180000',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = Date.now() + 15000
    let healthy = false
    while (Date.now() < deadline && !healthy) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        })).ok
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    record('daemon is up', healthy, `http://127.0.0.1:${port}/health`)
    if (!healthy) throw new Error('daemon did not start')

    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'control-probe', version: '1' },
    })
    await rpc('notifications/initialized')

    const created = await callTool('space.create', { name: 'control-probe' })
    spaceId = String((created.structured.space as { id?: string } | undefined)?.id ?? '')
    await callTool('space.open_tab', { url: 'https://example.com/?control=a' })
    await new Promise((r) => setTimeout(r, 800))

    // ── handoff puts the space in the user's hands ──
    const handed = await callTool('space.handoff', {})
    record(
      'handoff moves the space to the user',
      (handed.structured.space as { ownership?: string } | undefined)?.ownership ===
        'agentDelegatedToUser',
      `ownership=${String((handed.structured.space as { ownership?: string } | undefined)?.ownership)}`,
    )

    // ── while the user holds it, reads are refused ──
    const readWhileHeld = await callTool('space.list_tabs', {})
    record(
      'reads are refused while the user controls the space',
      readWhileHeld.isError === true && readWhileHeld.text.includes('user is controlling'),
      readWhileHeld.text.slice(0, 120),
    )

    // ── claim WITHOUT confirmation must be refused (hub's gate; ego has none) ──
    const unconfirmed = await callTool('space.claim', {})
    record(
      'claim without confirmation is refused',
      unconfirmed.isError === true &&
        (unconfirmed.text.includes('confirmation') ||
          unconfirmed.text.includes('needs-confirmation')),
      unconfirmed.text.slice(0, 140),
    )

    // ── waitForControl must time out, not take control on its own ──
    const waited = await callTool('space.wait_for_control', { timeout: 600 })
    record(
      'waitForControl times out instead of seizing control',
      waited.isError !== true &&
        (waited.structured.granted === false || waited.structured.timedOut === true),
      JSON.stringify(waited.structured).slice(0, 160),
    )

    // ── confirmed claim takes it back ──
    const claimed = await callTool('space.claim', { confirmed: true })
    record(
      'confirmed claim returns control to the agent',
      (claimed.structured.space as { ownership?: string } | undefined)?.ownership ===
        'agent',
      `ownership=${String((claimed.structured.space as { ownership?: string } | undefined)?.ownership)}`,
    )

    // ── waitForControl is immediate once the agent holds it again ──
    const waited2 = await callTool('space.wait_for_control', { timeout: 5000 })
    record(
      'waitForControl returns at once when the agent already has control',
      waited2.isError !== true && waited2.structured.granted === true,
      JSON.stringify(waited2.structured).slice(0, 160),
    )

    // ── the tab survived the whole round trip ──
    const tabs = await callTool('space.list_tabs', {})
    const list = (tabs.structured.tabs ?? []) as Array<{ url?: string }>
    record(
      'the space still owns its tab after the handoff round trip',
      list.length === 1 && String(list[0].url).includes('control=a'),
      JSON.stringify(list).slice(0, 160),
    )

    // ── the legacy `space.close` still cleans up ──
    const legacy = await callTool('space.close', { spaceId, keep: false })
    spaceId = ''
    record(
      'the legacy space.close still closes the space and its tab',
      legacy.isError !== true,
      legacy.text.slice(0, 120) || JSON.stringify(legacy.structured).slice(0, 120),
    )
    await new Promise((r) => setTimeout(r, 800))
    record(
      'the browser is back to its baseline windows',
      (await listWindows()).length === baselineWindows.length,
      `windows=${(await listWindows()).length} (baseline ${baselineWindows.length})`,
    )
  } finally {
    if (spaceId) {
      await callTool('space.finish', { spaceId, keep: [] }).catch(() => {})
    }
    try {
      daemon?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 800))
    for (const t of await listTargets()) {
      if (!baselineTargets.has(t.id)) {
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${t.id}`).catch(() => {})
      }
    }
    await new Promise((r) => setTimeout(r, 600))
    for (const w of await listWindows()) {
      if (!baselineWindows.includes(w.windowId)) {
        try {
          await session.cdpJson(
            'Browser.closeWindow',
            JSON.stringify({ windowId: w.windowId }),
          )
        } catch {
          /* already gone */
        }
      }
    }
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`space control live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: space control live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error(
    'SPACE CONTROL LIVE SMOKE FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
