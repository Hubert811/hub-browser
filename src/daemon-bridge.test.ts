/**
 * `ensureDaemon` must not accept just ANY daemon on the port.
 *
 * Measured on the real machine before this check existed: a new `hub --mcp`
 * bridged to the 2026-09-09 build, which answered `{"status":"ok"}` — the client
 * ran the OLD command implementations and its `space.create` landed in the OLD
 * daemon's ledger while its own `HUB_SPACES_FILE` was never created. Silent
 * misdirection, reintroduced at the version boundary.
 *
 * Three outcomes are pinned here:
 *   - same ledger + identity  → reuse;
 *   - different ledger        → REFUSE (a configuration conflict, not a version
 *                               one — killing the other party's daemon would
 *                               just make two clients fight over the port);
 *   - no identity             → it is an older hub build → replace it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDaemon } from './daemon-bridge.js'
import { scopeEnv } from '../tests/helpers/env-scope.js'

interface FakeDaemon {
  port: number
  server: Server
  requests: string[]
  stopped: boolean
  stop(): Promise<void>
}

/** A stand-in daemon whose /health body we control. */
async function startFakeDaemon(
  health: () => Record<string, unknown>,
): Promise<FakeDaemon> {
  const requests: string[] = []
  const state = { stopped: false }
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(health()))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  server.on('close', () => {
    state.stopped = true
  })
  return {
    port,
    server,
    requests,
    get stopped() {
      return state.stopped
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (state.stopped) return resolve()
        server.close(() => resolve())
        // close() waits for connections; the health fetches are already done.
        setTimeout(resolve, 300)
      }),
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

describe('ensureDaemon identity', () => {
  test('reuses a daemon that reports the SAME ledger', async () => {
    const ledger = '/tmp/same-ledger.json'
    const daemon = await startFakeDaemon(() => ({
      status: 'ok',
      pid: 4242,
      version: '0.2.24',
      ledger,
    }))
    cleanups.push(() => daemon.stop())

    const ok = await ensureDaemon({
      port: daemon.port,
      hubBin: '/nonexistent/hub.mjs',
      ledger,
      warn: () => {},
    })

    expect(ok).toBe(true)
    expect(daemon.stopped).toBe(false)
  })

  test('REFUSES a daemon that owns a different ledger, and does not kill it', async () => {
    const daemon = await startFakeDaemon(() => ({
      status: 'ok',
      pid: 4242,
      version: '0.2.24',
      ledger: '/tmp/daemon-ledger.json',
    }))
    cleanups.push(() => daemon.stop())

    const warnings: string[] = []
    const ok = await ensureDaemon({
      port: daemon.port,
      hubBin: '/nonexistent/hub.mjs',
      ledger: '/tmp/client-ledger.json',
      warn: (m) => warnings.push(m),
    })

    expect(ok).toBe(false)
    // Both paths are named, so the message is actionable.
    expect(warnings.join('\n')).toContain('/tmp/daemon-ledger.json')
    expect(warnings.join('\n')).toContain('/tmp/client-ledger.json')
    // Someone else's daemon is not ours to kill: two clients with different
    // ledgers must not fight over the port.
    expect(daemon.stopped).toBe(false)
  })

  test('REPLACES a daemon with no identity (an older hub build)', async () => {
    // The old build's exact answer.
    const old = await startFakeDaemon(() => ({ status: 'ok' }))
    cleanups.push(() => old.stop())

    // A stand-in for the new daemon that ensureDaemon will spawn: it listens on
    // HUB_DAEMON_PORT (inherited from this process) and reports identity.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-hub-'))
    const fakeHub = path.join(dir, 'hub.mjs')
    fs.writeFileSync(
      fakeHub,
      `import { createServer } from 'node:http'
const port = Number(process.env.HUB_DAEMON_PORT)
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', pid: process.pid, version: '0.2.24', ledger: process.env.HUB_SPACES_FILE }))
    return
  }
  res.writeHead(404); res.end('{}')
}).listen(port, '127.0.0.1')
`,
      'utf-8',
    )
    const env = scopeEnv(['HUB_DAEMON_PORT', 'HUB_SPACES_FILE'])
    cleanups.push(() => env.restore())
    process.env.HUB_DAEMON_PORT = String(old.port)
    process.env.HUB_SPACES_FILE = '/tmp/client-ledger.json'

    const warnings: string[] = []
    const ok = await ensureDaemon({
      port: old.port,
      hubBin: fakeHub,
      ledger: '/tmp/client-ledger.json',
      timeoutMs: 8000,
      warn: (m) => warnings.push(m),
    })

    expect(ok).toBe(true)
    expect(warnings.join('\n')).toContain('replacing an older hub daemon')
    // The old one was stopped, and the port now answers with identity.
    expect(old.stopped).toBe(true)
    const health = (await (
      await fetch(`http://127.0.0.1:${old.port}/health`)
    ).json()) as { version?: string }
    expect(health.version).toBe('0.2.24')
    cleanups.push(async () => {
      try {
        process.kill(
          Number(
            (
              (await (
                await fetch(`http://127.0.0.1:${old.port}/health`)
              ).json()) as { pid?: number }
            ).pid,
          ),
          'SIGKILL',
        )
      } catch {
        /* already gone */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    })
  }, 20000)
})
