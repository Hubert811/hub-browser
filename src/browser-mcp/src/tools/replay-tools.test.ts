import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReplayHtml,
  exportClawReplay,
  fetchSessionTimeline,
  fetchStreamEvents,
  listClawStreams,
  replay_export,
  replay_list,
  type ClawStreamEntry,
} from './replay-tools'
import { clawSessionIdOf } from './claw-reporter'

/**
 * P2-3 batch 3b — the replay read face contract.
 *
 * The tools query the BrowserClaw server over HTTP (stream index, NDJSON
 * events, session timeline) and export a self-contained HTML replay with the
 * vendored rrweb-player. Transport failures surface as `claw_unreachable`
 * structured errors, empty/unknown documents as `replay_empty` /
 * `replay_metadata_missing`, and the exported HTML must be openable offline
 * (player inlined) with the dispatch timeline seeking the player.
 */

const DOC = '33D25F3CF060E81B14070BC356FF1871'

const STREAM: ClawStreamEntry = {
  documentId: DOC,
  tabId: 101,
  firstEventAt: 1_000_000,
  lastEventAt: 1_100_000,
  sizeBytes: 634_000,
  eventCount: 3,
  hasGap: false,
}

const NDJSON =
  '{"type":4,"timestamp":1000000,"data":{"width":800,"height":600}}\n' +
  '{"type":2,"timestamp":1050000}\n' +
  '{"type":3,"timestamp":1100000}\n' +
  '{"type":2,"timestamp":11' // torn tail line — skipped, never parsed

interface RecordedRequest {
  url: string
}

function withClawMock(handler: (req: RecordedRequest) => { ok: boolean; status?: number; body?: string }) {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const req: RecordedRequest = { url: String(input) }
    requests.push(req)
    const outcome = handler(req)
    const status = outcome.status ?? (outcome.ok ? 200 : 500)
    return {
      ok: outcome.ok,
      status,
      json: async () => JSON.parse(outcome.body ?? '{}'),
      text: async () => outcome.body ?? '',
    } as Response
  }) as typeof fetch
  return {
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function clawRoutes(overrides?: { streams?: unknown; events?: string; session?: unknown; sessionStatus?: number }) {
  return (req: RecordedRequest) => {
    const path = req.url.replace('http://127.0.0.1:9210', '')
    if (path.startsWith('/api/v1/recordings/streams') && !path.includes('/events')) {
      return { ok: true, body: JSON.stringify({ streams: overrides?.streams ?? [STREAM] }) }
    }
    if (path.includes('/events')) {
      return { ok: true, body: overrides?.events ?? NDJSON }
    }
    if (path.startsWith('/api/v1/sessions/')) {
      if (overrides?.sessionStatus === 404) return { ok: false, status: 404, body: '' }
      return { ok: true, body: JSON.stringify(overrides?.session ?? { session: { slug: 'hub' }, dispatches: [] }) }
    }
    return { ok: false, status: 404, body: '' }
  }
}

describe('P2-3 replay read face — stream index and events', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_SERVER_URL = 'http://127.0.0.1:9210'
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_SERVER_URL
  })

  test('listClawStreams passes filters through and returns the entries', async () => {
    const mock = withClawMock(clawRoutes())
    try {
      const outcome = await listClawStreams({ tabId: 101, fromMs: 500, limit: 7 })
      expect(outcome.ok).toBe(true)
      if (outcome.ok === false) return
      expect(outcome.value).toHaveLength(1)
      expect(outcome.value[0]?.documentId).toBe(DOC)
      expect(mock.requests[0]?.url).toContain('tabId=101')
      expect(mock.requests[0]?.url).toContain('fromMs=500')
      expect(mock.requests[0]?.url).toContain('limit=7')
    } finally {
      mock.restore()
    }
  })

  test('connection failures and HTTP errors collapse to claw_unreachable', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    try {
      const outcome = await listClawStreams()
      expect(outcome.ok).toBe(false)
      if (outcome.ok === true) return
      expect(outcome.error.code).toBe('claw_unreachable')
      expect(outcome.error.message).toContain('ECONNREFUSED')
    } finally {
      globalThis.fetch = original
    }

    const mock = withClawMock(() => ({ ok: false, status: 503 }))
    try {
      const outcome = await listClawStreams()
      expect(outcome.ok).toBe(false)
      if (outcome.ok === true) return
      expect(outcome.error.code).toBe('claw_unreachable')
      expect(outcome.error.message).toContain('503')
    } finally {
      mock.restore()
    }
  })

  test('fetchStreamEvents parses NDJSON and skips torn tail lines', async () => {
    const mock = withClawMock(clawRoutes())
    try {
      const outcome = await fetchStreamEvents(DOC, { fromMs: 1_020_000 })
      expect(outcome.ok).toBe(true)
      if (outcome.ok === false) return
      expect(outcome.value).toHaveLength(3)
      expect(mock.requests[0]?.url).toContain('fromMs=1020000')
    } finally {
      mock.restore()
    }
  })

  test('fetchSessionTimeline maps dispatches; unknown sessions read as undefined', async () => {
    const mock = withClawMock(
      clawRoutes({
        session: {
          session: { slug: 'hub', status: 'live' },
          dispatches: [
            {
              dispatchId: 1,
              createdAt: 1_070_000,
              toolName: 'browser.click',
              resultMeta: 'ok',
              durationMs: 45,
              url: 'https://example.com',
              argsJson: '{"x":1}',
            },
            { dispatchId: 2, createdAt: 1_080_000, toolName: 'run' },
          ],
        },
      }),
    )
    try {
      const outcome = await fetchSessionTimeline('SESSIONID')
      expect(outcome.ok).toBe(true)
      if (outcome.ok === false) return
      expect(outcome.value?.session.slug).toBe('hub')
      expect(outcome.value?.dispatches).toHaveLength(2)
      expect(outcome.value?.dispatches[0]).toEqual({
        dispatchId: 1,
        createdAt: 1_070_000,
        toolName: 'browser.click',
        resultMeta: 'ok',
        durationMs: 45,
        url: 'https://example.com',
      })
      // Unknown fields (argsJson) never cross into the timeline row.
      expect(Object.keys(outcome.value?.dispatches[0] ?? {})).not.toContain('argsJson')
    } finally {
      mock.restore()
    }

    const mock404 = withClawMock(clawRoutes({ sessionStatus: 404 }))
    try {
      const outcome = await fetchSessionTimeline('UNKNOWN')
      expect(outcome.ok).toBe(true)
      if (outcome.ok === false) return
      expect(outcome.value).toBeUndefined()
    } finally {
      mock404.restore()
    }
  })
})

