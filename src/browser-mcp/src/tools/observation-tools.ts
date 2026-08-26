import { z } from 'zod'
import { defineTool, type ToolContext } from './framework'
// Engine bridge (plain JS; types from src/opencli-engine-modules.d.ts). The
// observation-query pipeline (network capture → shape preview / detail, and
// the console snapshot) is the shared single implementation the CLI commands
// run — the tools wrap the same functions so both faces observe identically.
import {
  runConsoleQuery,
  runNetworkDetail,
  runNetworkQuery,
} from '../../../opencli-engine/browser/observation-query.js'

/**
 * P2-6 (batch 2) — observation tools: the network / console capabilities the
 * CLI had as direct implementations, now single tool definitions. `network`
 * is the agent's API-discovery core (shape previews + keyed full-body
 * lookups); `console` reads recent console messages. The `--follow` streaming
 * loops stay CLI-only (poll streams do not fit the tool request/response
 * model — the tool face gets the snapshot query).
 */

type QueryOutcome =
  | { ok: true; envelope: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; [extra: string]: unknown } }

/**
 * Structured error result: `structuredContent` carries the machine-readable
 * `{ code, message, ...extra }` so the CLI wrapper can rebuild its native
 * error envelope (byte-compatible), and the text line leads with `[code]`
 * for MCP consumers.
 */
function queryError(outcome: { ok: false; error: { code: string; message: string; [k: string]: unknown } }) {
  const { code, message, ...extra } = outcome.error
  const text = `[${code}] ${message}`
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
    structuredContent: { code, message, ...extra },
  }
}

export const network = defineTool({
  name: 'network',
  description:
    'Capture network requests as shape previews and retrieve full bodies by key. Run once to capture (entries carry a stable key), then pass detail=<key> for a full body. filter narrows by body-shape field names; failed keeps only status 0/>=400.',
  input: z
    .object({
      page: z.number().int(),
      detail: z.string().optional().describe('Emit the full body for the entry with this key (from a previous capture).'),
      all: z.boolean().optional().describe('Include static resources (js/css/images/telemetry).'),
      raw: z.boolean().optional().describe('Emit full bodies for every entry (skip shape preview).'),
      filter: z
        .array(z.string())
        .optional()
        .describe('Keep only entries whose body shape has ALL these names as path segments.'),
      failed: z.boolean().optional().describe('Only include failed HTTP requests (status 0 or >= 400).'),
      sinceMs: z.number().int().optional().describe('Only include entries from the last N ms.'),
      untilMs: z.number().int().optional().describe('Only include entries older than N ms from now.'),
      maxBody: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('With detail: cap the emitted body at N chars (0 = unlimited).'),
      ttlMs: z.number().int().positive().optional().describe('Cache TTL in ms for detail lookups.'),
    })
    .strict(),
  annotations: { title: 'Capture network requests' },
  handler: async (args, ctx) => {
    const outcome: QueryOutcome = args.detail !== undefined
      ? await runNetworkDetailFor(ctx, args.page, args.detail, args.maxBody, args.ttlMs)
      : await runNetworkQueryFor(ctx, {
          page: args.page as number,
          all: args.all,
          raw: args.raw,
          filter: args.filter,
          failed: args.failed,
          sinceMs: args.sinceMs,
          untilMs: args.untilMs,
        })
    if (outcome.ok === false) return queryError(outcome)
    const env = outcome.envelope
    const count = typeof env.count === 'number' ? env.count : undefined
    const text =
      args.detail
        ? `network detail ${String(env.key ?? args.detail)}: status ${String(env.status ?? '?')} ${String(env.method ?? '')} ${String(env.url ?? '')}`
        : `Captured ${count ?? 0} requests${args.failed ? ' (failed only)' : ''}.\nRun again with detail=<key> for a full body.`
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: env,
    }
  },
})

async function runNetworkDetailFor(
  ctx: ToolContext,
  page: number,
  detail: string,
  maxBody?: number,
  ttlMs?: number,
): Promise<QueryOutcome> {
  const pageObj = await ctx.pageFor(page)
  const { pageSessionOf } = await import(
    '../../../opencli-engine/browser/observation-query.js'
  )
  const session = pageSessionOf(pageObj)
  return runNetworkDetail(session, detail, {
    maxBody: maxBody ?? 0,
    ttlMs,
  })
}

async function runNetworkQueryFor(
  ctx: ToolContext,
  args: {
    page: number
    all?: boolean
    raw?: boolean
    filter?: string[]
    failed?: boolean
    sinceMs?: number
    untilMs?: number
  },
): Promise<QueryOutcome> {
  const page = await ctx.pageFor(args.page)
  return runNetworkQuery(page, {
    all: args.all,
    raw: args.raw,
    filterFields: args.filter ?? null,
    failed: args.failed,
    sinceMs: args.sinceMs ?? null,
    untilMs: args.untilMs ?? null,
  })
}

// Named `consoleTool` internally so the export never shadows the global
// `console` (a future console.log in this file would silently break);
// the MCP registration name below stays `console`, matching the CLI command.
export const consoleTool = defineTool({
  name: 'console',
  description:
    'Read recent browser console messages. Level filter: all (default), error (includes warning), warning, log, info, debug. Time window via sinceMs/untilMs.',
  input: z
    .object({
      page: z.number().int(),
      level: z.enum(['all', 'error', 'warning', 'log', 'info', 'debug']).optional(),
      sinceMs: z.number().int().optional().describe('Only include messages from the last N ms.'),
      untilMs: z.number().int().optional().describe('Only include messages older than N ms from now.'),
    })
    .strict(),
  annotations: { title: 'Read console messages', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const outcome = await runConsoleQuery(page, {
      level: args.level ?? 'all',
      sinceMs: args.sinceMs ?? null,
      untilMs: args.untilMs ?? null,
    })
    if (outcome.ok === false) return queryError(outcome)
    const count = outcome.envelope.count
    const first = (outcome.envelope.messages as Array<{ text?: string }> | undefined)?.[0]?.text
    const text = `Console: ${String(count ?? 0)} messages${first ? `; first: ${String(first).slice(0, 120)}` : ''}`
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: outcome.envelope,
    }
  },
})

export const OBSERVATION_TOOLS = [network, consoleTool] as const
