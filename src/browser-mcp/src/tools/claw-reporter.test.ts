import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { ClawHarnessReporter, clawSessionIdOf } from './claw-reporter'

/**
 * P2-3 — the claw harness reporter contract.
 *
 * The reporter is an append-only observability feed to the BrowserClaw server
 * (the patched harness API). It must never gate a tool dispatch: session
 * starts and tab claims ride lazily in front of the first dispatch that needs
 * them, connection failures self-disable the reporter until a re-probe, and
 * queue pressure drops the oldest work.
 */

interface RecordedRequest {
  method: string
  url: string
  body: unknown
}

type MockOutcome = { ok: boolean; status?: number }

function withMockFetch(handler: (req: RecordedRequest) => MockOutcome | Promise<MockOutcome>) {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body !== undefined ? JSON.parse(init.body) : null,
    }
    requests.push(req)
    const outcome = await handler(req)
    return { ok: outcome.ok, status: outcome.status ?? (outcome.ok ? 200 : 500) } as Response
  }) as typeof fetch
  return {
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function pathOf(url: string): string {
  return url.replace('http://127.0.0.1:9210', '')
}

function reporter(): ClawHarnessReporter {
  process.env.HUB_CLAW_REPORT = 'on'
  process.env.HUB_CLAW_SERVER_URL = 'http://127.0.0.1:9210'
  // HUB_CLAW_SESSIONS_FILE stays caller-controlled: each describe isolates
  // the session ledger with its own beforeEach path.
  return new ClawHarnessReporter()
}

describe('P2-3 claw session id derivation', () => {
  test('deterministic and Ulid-shaped (26 alphanumeric chars)', () => {
    const a = clawSessionIdOf('mcp:claude:abc123')
    const b = clawSessionIdOf('mcp:claude:abc123')
    const c = clawSessionIdOf('cli:local')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9A-Z]{26}$/)
    expect(c).toMatch(/^[0-9A-Z]{26}$/)
  })

  test('hub namespacing separates hub sessions from same-named claw agents', () => {
    // The derivation prefixes "hub:" so a hub owner key can never collide
    // with a claw session id that happens to equal the raw key.
    expect(clawSessionIdOf('hub')).not.toBe(clawSessionIdOf('hub:hub'))
  })

  test('per-working-period session ids: unique across process instances, Ulid-shaped', () => {
    process.env.HUB_CLAW_SESSIONS_FILE = '/tmp/hub-claw-sessions-test-shape.json'
    const a = new ClawHarnessReporter()
    const b = new ClawHarnessReporter()
    expect(a.sessionIdFor('cli:local')).toMatch(/^[0-9A-Z]{26}$/)
    // Two process instances (e.g. consecutive daemon lives) never share a
    // session id — the claw task projection would otherwise freeze at the
    // first working period's start/end events.
    expect(a.sessionIdFor('cli:local')).not.toBe(b.sessionIdFor('cli:local'))
    expect(a.sessionIdFor('cli:local')).not.toBe(a.sessionIdFor('qbi-cp'))
    delete process.env.HUB_CLAW_SESSIONS_FILE
  })
})

