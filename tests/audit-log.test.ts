/**
 * P2-2 — audit log (SQLite sink).
 *
 * Unit: round-trip, redaction (secrets never land), bounding, parent/child
 * linkage, filters, opt-in activation.
 * Integration through the unified gate: every executeTool dispatch lands a
 * parent row (args redacted, result a summary), and run's bridged primitives
 * land child rows linked via parent_dispatch_id.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditLog,
  getAuditSink,
  setAuditSink,
} from '../src/audit/audit-log.ts'
import {
  TaskSpaceManager,
  type SpaceIdentity,
  type SpaceTabGateway,
  type TabLike,
} from '../src/space/task-space-manager.ts'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { run } from '../src/browser-mcp/src/tools/run.ts'
import { snapshot } from '../src/browser-mcp/src/tools/snapshot.ts'
import {
  createFakePage,
  makeContext,
} from '../src/browser-mcp/src/tools/test-helpers.ts'
import type { ToolContext } from '../src/browser-mcp/src/tools/framework.ts'

afterAll(() => {
  setAuditSink(undefined)
  delete process.env.HUB_AUDIT_DB
})

describe('AuditLog (P2-2 unit)', () => {
  let audit: AuditLog
  beforeEach(() => {
    audit = new AuditLog(
      join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.db'),
    )
  })

  it('round-trips a dispatch row with all fields', () => {
    const id = audit.recordDispatch({
      source: 'mcp',
      toolName: 'snapshot',
      convoId: 'convo-1',
      agentLabel: 'claude',
      sessionId: 'sess-1',
      pageId: 3,
      args: { page: 3 },
      resultMeta: { isError: false },
      durationMs: 42,
      ok: true,
    })
    expect(id).toBeTruthy()
    const rows = audit.listDispatches({ toolName: 'snapshot' })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.dispatch_id).toBe(id)
    expect(row.convo_id).toBe('convo-1')
    expect(row.agent_label).toBe('claude')
    expect(row.session_id).toBe('sess-1')
    expect(row.source).toBe('mcp')
    expect(row.page_id).toBe(3)
    expect(JSON.parse(row.args_json!)).toEqual({ page: 3 })
    expect(row.duration_ms).toBe(42)
    expect(row.ok).toBe(1)
  })

  it('redacts secrets in args before they land', () => {
    audit.recordDispatch({
      source: 'mcp',
      toolName: 'act',
      args: { page: 1, password: 'hunter2', api_key: 'sk-123', url: 'https://x.example/?token=abc' },
      durationMs: 1,
      ok: true,
    })
    const args = audit.listDispatches()[0].args_json!
    expect(args).toContain('[REDACTED]')
    expect(args).not.toContain('hunter2')
    expect(args).not.toContain('sk-123')
    expect(args).not.toContain('token=abc')
  })

  it('bounds oversized args payloads', () => {
    audit.recordDispatch({
      source: 'run',
      toolName: 'cdp',
      args: { params: { blob: 'x'.repeat(20_000) } },
      durationMs: 1,
      ok: true,
    })
    const args = audit.listDispatches()[0].args_json!
    expect(args.length).toBeLessThanOrEqual(4096 + 60)
    expect(args).toContain('truncated')
  })

  it('links child rows to the parent dispatch and filters by it', () => {
    const parent = audit.recordDispatch({
      source: 'mcp',
      toolName: 'run',
      durationMs: 100,
      ok: true,
    })
    audit.recordDispatch({
      parentDispatchId: parent,
      source: 'run',
      toolName: 'observe.snapshot',
      pageId: 1,
      durationMs: 5,
      ok: true,
    })
    audit.recordDispatch({
      parentDispatchId: parent,
      source: 'run',
      toolName: 'input.click',
      pageId: 1,
      durationMs: 3,
      ok: false,
      error: 'rejected',
    })
    const children = audit.listDispatches({ parentDispatchId: parent })
    expect(children.map((r) => r.tool_name)).toEqual([
      'input.click',
      'observe.snapshot',
    ])
    expect(children.every((r) => r.parent_dispatch_id === parent)).toBe(true)
  })

  it('filters by convo, paginates by cursor/limit, and persists across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-reopen-'))
    const path = join(dir, 'audit.db')
    const first = new AuditLog(path)
    for (let i = 0; i < 5; i += 1) {
      first.recordDispatch({
        source: 'mcp',
        toolName: `t${i}`,
        convoId: i % 2 === 0 ? 'convo-a' : 'convo-b',
        durationMs: i,
        ok: true,
      })
    }
    first.close()
    const reopened = new AuditLog(path)
    expect(reopened.listDispatches({ convoId: 'convo-a' })).toHaveLength(3)
    const page1 = reopened.listDispatches({ limit: 2 })
    expect(page1.map((r) => r.tool_name)).toEqual(['t4', 't3'])
    const page2 = reopened.listDispatches({ limit: 2, cursor: page1[1].id })
    expect(page2.map((r) => r.tool_name)).toEqual(['t2', 't1'])
    reopened.close()
  })

  it('stays a no-op in test runs (P2-4 default-ON, test safety valve)', () => {
    delete process.env.HUB_AUDIT_DB
    delete process.env.HUB_AUDIT
    const savedNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    setAuditSink(undefined)
    const sink = getAuditSink()
    // NULL sink returns the given id (or empty) and never throws.
    expect(sink.recordDispatch({ source: 'mcp', toolName: 'x', durationMs: 0, ok: true })).toBe('')
    expect(sink.listDispatches()).toEqual([])
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  })

  it('prunes rows past the age horizon, keeping newer ones (retention)', () => {
    const day = 86_400_000
    audit.recordDispatch({
      source: 'mcp', toolName: 'old', durationMs: 1, ok: true,
      createdAt: Date.now() - 40 * day,
    })
    audit.recordDispatch({
      source: 'mcp', toolName: 'fresh', durationMs: 1, ok: true,
      createdAt: Date.now(),
    })
    const deleted = audit.prune({ maxAgeDays: 30, maxCount: 100 })
    expect(deleted).toBeGreaterThanOrEqual(1)
    const names = audit.listDispatches().map((r) => r.tool_name)
    expect(names).toContain('fresh')
    expect(names).not.toContain('old')
  })

  it('prunes down to the newest maxCount rows', () => {
    for (let i = 0; i < 5; i += 1) {
      audit.recordDispatch({
        source: 'mcp', toolName: `keep-${i}`, durationMs: i, ok: true,
      })
    }
    const deleted = audit.prune({ maxAgeDays: 30, maxCount: 3 })
    expect(deleted).toBe(2)
    const names = audit.listDispatches().map((r) => r.tool_name)
    expect(names).toEqual(['keep-4', 'keep-3', 'keep-2'])
  })
})

describe('audit through the unified gate (P2-2 integration)', () => {
  let audit: AuditLog
  beforeEach(() => {
    audit = new AuditLog(
      join(mkdtempSync(join(tmpdir(), 'audit-gate-')), 'audit.db'),
    )
    setAuditSink(audit)
  })
  afterAll(() => {
    setAuditSink(undefined)
  })

  const AGENT: SpaceIdentity = {
    agentId: 'mcp:claude-code',
    convoId: 'mcp:claude-code:audit',
    displayName: 'claude-code',
  }

  function gatewayWithTabs(): { tabs: TabLike[]; gateway: SpaceTabGateway } {
    let nextPageId = 1
    const tabs: TabLike[] = []
    return {
      tabs,
      gateway: {
        newTab: async (url) => {
          const pageId = nextPageId++
          tabs.push({ pageId, targetId: `target-${pageId}`, url })
          return `target-${pageId}`
        },
        closeTab: async () => {},
        listTabs: async () => [...tabs],
      },
    }
  }

  it('executeTool lands a parent row (redacted args, summary result, page id)', async () => {
    const ctx: ToolContext = {
      ...makeContext(
        createFakePage({
          snapshot: async () => '[ref=e1] audited' as never,
        }),
      ),
      identity: AGENT,
    }
    const result = await executeTool(snapshot, { page: 1 }, ctx)
    expect(result?.isError).not.toBe(true)
    // ctx carries the dispatch id for child linkage.
    expect(ctx.dispatchId).toBeTruthy()

    const rows = audit.listDispatches({ toolName: 'snapshot' })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.source).toBe('mcp')
    expect(row.convo_id).toBe(AGENT.convoId)
    expect(row.agent_label).toBe('claude-code')
    expect(row.page_id).toBe(1)
    expect(JSON.parse(row.args_json!)).toEqual({ page: 1 })
    const meta = JSON.parse(row.result_meta!)
    expect(meta.isError).toBe(false)
    expect(meta.structuredKeys).toContain('page')
    expect(row.ok).toBe(1)
  })

  it('run lands child rows linked to the run dispatch', async () => {
    const fake = gatewayWithTabs()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'audit-run-')), 's.json'),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create(AGENT.convoId, 'audit-work')
    const ownTab = await manager.openTab(AGENT.convoId, space.id, 'https://own.example')
    const ctx: ToolContext = {
      ...makeContext(
        createFakePage({
          snapshot: async () => '[ref=e1] child' as never,
        }),
      ),
      identity: AGENT,
      spaces: manager,
    }

    const result = await executeTool(
      run,
      {
        code: `await browser.pages.list(); const s = await browser.observe(${ownTab}).snapshot(); return s.text`,
        timeout: 8000,
      },
      ctx,
    )
    expect(result?.isError).not.toBe(true)

    const runRows = audit.listDispatches({ toolName: 'run' })
    expect(runRows).toHaveLength(1)
    const parentId = runRows[0].dispatch_id
    const children = audit.listDispatches({ parentDispatchId: parentId })
    expect(children.map((r) => r.tool_name)).toEqual([
      'observe.snapshot',
      'pages.list',
    ])
    expect(children.every((r) => r.source === 'run')).toBe(true)
    expect(children.find((r) => r.tool_name === 'observe.snapshot')?.page_id).toBe(ownTab)
  })

  it('failed dispatches land with ok=0 and the error head', async () => {
    const fake = gatewayWithTabs()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'audit-guard-')), 's.json'),
      gateway: fake.gateway,
      persist: false,
    })
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager, // identity+spaces activate the guard; no space → D3
    }
    // foreign page (no space at all) → guard rejects inside executeTool
    const result = await executeTool(snapshot, { page: 99 }, ctx)
    expect(result?.isError).toBe(true)
    const row = audit.listDispatches({ toolName: 'snapshot' })[0]
    expect(row.ok).toBe(0)
    expect(row.error).toContain('no space')
    expect(JSON.parse(row.result_meta!).guard).toBe('no-space')
  })
})
