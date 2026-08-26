/**
 * P2-2 — audit log (SQLite sink, append-only).
 *
 * Every tool dispatch through the unified gate (executeTool — MCP tools, CLI
 * fork wrappers, and the run tool itself) lands one row; primitives executed
 * inside a `run` script land child rows via InnerCallHook.record with
 * `parent_dispatch_id` pointing at the run dispatch (BrowserOS audit_log /
 * ScriptInnerCallHook model).
 *
 * Division of state (roadmap P2-2): the JSON ledger keeps the CURRENT world
 * (space/tab ownership); this DB keeps the HISTORY (events, append-only,
 * queryable). Reuses opencli-engine/observation's redaction before writes —
 * secrets never land in the DB.
 *
 * M1 opt-in: the sink activates only when HUB_AUDIT_DB points at a file
 * (tests point it at a tmp path; flipping the default to on is deferred to
 * P2-4 when the query surface exists). Audit must never break execution:
 * every write is best-effort and silently degrades.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactValue } from '../opencli-engine/observation/redaction.js'
import { hubUserRoot } from '../space/task-space-manager.js'

/**
 * bun:sqlite is a Bun builtin — a static import breaks the entire dist import
 * graph under node (ERR_UNSUPPORTED_ESM_URL_SCHEME). Load it lazily through
 * createRequire instead: Bun resolves it, node throws MODULE_NOT_FOUND which
 * we catch, and resolveAuditDbPath() then reports "not available" so the audit
 * sink degrades to NULL (node layouts get audit-off, never a crash).
 */
interface SqliteStatement {
  all(...params: (string | number | null)[]): unknown[]
  run(...params: (string | number | null)[]): unknown
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  run(sql: string, params?: (string | number | null)[]): { changes?: number }
  close(): void
}
type SqliteDatabaseCtor = new (path: string, opts?: { create?: boolean }) => SqliteDatabase

let sqliteCtor: SqliteDatabaseCtor | undefined | null = null
function loadBunSqlite(): SqliteDatabaseCtor | undefined {
  if (sqliteCtor !== null) return sqliteCtor
  try {
    const require = createRequire(import.meta.url)
    sqliteCtor = (require('bun:sqlite') as { Database: SqliteDatabaseCtor }).Database
  } catch {
    sqliteCtor = undefined
  }
  return sqliteCtor ?? undefined
}

const ARGS_JSON_MAX = 4096
const RESULT_META_MAX = 4096

/**
 * P2-2 retention — the SQLite analogue of observation/retention.js's policy
 * (maxAge/maxCount, adapted from trace directories to dispatch rows). Audit
 * rows are history, so the defaults are longer-lived than traces.
 */
export interface AuditRetentionPolicy {
  maxAgeDays?: number
  maxCount?: number
}
const DEFAULT_RETENTION: Required<AuditRetentionPolicy> = {
  maxAgeDays: 30,
  maxCount: 20_000,
}
/** Prune is checked every N writes so the write path self-maintains. */
const PRUNE_EVERY_WRITES = 500

/** Where a dispatch entered the platform (the unified gate has three faces). */
export type AuditSource = 'mcp' | 'cli' | 'run' | 'daemon'

export interface AuditDispatchInput {
  /** Stable id for this dispatch; generates one when omitted. */
  dispatchId?: string
  /** Parent run dispatch when this row is a primitive inside a run script. */
  parentDispatchId?: string
  convoId?: string
  agentLabel?: string
  sessionId?: string
  source: AuditSource
  toolName: string
  pageId?: number
  args?: unknown
  resultMeta?: unknown
  durationMs: number
  ok: boolean
  error?: string
  /** When the dispatch started (children of a long run sort before its row). */
  createdAt?: number
}

export interface AuditDispatchRow {
  id: number
  dispatch_id: string
  parent_dispatch_id: string | null
  convo_id: string | null
  agent_label: string | null
  session_id: string | null
  source: string
  tool_name: string
  page_id: number | null
  args_json: string | null
  result_meta: string | null
  duration_ms: number
  ok: number
  error: string | null
  created_at: number
}

