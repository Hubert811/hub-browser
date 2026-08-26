/**
 * P2-4 — observability entries over the P2-2 audit sink:
 *  - resolveAuditDbPath activation matrix (explicit path > kill switch >
 *    test runs off > default ON in production);
 *  - the `audit.query` MCP tool (summary rows newest-first, filters, the
 *    "not active" notice);
 *  - the `hub audit list` CLI command (raw JSON rows, audit_off envelope).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditLog,
  resolveAuditDbPath,
  setAuditSink,
} from '../src/audit/audit-log.ts'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { audit_query } from '../src/browser-mcp/src/tools/audit-tools.ts'
import { createFakePage, makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'

const SAVED = {
  HUB_AUDIT_DB: process.env.HUB_AUDIT_DB,
  HUB_AUDIT: process.env.HUB_AUDIT,
  BUN_TEST: process.env.BUN_TEST,
  BROWSEROS_DIR: process.env.BROWSEROS_DIR,
}
afterAll(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setAuditSink(undefined)
})

describe('resolveAuditDbPath activation matrix (P2-4)', () => {
  it('explicit HUB_AUDIT_DB always wins', () => {
    process.env.HUB_AUDIT_DB = '/tmp/audit-explicit.db'
    process.env.HUB_AUDIT = 'off'
    process.env.NODE_ENV = 'test'
    expect(resolveAuditDbPath()).toBe('/tmp/audit-explicit.db')
  })

  it('HUB_AUDIT=off disables even outside tests', () => {
    delete process.env.HUB_AUDIT_DB
    process.env.HUB_AUDIT = 'off'
    delete process.env.NODE_ENV
    expect(resolveAuditDbPath()).toBeUndefined()
  })

  it('test runs stay off by default (BUN_TEST)', () => {
    delete process.env.HUB_AUDIT_DB
    delete process.env.HUB_AUDIT
    process.env.NODE_ENV = 'test'
    expect(resolveAuditDbPath()).toBeUndefined()
  })

  it('production default: on, under the hub user root', () => {
    delete process.env.HUB_AUDIT_DB
    delete process.env.HUB_AUDIT
    delete process.env.NODE_ENV
    const root = mkdtempSync(join(tmpdir(), 'audit-default-'))
    process.env.BROWSEROS_DIR = root
    expect(resolveAuditDbPath()).toBe(join(root, 'state', 'audit.db'))
    delete process.env.BROWSEROS_DIR
    process.env.NODE_ENV = 'test'
  })
})

describe('audit.query MCP tool (P2-4)', () => {
  it('returns summary rows newest-first with filters and cursor', async () => {
    const audit = new AuditLog(
      join(mkdtempSync(join(tmpdir(), 'audit-q-')), 'audit.db'),
    )
    setAuditSink(audit)
    audit.recordDispatch({
      source: 'mcp',
      toolName: 'tabs',
      convoId: 'convo-a',
      durationMs: 10,
      ok: true,
    })
    const rejected = audit.recordDispatch({
      source: 'run',
      toolName: 'observe.snapshot',
      convoId: 'convo-a',
      pageId: 3,
      durationMs: 5,
      ok: false,
      error: 'page 3 is not in your space',
    })
    expect(rejected).toBeTruthy()

    const result = await executeTool(
      audit_query,
      { convoId: 'convo-a' },
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const structured = (result as { structuredContent?: { rows?: Array<{ tool: string; ok: boolean; source: string }> } })
      .structuredContent
    // Newest first; audit.query's own dispatch row is filtered out by name.
    const queried = structured?.rows?.filter((r) => r.tool !== 'audit.query') ?? []
    expect(queried.map((r) => r.tool)).toEqual(['observe.snapshot', 'tabs'])
    expect(queried[0].ok).toBe(false)
    expect(queried[0].source).toBe('run')
  })

  it('answers with the not-active notice when the sink is off', async () => {
    setAuditSink(undefined)
    delete process.env.HUB_AUDIT_DB
    delete process.env.HUB_AUDIT
    process.env.NODE_ENV = 'test'
    const result = await executeTool(
      audit_query,
      {},
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
    expect(text).toContain('not active')
  })
})

describe('hub audit list CLI (P2-4)', () => {
  it('prints raw JSON rows from the configured DB', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'audit-cli-')), 'audit.db')
    process.env.HUB_AUDIT_DB = dbPath
    const audit = new AuditLog(dbPath)
    audit.recordDispatch({
      source: 'cli',
      toolName: 'read',
      convoId: 'cli:local',
      durationMs: 7,
      ok: true,
    })
    audit.close()
    setAuditSink(undefined)

    const program = createProgram(
      path.join(process.cwd(), 'clis'),
      path.join(tmpdir(), 'no-user-clis'),
    )
    const lines: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
    try {
      await program.parseAsync(['node', 'hub', 'audit', 'list', '--tool', 'read'])
    } finally {
      console.log = origLog
    }
    const rows = JSON.parse(lines.join('\n')) as Array<{
      tool_name: string
      convo_id: string
      source: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: 'read',
      convo_id: 'cli:local',
      source: 'cli',
    })
    delete process.env.HUB_AUDIT_DB
  })

  it('prints the audit_off envelope when inactive', async () => {
    delete process.env.HUB_AUDIT_DB
    delete process.env.HUB_AUDIT
    process.env.NODE_ENV = 'test'
    const program = createProgram(
      path.join(process.cwd(), 'clis'),
      path.join(tmpdir(), 'no-user-clis'),
    )
    const lines: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
    const origExit = process.exitCode
    try {
      await program.parseAsync(['node', 'hub', 'audit', 'list'])
    } finally {
      console.log = origLog
      process.exitCode = origExit
    }
    expect(lines.join('\n')).toContain('audit_off')
  })
})
