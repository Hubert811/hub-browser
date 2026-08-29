/**
 * F17 companion — adapter command audit (execution.js → adapter-audit.js).
 *
 * Adapter commands were the agent's heaviest browser activity yet bypassed
 * every audit surface. Covers the contract of makeAdapterAudit /
 * wrapPageForAudit:
 *   1. proxy semantics: async/sync methods record child rows, getters and
 *      non-function properties pass through, errors propagate AND record;
 *   2. parent row + primitive child rows land in the audit sink linked via
 *      parent_dispatch_id, with redacted args and primitives summary;
 *   3. the child-row cap (500) leaves a `capped` marker on the parent;
 *   4. executeCommand end-to-end: success and D3 no-space guard rejection
 *      both land exactly one parent row (source cli);
 *   5. the claw dual-write carries the real agent identity and redacted args,
 *      and end() closes the working-period session with kind closed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { AuditLog, setAuditSink } from '../src/audit/audit-log.ts'
import { makeAdapterAudit, wrapPageForAudit } from '../src/opencli-engine/adapter-audit.js'
import type { AuditDispatchRow } from '../src/audit/audit-log.ts'

// Claw reporter env must be set before the singleton constructs (first
// finish() call). Describe bodies execute at file load, before any test.
process.env.HUB_CLAW_REPORT = 'on'
process.env.HUB_CLAW_SERVER_URL = 'http://127.0.0.1:9210'
process.env.HUB_CLAW_SESSIONS_FILE = `/tmp/hub-claw-sessions-audit-${process.pid}.json`

// Restore the process for later test files: unset the env and force the
// shared singleton offline (bun runs every file in one process).
afterAll(async () => {
  delete process.env.HUB_CLAW_REPORT
  delete process.env.HUB_CLAW_SERVER_URL
  delete process.env.HUB_CLAW_SESSIONS_FILE
  try {
    const { clawHarnessReporter } = await import('../src/browser-mcp/src/tools/claw-reporter.ts')
    clawHarnessReporter.setConnectionDown(true)
  } catch {
    // module never loaded — nothing to disable
  }
})

const dirs: string[] = []
let sink: AuditLog

// Mock fetch for the WHOLE file: earlier describes' finish() calls hit the
// claw singleton too, and a real refused connection would self-disable it
// before the dual-write describe gets its turn.
const originalFetch = globalThis.fetch
const requests: Array<{ url: string; body: any }> = []

beforeEach(() => {
  requests.length = 0
  globalThis.fetch = (async (input: any, init?: { method?: string; body?: string }) => {
    requests.push({
      url: String(input),
      body: init?.body !== undefined ? JSON.parse(init.body) : null,
    })
    return { ok: true, status: 200 } as Response
  }) as typeof fetch
  sink = freshSink()
  setAuditSink(sink)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setAuditSink(undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshSink(): AuditLog {
  const dir = mkdtempSync(join(tmpdir(), 'hub-adapter-audit-'))
  dirs.push(dir)
  return new AuditLog(join(dir, 'audit.db'))
}

function rows(): AuditDispatchRow[] {
  return sink.listDispatches({ limit: 500 })
}

const CMD = {
  site: 'quickbi',
  name: 'quote-detail',
  domain: 'quickbi.com',
  browser: true,
  args: [],
}

describe('wrapPageForAudit — proxy instrumentation', () => {
  it('records one child entry per async/sync method call; getters pass through', async () => {
    const records: Array<{ tool: string; ok: boolean }> = []
    const calls: string[] = []
    const page = {
      get session() {
        return 'page-7'
      },
      evaluate: async (expr: string) => {
        calls.push(expr)
        return 42
      },
      snapshot: () => ({ nodes: 3 }),
      fail: async () => {
        throw new Error('boom')
      },
    }
    const proxy = wrapPageForAudit(page, (rec) => records.push(rec))

    expect(proxy.session).toBe('page-7')
    expect(proxy.snapshot()).toEqual({ nodes: 3 })
    await expect(proxy.evaluate('1+1')).resolves.toBe(42)
    await expect(proxy.fail()).rejects.toThrow('boom')

    expect(calls).toEqual(['1+1'])
    expect(records.map((r) => r.tool)).toEqual(['snapshot', 'evaluate', 'fail'])
    expect(records.map((r) => r.ok)).toEqual([true, true, false])
    expect(records[2].error).toContain('boom')
    // `then` stays unwrapped so `await proxy` never treats it as thenable.
    expect('then' in proxy).toBe('then' in page)
  })
})

describe('makeAdapterAudit — parent + child rows', () => {
  it('links primitive child rows to the command parent with redacted args', async () => {
    const audit = makeAdapterAudit({
      cmd: CMD,
      kwargs: { username: 'hubert', password: 's3cret-token', fields: ['a', 'b'] },
      agentId: 'qbi-cp',
      source: 'cli',
    })
    const page = audit.wrapPage({
      evaluate: async () => 1,
      click: async () => undefined,
    })
    await page.evaluate('x')
    await page.click('sel')
    await audit.finish({ error: undefined, page: undefined, binding: { pageId: 7 } })

    const all = rows()
    const parent = all.find((r) => r.parent_dispatch_id === null)
    const children = all.filter((r) => r.parent_dispatch_id === parent!.dispatch_id)
    expect(parent?.tool_name).toBe('quickbi/quote-detail')
    expect(parent?.source).toBe('cli')
    expect(parent?.convo_id).toBe('qbi-cp')
    expect(parent?.ok).toBe(1)
    expect(parent?.page_id).toBe(7)
    expect(parent?.args_json).not.toContain('s3cret-token')
    expect(parent?.args_json).toContain('[REDACTED]')
    const meta = JSON.parse(parent!.result_meta!)
    expect(meta.primitives.count).toBe(2)
    expect(meta.isError).toBe(false)

    expect(children.map((c) => c.tool_name).sort()).toEqual(['page.click', 'page.evaluate'])
    for (const child of children) {
      expect(child.parent_dispatch_id).toBe(parent!.dispatch_id)
      expect(child.ok).toBe(1)
      expect(child.convo_id).toBe('qbi-cp')
    }
  })

  it('records the failing primitive and the parent error row', async () => {
    const audit = makeAdapterAudit({ cmd: CMD, kwargs: {}, agentId: 'a1', source: 'cli' })
    const page = audit.wrapPage({
      evaluate: async () => {
        throw new Error('degradation: render hung')
      },
    })
    await expect(page.evaluate('x')).rejects.toThrow('degradation')
    await audit.finish({ error: new Error('command failed: quote fields missing'), page: undefined, binding: undefined })

    const all = rows()
    const parent = all.find((r) => r.parent_dispatch_id === null)!
    const child = all.find((r) => r.tool_name === 'page.evaluate')!
    expect(parent.ok).toBe(0)
    expect(parent.error).toContain('quote fields missing')
    expect(child.ok).toBe(0)
    expect(child.error).toContain('degradation')
    const meta = JSON.parse(parent.result_meta!)
    expect(meta.isError).toBe(true)
  })

  it('caps child rows at 500 and marks the parent resultMeta capped', async () => {
    const audit = makeAdapterAudit({ cmd: CMD, kwargs: {}, agentId: 'a1', source: 'cli' })
    const page = audit.wrapPage({ evaluate: async () => 1 })
    for (let i = 0; i < 520; i++) {
      await page.evaluate(`i${i}`)
    }
    await audit.finish({ error: undefined, page: undefined, binding: undefined })

    const all = rows()
    const parent = all.find((r) => r.parent_dispatch_id === null)!
    const children = sink.listDispatches({ parentDispatchId: parent.dispatch_id, limit: 500 })
    expect(children).toHaveLength(500)
    const meta = JSON.parse(parent.result_meta!)
    expect(meta.primitives.count).toBe(520)
    expect(meta.primitives.capped).toBe(true)
  })
})

describe('executeCommand — adapter audit hook (end-to-end)', () => {
  it('success path: one parent row plus page.* children with redacted args', async () => {
    const storagePath = join(mkdtempSync(join(tmpdir(), 'hub-audit-e2e-')), 'spaces.json')
    dirs.push(dirname(storagePath))
    const { TaskSpaceManager } = await import('../src/space/task-space-manager.ts')
    const setup = new TaskSpaceManager({ storagePath, persist: true })
    await setup.create('agent-a', 'space A')

    // Fake BrowserOS session seam (same pattern as execution-space-binding).
    const tabs = [{ pageId: 7, targetId: 'target-7', tabId: 101, url: 'https://legacy.example/', isActive: true }]
    let nextId = 100
    const session = {
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => {
          if (expression === 'navigator.userAgent') {
            return { result: { value: 'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36' } }
          }
          if (expression.includes('getHighEntropyValues')) {
            return { result: { value: { platform: 'macOS', platformVersion: '26.5', architecture: 'arm', bitness: '64', model: '', uaFullVersion: '148.0' } } }
          }
          if (expression === 'window.location.href') {
            return { result: { value: 'https://quickbi.com/report' } }
          }
          return { result: { value: 'ok' } }
        },
      },
      Emulation: { setUserAgentOverride: async () => ({}) },
      Page: { addScriptToEvaluateOnNewDocument: async () => ({}) },
    }
    ;(globalThis as any).__HubBrowserFactory = {
      _cdp: {},
      _session: {
        pages: {
          list: async () => tabs.map((t) => ({ ...t })),
          newPage: async (url: string) => {
            const pageId = nextId++
            tabs.push({ pageId, targetId: `target-${pageId}`, tabId: 100 + pageId, url, isActive: false })
            return pageId
          },
          getSession: async (pageId: number) => ({ sessionId: `s-${pageId}`, session }),
          getInfo: (pageId: number) => tabs.find((t) => t.pageId === pageId),
        },
        cdpJsonForPage: async () => ({}),
      },
    }
    process.env.HUB_SPACES_FILE = storagePath
    process.env.HUB_AGENT_ID = 'agent-a'
    try {
      const { executeCommand } = await import('../src/opencli-engine/execution.js')
      const cmd = {
        ...CMD,
        navigateBefore: false,
        args: [],
        func: async (page: any) => {
          await page.evaluate('1+1')
          await page.evaluate('2+2')
          return { done: true }
        },
      }
      const result = await executeCommand(cmd, { password: 's3cret-token' }, false, { prepared: true })
      expect(result).toEqual({ done: true })

      const all = rows()
      const parent = all.find((r) => r.parent_dispatch_id === null)!
      expect(parent.tool_name).toBe('quickbi/quote-detail')
      expect(parent.source).toBe('cli')
      expect(parent.convo_id).toBe('agent-a')
      expect(parent.ok).toBe(1)
      expect(parent.page_id).toBeGreaterThan(0)
      expect(parent.args_json).not.toContain('s3cret-token')
      const children = all.filter((r) => r.parent_dispatch_id === parent.dispatch_id)
      expect(children.length).toBeGreaterThanOrEqual(2)
      expect(children.every((c) => c.tool_name.startsWith('page.'))).toBe(true)
    } finally {
      delete (globalThis as any).__HubBrowserFactory
      delete process.env.HUB_SPACES_FILE
      delete process.env.HUB_AGENT_ID
    }
  })

  it('D3 no-space rejection still lands a parent row with the guard error', async () => {
    const storagePath = join(mkdtempSync(join(tmpdir(), 'hub-audit-e2e-')), 'spaces.json')
    dirs.push(dirname(storagePath))
    const session = {
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => {
          if (expression === 'navigator.userAgent') return { result: { value: 'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36' } }
          if (expression.includes('getHighEntropyValues')) {
            return { result: { value: { platform: 'macOS', platformVersion: '26.5', architecture: 'arm', bitness: '64', model: '', uaFullVersion: '148.0' } } }
          }
          return { result: { value: undefined } }
        },
      },
      Emulation: { setUserAgentOverride: async () => ({}) },
      Page: { addScriptToEvaluateOnNewDocument: async () => ({}) },
    }
    ;(globalThis as any).__HubBrowserFactory = {
      _cdp: {},
      _session: {
        pages: {
          list: async () => [{ pageId: 7, targetId: 't-7', tabId: 101, url: 'https://x/', isActive: true }],
          newPage: async () => 8,
          getSession: async (pageId: number) => ({ sessionId: `s-${pageId}`, session }),
          getInfo: () => undefined,
        },
        cdpJsonForPage: async () => ({}),
      },
    }
    process.env.HUB_SPACES_FILE = storagePath
    process.env.HUB_AGENT_ID = 'ghost-agent'
    try {
      const { executeCommand } = await import('../src/opencli-engine/execution.js')
      const cmd = {
        ...CMD,
        navigateBefore: false,
        args: [],
        func: async () => 'never runs',
      }
      await expect(executeCommand(cmd, {}, false, { prepared: true })).rejects.toMatchObject({
        name: 'SpaceGuardError',
        code: 'no-space',
      })

      const parent = rows().find((r) => r.parent_dispatch_id === null && r.convo_id === 'ghost-agent')
      expect(parent).toBeDefined()
      expect(parent!.ok).toBe(0)
      expect(parent!.error).toContain('agent has no space')
    } finally {
      delete (globalThis as any).__HubBrowserFactory
      delete process.env.HUB_SPACES_FILE
      delete process.env.HUB_AGENT_ID
    }
  })
})

describe('makeAdapterAudit — claw dual-write', () => {
  it('reports the parent dispatch to claw with real identity and redacted args', async () => {
    const { clawHarnessReporter } = await import('../src/browser-mcp/src/tools/claw-reporter.ts')
    const audit = makeAdapterAudit({
      cmd: CMD,
      kwargs: { username: 'hubert', password: 's3cret-token' },
      agentId: 'qbi-cp',
      source: 'cli',
    })
    const page = audit.wrapPage({ evaluate: async () => 1 })
    await page.evaluate('x')
    await audit.finish({ error: undefined, page: undefined, binding: { pageId: 7 } })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const dispatch = requests.find((r) => r.url.endsWith('/dispatches'))
    expect(dispatch).toBeDefined()
    expect(dispatch!.body).toMatchObject({
      toolName: 'quickbi/quote-detail',
      agentId: 'qbi-cp',
      agentLabel: 'qbi-cp',
      pageId: 7,
    })
    expect(JSON.stringify(dispatch!.body.args)).not.toContain('s3cret-token')
    // Session start carries the identity too (not the legacy 'hub').
    const start = requests.find((r) => r.url.endsWith('/api/v1/harness/sessions'))
    expect(start?.body.agentId).toBe('qbi-cp')
    // end() closes the working-period session with the terminal kind.
    await clawHarnessReporter.endAllSessions()
    const end = requests.find((r) => r.url.endsWith('/end'))
    expect(end?.body).toEqual({ kind: 'closed' })
  })
})
