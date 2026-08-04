/**
 * Phase 4.3 — `opencli history` command group: list (reuses the fork history
 * tool -> History.getRecent) and search (History.search CDP domain), with
 * --limit / --since / --domain filtering. Fake bridge, no CDP needed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { FakeBrowser, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

const ENTRIES = [
  {
    id: 'h1',
    url: 'https://github.com/openai/codex',
    title: 'openai/codex',
    lastVisitTime: Date.parse('2026-07-20T10:00:00Z'),
    visitCount: 3,
    typedCount: 1,
  },
  {
    id: 'h2',
    url: 'https://example.com/help',
    title: 'Example Help',
    lastVisitTime: Date.parse('2026-07-19T08:00:00Z'),
    visitCount: 1,
    typedCount: 0,
  },
]

function makeEnv() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cli-cache-'))
  const browser = new FakeBrowser()
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
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

describe('opencli history command group (Phase 4.3)', () => {
  beforeEach(() => {
    installFakeBridge(new FakeBrowser())
  })
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    process.exitCode = 0
  })

  it('list reuses the fork history tool (History.getRecent) and prints entries', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'History.getRecent') return { entries: ENTRIES }
      return {}
    }
    const out = await env.run(['history', 'list'])
    expect(out).toContain('openai/codex')
    expect(out).toContain('https://github.com/openai/codex')
    expect(out).toContain('3 visits')
    expect(out).toContain('Example Help')
    const call = env.browser.cdpCalls.find((c) => c.method === 'History.getRecent')
    expect(call?.params).toMatchObject({ maxResults: 100 })
  })

  it('list --limit passes maxResults and --json returns the envelope', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'History.getRecent') return { entries: ENTRIES }
      return {}
    }
    const out = await env.run(['history', 'list', '--limit', '5', '--json'])
    const parsed = JSON.parse(out) as { entries: unknown[]; count: number }
    expect(parsed.count).toBe(2)
    expect(env.browser.cdpCalls.find((c) => c.method === 'History.getRecent')?.params)
      .toMatchObject({ maxResults: 5 })
  })

  it('list --since filters by lastVisitTime', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'History.getRecent') return { entries: ENTRIES }
      return {}
    }
    const out = await env.run(['history', 'list', '--since', '2026-07-20T00:00:00Z'])
    expect(out).toContain('openai/codex')
    expect(out).not.toContain('Example Help')
  })

  it('list --domain filters by hostname (host and subdomains)', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'History.getRecent') return { entries: ENTRIES }
      return {}
    }
    const out = await env.run(['history', 'list', '--domain', 'github.com'])
    expect(out).toContain('openai/codex')
    expect(out).not.toContain('Example Help')
  })

  it('list --since rejects invalid dates with a usage error', async () => {
    const env = makeEnv()
    const out = await env.run(['history', 'list', '--since', 'not-a-date'])
    expect(JSON.parse(out) as { error: { code: string } }).toMatchObject({ error: { code: 'usage_error' } })
  })

  it('search uses History.search and prints matches', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'History.search') return { entries: [ENTRIES[0]] }
      return {}
    }
    const out = await env.run(['history', 'search', 'codex'])
    expect(out).toContain('openai/codex')
    const call = env.browser.cdpCalls.find((c) => c.method === 'History.search')
    expect(call?.params).toMatchObject({ query: 'codex', maxResults: 100 })

    const jsonOut = await env.run(['history', 'search', 'codex', '--limit', '3', '--json'])
    expect((JSON.parse(jsonOut) as { count: number }).count).toBe(1)
  })

  it('search with no matches prints a friendly empty result', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'History.search') return { entries: [] }
      return {}
    }
    const out = await env.run(['history', 'search', 'zzz'])
    expect(out).toContain('(no matching history entries)')
  })
})