describe('P2-3 replay export — self-contained HTML', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_SERVER_URL = 'http://127.0.0.1:9210'
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_SERVER_URL
  })

  test('exports a playable HTML file with events, timeline, and seek wiring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-replay-'))
    const out = join(dir, 'replay.html')
    const mock = withClawMock(
      clawRoutes({
        session: {
          session: { slug: 'hub' },
          dispatches: [
            { dispatchId: 1, createdAt: 1_070_000, toolName: 'browser.click', resultMeta: 'ok', durationMs: 45 },
          ],
        },
      }),
    )
    try {
      const outcome = await exportClawReplay({ documentId: DOC, sessionId: 'SESSIONID', out })
      expect(outcome.ok).toBe(true)
      if (outcome.ok === false) return
      expect(outcome.value.eventCount).toBe(3)
      expect(outcome.value.dispatchCount).toBe(1)
      expect(outcome.value.durationSec).toBe(100)
      expect(outcome.value.path).toBe(out)
      expect(existsSync(out)).toBe(true)

      const html = readFileSync(out, 'utf8')
      // Player inlined — the file opens offline.
      expect(html).toContain('rrwebPlayer')
      // Events embedded as JSON.
      expect(html).toContain('"timestamp":1050000')
      // Dispatch row carries its seek offset (70s after the first event).
      expect(html).toContain('data-t="70.0"')
      // Player sized from the Meta event viewport.
      expect(html).toContain('width: 800')
      expect(html).toContain('height: 600')
      // Timeline fetched for the requested session.
      expect(mock.requests.some((req) => req.url.includes('/api/v1/sessions/SESSIONID'))).toBe(true)
    } finally {
      mock.restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty event streams surface replay_empty; missing index rows replay_metadata_missing', async () => {
    const mock = withClawMock(clawRoutes({ events: '' }))
    try {
      const outcome = await exportClawReplay({ documentId: DOC })
      expect(outcome.ok).toBe(false)
      if (outcome.ok === true) return
      expect(outcome.error.code).toBe('replay_empty')
    } finally {
      mock.restore()
    }

    const mockNoIndex = withClawMock(clawRoutes({ streams: [] }))
    try {
      const outcome = await exportClawReplay({ documentId: DOC })
      expect(outcome.ok).toBe(false)
      if (outcome.ok === true) return
      expect(outcome.error.code).toBe('replay_metadata_missing')
    } finally {
      mockNoIndex.restore()
    }
  })

  test('buildReplayHtml escapes markup in dispatch fields and script-closing sequences in events', () => {
    const html = buildReplayHtml({
      stream: STREAM,
      events: [{ type: 2, timestamp: 1_000_000, data: { node: { textContent: '</script><b>x</b>' } } }],
      timeline: {
        session: { slug: 'hub' },
        dispatches: [
          {
            dispatchId: 1,
            createdAt: 1_050_000,
            toolName: '<img src=x onerror=alert(1)>',
            resultMeta: 'ok',
          },
        ],
      },
    })
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // `</script>` inside the embedded events JSON is neutralized.
    expect(html).not.toContain('</script><b>')
    expect(html).toContain('<\\/script>')
  })
})

