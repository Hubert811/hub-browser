/**
 * Minimal type surface for the opencli-engine (plain JS, no allowJs) modules
 * imported from the browser-mcp TypeScript side (adapter-tools.ts).
 *
 * Wildcard ambient declarations: the engine stays untyped JS (single source,
 * no build step for it), and these declarations only pin the signatures the
 * MCP adapter tools actually call — everything else stays `unknown`/loose on
 * purpose so the engine can evolve without a .d.ts mirror of every file.
 */

declare module '*opencli-engine/execution.js' {
  /** See execution.js — opts.agentId (P2-7) overrides the HUB_AGENT_ID env fallback. */
  export function executeCommand(
    cmd: unknown,
    rawKwargs: Record<string, unknown>,
    debug?: boolean,
    opts?: {
      prepared?: boolean
      trace?: string
      profile?: string
      windowMode?: string
      siteSession?: string
      keepTab?: string
      agentId?: string
      [key: string]: unknown
    },
  ): Promise<unknown>
  export function prepareCommandArgs(
    cmd: unknown,
    rawKwargs: Record<string, unknown>,
  ): Record<string, unknown>
}

declare module '*opencli-engine/registry.js' {
  export function getRegistry(): Map<string, { site: string; name: string; [key: string]: unknown }>
  export function fullName(cmd: { site: string; name: string }): string
  export function registerCommand(cmd: unknown): void
}

declare module '*opencli-engine/discovery.js' {
  export function ensureUserCliCompatShims(baseDir?: string): Promise<void>
  export function ensureUserAdapters(clisDir?: string): Promise<void>
  export function discoverClis(...dirs: string[]): Promise<void>
  export function discoverPlugins(pluginsDir?: string): Promise<void>
  /** #35: fresh-path copy of a source tree so re-discovery re-evaluates edited modules. */
  export function buildFreshCliMirror(clisDir?: string, mirrorRoot?: string): Promise<string | null>
  /** #35 follow-ups: shared discovery/refresh unit for the long-lived faces (daemon, MCP server). */
  export function createUserSourceReloader(
    builtinClisDir: string,
    opts?: { clisDir?: string; pluginsDir?: string },
  ): {
    discoverAll(): Promise<void>
    refreshIfChanged(): Promise<{
      changed: boolean
      clisChanged?: boolean
      pluginsChanged?: boolean
      mirrorDegraded?: boolean
    }>
  }
  export const USER_CLIS_DIR: string
  export const PLUGINS_DIR: string
}

declare module '*opencli-engine/validate.js' {
  export function validateClisWithTarget(
    dirs: unknown[],
    target?: string,
  ): { ok: boolean; results?: unknown[]; [key: string]: unknown }
  export function renderValidationReport(report: unknown): string
}

declare module '*opencli-engine/verify.js' {
  export function verifyClis(opts: {
    builtinClis: string
    userClis: string
    target?: string
    smoke?: boolean
  }): Promise<{ ok: boolean; validation: unknown; smoke: unknown }>
  export function renderVerifyReport(report: unknown): string
}

declare module '*opencli-engine/convention-audit.js' {
  export function runConventionAudit(opts: {
    projectRoot: string
    target?: string
    site?: string
  }): { ok: boolean; [key: string]: unknown }
  export function renderConventionAuditText(report: unknown): string
}

declare module '*opencli-engine/browser/observation-query.js' {
  export interface ObservationError {
    code: string
    message: string
    [extra: string]: unknown
  }
  export type NetworkQueryOutcome =
    | { ok: true; envelope: Record<string, unknown> }
    | { ok: false; error: ObservationError }
  export function runNetworkQuery(page: {
    session?: unknown
    evaluate(js: string): Promise<unknown>
    readNetworkCapture?(): Promise<unknown>
  }, opts?: {
    all?: boolean
    raw?: boolean
    filterFields?: string[] | null
    failed?: boolean
    sinceMs?: number | null
    untilMs?: number | null
  }): Promise<NetworkQueryOutcome>
  export function runNetworkDetail(
    session: string,
    key: string,
    opts?: { maxBody?: number; ttlMs?: number },
  ): NetworkQueryOutcome
  export function runConsoleQuery(
    page: { session?: unknown; consoleMessages(level?: string): Promise<unknown[]> },
    opts?: { level?: string; sinceMs?: number | null; untilMs?: number | null },
  ): Promise<NetworkQueryOutcome>
  export function runFindQuery(
    page: { evaluate(js: string): Promise<unknown> },
    opts: {
      css?: string
      locator?: Record<string, string> | null
      limit?: number
      textMax?: number
    },
  ): Promise<
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: ObservationError }
  >
  export function runSiteAnalysis(
    page: {
      goto(url: string): Promise<unknown>
      wait(seconds?: number): Promise<unknown>
      evaluate(js: string): Promise<unknown>
      startNetworkCapture?(): Promise<boolean>
      getCookies(opts: { url: string }): Promise<Array<{ name: string }>>
    },
    url: string,
    opts?: { registry?: unknown },
  ): Promise<{ ok: true; report: Record<string, unknown> }>
  export function pageSessionOf(page: { session?: unknown }): string
  export function parseDurationMs(
    raw: unknown,
    label: string,
  ): number | null | { error: string }
  export function toIsoTimestamp(ts: unknown): string | undefined
  export function filterByTimeWindow(
    items: Array<{ timestamp?: number; [k: string]: unknown }>,
    opts: { sinceMs?: number | null; untilMs?: number | null },
    now?: number,
  ): Array<{ timestamp?: number; [k: string]: unknown }>
}

declare module '*opencli-engine/browser/extract.js' {
  /** Build the in-page extraction expression (HTML + url + title of the scoped root). */
  export function buildExtractHtmlJs(selector: string | null): string
  /** HTML → markdown → paragraph-aware chunk envelope (shared by CLI + MCP faces). */
  export function runExtractFromHtml(opts: {
    html: string
    url: string
    title: string
    selector?: string | null
    start: number
    chunkSize: number
  }): {
    url: string
    title: string
    selector: string | null
    total_chars: number
    chunk_size: number
    start: number
    end: number
    next_start_char: number | null
    content: string
  }
}

declare module '*opencli-engine/package-paths.js' {
  export function findPackageRoot(startFile: string): string
}

declare module '*opencli-engine/errors.js' {
  /**
   * Plain-JS engine copy of the CliError family (mirrors opencli/errors.ts —
   * see errors.js for the exit-code table). Only the members imported from
   * TypeScript are declared.
   */
  export class ArgumentError extends Error {
    code: string
    hint?: string
    exitCode: number
  }
}

declare module '*opencli-engine/runtime-globals.js' {
  /** See runtime-globals.js — the centralized process-global contract (P1-4 phase C). */
  export function setDaemonMode(): void
  export function isDaemonMode(): boolean
  export function setDaemonFactory(factory: unknown): void
  /**
   * The daemon's UnifiedBrowserFactory singleton. Callers access it
   * structurally (._cdp/._session/.connect) across module-family
   * boundaries, so the type stays loose — `any` matches how the raw
   * globalThis reads were typed before the accessor migration.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getDaemonFactory(): any
  export function getBrowserBridgeOverride(): unknown
}