export interface ListDispatchesQuery {
  convoId?: string
  sessionId?: string
  parentDispatchId?: string
  toolName?: string
  /** Return rows with id < cursor (newest-first pagination). */
  cursor?: number
  limit?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL UNIQUE,
  parent_dispatch_id TEXT,
  convo_id TEXT,
  agent_label TEXT,
  session_id TEXT,
  source TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  page_id INTEGER,
  args_json TEXT,
  result_meta TEXT,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_convo ON tool_dispatches(convo_id, id);
CREATE INDEX IF NOT EXISTS idx_dispatch_parent ON tool_dispatches(parent_dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_created ON tool_dispatches(created_at);
`

/** Redact then bound a JSON payload (args / result meta) before it lands. */
function boundedJson(value: unknown, max: number): string | null {
  if (value === undefined) return null
  try {
    let text = JSON.stringify(redactValue(value, { maxStringLength: 2048 }))
    if (text === undefined) return null
    if (text.length > max) {
      text = `${text.slice(0, max)}...[truncated, ${text.length - max} chars omitted]`
    }
    return text
  } catch {
    return '"[unserializable]"'
  }
}

export class AuditLog {
  private db: SqliteDatabase
  private insertStmt: SqliteStatement
  private disabled = false
  private writeCount = 0

  constructor(dbPath: string) {
    const Sqlite = loadBunSqlite()
    if (Sqlite === undefined) {
      throw new Error('bun:sqlite is not available in this runtime (node); audit requires Bun')
    }
    this.db = new Sqlite(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.insertStmt = this.db.prepare(`
      INSERT INTO tool_dispatches
        (dispatch_id, parent_dispatch_id, convo_id, agent_label, session_id,
         source, tool_name, page_id, args_json, result_meta, duration_ms, ok, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  /** Appends one dispatch row; returns its dispatch id. Never throws. */
  recordDispatch(input: AuditDispatchInput): string {
    if (this.disabled) return input.dispatchId ?? ''
    const dispatchId = input.dispatchId ?? crypto.randomUUID()
    try {
      this.insertStmt.run(
        dispatchId,
        input.parentDispatchId ?? null,
        input.convoId ?? null,
        input.agentLabel ?? null,
        input.sessionId ?? null,
        input.source,
        input.toolName,
        input.pageId ?? null,
        boundedJson(input.args, ARGS_JSON_MAX),
        boundedJson(input.resultMeta, RESULT_META_MAX),
        Math.max(0, Math.round(input.durationMs)),
        input.ok ? 1 : 0,
        input.error ?? null,
        input.createdAt ?? Date.now(),
      )
      // Retention piggybacks on the write path: every PRUNE_EVERY_WRITES
      // inserts run one prune with the default policy.
      this.writeCount += 1
      if (this.writeCount % PRUNE_EVERY_WRITES === 0) this.prune()
    } catch {
      // Audit is best-effort: a failed write never breaks the dispatch.
      this.disabled = true
    }
    return dispatchId
  }

  /**
   * Deletes rows past the retention horizon: older than maxAgeDays, or
   * beyond the newest maxCount. Best-effort; returns the deleted count.
   */
  prune(policy: AuditRetentionPolicy = {}): number {
    if (this.disabled) return 0
    const { maxAgeDays, maxCount } = { ...DEFAULT_RETENTION, ...policy }
    let deleted = 0
    try {
      const cutoff = Date.now() - maxAgeDays * 86_400_000
      const byAge = this.db.run(
        'DELETE FROM tool_dispatches WHERE created_at < ?',
        [cutoff],
      )
      deleted += Number(byAge.changes ?? 0)
      const byCount = this.db.run(
        'DELETE FROM tool_dispatches WHERE id NOT IN (SELECT id FROM tool_dispatches ORDER BY id DESC LIMIT ?)',
        [maxCount],
      )
      deleted += Number(byCount.changes ?? 0)
    } catch {
      // best-effort: a failed prune never surfaces
    }
    return deleted
  }

  listDispatches(query: ListDispatchesQuery = {}): AuditDispatchRow[] {
    const conditions: string[] = []
    const params: (string | number)[] = []
    if (query.convoId !== undefined) {
      conditions.push('convo_id = ?')
      params.push(query.convoId)
    }
    if (query.sessionId !== undefined) {
      conditions.push('session_id = ?')
      params.push(query.sessionId)
    }
    if (query.parentDispatchId !== undefined) {
      conditions.push('parent_dispatch_id = ?')
      params.push(query.parentDispatchId)
    }
    if (query.toolName !== undefined) {
      conditions.push('tool_name = ?')
      params.push(query.toolName)
    }
    if (query.cursor !== undefined) {
      conditions.push('id < ?')
      params.push(query.cursor)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(Math.max(1, query.limit ?? 50), 500)
    const stmt = this.db.prepare(
      `SELECT * FROM tool_dispatches ${where} ORDER BY id DESC LIMIT ${limit}`,
    )
    return stmt.all(...params) as AuditDispatchRow[]
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }
}

/** Shared no-op used when the sink is not active. */
export const NULL_AUDIT: AuditSink = {
  recordDispatch: (input) => input.dispatchId ?? '',
  listDispatches: () => [],
}

/** The surface callers get: append + query (NULL_AUDIT when inactive). */
export interface AuditSink {
  recordDispatch(input: AuditDispatchInput): string
  listDispatches(query?: ListDispatchesQuery): AuditDispatchRow[]
}

/**
 * Where the audit DB lives (P2-4 activation matrix):
 *  1. HUB_AUDIT_DB  — explicit path, always wins (tests point it at tmp);
 *  2. HUB_AUDIT=off — explicit kill switch;
 *  3. NODE_ENV=test — test runs stay off (bun test sets NODE_ENV=test;
 *     BUN_TEST is NOT set by bun test — probed 2026-08-22);
 *  4. default       — ON in production: ~/.hub/state/audit.db.
 */
export function resolveAuditDbPath(): string | undefined {
  const explicit = process.env.HUB_AUDIT_DB?.trim()
  if (explicit) return explicit
  const kill = process.env.HUB_AUDIT?.trim().toLowerCase()
  if (kill === 'off' || kill === '0' || kill === 'false') return undefined
  if (process.env.NODE_ENV === 'test' || process.env.BUN_TEST === '1') {
    return undefined
  }
  // bun:sqlite is Bun-only: under node (published dist layout) the audit sink
  // gracefully stays off rather than breaking the process.
  if (loadBunSqlite() === undefined) return undefined
  return join(hubUserRoot(), 'state', 'audit.db')
}

let shared: AuditSink | undefined

/**
 * The process-wide audit sink (see resolveAuditDbPath for activation).
 * Opening failures degrade to the NULL sink — the unified gate in
 * executeTool keeps working unchanged.
 */
export function getAuditSink(): AuditSink {
  if (shared !== undefined) return shared
  const path = resolveAuditDbPath()
  if (!path) {
    shared = NULL_AUDIT
    return shared
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    shared = new AuditLog(path)
  } catch {
    shared = NULL_AUDIT
  }
  return shared
}

/** Test seam: swap the shared sink (or reset to env-derived with undefined). */
export function setAuditSink(
  sink: AuditLog | AuditSink | undefined,
): void {
  if (shared instanceof AuditLog) shared.close()
  shared = sink
}
