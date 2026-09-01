/**
 * P2-7 — adapter tool family over MCP: the `hub <site> <cmd>` execution face
 * and the adapter-maintenance face, both previously CLI-only.
 *
 * `adapter.run` is the key to the MCP-coexistence route (handoff §4): with it
 * an agent can run claw-server for exploration and hub for thick adapter
 * commands in one dual-server config. It is a thin shell over the existing
 * execution.js chain — validation, browser session, and the P1-4/D3 space
 * guard (bindAdapterPageToSpace) all stay inside executeCommand, so the MCP
 * face inherits the same door the CLI face walks through.
 *
 * `adapter.validate` / `adapter.convention_audit` are static and browserless;
 * `adapter.verify` adds the optional smoke leg (npx vitest tests/smoke).
 *
 * Identity: unlike the CLI (per-process HUB_AGENT_ID), the MCP server is a
 * shared long-lived process — the per-caller ownership key travels via
 * opts.agentId (executeCommand P2-7 hook), resolved from the tool ctx
 * identity with ownerOf, never from env.
 */
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  SpaceGuardError,
  ownerOf,
} from '../../../space/task-space-manager.js'
import { defineTool, errorResult, textResult } from './framework'

// ── engine bridge (plain JS; types from src/opencli-engine-modules.d.ts) ────
import { executeCommand, prepareCommandArgs } from '../../../opencli-engine/execution.js'
import { getRegistry } from '../../../opencli-engine/registry.js'
import {
  createUserSourceReloader,
  USER_CLIS_DIR,
} from '../../../opencli-engine/discovery.js'
import { findPackageRoot } from '../../../opencli-engine/package-paths.js'

/** Adapter results can be large; keep one tool response bounded. */
const MAX_RESULT_JSON = 128_000

/** Module-level registry populated once per process (mirrors hub.mjs ensureDiscovery). */
let discoveryPromise: Promise<void> | undefined

/** Shared discovery warm-up (also used by the analyze discovery tool). */
const adapterReloader = createUserSourceReloader(`${findPackageRoot(fileURLToPath(import.meta.url))}/clis`)

export function ensureAdapterDiscovery(): Promise<void> {
  discoveryPromise ??= adapterReloader.discoverAll().catch((err) => {
    // Reset so a later call can retry (e.g. transient fs issues); discovery
    // failures are not fatal — tools below degrade to empty-registry hints.
    discoveryPromise = undefined
    throw err
  })
  // #35 follow-ups: this is a long-lived process — pick up user adapter AND
  // plugin edits with the same mirror reload the daemon uses, before this
  // tool call executes.
  return discoveryPromise.then(() => adapterReloader.refreshIfChanged()).then(() => undefined)
}

/** Canonical commands of one site (alias keys excluded), sorted by name. */
function commandsOfSite(site: string): string[] {
  const names = new Set<string>()
  for (const [key, cmd] of getRegistry()) {
    if (cmd.site === site && key === `${cmd.site}/${cmd.name}`) {
      names.add(cmd.name)
    }
  }
  return [...names].sort()
}

/** Sites whose name fuzzily matches (prefix/substring), for unknown-site hints. */
function similarSites(site: string): string[] {
  const sites = new Set<string>()
  for (const [, cmd] of getRegistry()) sites.add(cmd.site)
  const lower = site.toLowerCase()
  return [...sites]
    .filter((s) => s.includes(lower) || lower.includes(s))
    .sort()
    .slice(0, 8)
}

function notFoundResult(site: string, command: string) {
  const commands = commandsOfSite(site)
  if (commands.length > 0) {
    const preview = commands.slice(0, 20).join(', ')
    return errorResult(
      `adapter.run: unknown command '${site}/${command}'. Commands of ${site}: ${preview}${commands.length > 20 ? ` (+${commands.length - 20} more)` : ''}`,
    )
  }
  const similar = similarSites(site)
  const hint = similar.length > 0 ? ` Similar sites: ${similar.join(', ')}.` : ''
  return errorResult(
    `adapter.run: unknown site '${site}'.${hint} Use hub's site adapters by their directory name under clis/.`,
  )
}

