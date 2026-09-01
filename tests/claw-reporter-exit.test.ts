/**
 * bug #36 — a direct-CLI adapter run must exit even when the claw server is
 * unreachable.
 *
 * drain() deliberately keeps failed queue entries for retry, so after a claw
 * POST failure the queue never empties. endSessionIds's Promise.race used to
 * abandon an unbounded waitForDrain poll — which kept scheduling 10ms timers
 * forever, pinning the event loop: the process printed its output but never
 * exited. `browser verify` (30s execFileSync) killed every browser adapter
 * subprocess because of this.
 *
 * The child script below reproduces the exact audit.end() shape — a failed
 * dispatch report against a dead claw port, then a fire-and-forget
 * endAllSessions with no process.exit. If the fix regresses, the child hangs
 * and this test times out. Mirrors the bug #9 precedent
 * (space-close-direct-exit.test.ts).
 */
import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const PROJECT_ROOT = path.join(import.meta.dir, '..')

describe('bug #36 — direct-CLI process exit with unreachable claw server', () => {
  it('exits on its own after a failed claw report + fire-and-forget end (no hang)', async () => {
    const sessionsFile = path.join(
      mkdtempSync(path.join(tmpdir(), 'claw-exit-')),
      'claw-sessions.json',
    )
    const childScript = path.join(
      mkdtempSync(path.join(tmpdir(), 'claw-exit-src-')),
      'exit-child.mjs',
    )
    writeFileSync(
      childScript,
      `
import { ClawHarnessReporter } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/browser-mcp/src/tools/claw-reporter.ts'))};

const r = new ClawHarnessReporter();
// One dispatch against the dead claw port: drain() fails fast (ECONNREFUSED)
// and keeps the entry queued for retry — the queue never empties afterwards.
r.reportDispatch({
  owner: 'cli:local',
  agentId: 'cli:local',
  toolName: 'probe cookie',
  durationMs: 5,
  createdAt: 1,
  isError: false,
});
// adapter-audit.js end() shape: fire-and-forget, no process.exit — the
// process must exit on its own once the event loop drains.
void r.endAllSessions('closed').catch(() => {});
console.log('done');
`,
    )

    const result = await new Promise<{ code: number | null; timedOut: boolean; stdout: string }>(
      (resolve, reject) => {
        // Port 1 on loopback: closed, so fetches fail immediately — no real
        // server dependency for this test.
        const child = spawn(process.execPath, [childScript], {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            HUB_CLAW_REPORT: 'on',
            HUB_CLAW_SERVER_URL: 'http://127.0.0.1:1',
            HUB_CLAW_SESSIONS_FILE: sessionsFile,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve({ code: null, timedOut: true, stdout })
        }, 15000)
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, timedOut: false, stdout })
        })
      },
    )

    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('done')
    expect(result.code).toBe(0)
  })
})
