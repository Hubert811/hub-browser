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
})

describe('P2-3 claw harness reporter — lazy session + claim sequencing', () => {
  beforeEach(() => {
    process.env.HUB_CLAW_REPORT = 'on'
  })
  afterEach(() => {
    delete process.env.HUB_CLAW_REPORT
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
      const sessionId = clawSessionIdOf('mcp:claude:s1')
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
      await r.endSession('mcp:claude:s1')

      const endCall = mock.requests.find((req) => req.url.endsWith('/end'))
      expect(endCall?.body).toEqual({ kind: 'normal' })

      // After end, a new dispatch starts a fresh session + claim.
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
    } finally {
      mock.restore()
    }
  })
})
