/**
 * Phase 4.4 / 4.5 — `opencli browser diff`, `browser read`, `browser grep`
 * (thin wrappers over the fork diff/read/grep tools). Fake bridge, no CDP.
 *
 * P1-4: the fork wrappers now run behind the executeTool space gate, so makeEnv
 * presets a space owning the fake page (100) — these tests exercise the
 * wrapper output formats, not the guard.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { FakeBrowser, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')
const GATE_OWNER = 'phase4-read-cli'

async function makeEnv() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-grep-diff-cache-'))
  const browser = new FakeBrowser()
  browser.tabs.push({ pageId: 100, targetId: 'target-100', url: 'https://example.com', isActive: true })
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  // Space-gate preset: one space owned by GATE_OWNER with the fake page in it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-grep-diff-spaces-'))
  const ledger = path.join(root, 'hub-spaces.json')
  process.env.HUB_SPACES_FILE = ledger
  process.env.HUB_AGENT_ID = GATE_OWNER
  const { TaskSpaceManager } = await import('../src/space/task-space-manager.ts')
  const manager = new TaskSpaceManager({ storagePath: ledger })
  await manager.create(GATE_OWNER, 'phase4')
  await manager.recordTabForCurrentSpace(GATE_OWNER, 100, 'https://example.com')
  return {
    cacheDir,
    browser,
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        process.env.OPENCLI_CACHE_DIR = cacheDir
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    },
  }
}

describe('opencli browser diff (Phase 4.4)', () => {
  beforeEach(() => installFakeBridge(new FakeBrowser()))
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.HUB_SPACES_FILE
    delete process.env.HUB_AGENT_ID
    process.exitCode = 0
  })

  it('prints the formatted diff from the fork diff tool', async () => {
    const env = await makeEnv()
    env.browser.diffResult = {
      changed: true,
      added: 'new line',
      removed: 'old line',
      text: '- old line\n+ new line',
      afterUrl: 'https://example.com',
    }
    const out = await env.run(['browser', '--session', 'work', 'diff'])
    expect(out).toContain('+ new line')
    expect(out).toContain('- old line')
  })

  it('--json prints the structured diff envelope', async () => {
    const env = await makeEnv()
    env.browser.diffResult = {
      changed: true,
      added: 'new line',
      removed: 'old line',
      text: 'x',
      afterUrl: 'https://example.com',
    }
    const out = await env.run(['browser', '--session', 'work', 'diff', '--json'])
    const parsed = JSON.parse(out) as { changed: boolean; added: string; removed: string }
    expect(parsed.changed).toBe(true)
    expect(parsed.added).toBe('new line')
    expect(parsed.removed).toBe('old line')
  })

  it('no-change diff says so', async () => {
    const env = await makeEnv()
    env.browser.diffResult = { changed: false }
    const out = await env.run(['browser', '--session', 'work', 'diff'])
    expect(out).toContain('no change since last snapshot')
  })
})

describe('opencli browser read (Phase 4.5)', () => {
  beforeEach(() => installFakeBridge(new FakeBrowser()))
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.HUB_SPACES_FILE
    delete process.env.HUB_AGENT_ID
    process.exitCode = 0
  })

  it('default format is markdown and prints extracted content', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = '**hello markdown**'
    const out = await env.run(['browser', '--session', 'work', 'read'])
    expect(out).toContain('hello markdown')
    expect(out).toContain('UNTRUSTED_PAGE_CONTENT')
  })

  it('--format links renders a link list', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = '[A](https://a.example)\n[B](https://b.example)'
    const out = await env.run(['browser', '--session', 'work', 'read', '--format', 'links'])
    expect(out).toContain('[A](https://a.example)')
    expect(out).toContain('[B](https://b.example)')
    const jsonOut = await env.run(['browser', '--session', 'work', 'read', '--format', 'links', '--json'])
    expect((JSON.parse(jsonOut) as { format: string }).format).toBe('links')
  })

  it('--format text prints plain text', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = 'plain text body'
    const out = await env.run(['browser', '--session', 'work', 'read', '--format', 'text'])
    expect(out).toContain('plain text body')
  })

  it('--selector is forwarded into the extraction expression', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = 'scoped content'
    await env.run(['browser', '--session', 'work', 'read', '--selector', 'div.main'])
    expect(env.browser.evaluateCalls.length).toBeGreaterThan(0)
    expect(env.browser.evaluateCalls[0]).toContain('div.main')
  })

  it('rejects unknown formats with a usage error', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'read', '--format', 'xml'])
    expect(JSON.parse(out) as { error: { code: string } }).toMatchObject({ error: { code: 'usage_error' } })
  })
})

describe('opencli browser grep (Phase 4.5)', () => {
  beforeEach(() => installFakeBridge(new FakeBrowser()))
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.HUB_SPACES_FILE
    delete process.env.HUB_AGENT_ID
    process.exitCode = 0
  })

  it('over=ax greps the snapshot and keeps refs', async () => {
    const env = await makeEnv()
    env.browser.snapshotText = 'title\nline with error here [ref=e2]\nfooter'
    const out = await env.run(['browser', '--session', 'work', 'grep', 'error'])
    expect(out).toContain('line with error here [ref=e2]')
    const jsonOut = await env.run(['browser', '--session', 'work', 'grep', 'error', '--json'])
    expect((JSON.parse(jsonOut) as { count: number; over: string }).count).toBe(1)
  })

  it('over=content greps visible text via evaluate', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = 'price: 100\nother line'
    const out = await env.run(['browser', '--session', 'work', 'grep', 'price', '--over', 'content'])
    expect(out).toContain('price: 100')
  })

  it('--limit caps the number of matching lines', async () => {
    const env = await makeEnv()
    env.browser.snapshotText = 'a error 1 [ref=e1]\nb error 2 [ref=e2]\nc error 3 [ref=e3]'
    const out = await env.run(['browser', '--session', 'work', 'grep', 'error', '--limit', '2', '--json'])
    const parsed = JSON.parse(out) as { count: number; matches: string[] }
    expect(parsed.count).toBe(2)
    expect(parsed.matches).toHaveLength(2)
  })

  it('no matches prints "no matches"', async () => {
    const env = await makeEnv()
    env.browser.snapshotText = 'nothing here'
    const out = await env.run(['browser', '--session', 'work', 'grep', 'zzz'])
    expect(out).toContain('no matches')
  })

  it('rejects an invalid --over value', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'grep', 'x', '--over', 'dom'])
    expect(JSON.parse(out) as { error: { code: string } }).toMatchObject({ error: { code: 'usage_error' } })
  })
})
