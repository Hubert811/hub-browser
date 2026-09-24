/**
 * Two AGENTS, one hub — through the stdio bridge.
 *
 * `hub --mcp` is a client of the daemon (M5), and it forwards the client's
 * `HUB_AGENT_ID` to it in the `x-hub-agent-id` header. Nothing tested that
 * header. If the daemon ignored it, every bridged agent would fall back to the
 * DAEMON's own (usually unset) identity and two agents would land in ONE
 * session-scoped space — silently merging two tasks' tabs, which is the exact
 * failure the M-series exists to prevent.
 *
 * This is the composition the other smokes miss:
 *   - space-multi-session-live-smoke: two MCP sessions over HTTP, no agent id
 *     (the session-derived identity path);
 *   - space-stdio-live-smoke: one bridged client, one agent id;
 *   - here: two bridged clients, one daemon, two DIFFERENT agent ids.
 *
 * Run: BROWSEROS_CDP_PORT=9112 bun tests/space-stdio-multi-agent-live-smoke.ts
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

interface WindowRow {
  windowId: number
  tabCount?: number
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
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, {
      stdio: 'ignore',
    })
  } catch {
    /* nothing listening */
  }
}

/** One bridged stdio MCP client (JSON-RPC over the child's pipes). */
function openClient(env: Record<string, string>, cwd: string) {
  const child: ChildProcess = spawn(process.execPath, [HUB_BIN, '--mcp'], {
    env: { ...process.env, ...env },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (msg: Record<string, unknown>) => void>()
  let buffer = ''
  let stderr = ''
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
        continue
      }
      const id = msg.id
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)!(msg)
        pending.delete(id)
      }
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8')
  })

  let nextId = 1
  const rpc = (
    method: string,
    params?: unknown,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 25000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      )
    })

  return {
    child,
    rpc,
    stderrText: () => stderr,
    async initialize(): Promise<void> {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'multi-agent-probe', version: '1' },
      })
      child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
          '\n',
      )
    },
    async callTool(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<{ structured: Record<string, unknown>; text: string }> {
      const msg = await rpc('tools/call', { name, arguments: args })
      const result = msg.result as
        | { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> }
        | undefined
      return {
        structured: result?.structuredContent ?? {},
        text: result?.content?.map((c) => c.text ?? '').join('\n') ?? '',
      }
    },
    close(): void {
      try {
        child.stdin!.end()
      } catch {
        /* already closed */
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    },
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())
  console.log(`[stdio-multi-agent] CDP ${port}`)
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
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  const baseline = (await listWindows()).length
  const root = mkdtempSync(join(tmpdir(), 'stdio-multi-agent-'))
  const ledger = join(root, 'hub-spaces.json')
  // ONE daemon port for BOTH clients — that is the whole point.
  const daemonPort = await freePort()
  let daemon: ChildProcess | undefined
  const clients: Array<ReturnType<typeof openClient>> = []
  const spaces: Array<{ id: string; owner: string }> = []

  try {
    daemon = spawn(process.execPath, [HUB_BIN], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_DAEMON: 'true',
        HUB_DAEMON_PORT: String(daemonPort),
        HUB_SPACES_FILE: ledger,
        HUB_AUDIT_DB: join(root, 'audit.db'),
        BROWSEROS_DIR: root,
        BROWSEROS_CDP_PORT: String(port),
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

    const commonEnv = {
      HUB_SPACES_FILE: ledger,
      BROWSEROS_DIR: root,
      BROWSEROS_CDP_PORT: String(port),
      HUB_DAEMON_PORT: String(daemonPort),
      HUB_SPACE_REAP: 'off',
      HUB_SESSION_END_SPACES: 'off',
    }
    const alpha = openClient(
      { ...commonEnv, HUB_AGENT_ID: 'multi-agent-alpha' },
      process.cwd(),
    )
    const beta = openClient(
      { ...commonEnv, HUB_AGENT_ID: 'multi-agent-beta' },
      process.cwd(),
    )
    clients.push(alpha, beta)
    await alpha.initialize()
    await beta.initialize()

    const createdA = await alpha.callTool('space.create', { name: 'alpha-work' })
    const spaceA = String(
      (createdA.structured.space as { id?: string } | undefined)?.id ?? '',
    )
    spaces.push({ id: spaceA, owner: 'multi-agent-alpha' })
    await alpha.callTool('space.open_tab', { url: 'https://example.com/?agent=a' })

    const createdB = await beta.callTool('space.create', { name: 'beta-work' })
    const spaceB = String(
      (createdB.structured.space as { id?: string } | undefined)?.id ?? '',
    )
    spaces.push({ id: spaceB, owner: 'multi-agent-beta' })
    await beta.callTool('space.open_tab', { url: 'https://example.com/?agent=b' })
    await new Promise((r) => setTimeout(r, 1200))

    record(
      'two bridged agents get two different spaces',
      spaceA !== '' && spaceB !== '' && spaceA !== spaceB,
      `A=${spaceA.slice(0, 8)} B=${spaceB.slice(0, 8)}`,
    )

    // The header is what makes this true: without it both clients would fall
    // back to the daemon's own identity and share ONE space.
    const tabsA = (await alpha.callTool('space.list_tabs')).structured
      .tabs as Array<{ url?: string }> | undefined
    const tabsB = (await beta.callTool('space.list_tabs')).structured
      .tabs as Array<{ url?: string }> | undefined
    record(
      'each agent sees ONLY its own tab (the x-hub-agent-id header works)',
      tabsA?.length === 1 &&
        String(tabsA[0].url).includes('agent=a') &&
        tabsB?.length === 1 &&
        String(tabsB[0].url).includes('agent=b'),
      `A=[${tabsA?.map((t) => t.url).join(',')}] B=[${tabsB?.map((t) => t.url).join(',')}]`,
    )

    const currentA = (await alpha.callTool('space.current')).structured.space as
      | { id?: string }
      | undefined
    const currentB = (await beta.callTool('space.current')).structured.space as
      | { id?: string }
      | undefined
    record(
      'each agent has its OWN current space',
      currentA?.id === spaceA && currentB?.id === spaceB,
      `A=${String(currentA?.id).slice(0, 8)} B=${String(currentB?.id).slice(0, 8)}`,
    )

    // The shared ledger is the one authority: both spaces are in it, each under
    // its own owner.
    const raw = JSON.parse(
      (await import('node:fs')).readFileSync(ledger, 'utf-8'),
    ) as { spaces: Record<string, { owner: string; name: string }> }
    const owners = Object.values(raw.spaces).map((s) => s.owner).sort()
    record(
      'the shared ledger holds both spaces under their own owners',
      owners.join(',') === 'multi-agent-alpha,multi-agent-beta',
      `owners=[${owners.join(',')}]`,
    )

    // Agent B must not be able to touch agent A's space.
    const stolen = await beta.callTool('space.list_tabs', { spaceId: spaceA })
    record(
      "an agent cannot read another agent's space",
      stolen.text.toLowerCase().includes('not') || stolen.text.includes('拒绝') ||
        !stolen.text.includes('agent=a'),
      `text=${JSON.stringify(stolen.text.slice(0, 120))}`,
    )
  } finally {
    for (const client of clients) client.close()
    for (const space of spaces) {
      try {
        await fetch(`http://127.0.0.1:${daemonPort}/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            argv: ['space', 'close', space.id],
            env: { HUB_AGENT_ID: space.owner },
          }),
          signal: AbortSignal.timeout(10000),
        })
      } catch {
        /* best-effort cleanup */
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
    throw new Error(
      `stdio multi-agent failures: ${failed.map((f) => f.name).join(', ')}`,
    )
  }
  console.log(
    `PASS: space stdio multi-agent live smoke (${results.length}/${results.length})`,
  )
}

main().catch((err) => {
  console.error(
    'SPACE STDIO MULTI-AGENT FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