export const adapter_run = defineTool({
  name: 'adapter.run',
  description:
    "Run a hub site-adapter command — the `hub <site> <cmd>` thick-command face over MCP (e.g. adapter.run('github', 'issues', {repo: '...'})). Adapters are prebuilt per-site knowledge: login-aware reads and actions that reuse the caller's space tab. The command runs through the same validation, browser session, and space-ownership guard as the CLI; the caller needs a current task space (space.create) for browser commands. Output is the adapter's row data as JSON.",
  input: z.object({
    site: z.string().min(1).describe('Site adapter name, e.g. "github".'),
    command: z.string().min(1).describe('Command name under the site, e.g. "issues".'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Command arguments as an object (positional args by their declared name, options by name).'),
  }),
  handler: async (args, ctx) => {
    await ensureAdapterDiscovery()
    const cmd = getRegistry().get(`${args.site}/${args.command}`)
    if (!cmd) return notFoundResult(args.site, args.command)

    let kwargs: Record<string, unknown>
    try {
      kwargs = prepareCommandArgs(cmd, args.args ?? {})
    } catch (err) {
      return errorResult(
        `adapter.run: invalid arguments for ${args.site}/${args.command}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const started = Date.now()
    try {
      const result = await executeCommand(cmd, kwargs, false, {
        prepared: true,
        // Per-caller ownership key; env fallback inside executeCommand keeps
        // the CLI/daemon faces byte-identical.
        ...(ctx.identity && { agentId: ownerOf(ctx.identity) }),
      })
      const rows = Array.isArray(result) ? result : undefined
      let json = JSON.stringify(result ?? null, null, 2)
      let truncated = false
      if (json.length > MAX_RESULT_JSON) {
        json = `${json.slice(0, MAX_RESULT_JSON)}\n… (truncated)`
        truncated = true
      }
      return textResult(
        json === 'null' ? `(no output from ${args.site}/${args.command})` : json,
        {
          site: args.site,
          command: args.command,
          ...(rows !== undefined && { rowCount: rows.length }),
          truncated,
          durationMs: Date.now() - started,
        },
      )
    } catch (err) {
      if (err instanceof SpaceGuardError) {
        return errorResult(
          `[${err.code}] ${err.message}${err.hint ? `\nHint: ${err.hint}` : ''}`,
        )
      }
      throw err
    }
  },
})

export const adapter_validate = defineTool({
  name: 'adapter.validate',
  description:
    'Statically validate discovered adapter commands (registry shape: description, arg duplicates, func/pipeline presence, pipeline step names). Use it right after generating or editing an adapter — before any browser run.',
  input: z.object({
    target: z
      .string()
      .optional()
      .describe('Limit to "site" or "site/name". Omit to validate everything.'),
  }),
  annotations: { title: 'Validate adapters', readOnlyHint: true },
  handler: async (args) => {
    await ensureAdapterDiscovery()
    const { validateClisWithTarget, renderValidationReport } = await import(
      '../../../opencli-engine/validate.js'
    )
    const report = validateClisWithTarget([], args.target)
    const failed = (report.results ?? []).filter(
      (r) => Array.isArray((r as { errors?: unknown[] }).errors) &&
        ((r as { errors: unknown[] }).errors.length ?? 0) > 0,
    )
    return textResult(renderValidationReport(report), {
      ok: report.ok,
      commands: report.commands,
      errors: report.errors,
      warnings: report.warnings,
      ...(args.target && { target: args.target }),
      ...(failed.length > 0 && {
        failing: failed.map((r) => (r as { label: string }).label),
      }),
    })
  },
})

export const adapter_convention_audit = defineTool({
  name: 'adapter.convention_audit',
  description:
    'Scan adapter sources for agent-native convention violations (output row shape, error envelopes, arg naming). Deeper than adapter.validate: it reads the adapter source conventions, not just the registry shape.',
  input: z.object({
    target: z.string().optional().describe('Limit to "site" or "site/name".'),
    site: z.string().optional().describe('Limit to one site (alternative to target).'),
  }),
  annotations: { title: 'Audit adapter conventions', readOnlyHint: true },
  handler: async (args) => {
    const { runConventionAudit, renderConventionAuditText } = await import(
      '../../../opencli-engine/convention-audit.js'
    )
    const report = runConventionAudit({
      projectRoot: findPackageRoot(fileURLToPath(import.meta.url)),
      ...(args.target !== undefined && { target: args.target }),
      ...(args.site !== undefined && { site: args.site }),
    })
    return textResult(renderConventionAuditText(report), {
      ok: report.ok,
      ...('violations' in report && Array.isArray(report.violations)
        ? { violationCount: (report.violations as unknown[]).length }
        : {}),
    })
  },
})

export const adapter_verify = defineTool({
  name: 'adapter.verify',
  description:
    'Validate + optional smoke test for adapters. Without smoke this equals adapter.validate plus the verify report; with smoke=true it spawns the bundled vitest smoke suite (tests/smoke) against real sites — slow and browser-dependent, use it as the final gate before keeping an adapter.',
  input: z.object({
    target: z.string().optional().describe('Limit to "site" or "site/name".'),
    smoke: z
      .boolean()
      .optional()
      .describe('Run the smoke suite (slow, hits real sites). Default false.'),
  }),
  annotations: { title: 'Verify adapters' },
  handler: async (args) => {
    await ensureAdapterDiscovery()
    const { verifyClis, renderVerifyReport } = await import(
      '../../../opencli-engine/verify.js'
    )
    const builtinClis = `${findPackageRoot(fileURLToPath(import.meta.url))}/clis`
    const report = await verifyClis({
      builtinClis,
      userClis: USER_CLIS_DIR,
      ...(args.target !== undefined && { target: args.target }),
      ...(args.smoke !== undefined && { smoke: args.smoke }),
    })
    return textResult(renderVerifyReport(report), {
      ok: report.ok,
      ...(args.smoke !== undefined && { smoke: args.smoke }),
    })
  },
})

export const ADAPTER_TOOLS = [
  adapter_run,
  adapter_validate,
  adapter_convention_audit,
  adapter_verify,
]
