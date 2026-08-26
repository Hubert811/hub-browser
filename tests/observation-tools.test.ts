/**
 * P2-6 (batch 2) — observation tools (`network` / `console`): the pipelines
 * extracted to opencli-engine/browser/observation-query.js, shared by the CLI
 * commands (thin wrappers) and the MCP tool face. Tool-level tests run the
 * real capture → noise-filter → key → cache → shape pipeline; CLI-level tests
 * verify the wrapper output contracts survive toolification byte-compatibly
 * (envelope shapes + the CLI-native error envelopes with pipeline error codes).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProgram } from '../src/opencli-engine/cli.js'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { consoleTool, network } from '../src/browser-mcp/src/tools/observation-tools.ts'
import { createFakePage, makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'
import { FakeBrowser, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

// ── Tool level ─────────────────────────────────────────────────────────────

function cdpEntry(over: Record<string, unknown>) {
  return {
    url: 'https://api.example.com/v1/items',
    method: 'GET',
    responseStatus: 200,
    responseContentType: 'application/json',
    responseBodyFullSize: 42,
    responsePreview: '{"items":[{"id":1}],"total":1}',
    responseBodyTruncated: false,
    timestamp: Date.now() - 100,
    ...over,
  }
}

describe('network tool (P2-6 batch 2)', () => {
  beforeEach(() => {
    process.env.OPENCLI_CACHE_DIR = mkdtempSync(join(tmpdir(), 'obs-tool-cache-'))
  })
  afterEach(() => {
    delete process.env.OPENCLI_CACHE_DIR
  })

  const capture = [
    cdpEntry({}),
    cdpEntry({ url: 'https://api.example.com/v1/users', responsePreview: '{"users":[]}' }),
    // static noise: dropped by the default (non---all) filter
    cdpEntry({ url: 'https://cdn.example.com/app.js', responseContentType: 'application/javascript' }),
    // failed request
    cdpEntry({ url: 'https://api.example.com/v1/broken', responseStatus: 500 }),
  ]

  it('captures entries with keys, dropping static noise (default filter)', async () => {
    const page = createFakePage({ readNetworkCapture: async () => capture })
    const result = await executeTool(network, { page: 1 }, makeContext(page))
    expect(result.isError).toBeFalsy()
    const env = result.structuredContent as {
      session: string
      count: number
      filtered_out: number
      detail_hint: string
      entries: Array<{ key: string; status: number; shape: unknown }>
    }
    expect(env.count).toBe(3) // noise (.js) dropped
    expect(env.filtered_out).toBe(1)
    expect(env.entries.length).toBe(3)
    for (const e of env.entries) expect(typeof e.key).toBe('string')
    expect(env.detail_hint).toContain('detail')
  })

  it('all=true keeps static resources; failed=true keeps only status 0/>=400', async () => {
    const page = createFakePage({ readNetworkCapture: async () => capture })
    const all = await executeTool(network, { page: 1, all: true }, makeContext(page))
    expect((all.structuredContent as { count: number }).count).toBe(4)

    const failed = await executeTool(network, { page: 1, failed: true }, makeContext(page))
    const failedEnv = failed.structuredContent as { count: number; entries: Array<{ status: number }> }
    expect(failedEnv.count).toBe(1)
    expect(failedEnv.entries[0].status).toBe(500)
  })

  it('detail=<key> from a previous capture emits the full body', async () => {
    const page = createFakePage({ readNetworkCapture: async () => capture })
    const first = await executeTool(network, { page: 1 }, makeContext(page))
    const key = (first.structuredContent as { entries: Array<{ key: string }> }).entries[0].key
    const detail = await executeTool(network, { page: 1, detail: key }, makeContext(page))
    expect(detail.isError).toBeFalsy()
    const env = detail.structuredContent as { key: string; body: unknown; shape: unknown }
    expect(env.key).toBe(key)
    expect(env.body).toEqual({ items: [{ id: 1 }], total: 1 })
    expect(env.shape).toBeDefined()
  })

  it('detail with no cached capture is a structured error with the pipeline code', async () => {
    const page = createFakePage({ readNetworkCapture: async () => [] })
    const result = await executeTool(network, { page: 1, detail: 'nope' }, makeContext(page))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'cache_missing' })
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('[cache_missing]')
  })

  it('detail with an unknown key lists available keys', async () => {
    const page = createFakePage({ readNetworkCapture: async () => capture })
    await executeTool(network, { page: 1 }, makeContext(page)) // populate cache
    const result = await executeTool(network, { page: 1, detail: 'nope' }, makeContext(page))
    expect(result.isError).toBe(true)
    const err = result.structuredContent as { code: string; available_keys: string[] }
    expect(err.code).toBe('key_not_found')
    expect(err.available_keys.length).toBeGreaterThan(0)
  })
})

describe('console tool (P2-6 batch 2)', () => {
  const messages = [
    { type: 'log', text: 'boot ok', timestamp: Date.now() - 3000 },
    { type: 'error', text: 'boom', timestamp: Date.now() - 2000 },
    { type: 'warning', text: 'careful', timestamp: Date.now() - 1000 },
  ]

  it('returns the envelope with normalized ISO timestamps', async () => {
    const page = createFakePage({ consoleMessages: async () => messages })
    const result = await executeTool(consoleTool, { page: 1 }, makeContext(page))
    expect(result.isError).toBeFalsy()
    const env = result.structuredContent as {
      session: string
      count: number
      messages: Array<{ type: string; timestamp: string }>
    }
    expect(env.count).toBe(3)
    expect(env.messages[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("level=error keeps errors and warnings (CLI's error semantics)", async () => {
    const page = createFakePage({ consoleMessages: async () => messages })
    const result = await executeTool(consoleTool, { page: 1, level: 'error' }, makeContext(page))
    const env = result.structuredContent as { count: number; messages: Array<{ type: string }> }
    expect(env.count).toBe(2)
    expect(env.messages.map((m) => m.type).sort()).toEqual(['error', 'warning'])
  })
})

// ── CLI thin-wrapper level ──────────────────────────────────────────────────

const BUILTIN_CLIS = join(process.cwd(), 'clis')
const USER_CLIS = join(tmpdir(), 'hub-clis-empty-obs')
const GATE_OWNER = 'obs-cli'

async function makeEnv() {
  const browser = new FakeBrowser()
  browser.tabs.push({ pageId: 100, targetId: 'target-100', url: 'https://example.com', isActive: true })
  browser.networkCaptureResult = [
    cdpEntry({}),
    cdpEntry({ url: 'https://api.example.com/v1/users', responsePreview: '{"users":[]}' }),
  ]
  browser.consoleMessagesResult = [
    { type: 'log', text: 'hello', timestamp: Date.now() - 500 },
    { type: 'error', text: 'bad', timestamp: Date.now() - 250 },
  ]
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  // Space-gate preset (P1-4): one space owning the fake page so the wrapper
  // passes the executeTool gate.
  const root = mkdtempSync(join(tmpdir(), 'obs-spaces-'))
  const ledger = join(root, 'hub-spaces.json')
  process.env.HUB_SPACES_FILE = ledger
  process.env.HUB_AGENT_ID = GATE_OWNER
  process.env.OPENCLI_CACHE_DIR = mkdtempSync(join(tmpdir(), 'obs-cli-cache-'))
  const { TaskSpaceManager } = await import('../src/space/task-space-manager.ts')
  const manager = new TaskSpaceManager({ storagePath: ledger })
  await manager.create(GATE_OWNER, 'obs')
  await manager.recordTabForCurrentSpace(GATE_OWNER, 100, 'https://example.com')
  return {
    browser,
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    },
  }
}

describe('browser network / console CLI wrappers (P2-6 batch 2)', () => {
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.HUB_SPACES_FILE
    delete process.env.HUB_AGENT_ID
    process.exitCode = 0
  })

  it('network prints the capture envelope (pre-P2-6 contract)', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'network'])
    const parsed = JSON.parse(out) as {
      session: string
      captured_at: string
      count: number
      entries: Array<{ key: string }>
      detail_hint: string
    }
    expect(parsed.session).toBe('page-100')
    expect(parsed.count).toBe(2)
    expect(parsed.entries.length).toBe(2)
    expect(typeof parsed.entries[0].key).toBe('string')
    expect(parsed.detail_hint).toContain('--detail')
  })

  it('network --detail after a capture emits the full body (key continuity)', async () => {
    const env = await makeEnv()
    const list = JSON.parse(await env.run(['browser', '--session', 'work', 'network'])) as {
      entries: Array<{ key: string }>
    }
    const key = list.entries[0].key
    const out = await env.run(['browser', '--session', 'work', 'network', '--detail', key])
    const detail = JSON.parse(out) as { key: string; body: unknown }
    expect(detail.key).toBe(key)
    expect(detail.body).toEqual({ items: [{ id: 1 }], total: 1 })
  })

  it('network --detail with no cache keeps the CLI error envelope and code', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'network', '--detail', 'nope'])
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('cache_missing')
  })

  it('network local usage errors keep their CLI codes after toolification', async () => {
    const env = await makeEnv()
    const out = await env.run([
      'browser', '--session', 'work', 'network',
      '--detail', 'x', '--filter', 'a,b',
    ])
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('invalid_args')
  })

  it('console prints the snapshot envelope (pre-P2-6 contract)', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'console'])
    const parsed = JSON.parse(out) as {
      session: string
      count: number
      messages: Array<{ type: string; text: string }>
    }
    expect(parsed.session).toBe('page-100')
    expect(parsed.count).toBe(2)
    expect(parsed.messages[0].text).toBe('hello')
  })

  it('console --level error keeps the error+warning semantics', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'console', '--level', 'error'])
    const parsed = JSON.parse(out) as { count: number; messages: Array<{ type: string }> }
    expect(parsed.count).toBe(1)
    expect(parsed.messages[0].type).toBe('error')
  })

  it('console --since validation keeps the CLI error code', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'console', '--since', 'nope'])
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('invalid_since')
  })
})
