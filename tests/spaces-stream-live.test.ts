/**
 * M1 (docs/specs/space-ledger-architecture.md, L1) — the daemon is the ledger's
 * authority, and `GET /spaces/stream` is how the browser-side Space UI hears
 * about changes instead of polling.
 *
 * Spins up a real daemon on an ephemeral port with a temp ledger. No browser is
 * needed: every assertion here is ledger-only.
 *
 * What is pinned:
 *   - the first frame is the CURRENT state (`reason: null`), so a subscriber
 *     never has to poll once to render;
 *   - an in-daemon change (a CLI `space create`, which the CLI forwards to the
 *     daemon) arrives as a pushed frame carrying the triggering event;
 *   - an EXTERNAL writer's change arrives too — that is the storage watcher,
 *     the transitional bridge to the writers that are not the daemon yet;
 *   - an attached subscriber suppresses the daemon's idle retirement, and the
 *     last viewer leaving re-arms it.
 */
import { describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const REPO_ROOT = process.cwd()
const HUB_BIN = path.join(REPO_ROOT, 'bin', 'hub.mjs')

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

async function health(port: number, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await health(port)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function runCli(port: number, env: Record<string, string>, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HUB_BIN, ...args], {
      env: { ...process.env, HUB_DAEMON_PORT: String(port), ...env },
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`cli exited ${code}: ${out}\n${err}`))
        return
      }
      resolve(out)
    })
  })
}

function stopDaemon(daemon: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!daemon?.pid) return resolve()
    daemon.on('exit', () => resolve())
    daemon.kill('SIGTERM')
    setTimeout(() => {
      try {
        daemon?.kill('SIGKILL')
      } catch {}
      resolve()
    }, 3000)
  })
}

type Frame = { reason: { type: string; spaceId?: string } | null; snapshot: { spaces: Array<{ name: string }> } }

/** Minimal SSE client: accumulates frames, lets a test await a predicate. */
function openSse(url: string) {
  const controller = new AbortController()
  const frames: Frame[] = []
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const w of [...waiters]) w()
  }
  let buffer = ''
  const ready = (async () => {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const dataLine = raw
              .split('\n')
              .find((l) => l.startsWith('data:'))
            if (!dataLine) continue // heartbeat comment
            frames.push(JSON.parse(dataLine.slice(5).trim()) as Frame)
            wake()
          }
        }
      } catch {
        /* aborted */
      }
      wake()
    })()
    return res
  })()
  return {
    frames,
    ready,
    async waitForFrame(pred: (f: Frame) => boolean, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = frames.find(pred)
        if (hit) return hit
        if (Date.now() > deadline) return undefined
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(onWake)
            resolve()
          }, 100)
          const onWake = () => {
            clearTimeout(timer)
            waiters.delete(onWake)
            resolve()
          }
          waiters.add(onWake)
        })
      }
    },
    close() {
      controller.abort()
    },
  }
}

