/**
 * Live smoke for the substrate M1 actually changed: TWO concurrent MCP sessions
 * on ONE daemon, each with its own session-scoped identity.
 *
 * M1 replaced "one TaskSpaceManager per session" with ONE process-wide manager.
 * Everything the multi-agent story rests on now runs on that shared manager:
 *   - each session's spaces/tabs stay invisible to the other;
 *   - `tabs view=all` still classifies the other agent's tab as `other-agent`
 *     and strips its url/title (P1-5);
 *   - the guards still refuse acting on the other session's tab;
 *   - tearing a session down closes only ITS spaces.
 *
 * Self-contained: temp daemon, temp ledger, its own tabs; closes everything and
 * checks the browser is back to its baseline.
 *
 * Run:
 *   bun tests/space-multi-session-live-smoke.ts
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
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

interface WindowRow {
  windowId: number
}

async function main(): Promise<void> {
  console.log(`[space-multi-session-live] CDP ${cdpPort}`)
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
  const root = mkdtempSync(join(tmpdir(), 'space-multi-live-'))
  const port = await freePort()
  let daemon: ChildProcess | undefined

  /** One MCP session = one session id + one identity (from clientInfo). */
  function openSession(name: string) {
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
      toolName: string,
      args: Record<string, unknown> = {},
    ): Promise<{ isError?: boolean; structured: Record<string, unknown>; text: string }> => {
      const msg = await rpc('tools/call', { name: toolName, arguments: args })
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
    return {
      name,
      callTool,
      initialize: async () => {
        await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name, version: '1' },
        })
        await rpc('notifications/initialized')
      },
      /** Tear the session down the way an MCP client does. */
      delete: async (): Promise<number> => {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
          signal: AbortSignal.timeout(20000),
        })
        return res.status
      },
    }
  }

  const spaces: Array<{ id: string; owner: string }> = []
  try {
    daemon = spawn(process.execPath, [HUB_BIN], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_DAEMON: 'true',
        HUB_DAEMON_PORT: String(port),
        // No HUB_AGENT_ID: identities are per-session, which is what makes two
        // sessions two owners.
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
        healthy = (
          await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    record('daemon is up', healthy, `http://127.0.0.1:${port}/health`)
    if (!healthy) throw new Error('daemon did not start')

    const a = openSession('multi-alpha')
    const b = openSession('multi-beta')
    await a.initialize()
    await b.initialize()

    const createdA = await a.callTool('space.create', { name: 'alpha-work' })
    const spaceA = String((createdA.structured.space as { id?: string })?.id ?? '')
    spaces.push({ id: spaceA, owner: a.name })
    await a.callTool('space.open_tab', { url: 'https://example.com/?multi=a' })

    const createdB = await b.callTool('space.create', { name: 'beta-work' })
    const spaceB = String((createdB.structured.space as { id?: string })?.id ?? '')
    spaces.push({ id: spaceB, owner: b.name })
    await b.callTool('space.open_tab', { url: 'https://example.com/?multi=b' })
    await new Promise((r) => setTimeout(r, 900))

    record(
      'two sessions own two different spaces',
      spaceA !== '' && spaceB !== '' && spaceA !== spaceB,
      `A=${spaceA.slice(0, 8)} B=${spaceB.slice(0, 8)}`,
    )

    const tabsA = (await a.callTool('space.list_tabs', {})).structured
      .tabs as Array<{ url?: string; pageId?: number }>
    const tabsB = (await b.callTool('space.list_tabs', {})).structured
      .tabs as Array<{ url?: string; pageId?: number }>
    record(
      'each session sees ONLY its own tab (shared manager, disjoint views)',
      tabsA?.length === 1 &&
        String(tabsA[0].url).includes('multi=a') &&
        tabsB?.length === 1 &&
        String(tabsB[0].url).includes('multi=b'),
      `A=[${tabsA?.map((t) => t.url).join(',')}] B=[${tabsB?.map((t) => t.url).join(',')}]`,
    )

    const curA = (await a.callTool('space.current', {})).structured.space as
      | { windowId?: number }
      | undefined
    const curB = (await b.callTool('space.current', {})).structured.space as
      | { windowId?: number }
      | undefined
    record(
      'each space got its own window',
      curA?.windowId !== undefined &&
        curB?.windowId !== undefined &&
        curA.windowId !== curB.windowId,
      `A.window=${String(curA?.windowId)} B.window=${String(curB?.windowId)}`,
    )

    // P1-5: A may learn WHO holds B's tab, never WHAT is in it.
    const all = (await a.callTool('tabs', { action: 'list', view: 'all' })).structured
      .pages as Array<{ page?: number; ownership?: string; url?: string; title?: string }>
    const foreign = (all ?? []).find((p) => p.ownership === 'other-agent')
    record(
      "the other session's tab is classified other-agent, identity-only",
      foreign !== undefined && foreign.url === undefined && foreign.title === undefined,
      `foreign=${JSON.stringify(foreign)}`,
    )

    // …and acting on it is refused.
    const foreignPageId = tabsB?.[0]?.pageId
    const peek = await a.callTool('snapshot', { page: foreignPageId })
    record(
      "acting on the other session's tab is refused",
      peek.isError === true &&
        (peek.text.includes('not in your space') ||
          peek.text.includes('not the tab your space recorded')),
      peek.text.slice(0, 140),
    )

    // ── tearing ONE session down must close only ITS spaces ──
    const statusA = await a.delete()
    await new Promise((r) => setTimeout(r, 1500))
    const stillB = await b.callTool('space.list_tabs', {})
    record(
      "deleting session A closed A's space but left B's alone",
      statusA < 400 && (stillB.structured.tabs as unknown[])?.length === 1,
      `delete=${statusA} B.tabs=${JSON.stringify(stillB.structured.tabs).slice(0, 120)}`,
    )

    const statusB = await b.delete()
    spaces.length = 0
    await new Promise((r) => setTimeout(r, 1500))
    record(
      'deleting session B closed the rest',
      statusB < 400 && (await listWindows()).length === baselineWindows.length,
      `delete=${statusB} windows=${(await listWindows()).length} (baseline ${baselineWindows.length})`,
    )
  } finally {
    for (const s of spaces) {
      /* best-effort: sessions may already be gone */
      void s
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
    throw new Error(
      `space multi-session live failures: ${failed.map((f) => f.name).join(', ')}`,
    )
  }
  console.log(`PASS: space multi-session live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error(
    'SPACE MULTI-SESSION LIVE SMOKE FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
