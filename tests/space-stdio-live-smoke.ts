/**
 * Live smoke for the OTHER MCP face: `hub --mcp` over stdio.
 *
 * Why this exists: the daemon's HTTP face and the stdio face build their
 * gateways from DIFFERENT shapes, and that is not a detail — `gatewayFromProvider`
 * was missing the whole window family for a round, so per-space windows silently
 * degraded to the shared window on both faces while the smoke in use
 * (`gatewayFromPage`) stayed green. Everything else here is verified through the
 * daemon; this pins the stdio process end to end.
 *
 * Speaks real MCP over the child's stdin/stdout (newline-delimited JSON-RPC),
 * creates its own space, and asserts the space gets its OWN browser window —
 * then closes it and checks the browser is back to its baseline.
 *
 * Run:
 *   bun tests/space-stdio-live-smoke.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())
const HUB_BIN = join(process.cwd(), 'bin', 'hub.mjs')

interface WindowRow {
  windowId: number
  tabCount?: number
}

async function main(): Promise<void> {
  console.log(`[space-stdio-live] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]
  const listTargets = async (): Promise<Array<{ id: string; url: string }>> => {
    const all = (await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
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
  const root = mkdtempSync(join(tmpdir(), 'stdio-space-live-'))

  const child: ChildProcess = spawn(process.execPath, [HUB_BIN, '--mcp'], {
    env: {
      ...process.env,
      HUB_AGENT_ID: 'stdio-space-probe',
      HUB_SPACES_FILE: join(root, 'hub-spaces.json'),
      BROWSEROS_DIR: root,
      BROWSEROS_CDP_PORT: String(port),
      HUB_SPACE_REAP: 'off',
      // Keep the space alive when the process exits: this smoke closes it
      // explicitly and then checks the browser.
      HUB_SESSION_END_SPACES: 'off',
    },
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const pending = new Map<number, (msg: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // not a JSON-RPC frame (a stray log line)
      }
      const id = msg.id
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)!(msg)
        pending.delete(id)
      }
    }
  })
  child.stderr!.on('data', () => {
    /* the child logs here; not an assertion surface */
  })

  let nextId = 1
  const rpc = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, 20000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  const notify = (method: string, params?: unknown) => {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
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

  const spaceIds: string[] = []
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stdio-space-probe', version: '1' },
    })
    record(
      'the stdio MCP server completes an initialize handshake',
      typeof (init.result as { serverInfo?: { name?: string } })?.serverInfo?.name ===
        'string',
      `serverInfo=${JSON.stringify((init.result as { serverInfo?: unknown })?.serverInfo)}`,
    )
    notify('notifications/initialized')

    const created = await callTool('space.create', { name: 'stdio-probe' })
    const spaceId = (created.structured.space as { id?: string } | undefined)?.id
    if (spaceId) spaceIds.push(spaceId)
    record(
      'space.create works over stdio',
      !created.isError && typeof spaceId === 'string',
      `spaceId=${String(spaceId)}`,
    )

    const opened = await callTool('space.open_tab', {
      url: 'https://example.com/?stdio=a',
    })
    record(
      'space.open_tab works over stdio',
      !opened.isError && typeof opened.structured.pageId === 'number',
      `pageId=${String(opened.structured.pageId)} label=${String(opened.structured.label)}`,
    )

    await new Promise((r) => setTimeout(r, 800))

    const current = await callTool('space.current', {})
    const currentSpace = current.structured.space as
      | { windowId?: number; tabIds?: number[] }
      | undefined
    record(
      'the stdio face gives the space its OWN window (the provider-gateway bug)',
      typeof currentSpace?.windowId === 'number' &&
        (await listWindows()).length === baselineWindows.length + 1,
      `windowId=${String(currentSpace?.windowId)} windows=${baselineWindows.length}->${(await listWindows()).length}`,
    )

    const listed = await callTool('space.list_tabs', { view: 'all' })
    const tabs = (listed.structured.tabs ?? []) as Array<{
      pageId: number
      tabId?: number
      targetId?: string
      url?: string
    }>
    record(
      'the ledger records the native tab identity and the real URL',
      tabs.length === 1 &&
        typeof tabs[0].tabId === 'number' &&
        typeof tabs[0].targetId === 'string' &&
        tabs[0].url === 'https://example.com/?stdio=a',
      `tabs=${JSON.stringify(tabs).slice(0, 180)}`,
    )

    const finished = await callTool('space.finish', { keep: [] })
    spaceIds.length = 0
    record(
      'space.finish closes the tab and the space over stdio',
      !finished.isError && finished.structured.closedSpace === true,
      `closedLabels=${JSON.stringify(finished.structured.closedLabels)}`,
    )
    await new Promise((r) => setTimeout(r, 700))
    record(
      'the space window went away with it',
      (await listWindows()).length === baselineWindows.length,
      `windows=${(await listWindows()).length} (baseline ${baselineWindows.length})`,
    )
  } finally {
    for (const id of spaceIds) {
      await callTool('space.close', { spaceId: id, keep: false }).catch(() => {})
    }
    try {
      child.stdin!.end()
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 800))
    for (const t of await listTargets()) {
      if (!baselineTargets.has(t.id)) {
        await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {})
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
    throw new Error(`space stdio live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: space stdio live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error(
    'SPACE STDIO LIVE SMOKE FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
