/**
 * #11 — daemon picks up adapters written after its startup.
 *
 * The daemon caches the adapter registry in memory (discoveryDone runs once),
 * so an adapter created while the daemon was already running was invisible
 * until a restart. Fix: before every forwarded /command the daemon compares
 * the user clis tree's mtime signature; on change it re-runs that tree's
 * discovery (registerCommand is overwrite semantics — idempotent).
 *
 * Real daemon child process on an ephemeral port with an isolated
 * BROWSEROS_DIR (user clis = <root>/clis). Assertions key off `--help` output
 * so the probe adapter itself never needs to execute.
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
      srv.close(() => resolve(addr.port))
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

function runCli(port: number, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HUB_BIN, ...args], {
      env: { ...process.env, HUB_DAEMON_PORT: String(port), ...env },
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', () => resolve({ code: -1, out, err }))
    child.on('close', (code) => resolve({ code, out, err }))
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

const PROBE_ADAPTER = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
    site: 'probe11',
    name: 'hello',
    access: 'read',
    description: 'probe adapter written while the daemon runs (#11)',
    domain: 'probe11.invalid',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [],
    columns: ['message'],
    pipeline: [
        { map: { message: 'hello from a post-startup adapter' } },
    ],
});
`

describe('daemon picks up post-startup adapters (#11)', () => {
  it('an adapter written after daemon startup is recognized without a restart', async () => {
    const port = await freePort()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-adapters-'))
    let daemon: ChildProcess | undefined

    try {
      daemon = spawn(process.execPath, [HUB_BIN], {
        env: {
          ...process.env,
          HUB_DAEMON: 'true',
          HUB_DAEMON_PORT: String(port),
          HUB_AGENT_ID: 'adapter-probe',
          BROWSEROS_DIR: root,
          HUB_DAEMON_IDLE_TIMEOUT: '60000',
        },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(await waitForHealth(port)).toBe(true)

      // Warm the daemon: this /command run completes the one-shot discovery
      // WITHOUT the probe adapter (it does not exist yet). Note `hub
      // <unknown-site> --help` falls back to the global help and exits 0 —
      // the discriminator is whether the site's command shows up, not the
      // exit code.
      await runCli(port, ['space', 'list', '--json'])
      const before = await runCli(port, ['probe11', '--help'])
      expect(before.out).not.toContain('hello')

      // Write the adapter while the daemon keeps running. mtime granularity:
      // make sure the file's mtime differs from the tree snapshot taken at
      // discovery time (same-second writes can be invisible to mtimeMs).
      const siteDir = path.join(root, 'clis', 'probe11')
      fs.mkdirSync(siteDir, { recursive: true })
      const adapterPath = path.join(siteDir, 'hello.js')
      fs.writeFileSync(adapterPath, PROBE_ADAPTER)
      // Force a distinguishable mtime: discovery snapshot was taken earlier
      // this second; set the adapter's mtime safely into the future of that.
      const future = new Date(Date.now() + 2000)
      fs.utimesSync(adapterPath, future, future)

      // The very next command must see it — no daemon restart.
      const after = await runCli(port, ['probe11', '--help'])
      expect(after.out).toContain('hello')
      expect(after.out.toLowerCase()).toContain('probe adapter written while the daemon runs')
    } finally {
      if (daemon) await stopDaemon(daemon)
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
    }
  }, 60000)
})
