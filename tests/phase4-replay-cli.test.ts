/**
 * Phase 4.6 — `opencli replay` command group (claw-server-rust HTTP API):
 * list / show / export. The claw server HTTP layer is mocked via a global
 * fetch stub; no live server or CDP needed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

const SESSION_1 = {
  sessionId: 'sess-1',
  slug: 'search',
  name: 'Search task',
  status: 'done',
  startedAt: Date.parse('2026-07-20T10:00:00Z'),
  durationMs: 12000,
  dispatchCount: 3,
}
const SESSION_2 = {
  sessionId: 'sess-2',
  slug: 'other',
  name: 'Other task',
  status: 'live',
  startedAt: Date.parse('2026-07-21T10:00:00Z'),
  durationMs: 500,
  dispatchCount: 0,
}
const RECORDING_1 = {
  hasData: true,
  complete: true,
  sizeBytes: 4096,
  firstEventAt: Date.parse('2026-07-20T10:00:01Z'),
  lastEventAt: Date.parse('2026-07-20T10:02:00Z'),
  tabs: [
    {
      tabId: 1,
      complete: true,
      firstEventAt: Date.parse('2026-07-20T10:00:01Z'),
      lastEventAt: Date.parse('2026-07-20T10:02:00Z'),
      segments: [
        { documentId: 'doc-1', firstEventAt: 1, lastEventAt: 2, sizeBytes: 4000, eventCount: 12, hasGap: false },
      ],
    },
  ],
}
const NDJSON = [
  JSON.stringify({ type: 4, timestamp: 1000, data: { a: 1 } }),
  JSON.stringify({ type: 3, timestamp: 2000, data: { b: 2 } }),
  '',
].join('\n')

type FetchResponse = { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }

function makeFetchStub(routes: Record<string, FetchResponse>) {
  return async (url: string | URL | Request, init?: unknown): Promise<FetchResponse> => {
    const key = String(url)
    const entry = routes[key]
    if (!entry) {
      return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) }
    }
    return entry
  }
}

function makeEnv(fetchStub: (url: string | URL | Request, init?: unknown) => Promise<FetchResponse>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cli-'))
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  const originalFetch = globalThis.fetch
  ;(globalThis as any).fetch = fetchStub
  return {
    tmp,
    restore: () => {
      ;(globalThis as any).fetch = originalFetch
    },
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      const origStdout = process.stdout.write
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      process.stdout.write = (chunk: unknown) => {
        lines.push(String(chunk))
        return true
      }
      try {
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
        process.stdout.write = origStdout
      }
      return lines.join('\n')
    },
  }
}

describe('opencli replay command group (Phase 4.6)', () => {
  const base = 'http://127.0.0.1:9200'
  beforeEach(() => {
    process.exitCode = 0
  })
  afterEach(() => {
    delete process.env.CLAW_SERVER_URL
    delete process.env.BROWSEROS_SERVER_URL
    delete process.env.BROWSEROS_SERVER_PORT
    process.exitCode = 0
  })

  it('list annotates sessions with recording metadata (parallel probes)', async () => {
    const env = makeEnv(makeFetchStub({
      [`${base}/api/v1/sessions`]: {
        ok: true,
        status: 200,
        json: async () => ({ items: [SESSION_1, SESSION_2] }),
      },
      [`${base}/api/v1/sessions/sess-1/recording`]: {
        ok: true,
        status: 200,
        json: async () => RECORDING_1,
      },
      [`${base}/api/v1/sessions/sess-2/recording`]: {
        ok: false,
        status: 404,
        text: async () => '{"error":{"message":"session not found"}}',
      },
    }))
    try {
      const out = await env.run(['replay', 'list'])
      expect(out).toContain('sess-1')
      expect(out).toContain('[recording 4096 bytes')
      expect(out).toContain('sess-2')
      expect(out).toContain('[no recording]')
    } finally {
      env.restore()
    }
  })

  it('list --no-recordings skips probes', async () => {
    const requests: string[] = []
    const env = makeEnv(async (url: string | URL | Request) => {
      requests.push(String(url))
      if (String(url).endsWith('/api/v1/sessions')) {
        return { ok: true, status: 200, json: async () => ({ items: [SESSION_1] }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    try {
      const out = await env.run(['replay', 'list', '--no-recordings'])
      expect(out).toContain('sess-1')
      expect(requests).toHaveLength(1)
    } finally {
      env.restore()
    }
  })

  it('show prints recording metadata; --json returns the envelope', async () => {
    const env = makeEnv(makeFetchStub({
      [`${base}/api/v1/sessions/sess-1/recording`]: {
        ok: true,
        status: 200,
        json: async () => RECORDING_1,
      },
    }))
    try {
      const out = await env.run(['replay', 'show', 'sess-1'])
      expect(out).toContain('hasData: true')
      expect(out).toContain('complete: true')
      expect(out).toContain('sizeBytes: 4096')
      expect(out).toContain('tab 1')
      expect(out).toContain('12 event(s)')

      const jsonOut = await env.run(['replay', 'show', 'sess-1', '--json'])
      expect((JSON.parse(jsonOut) as { recording: { sizeBytes: number } }).recording.sizeBytes).toBe(4096)
    } finally {
      env.restore()
    }
  })

  it('show --timeline includes the rrweb event-type summary', async () => {
    const env = makeEnv(makeFetchStub({
      [`${base}/api/v1/sessions/sess-1/recording`]: {
        ok: true,
        status: 200,
        json: async () => RECORDING_1,
      },
      [`${base}/api/v1/sessions/sess-1/recording/events`]: {
        ok: true,
        status: 200,
        text: async () => NDJSON,
      },
    }))
    try {
      const out = await env.run(['replay', 'show', 'sess-1', '--timeline'])
      expect(out).toContain('2 event(s)')
      expect(out).toContain('4: 1')
      const jsonOut = await env.run(['replay', 'show', 'sess-1', '--timeline', '--json'])
      expect((JSON.parse(jsonOut) as { timeline: { events: number } }).timeline.events).toBe(2)
    } finally {
      env.restore()
    }
  })

  it('export defaults to raw ndjson on stdout', async () => {
    const env = makeEnv(makeFetchStub({
      [`${base}/api/v1/sessions/sess-1/recording/events`]: {
        ok: true,
        status: 200,
        text: async () => NDJSON,
      },
    }))
    try {
      const out = await env.run(['replay', 'export', 'sess-1'])
      expect(out).toContain('"type":4')
      expect(out).toContain('"type":3')
    } finally {
      env.restore()
    }
  })

  it('export --format json --out writes a JSON array file', async () => {
    const env = makeEnv(makeFetchStub({
      [`${base}/api/v1/sessions/sess-1/recording/events`]: {
        ok: true,
        status: 200,
        text: async () => NDJSON,
      },
    }))
    try {
      const target = path.join(env.tmp, 'recording.json')
      const out = await env.run(['replay', 'export', 'sess-1', '--format', 'json', '--out', target])
      expect(out).toContain(target)
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8')) as Array<{ type: number }>
      expect(parsed).toHaveLength(2)
      expect(parsed[0].type).toBe(4)
    } finally {
      env.restore()
    }
  })

  it('honors CLAW_SERVER_URL for the base URL', async () => {
    const customBase = 'http://127.0.0.1:9999'
    process.env.CLAW_SERVER_URL = customBase
    const env = makeEnv(makeFetchStub({
      [`${customBase}/api/v1/sessions`]: {
        ok: true,
        status: 200,
        json: async () => ({ items: [SESSION_1] }),
      },
    }))
    try {
      const out = await env.run(['replay', 'list', '--no-recordings'])
      expect(out).toContain('sess-1')
    } finally {
      env.restore()
    }
  })

  it('network failure prints the claw-server dependency hint', async () => {
    const env = makeEnv(async () => {
      throw new TypeError('fetch failed')
    })
    try {
      const out = await env.run(['replay', 'list'])
      expect(out).toContain('ERR')
      expect(out).toContain('replay depends on the BrowserClaw server')
      expect(out).toContain(base)
      expect(process.exitCode).toBe(69) // EX_UNAVAILABLE
    } finally {
      env.restore()
    }
  })

  it('404 from the server surfaces the HTTP error status', async () => {
    const env = makeEnv(makeFetchStub({
      [`${base}/api/v1/sessions/sess-x/recording`]: {
        ok: false,
        status: 404,
        text: async () => '{"error":{"message":"session not found"}}',
      },
    }))
    try {
      const out = await env.run(['replay', 'show', 'sess-x'])
      expect(out).toContain('HTTP 404')
    } finally {
      env.restore()
    }
  })
})
