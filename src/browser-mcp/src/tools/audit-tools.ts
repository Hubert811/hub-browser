/**
 * P2-4 — observability entry: query the audit log (P2-2 SQLite sink).
 *
 * `audit.query` is platform metadata: it needs no browser connection (like
 * the space.* family) and returns summary rows newest-first — who dispatched
 * what, from which face, how long it took, whether the guard rejected it.
 * Rows keep args/result payloads OUT (they live redacted in the DB; the
 * summary is enough for timeline review — `hub audit list` on the CLI side
 * gives the raw JSON when deeper inspection is needed).
 */
import { z } from 'zod'
import { getAuditSink, NULL_AUDIT } from '../../../audit/audit-log.js'
import { defineTool, textResult } from './framework'

export const audit_query = defineTool({
  name: 'audit.query',
  description:
    'Query the audit log: the append-only history of tool dispatches (this MCP server, the CLI, and primitives inside `run` scripts). Rows come newest-first with the dispatch id, source face (mcp/cli/run/daemon), tool name, duration, page id, and guard rejections (attempted violations carry their guard code). Use it to answer "who did what, when" — e.g. after a multi-agent session or when a tab mysteriously changed.',
  input: z.object({
    convoId: z
      .string()
      .optional()
      .describe('Filter by conversation/owner id (the ownership key).'),
    sessionId: z.string().optional().describe('Filter by session id.'),
    parentDispatchId: z
      .string()
      .optional()
      .describe('List the child rows of one run dispatch.'),
    toolName: z.string().optional().describe('Filter by tool name.'),
    cursor: z
      .number()
      .int()
      .optional()
      .describe('Pagination: return rows with id < cursor.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max rows to return (default 20, max 200).'),
  }),
  annotations: { title: 'Query audit log', readOnlyHint: true },
  handler: async (args) => {
    const sink = getAuditSink()
    if (sink === NULL_AUDIT) {
      return textResult(
        'audit log is not active (HUB_AUDIT=off or a test run); set HUB_AUDIT_DB to enable',
        { rows: [], active: false },
      )
    }
    const rows = sink.listDispatches({
      ...(args.convoId !== undefined && { convoId: args.convoId }),
      ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
      ...(args.parentDispatchId !== undefined && {
        parentDispatchId: args.parentDispatchId,
      }),
      ...(args.toolName !== undefined && { toolName: args.toolName }),
      ...(args.cursor !== undefined && { cursor: args.cursor }),
      limit: args.limit ?? 20,
    })
    const lines = rows.map((row) => {
      const iso = new Date(row.created_at).toISOString()
      const status = row.ok === 1 ? 'ok' : `FAIL${row.error ? ` (${row.error.slice(0, 60)})` : ''}`
      const meta = [
        row.page_id !== null && `page=${row.page_id}`,
        row.parent_dispatch_id !== null && 'child',
        row.convo_id !== null && `convo=${row.convo_id}`,
      ]
        .filter(Boolean)
        .join(' ')
      return `[#${row.id}] ${iso} ${row.source} ${row.tool_name} ${status} ${row.duration_ms}ms${meta ? ` ${meta}` : ''}`
    })
    const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : undefined
    return textResult(lines.join('\n') || '(no matching dispatches)', {
      rows: rows.map((row) => ({
        id: row.id,
        dispatchId: row.dispatch_id,
        ...(row.parent_dispatch_id !== null && {
          parentDispatchId: row.parent_dispatch_id,
        }),
        ...(row.convo_id !== null && { convoId: row.convo_id }),
        ...(row.agent_label !== null && { agentLabel: row.agent_label }),
        source: row.source,
        tool: row.tool_name,
        ...(row.page_id !== null && { pageId: row.page_id }),
        durationMs: row.duration_ms,
        ok: row.ok === 1,
        ...(row.error !== null && { error: row.error }),
        createdAt: row.created_at,
      })),
      ...(nextCursor !== undefined && { nextCursor }),
    })
  },
})

export const AUDIT_TOOLS = [audit_query]