function spawnDaemon(opts: {
  port: number
  ledger: string
  root: string
  idleTimeoutMs?: number
}): ChildProcess {
  return spawn(process.execPath, [HUB_BIN], {
    env: {
      ...process.env,
      HUB_DAEMON: 'true',
      HUB_DAEMON_PORT: String(opts.port),
      HUB_AGENT_ID: 'stream-probe',
      HUB_SPACES_FILE: opts.ledger,
      HUB_AUDIT_DB: path.join(opts.root, 'audit.db'),
      BROWSEROS_DIR: opts.root,
      BROWSEROS_CDP_PORT: '1',
      HUB_SPACE_REAP: 'off',
      HUB_DAEMON_IDLE_TIMEOUT: String(opts.idleTimeoutMs ?? 30000),
    },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('GET /spaces/stream — daemon push feed (M1)', () => {
  it('first frame is current state, then every ledger change is pushed', async () => {
    const port = await freePort()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-stream-'))
    const ledger = path.join(root, 'hub-spaces.json')
    let daemon: ChildProcess | undefined
    let sse: ReturnType<typeof openSse> | undefined

    try {
      daemon = spawnDaemon({ port, ledger, root })
      expect(await waitForHealth(port)).toBe(true)

      sse = openSse(`http://127.0.0.1:${port}/spaces/stream`)
      await sse.ready

      // 1. Hello frame: what IS, with no reason.
      const hello = await sse.waitForFrame((f) => f.reason === null)
      expect(hello).toBeDefined()
      expect(hello!.snapshot.spaces).toEqual([])

      // 2. An in-daemon change. The CLI forwards `space create` to the daemon,
      //    so it mutates the daemon's own ledger → bus → pushed frame.
      await runCli(port, { HUB_SPACES_FILE: ledger, HUB_AGENT_ID: 'stream-probe' }, [
        'space',
        'create',
        'streamed',
      ])

      const pushed = await sse.waitForFrame((f) => f.reason?.type === 'space.created')
      expect(pushed).toBeDefined()
      expect(pushed!.snapshot.spaces.map((s) => s.name)).toContain('streamed')
    } finally {
      sse?.close()
      await stopDaemon(daemon)
    }
  })

  it('an EXTERNAL writer is pushed too (storage watcher)', async () => {
    const port = await freePort()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-stream-ext-'))
    const ledger = path.join(root, 'hub-spaces.json')
    let daemon: ChildProcess | undefined
    let sse: ReturnType<typeof openSse> | undefined

    try {
      daemon = spawnDaemon({ port, ledger, root })
      expect(await waitForHealth(port)).toBe(true)

      sse = openSse(`http://127.0.0.1:${port}/spaces/stream`)
      await sse.ready
      await sse.waitForFrame((f) => f.reason === null)

      // An EXTERNAL writer touched the same ledger file — what a `hub --mcp`
      // stdio server or a direct CLI invocation of an older build does. Under
      // M5 it cannot CLAIM the ledger (the daemon holds the authority, so its
      // own manager would be read-only), which is exactly why the change is
      // modelled at the FILE level: the watcher's contract is "the file
      // changed", not "some manager wrote it". The daemon shares no memory
      // with this writer, so only the storage watcher can see it.
      const externalLedger = {
        version: 4,
        spaces: {
          outsider: {
            id: 'outsider',
            name: 'from-outside',
            owner: 'outsider',
            ownership: 'agent',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            tabs: [],
          },
        },
        currentSpaceByOwner: { outsider: 'outsider' },
      }
      fs.writeFileSync(ledger, JSON.stringify(externalLedger, null, 2), 'utf-8')

      const pushed = await sse.waitForFrame(
        (f) => f.reason?.type === 'space.ledger_reloaded',
      )
      expect(pushed).toBeDefined()
      expect(pushed!.snapshot.spaces.map((s) => s.name)).toContain('from-outside')

      // And the plain snapshot endpoint agrees (same in-memory authority).
      const snap = (await (
        await fetch(`http://127.0.0.1:${port}/spaces`)
      ).json()) as { spaces: Array<{ name: string }> }
      expect(snap.spaces.map((s) => s.name)).toContain('from-outside')
    } finally {
      sse?.close()
      await stopDaemon(daemon)
    }
  })

  it('a subscriber suppresses idle retirement; the last one leaving re-arms it', async () => {
    const port = await freePort()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-stream-idle-'))
    const ledger = path.join(root, 'hub-spaces.json')
    let daemon: ChildProcess | undefined
    let sse: ReturnType<typeof openSse> | undefined

    try {
      const idleMs = 1200
      daemon = spawnDaemon({ port, ledger, root, idleTimeoutMs: idleMs })
      expect(await waitForHealth(port)).toBe(true)

      sse = openSse(`http://127.0.0.1:${port}/spaces/stream`)
      await sse.ready
      await sse.waitForFrame((f) => f.reason === null)

      // No other request in this window: if the stream did not count as
      // activity, the daemon would have retired ~1.2s in.
      await new Promise((r) => setTimeout(r, idleMs * 2.5))
      expect(await health(port)).toBe(true)

      // Last viewer leaves → the idle timer is re-armed and the daemon retires.
      sse.close()
      sse = undefined
      // NOTE: no polling here. /health itself calls resetIdleTimer(), so a poll
      // loop would keep the daemon alive and make this assertion vacuous.
      await new Promise((r) => setTimeout(r, idleMs * 2.5))
      expect(await health(port)).toBe(false)
    } finally {
      sse?.close()
      await stopDaemon(daemon)
    }
  }, 30000)
})
