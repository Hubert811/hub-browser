/**
 * bug #9 — direct-connect `space close` must not hang.
 *
 * A non-daemon `space close`/`space refresh` creates its own BrowserBridge;
 * the open CDP connection used to keep the event loop alive, so the process
 * never exited. The fix: the action's finally tears the bridge down and calls
 * process.exit() (daemon mode excepted).
 *
 * This runs a real subprocess (no live Chrome needed): the fake bridge leaves
 * an interval running so the process CANNOT exit on its own — only the
 * action's finally + process.exit() terminates it. If the fix regresses, the
 * subprocess times out and the test fails.
 */
import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const PROJECT_ROOT = path.join(import.meta.dir, '..')
const BUILTIN_CLIS = path.join(PROJECT_ROOT, 'clis')
const USER_CLIS = path.join(process.env.HOME ?? process.cwd(), '.hub', 'clis')

describe('bug #9 — non-daemon `space close` process exit', () => {
  it('exits on its own after a direct-connect close (no hang, exit 0)', async () => {
    const ledger = path.join(
      mkdtempSync(path.join(tmpdir(), 'space-close-exit-')),
      'hub-spaces.json',
    )
    const childScript = path.join(
      mkdtempSync(path.join(tmpdir(), 'space-close-exit-src-')),
      'close-child.mjs',
    )
    writeFileSync(
      childScript,
      `
import { createProgram } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/opencli-engine/cli.js'))};
import { TaskSpaceManager } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/space/task-space-manager.ts'))};

// Fake bridge: connect() keeps the event loop alive with a never-cleared
// interval and close() is a no-op — exactly the pre-fix hang condition.
class FakeBridge {
  async connect() {
    setInterval(() => {}, 1000);
    return {
      newTab: async () => 'target-1',
      closeTab: async () => {},
      tabs: async () => [{ pageId: 1, targetId: 'target-1', url: 'https://example.com' }],
    };
  }
  async close() {}
}
globalThis.__HubBrowserBridgeOverride = FakeBridge;

// Setup: space with one attributed tab in the shared ledger.
const setup = new TaskSpaceManager({
  storagePath: process.env.HUB_SPACES_FILE,
  persist: true,
  gateway: {
    newTab: async () => 7,
    closeTab: async () => {},
    listTabs: async () => [{ pageId: 7, targetId: 'target-7', url: 'https://example.com' }],
  },
});
const space = await setup.create('cli:local', 'exit-smoke');
await setup.openTab('cli:local', space.id, 'https://example.com');
setup.dispose();

const program = createProgram(${JSON.stringify(BUILTIN_CLIS)}, ${JSON.stringify(USER_CLIS)});
// Non-daemon mode (no __HubDaemonMode): the finally must exit the process.
await program.parseAsync(['node', 'hub', 'space', 'close', space.id, '--json']);
`,
    )

    const result = await new Promise<{ code: number | null; timedOut: boolean; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [childScript], {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            HUB_SPACES_FILE: ledger,
            BROWSEROS_CDP_PORT: '9110',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve({ code: null, timedOut: true, stderr })
        }, 15000)
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, timedOut: false, stderr })
        })
      },
    )

    expect(result.timedOut).toBe(false)
    expect(result.stderr).not.toContain('Error:')
    expect(result.code).toBe(0)
  })
})
