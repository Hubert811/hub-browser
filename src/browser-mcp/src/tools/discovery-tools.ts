import { z } from 'zod'
import { defineTool } from './framework'
// Engine bridge (plain JS; types from src/opencli-engine-modules.d.ts). The
// find (CSS / semantic-locator query) and analyze (site recon) pipelines live
// in opencli-engine/browser/{find,analyze}.js + observation-query.js — the
// same implementations the CLI commands run.
import {
  runFindQuery,
  runSiteAnalysis,
} from '../../../opencli-engine/browser/observation-query.js'
import { ensureAdapterDiscovery } from './adapter-tools'

/**
 * P2-6 (batch 3) — discovery tools: `find` (structured element query — CSS or
 * semantic locator, the CLI's most-used read primitive) and `analyze` (site
 * recon: navigate, capture network, classify anti-bot/API candidates/pattern/
 * nearest adapter). Both were CLI-only direct implementations; the tool face
 * gives MCP clients the same discovery loop an agent walks in the shell.
 */

type QueryOutcome =
  | { ok: true; result?: Record<string, unknown>; report?: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; [extra: string]: unknown } }

/** Structured error result mirroring the observation-tools error contract. */
function queryError(outcome: { ok: false; error: { code: string; message: string; [k: string]: unknown } }) {
  const { code, message, ...extra } = outcome.error
  const text = `[${code}] ${message}`
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
    structuredContent: { code, message, ...extra },
  }
}

const SEMANTIC_FIELDS = {
  role: z.string().optional().describe('Semantic role: button, link, textbox, option, ...'),
  name: z
    .string()
    .optional()
    .describe('Accessible name contains text (aria-label, label, title, placeholder, visible text).'),
  label: z.string().optional().describe('Associated label contains text.'),
  text: z.string().optional().describe('Visible text contains text.'),
  testid: z.string().optional().describe('data-testid / data-test / test-id contains id.'),
} as const

function locatorOf(args: { role?: string; name?: string; label?: string; text?: string; testid?: string }) {
  const locator: Record<string, string> = {}
  for (const key of ['role', 'name', 'label', 'text', 'testid'] as const) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) locator[key] = v.trim()
  }
  return Object.keys(locator).length > 0 ? locator : null
}

export const find = defineTool({
  name: 'find',
  description:
    'Find DOM elements by CSS selector or semantic locator (role/name/label/text/testid). Returns {matches_n, entries[]} with ref, tag, text, attrs per match — the refs feed act/get targets. Pass either css or the semantic fields, not both.',
  input: z
    .object({
      page: z.number().int(),
      css: z.string().optional().describe('CSS selector (e.g. ".btn.primary").'),
      ...SEMANTIC_FIELDS,
      limit: z.number().int().positive().optional().describe('Max entries returned (default 50).'),
      textMax: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max chars of trimmed text per entry (default 120).'),
    })
    .strict(),
  annotations: { title: 'Find DOM elements', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const outcome = (await runFindQuery(page, {
      css: args.css,
      locator: locatorOf(args),
      limit: args.limit,
      textMax: args.textMax,
    })) as QueryOutcome
    if (outcome.ok === false) return queryError(outcome)
    const result = (outcome.result ?? {}) as {
      matches_n?: number
      entries?: Array<{
        ref?: string | number
        tag?: string
        text?: string
        attrs?: Record<string, string>
      }>
    }
    const n = result.matches_n ?? 0
    const lines = [`find: ${n} match(es).`, '']
    for (const e of (result.entries ?? []).slice(0, 20)) {
      // A4: inputs/buttons have no textContent — the tag + whitelisted attrs
      // (placeholder/name/value…) are what identify them. attrs lives in the
      // structured envelope; surface the high-signal ones in the text too.
      const tag = e.tag ? `<${e.tag}>` : ''
      const attrs = e.attrs ?? {}
      const attrBits = ['placeholder', 'name', 'value', 'type', 'aria-label', 'id', 'data-testid']
        .filter((k) => typeof attrs[k] === 'string' && attrs[k] !== '')
        .slice(0, 3)
        .map((k) => `${k}=${JSON.stringify(attrs[k])}`)
        .join(' ')
      const text = String(e.text ?? '').slice(0, 60)
      const bits = [tag, attrBits, text].filter((b) => b !== '').join(' ')
      lines.push(`- [${e.ref ?? '?'}] ${bits || '(no identifying info — see structuredContent)'}`)
    }
    if (n > 20) lines.push(`... and ${n - 20} more`)
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: result,
    }
  },
})

export const analyze = defineTool({
  name: 'analyze',
  description:
    'Site recon on a URL: navigates the page, captures network, probes cookies/initial-state, and classifies — anti-bot vendor, real-data API candidates, page pattern (A/B/C/D), nearest installed adapter, recommended next step. The first move when planning how to scrape a new site.',
  input: z
    .object({
      page: z.number().int(),
      url: z.string().describe('URL to analyze (navigates this page).'),
    })
    .strict(),
  annotations: {
    title: 'Analyze site (recon)',
    // Navigates the target page away from wherever it was.
    destructiveHint: true,
  },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    // Discovery (best-effort) so the nearest-adapter match sees the installed
    // adapter set; a bare registry just reports no match.
    await ensureAdapterDiscovery().catch(() => undefined)
    const outcome = (await runSiteAnalysis(page, args.url)) as QueryOutcome
    if (outcome.ok === false) return queryError(outcome)
    const report = (outcome.report ?? {}) as Record<string, unknown>
    // A3: report.pattern is the classifyPattern() RESULT ({pattern, reason,
    // …}) — printing the object itself renders "[object Object]".
    const patternInfo = report.pattern as { pattern?: string; reason?: string } | string | undefined
    const pattern = typeof patternInfo === 'object' && patternInfo !== null
      ? `${patternInfo.pattern ?? '?'} (${String(patternInfo.reason ?? '').slice(0, 80)})`
      : String(patternInfo ?? '?')
    const antiBot = String(
      (report.antiBot as { vendor?: string } | undefined)?.vendor ?? 'none',
    )
    const text = [
      `analyze ${args.url}`,
      `pattern: ${pattern}  anti-bot: ${antiBot}`,
      `next step: ${String(report.recommended_next_step ?? '(see report)')}`,
    ].join('\n')
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: report,
    }
  },
})

export const DISCOVERY_TOOLS = [find, analyze] as const