describe('P2-3 replay MCP tools', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_SERVER_URL = 'http://127.0.0.1:9210'
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_SERVER_URL
  })

  test('replay.list renders summary lines with the structured stream list', async () => {
    const mock = withClawMock(clawRoutes())
    try {
      const result = await replay_list.handler(
        { tabId: 101 },
        {} as never,
        undefined as never,
      )
      const text = (result?.content as Array<{ type: string; text?: string }>)[0]?.text ?? ''
      expect(text).toContain(`[${DOC.slice(0, 8)}]`)
      expect(text).toContain('tab=101')
      const structured = result?.structuredContent as { streams: unknown[]; count: number }
      expect(structured.count).toBe(1)
    } finally {
      mock.restore()
    }
  })

  test('replay.list surfaces claw_unreachable as a structured error', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    try {
      const result = await replay_list.handler({}, {} as never, undefined as never)
      expect(result?.isError).toBe(true)
      const structured = result?.structuredContent as { code: string }
      expect(structured.code).toBe('claw_unreachable')
    } finally {
      globalThis.fetch = original
    }
  })

  test('replay.export derives the timeline session from ctx.identity by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-replay-'))
    const mock = withClawMock(
      clawRoutes({
        session: {
          session: { slug: 'hub' },
          dispatches: [{ dispatchId: 1, createdAt: 1_070_000, toolName: 'browser.click', resultMeta: 'ok' }],
        },
      }),
    )
    try {
      const result = await replay_export.handler(
        { documentId: DOC, out: join(dir, 'identity.html') },
        { identity: { agentId: 'mcp:claude', convoId: 'mcp:claude:s1', displayName: 'claude' } } as never,
        undefined as never,
      )
      expect(result?.isError).toBeFalsy()
      // The timeline was fetched for the conversation's derived claw session.
      const expected = clawSessionIdOf('mcp:claude:s1')
      expect(mock.requests.some((req) => req.url.endsWith(`/api/v1/sessions/${expected}`))).toBe(true)
      const structured = result?.structuredContent as { dispatchCount: number }
      expect(structured.dispatchCount).toBe(1)
    } finally {
      mock.restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('hub recording list CLI (P2-3)', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_SERVER_URL = 'http://127.0.0.1:9210'
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_SERVER_URL
  })

  test('prints the stream index as raw JSON', async () => {
    const mock = withClawMock(clawRoutes())
    const { createProgram } = await import('../../../opencli-engine/cli.js')
    const lines: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
    const origExit = process.exitCode
    try {
      const program = createProgram(
        join(process.cwd(), 'clis'),
        join(tmpdir(), 'no-user-clis'),
      )
      await program.parseAsync(['node', 'hub', 'recording', 'list', '--tab', '101'])
    } finally {
      console.log = origLog
      process.exitCode = origExit
      mock.restore()
    }
    const body = JSON.parse(lines.join('\n')) as {
      streams: Array<{ documentId: string }>
      count: number
    }
    expect(body.count).toBe(1)
    expect(body.streams[0]?.documentId).toBe(DOC)
  })

  test('prints the claw_unreachable envelope when the server is down', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const { createProgram } = await import('../../../opencli-engine/cli.js')
    const lines: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
    const origExit = process.exitCode
    try {
      const program = createProgram(
        join(process.cwd(), 'clis'),
        join(tmpdir(), 'no-user-clis'),
      )
      await program.parseAsync(['node', 'hub', 'recording', 'list'])
    } finally {
      console.log = origLog
      globalThis.fetch = original
    }
    const body = JSON.parse(lines.join('\n')) as {
      error: { code: string }
    }
    expect(body.error.code).toBe('claw_unreachable')
    expect(process.exitCode).not.toBe(0)
    process.exitCode = origExit
  })
})