describe('P2-3 claw harness reporter — working-period sessions + identity', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_REPORT = 'on'
    process.env.HUB_CLAW_SESSIONS_FILE = `/tmp/hub-claw-sessions-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_REPORT
    delete process.env.HUB_CLAW_SESSIONS_FILE
  })

  test('agentId passthrough reaches session start, claim, and dispatch bodies', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({
        owner: 'qbi-cp',
        agentId: 'qbi-cp',
        agentLabel: 'qbi-cp',
        toolName: 'quickbi quote-detail',
        pageId: 7,
        tabId: 42,
        durationMs: 120,
        createdAt: 1000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(mock.requests[0].body).toMatchObject({ agentId: 'qbi-cp' })
      expect(mock.requests[1].body).toMatchObject({ agentId: 'qbi-cp' })
      expect(mock.requests[2].body).toMatchObject({ agentId: 'qbi-cp' })
      // Unattributed callers keep the legacy label.
      r.reportDispatch({ owner: 'x', toolName: 't', durationMs: 1, createdAt: 1, isError: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const dispatch = mock.requests.filter((req) => req.url.endsWith('/dispatches')).pop()
      expect(dispatch?.body).toMatchObject({ agentId: 'hub' })
    } finally {
      mock.restore()
    }
  })

  test('endAllSessions ends every started session with kind closed, after the queue drains', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      for (const owner of ['qbi-cp', 'cli:local']) {
        r.reportDispatch({ owner, toolName: 't', durationMs: 1, createdAt: 1, isError: false })
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      await r.endAllSessions()

      const ends = mock.requests.filter((req) => req.url.endsWith('/end'))
      expect(ends).toHaveLength(2)
      for (const end of ends) expect(end.body).toEqual({ kind: 'closed' })
      // The ends land after both sessions' dispatches.
      const lastDispatchIdx = mock.requests
        .map((req, i) => (req.url.endsWith('/dispatches') ? i : -1))
        .filter((i) => i >= 0)
        .pop()
      expect(ends[0]).toBe(mock.requests[lastDispatchIdx + 1] ?? ends[0])
      expect(r.currentSessionIdOf('qbi-cp')).toBeUndefined()
    } finally {
      mock.restore()
    }
  })

  test('session ledger records the working period; currentSessionIdOf tracks the live one', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      expect(r.currentSessionIdOf('qbi-cp')).toBeUndefined()
      r.reportDispatch({ owner: 'qbi-cp', agentId: 'qbi-cp', toolName: 't', durationMs: 1, createdAt: 1, isError: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(r.currentSessionIdOf('qbi-cp')).toBe(r.sessionIdFor('qbi-cp'))

      const fs = await import('node:fs')
      const ledger = JSON.parse(fs.readFileSync(process.env.HUB_CLAW_SESSIONS_FILE!, 'utf-8'))
      expect(ledger[0]).toMatchObject({ owner: 'qbi-cp', sessionId: r.sessionIdFor('qbi-cp') })
    } finally {
      mock.restore()
    }
  })
})

describe('P2-3 claw harness reporter — startup orphan sweep', () => {
  const HOUR = 60 * 60_000
  let now: number

  beforeEach(() => {
    process.env.HUB_CLAW_REPORT = 'on'
    process.env.HUB_CLAW_SESSIONS_FILE = `/tmp/hub-claw-sessions-sweep-${process.pid}-${Math.random().toString(36).slice(2)}.json`
    now = 10 * 24 * HOUR
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_REPORT
    delete process.env.HUB_CLAW_SESSIONS_FILE
  })

  interface SessionSpec {
    status?: string
    lastDispatchAt?: number[]
    httpStatus?: number
  }

  /** Mock fetch that answers GET /sessions/{id} from a spec map and accepts
   * the sweep's POST /end. */
  function withSweepMock(sessions: Record<string, SessionSpec>) {
    const requests: Array<{ method: string; url: string; body: unknown }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({
        method,
        url,
        body: init?.body !== undefined ? JSON.parse(init.body) : null,
      })
      const match = url.match(/\/api\/v1\/sessions\/([^/]+)$/)
      if (method === 'GET' && match) {
        const spec = sessions[match[1]]
        if (spec === undefined || spec.httpStatus === 404) {
          return { ok: false, status: 404 } as Response
        }
        if (spec.httpStatus !== undefined) return { ok: false, status: spec.httpStatus } as Response
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session: { status: spec.status ?? 'live' },
            dispatches: (spec.lastDispatchAt ?? []).map((t) => ({ createdAt: t })),
          }),
        } as unknown as Response
      }
      return { ok: true, status: 200 } as Response
    }) as typeof fetch
    return { requests, restore: () => { globalThis.fetch = original } }
  }

  function writeLedger(entries: Array<{ owner: string; sessionId: string; startedAt: number }>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs')
    fs.writeFileSync(process.env.HUB_CLAW_SESSIONS_FILE!, JSON.stringify(entries, null, 2))
  }

  function readLedger(): Array<{ owner: string; sessionId: string }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs')
    return JSON.parse(fs.readFileSync(process.env.HUB_CLAW_SESSIONS_FILE!, 'utf-8'))
  }

  test('ends stale live sessions with reason; keeps recent ones; drops terminal; ends zero-dispatch orphans', async () => {
    writeLedger([
      { owner: 'a', sessionId: 'STALELIVE0000000000000000AA', startedAt: now - 3 * HOUR },
      { owner: 'b', sessionId: 'RECENTLIVE000000000000000BB', startedAt: now - 10 * HOUR },
      { owner: 'c', sessionId: 'ALREADYDONE00000000000000CC', startedAt: now - 3 * HOUR },
      { owner: 'd', sessionId: 'ZERODISPATCH0000000000000DD', startedAt: now - 3 * HOUR },
    ])
    const mock = withSweepMock({
      STALELIVE0000000000000000AA: { status: 'live', lastDispatchAt: [now - 2 * HOUR] },
      RECENTLIVE000000000000000BB: { status: 'live', lastDispatchAt: [now - 5 * 60_000] },
      ALREADYDONE00000000000000CC: { status: 'done' },
      // Zero-dispatch orphan: the detail route 404s (dispatch_count filter),
      // but the session is still Live in the DB — the sweep must end it.
      ZERODISPATCH0000000000000DD: { httpStatus: 404 },
    })
    const r = reporter()
    try {
      const ended = await r.sweepStaleSessions(now)
      expect(ended).toBe(2)
      const ends = mock.requests.filter((req) => req.method === 'POST' && req.url.endsWith('/end'))
      expect(ends.map((e) => e.url.match(/sessions\/([^/]+)\/end$/)![1]).sort()).toEqual(
        ['STALELIVE0000000000000000AA', 'ZERODISPATCH0000000000000DD'].sort(),
      )
      expect(ends[0].body).toEqual({ kind: 'closed', reason: 'idle timeout sweep' })
      // Ledger keeps only the recently-active session.
      expect(readLedger().map((e) => e.sessionId)).toEqual(['RECENTLIVE000000000000000BB'])
    } finally {
      mock.restore()
    }
  })

  test('a session whose last dispatch is recent survives even when started long ago', async () => {
    // Long-lived daemon session: started 3 days ago, dispatch 10 minutes ago.
    writeLedger([{ owner: 'a', sessionId: 'LONGRUN000000000000000000EE', startedAt: now - 72 * HOUR }])
    const mock = withSweepMock({
      LONGRUN000000000000000000EE: { status: 'live', lastDispatchAt: [now - 10 * 60_000] },
    })
    const r = reporter()
    try {
      expect(await r.sweepStaleSessions(now)).toBe(0)
      expect(mock.requests.some((req) => req.method === 'POST')).toBe(false)
      expect(readLedger()).toHaveLength(1)
    } finally {
      mock.restore()
    }
  })

  test('claw unreachable mid-sweep stops and preserves the remaining ledger', async () => {
    writeLedger([
      { owner: 'a', sessionId: 'DOWNFIRST0000000000000000FF', startedAt: now - 3 * HOUR },
      { owner: 'b', sessionId: 'NEVERPROBED0000000000000GG', startedAt: now - 3 * HOUR },
    ])
    const mock = withSweepMock({
      DOWNFIRST0000000000000000FF: { httpStatus: 503 },
    })
    const r = reporter()
    try {
      expect(await r.sweepStaleSessions(now)).toBe(0)
      // Server down after the first lookup: the whole ledger survives.
      expect(readLedger().map((e) => e.sessionId).sort()).toEqual([
        'DOWNFIRST0000000000000000FF',
        'NEVERPROBED0000000000000GG',
      ])
      expect(mock.requests.some((req) => req.method === 'POST')).toBe(false)
    } finally {
      mock.restore()
    }
  })

  test('this process own live session is never swept', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({ owner: 'a', agentId: 'a', toolName: 't', durationMs: 1, createdAt: 1, isError: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const own = r.sessionIdFor('a')
      // Seed the ledger with an old startedAt for the OWN session id.
      writeLedger([{ owner: 'a', sessionId: own, startedAt: now - 3 * HOUR }])
      expect(await r.sweepStaleSessions(now)).toBe(0)
      expect(readLedger().map((e) => e.sessionId)).toEqual([own])
    } finally {
      mock.restore()
    }
  })

  test('empty ledger is a no-op (no network)', async () => {
    const mock = withSweepMock({})
    const r = reporter()
    try {
      expect(await r.sweepStaleSessions(now)).toBe(0)
      expect(mock.requests).toHaveLength(0)
    } finally {
      mock.restore()
    }
  })
})

describe('P2-3 claw harness reporter — lazy session + claim sequencing', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_REPORT = 'on'
    process.env.HUB_CLAW_SESSIONS_FILE = `/tmp/hub-claw-sessions-lazy-${process.pid}.json`
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_REPORT
    delete process.env.HUB_CLAW_SESSIONS_FILE
  })

  test('first dispatch issues session start, tab claim, then the dispatch — in order', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        pageId: 3,
        tabId: 101,
        durationMs: 20,
        createdAt: 1000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))

      const paths = mock.requests.map((req) => pathOf(req.url))
      const sessionId = r.sessionIdFor('mcp:claude:s1')
      expect(paths).toEqual([
        `/api/v1/harness/sessions`,
        `/api/v1/harness/sessions/${sessionId}/tabs`,
        `/api/v1/harness/sessions/${sessionId}/dispatches`,
      ])
      // Session start body shape
      expect(mock.requests[0].body).toEqual({
        sessionId,
        agentId: 'hub',
        slug: 'hub',
        agentLabel: 'hub-browser',
        clientName: 'hub-browser',
      })
      // Claim carries the dispatch timestamp as the window start
      expect(mock.requests[1].body).toEqual({ tabId: 101, claimedAt: 1000, agentId: 'hub' })
      // Dispatch row — resultMeta carries the official field set
      // (cancelled/contentSummary included; the report has no block count
      // so contentSummary stays absent, matching optional-field semantics)
      expect(mock.requests[2].body).toMatchObject({
        toolName: 'browser.click',
        pageId: 3,
        tabId: 101,
        resultMeta: JSON.stringify({ isError: false, cancelled: false }),
        durationMs: 20,
        createdAt: 1000,
      })
    } finally {
      mock.restore()
    }
  })

  test('subsequent dispatches skip session start and the same-tab claim', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      for (let i = 0; i < 3; i++) {
        r.reportDispatch({
          owner: 'mcp:claude:s1',
          toolName: 'browser.click',
          tabId: 101,
          durationMs: 1,
          createdAt: 1000 + i,
          isError: false,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 20))

      const sessionId = clawSessionIdOf('mcp:claude:s1')
      const paths = mock.requests.map((req) => pathOf(req.url))
      expect(paths.filter((p) => p === `/api/v1/harness/sessions`)).toHaveLength(1)
      expect(paths.filter((p) => p.endsWith('/tabs'))).toHaveLength(1)
      expect(paths.filter((p) => p.endsWith('/dispatches'))).toHaveLength(3)
      // A new tab claims again (same session)
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        tabId: 202,
        durationMs: 1,
        createdAt: 2000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const paths2 = mock.requests.map((req) => pathOf(req.url))
      expect(paths2.filter((p) => p.endsWith('/tabs'))).toHaveLength(2)
      expect(paths2.filter((p) => p === `/api/v1/harness/sessions`)).toHaveLength(1)
    } finally {
      mock.restore()
    }
  })

  test('guard rejections and errors map to the official JSON resultMeta shape', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        isError: true,
        guard: 'page-not-in-space',
        errorHead: '[page-not-in-space] Page 3 is outside',
        durationMs: 5,
        createdAt: 1000,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const dispatch = mock.requests.find((req) => req.url.endsWith('/dispatches'))
      expect(dispatch?.body).toMatchObject({
        resultMeta: JSON.stringify({
          isError: true,
          cancelled: false,
          guard: 'page-not-in-space',
          error: '[page-not-in-space] Page 3 is outside',
        }),
      })
    } finally {
      mock.restore()
    }
  })

  test('contentBlockCount renders the official contentSummary field', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'snapshot',
        isError: false,
        structuredKeys: ['page', 'content'],
        contentBlockCount: 4,
        durationMs: 75,
        createdAt: 1000,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const dispatch = mock.requests.find((req) => req.url.endsWith('/dispatches'))
      expect(dispatch?.body).toMatchObject({
        resultMeta: JSON.stringify({
          isError: false,
          cancelled: false,
          contentSummary: '4 block(s)',
          structuredKeys: ['page', 'content'],
        }),
      })
    } finally {
      mock.restore()
    }
  })
})

describe('P2-3 claw harness reporter — failure isolation', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_REPORT = 'on'
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_REPORT
  })

  test('connection refusal self-disables and stops issuing requests', async () => {
    let fail = true
    const mock = withMockFetch(() => (fail ? { ok: false, status: 503 } : { ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        durationMs: 1,
        createdAt: 1000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(r.isEnabled()).toBe(false)

      const countAfterFirst = mock.requests.length
      // Further reports are dropped while disabled (before the re-probe).
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        durationMs: 1,
        createdAt: 2000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(mock.requests.length).toBe(countAfterFirst)
    } finally {
      mock.restore()
    }
  })

  test('HUB_CLAW_REPORT=off disables the reporter outright', () => {
    process.env.HUB_CLAW_REPORT = 'off'
    const r = new ClawHarnessReporter()
    expect(r.isEnabled()).toBe(false)
    // reportDispatch on a disabled reporter never touches the network.
    r.reportDispatch({ owner: 'x', toolName: 't', durationMs: 1, createdAt: 1, isError: false })
  })

  test('default (no env) is disabled under NODE_ENV=test — tool tests stay offline', () => {
    delete process.env.HUB_CLAW_REPORT
    const r = new ClawHarnessReporter()
    expect(r.isEnabled()).toBe(false)
  })

  test('endSession posts the end call and clears tracking state', async () => {
    const mock = withMockFetch(() => ({ ok: true }))
    const r = reporter()
    try {
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        tabId: 101,
        durationMs: 1,
        createdAt: 1000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const endedSessionId = r.sessionIdFor('mcp:claude:s1')
      await r.endSession('mcp:claude:s1')

      const endCall = mock.requests.find((req) => req.url.endsWith('/end'))
      expect(endCall?.body).toEqual({ kind: 'closed' })

      // After end, a new dispatch starts a fresh session + claim — and the
      // period rotation guarantees the new session id differs from the ended
      // one (the claw task projection anchors to first start/end events).
      const before = mock.requests.length
      r.reportDispatch({
        owner: 'mcp:claude:s1',
        toolName: 'browser.click',
        tabId: 101,
        durationMs: 1,
        createdAt: 3000,
        isError: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(mock.requests.length).toBeGreaterThan(before)
      const paths = mock.requests.slice(before).map((req) => pathOf(req.url))
      expect(paths[0]).toBe('/api/v1/harness/sessions')
      const newSessionId = r.sessionIdFor('mcp:claude:s1')
      expect(newSessionId).not.toBe(endedSessionId)
    } finally {
      mock.restore()
    }
  })
})
