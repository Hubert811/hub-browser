/**
 * Fix 1 (adapter-space e2e bug #3) — daemon identity passthrough.
 *
 * A shared daemon must apply each CLI caller's space-related env
 * (HUB_AGENT_ID / HUB_SPACES_FILE) for the duration of its command instead of
 * collapsing every caller onto the daemon's startup identity. This spins up a
 * real daemon (`bin/hub.mjs` HUB_DAEMON=true) on an ephemeral port and drives
 * it through the real CLI binary — no browser needed (`space create` is
 * ledger-only).
 *
 * Assertions:
 *   - CLI `space create` with HUB_AGENT_ID=adapter-X → ledger owner adapter-X
 *     (not the daemon's fixed-A) — proves the CLI forwards env AND the daemon
 *     applies it.
 *   - A second caller adapter-Y gets its own space/owner (no cross-talk).
 *   - A raw /command POST without `env` falls back to the daemon's identity
 *     (fixed-A) — per-command env is optional.
 */
import { describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const REPO_ROOT = path.join(process.cwd())
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

async function waitForHealth(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (res.ok) return true
    } catch {
      // not up yet
    }
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

function stopDaemon(daemon: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!daemon.pid) return resolve()
    daemon.on('exit', () => resolve())
    daemon.kill('SIGTERM')
    setTimeout(() => {
      try {
        daemon.kill('SIGKILL')
      } catch {}
      resolve()
    }, 3000)
  })
}

describe('daemon identity passthrough (bug #3)', () => {
  it('per-command HUB_AGENT_ID reaches the ledger; raw /command without env keeps daemon identity', async () => {
    const port = await freePort()
    const cdpPort = await freePort() // closed port → startup restore skipped fast
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-identity-'))
    const ledger = path.join(root, 'hub-spaces.json')
    let daemon: ChildProcess | undefined

    try {
      daemon = spawn(process.execPath, [HUB_BIN], {
        env: {
          ...process.env,
          HUB_DAEMON: 'true',
          HUB_DAEMON_PORT: String(port),
          HUB_AGENT_ID: 'fixed-A',
          HUB_SPACES_FILE: ledger,
          BROWSEROS_DIR: root,
          BROWSEROS_CDP_PORT: String(cdpPort),
          HUB_DAEMON_IDLE_TIMEOUT: '30000',
        },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let daemonErr = ''
      daemon.stderr.on('data', (d) => (daemonErr += d))
      expect(await waitForHealth(port)).toBe(true)

      // CLI caller adapter-X: the space owner must be adapter-X, not fixed-A.
      const outX = await runCli(port, { HUB_AGENT_ID: 'adapter-X', HUB_SPACES_FILE: ledger }, [
        'space',
        'create',
        'smoke-X',
        '--json',
      ])
      const createdX = JSON.parse(outX) as { space: { owner: string; name: string } }
      expect(createdX.space.name).toBe('smoke-X')
      expect(createdX.space.owner).toBe('adapter-X')

      // CLI caller adapter-Y: independent identity, no cross-talk.
      const outY = await runCli(port, { HUB_AGENT_ID: 'adapter-Y', HUB_SPACES_FILE: ledger }, [
        'space',
        'create',
        'smoke-Y',
        '--json',
      ])
      const createdY = JSON.parse(outY) as { space: { owner: string; name: string } }
      expect(createdY.space.name).toBe('smoke-Y')
      expect(createdY.space.owner).toBe('adapter-Y')

      // Raw /command without env → falls back to the daemon's identity (fixed-A).
      const rawRes = await fetch(`http://127.0.0.1:${port}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['space', 'create', 'smoke-daemon', '--json'] }),
      })
      const rawJson = (await rawRes.json()) as { stdout: string; stderr: string; exitCode: number }
      expect(rawJson.exitCode).toBe(0)
      const createdRaw = JSON.parse(rawJson.stdout) as { space: { owner: string; name: string } }
      expect(createdRaw.space.name).toBe('smoke-daemon')
      expect(createdRaw.space.owner).toBe('fixed-A')

      // Ledger ground truth: all three spaces persisted with correct owners.
      const persisted = JSON.parse(fs.readFileSync(ledger, 'utf-8')) as {
        spaces: Record<string, { name: string; owner: string }>
      }
      const owners = Object.values(persisted.spaces).map((s) => `${s.name}=${s.owner}`)
      expect(owners).toContain('smoke-X=adapter-X')
      expect(owners).toContain('smoke-Y=adapter-Y')
      expect(owners).toContain('smoke-daemon=fixed-A')
    } finally {
      if (daemon) await stopDaemon(daemon)
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
    }
  }, 60000)
})
