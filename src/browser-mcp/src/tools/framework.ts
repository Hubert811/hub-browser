import type { UnifiedPage } from '../../../page.js'
import { getAuditSink } from '../../../audit/audit-log.js'
import { clawHarnessReporter } from './claw-reporter.js'
import {
  SpaceGuardError,
  ownerOf,
  type SpaceIdentity,
  type TaskSpaceManager,
} from '../../../space/task-space-manager.js'
import {
  contextFromSession,
  isSessionContext,
  type SessionToolContext,
} from './session-adapter'
import type { TypeOf, ZodObject, ZodRawShape } from 'zod'
import {
  type ContentItem,
  type ToolResult as ResponseToolResult,
  ToolResponse,
} from '../response'

export type ToolInputSchema = ZodObject<ZodRawShape>
export type ToolOutputSchema = ZodObject<ZodRawShape>

/**
 * Page-provider contract the fork binds to. `UnifiedBrowserFactory`
 * (hub-browser/src/factory.ts) satisfies it: `connect()` returns a
 * `UnifiedPage` over the shared CdpBackend/BrowserSession, and passing
 * `pageId` binds the returned page to that tab.
 */
export interface UnifiedPageProvider {
  connect(opts?: {
    timeout?: number
    cdpEndpoint?: string
    pageId?: number
    session?: string
  }): Promise<UnifiedPage>
}

export interface ToolContext {
  page: UnifiedPage
  /** Resolves a UnifiedPage bound to a specific page id on the same CDP connection. */
  pageFor(pageId: number): Promise<UnifiedPage>
  defaultWindowId?: number
  defaultTabGroupId?: string
  signal?: AbortSignal
  /**
   * Phase 3 — identity of the calling agent/conversation. When set together
   * with `spaces`, the fork enforces agent-level tab isolation (tabs list
   * filtering + page-control guards). When absent, tools keep the legacy
   * open-world behavior.
   */
  identity?: SpaceIdentity
  /** Phase 3 — the shared TaskSpaceManager (统一 Core 单点). */
  spaces?: TaskSpaceManager
  /**
   * P2-2 audit — the face this dispatch entered from ('mcp' | 'cli' | ...
   * for the audit row's source column; defaults to 'mcp' which is correct
   * for the MCP server path that owns most executeTool callers).
   */
  auditSource?: string
  /**
   * P2-2 audit — set by executeTool at dispatch start; `run`'s
   * InnerCallHook children link their rows to this id as parent_dispatch_id.
   */
  dispatchId?: string
}

/**
 * P2-2 groundwork — one audit sub-row for a single bridged primitive
 * dispatched through the run bridge (the parent row is the run tool call
 * itself). `tool` is the primitive path (`observe.snapshot`,
 * `pages.newPage`, `cdp`, ...). Rejected authorize/dispatch attempts record
 * the same trail successful ones do (`ok:false` + error summary).
 */
export interface InnerCallRecord {
  tool: string
  pageId?: number
  ok: boolean
  durationMs: number
  error?: string
}

/**
 * P1-8 / P1-4 — per-primitive gate hook for embedded runtimes (the run
 * worker's SDK bridge), mirroring BrowserOS `ScriptInnerCallHook`. The
 * bridge's call() pipeline is authorize → dispatch → effects → record:
 * page-scoped calls pass `assertPage` before dispatch, `pages.newPage`
 * passes `assertCanOpenTab` and the fresh tab is claimed via
 * `onPageCreated` (otherwise the next `observe(newId)` chain-rejects with
 * page-not-in-space), `pages.list()` results pass `annotatePages` so
 * foreign tabs never leak, and every attempt lands `record` as an audit
 * sub-row (P2-2 swaps the sink for SQLite; the interface stays).
 *
 * This is the gate the unified execution point (P1-4) reuses for all three
 * entrances (CLI / MCP tools / run primitives).
 */
export interface InnerCallHook {
  /** Guard: reject a page-scoped call on a page the caller does not control. */
  assertPage(pageId: number): Promise<void>
  /** Guard: reject opening a new tab while the caller owns no controllable space. */
  assertCanOpenTab(): Promise<void>
  /** Effect: claim a freshly opened tab into the caller's current space ledger. */
  onPageCreated(pageId: number, url?: string): Promise<void>
  /** Post-filter: drop tabs the caller must not see from pages.list(). */
  annotatePages(tabs: Array<{ pageId: number }>): Promise<Array<{ pageId: number }>>
  /** Audit sink (sub-row per primitive). Implementations must not throw. */
  record(rec: InnerCallRecord): Promise<void>
}

/** @deprecated in the fork — kept so vendored consumers (apps/server) typecheck unchanged. */
export type { SessionToolContext } from './session-adapter'
export { isSessionContext, pageFromSession, contextFromSession } from './session-adapter'

export type ContentBlock = ContentItem
export type ToolResult = ResponseToolResult

export interface ToolAnnotations {
  /**
   * Human-readable display name shown in MCP clients (e.g. Claude Desktop's
   * tool call UI). Required for Claude Directory listings.
   */
  title?: string
  readOnlyHint?: boolean
  /**
   * True when the tool may modify or delete state, files, or data.
   * Meaningful only when readOnlyHint is not true. Destructive tools
   * always prompt the user before running in MCP clients that respect the
   * hint.
   */
  destructiveHint?: boolean
  /** True when repeated calls with the same args produce the same effect. */
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  input: ToolInputSchema
  output?: ToolOutputSchema
  annotations?: ToolAnnotations
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
    response: ToolResponse,
  ) => Promise<ToolResult | undefined>
}

export function defineTool<S extends ToolInputSchema>(def: {
  name: string
  description: string
  input: S
  output?: ToolOutputSchema
  annotations?: ToolAnnotations
  handler: (
    args: TypeOf<S>,
    ctx: ToolContext,
    response: ToolResponse,
  ) => Promise<ToolResult | undefined>
}): ToolDefinition {
  return def as unknown as ToolDefinition
}

export function textResult(text: string, structured?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured !== undefined && { structuredContent: structured }),
  }
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * P1-4 (phase C) error contract — structured errors keep their shape when
 * crossing the executeTool boundary.
 *
 * SpaceGuardError established the `{code, message, hint?, ...meta}` pattern;
 * TargetError (code/hint/candidates/matches_n) and the CliError family
 * (code/hint/exitCode — both the TS copy in opencli/errors.ts and the
 * plain-JS engine copy in opencli-engine/errors.js) follow it. Detection is
 * shape-based, not instanceof: src/dist module duplication means two copies
 * of the same class can coexist in one process, and instanceof only matches
 * its own copy. The class-name + exitCode gate excludes everything else that
 * happens to carry a string `code` — Node system errors (ENOENT & friends)
 * are excluded via their errno/syscall markers; their code is OS-level, not
 * a platform contract member.
 */
export function structuredErrorFields(
  err: unknown,
): Record<string, unknown> | undefined {
  if (!(err instanceof Error)) return undefined
  const e = err as Error & {
    code?: unknown
    hint?: unknown
    exitCode?: unknown
    candidates?: unknown
    matches_n?: unknown
    spaceId?: unknown
    pageId?: unknown
    errno?: unknown
    syscall?: unknown
  }
  if (typeof e.code !== 'string' || e.code === '') return undefined
  if (e.errno !== undefined || e.syscall !== undefined) return undefined
  const isContractMember =
    err.name === 'TargetError' ||
    err.name === 'SpaceGuardError' ||
    err.name === 'CliError' ||
    typeof e.exitCode === 'number' // both CliError copies always carry exitCode
  if (isContractMember === false) return undefined
  const fields: Record<string, unknown> = { code: e.code, message: e.message }
  if (typeof e.hint === 'string') fields.hint = e.hint
  if (Array.isArray(e.candidates)) fields.candidates = e.candidates
  if (typeof e.matches_n === 'number') fields.matches_n = e.matches_n
  if (typeof e.spaceId === 'string') fields.spaceId = e.spaceId
  if (typeof e.pageId === 'number') fields.pageId = e.pageId
  if (typeof e.exitCode === 'number') fields.exitCode = e.exitCode
  return fields
}

/** Validate a structuredContent payload against the error-contract shape. */
function errorContractOf(
  structured: unknown,
): { code: string; message: string } | undefined {
  if (typeof structured !== 'object' || structured === null) return undefined
  const sc = structured as Record<string, unknown>
  if (typeof sc.code !== 'string' || typeof sc.message !== 'string') {
    return undefined
  }
  return { code: sc.code, message: sc.message }
}

export function clampTimeout(
  value: number | undefined,
  defaultMs: number,
  maxMs: number,
): number {
  if (value === undefined) return defaultMs
  if (!Number.isFinite(value) || value <= 0) return defaultMs
  return Math.min(Math.round(value), maxMs)
}

export function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      clearTimeout(timeout)
      reject(abortError(signal?.reason))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason)
}

/** Races tool work against cancellation, including CDP calls that do not accept AbortSignal. */
async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return operation

  let cleanup = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    cleanup = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    return await Promise.race([operation, aborted])
  } finally {
    cleanup()
    void operation.catch(() => {})
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(
    reason === undefined ? 'The operation was aborted.' : String(reason),
  )
  error.name = 'AbortError'
  return error
}


/**
 * Phase 3 — agent-level tab isolation guard (spec 3.3 + decision D3).
 *
 * Applies only when the ctx carries BOTH an identity and a TaskSpaceManager
 * (统一 Core 单点). D3 (2026-08-03): space is a hard precondition for tab
 * operations — an agent that owns no space is rejected (`no-space`), never
 * granted the legacy open world. Per-tool policy:
 *  - tools taking a `page` (act/navigate/read/evaluate/screenshot/run/grep/
 *    wait/...) are rejected with `no-space` when the agent owns no space;
 *    rejected when the page is not in one of the agent's spaces
 *    ("page not in your space") or the owning space is user-held
 *    ("user is controlling").
 *  - `tab_groups` validates every page in `pages`; actions addressed by
 *    `groupId` (update/close, or create adding to an existing group) resolve
 *    the group's member pages and require every member to belong to the
 *    agent's CURRENT space (space-level, finalized 2026-08-24 — the initial
 *    fix was agent-level, which a real run proved too loose: it waved
 *    through a same-agent rename of another space's group).
 *  - `tabs new` is rejected with `no-space` while the agent owns no space,
 *    and while the agent's current space is user-held.
 *  - `run` (no page arg) validates the default/active page.
 *  - `tabs list/active` and browser-level tools (windows/history) are not
 *    rejected here; `tabs` filters its output in its handler (empty list for
 *    an agent with no space — D3).
 *  - Only a ctx WITHOUT identity (no agent identified) keeps the legacy
 *    open-world behavior; once an agent identity is present, space is the
 *    precondition.
 */
export async function guardToolAccess(
  def: Pick<ToolDefinition, 'name'>,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> {
  const { spaces, identity } = ctx
  if (!spaces || !identity) return
  const owner = ownerOf(identity)

  if (def.name === 'tabs') {
    if (args.action === 'new') {
      return spaces.assertCurrentSpaceAgentControllable(owner)
    }
    if (typeof args.page === 'number') {
      return spaces.assertPageControllable(owner, args.page)
    }
    return
  }

  if (def.name === 'tab_groups') {
    if (Array.isArray(args.pages) && args.pages.length > 0) {
      await spaces.assertPagesControllable(owner, args.pages as number[])
    }
    if (typeof args.groupId === 'string') {
      await assertTabGroupControllable(spaces, owner, ctx.page, args.groupId)
    }
    return
  }

  if (typeof args.page === 'number') {
    return spaces.assertPageControllable(owner, args.page)
  }

  if (def.name === 'run') {
    const pageId = (ctx.page as unknown as { pageId?: number }).pageId
    if (pageId !== undefined) {
      return spaces.assertPageControllable(owner, pageId)
    }
  }
}

/** Resolve a groupId-addressed tab_groups call (update/close, or create
 * adding pages to an existing group) to its member page ids and require every
 * member page to belong to the agent's CURRENT space.
 *
 * Guard semantics finalized 2026-08-24 (P2-6): SPACE-level, matching the CLI
 * face's assertGroupInCurrentSpace. A tab group is the current space's D5
 * visual projection, so every member page must belong to the CURRENT space —
 * the previous agent-level check (assertPagesControllable) waved through a
 * same-agent rename of ANOTHER space's group in a real run (one agent, two
 * spaces). Unknown group ids, empty groups, and tabs missing from the pages
 * map are left to the handler's CDP call for its native error — the guard
 * only rejects what it can prove is foreign. */
async function assertTabGroupControllable(
  spaces: NonNullable<ToolContext['spaces']>,
  owner: string,
  page: ToolContext['page'],
  groupId: string,
): Promise<void> {
  const groups = (await page.tabGroupList()) as Array<{
    groupId?: string
    tabIds?: number[]
  }>
  const group = groups.find((g) => g?.groupId === groupId)
  if (!group || !Array.isArray(group.tabIds) || group.tabIds.length === 0) return
  const tabs = (await page.tabs()) as Array<{
    tabId?: number
    pageId?: number
  }>
  const pageIds = group.tabIds
    .map((tabId) => tabs.find((t) => t?.tabId === tabId)?.pageId)
    .filter((id): id is number => typeof id === 'number')
  if (pageIds.length === 0) return
  // D3 + user-held gate first (same policy as tabs new).
  await spaces.assertCurrentSpaceAgentControllable(owner)
  const space = await spaces.currentSpace(owner)
  if (!space) return // unreachable after the assert above; kept defensive
  for (const pageId of pageIds) {
    const sid = await spaces.spaceIdForPage(pageId)
    if (sid !== space.id) {
      throw new SpaceGuardError(
        'page-not-in-space',
        `group ${groupId} is not in your space (page ${pageId} belongs to ${sid ?? 'no space'})`,
        {
          pageId,
          hint: "operate on your current space's group, or space.switch first",
        },
      )
    }
  }
}

/**
 * Validate args, run the handler, and convert any failure into an instructive
 * error result.
 *
 * Accepts both the fork's page-based ctx (`{ page, pageFor }`) and the
 * vendored session-based ctx (`{ session }`) that apps/server's tool-adapter
 * passes. The session shape is bridged through `contextFromSession`
 * (session-adapter.ts), so the 17 tool handlers always see `page`/`pageFor`.
 */
export async function executeTool(
  def: ToolDefinition,
  rawArgs: unknown,
  ctx: ToolContext | SessionToolContext,
): Promise<ToolResult> {
  throwIfAborted(ctx.signal)
  const pageCtx = isSessionContext(ctx) ? await contextFromSession(ctx) : ctx
  throwIfAborted(pageCtx.signal)
  // P2-2 — assign the dispatch id up front (run's children need it during
  // the handler) and remember the start time; the audit row itself lands at
  // the end, best-effort (the sink never throws and never gates execution).
  const dispatchId = crypto.randomUUID()
  const auditStart = Date.now()
  pageCtx.dispatchId = dispatchId
  const parsed = def.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return errorResult(`Invalid arguments for ${def.name}: ${detail}`)
  }

  // P2-2 — appends the audit row for this dispatch (best-effort: the sink
  // never throws and never gates execution). Args land redacted and bounded;
  // the result keeps only a summary (guard code / error head / structured
  // keys), never full page content.
  const auditArgs = parsed.data as Record<string, unknown>
  // P2-3 — page attribution captured during the dispatch's tab lookup
  // (below): url/title/targetId ride on the claw report so cockpit rows look
  // like native session rows. Guard rejections short-circuit before the
  // lookup, so those rows simply carry no page context.
  let dispatchTab: { tabId?: number; targetId?: string; url?: string; title?: string } = {}
  const recordAuditRow = (outcome: {
    isError: boolean
    error?: string
    guard?: string
    structuredKeys?: string[]
    tabId?: number
    contentBlockCount?: number
  }): void => {
    getAuditSink().recordDispatch({
      dispatchId,
      ...(pageCtx.identity && {
        convoId: ownerOf(pageCtx.identity),
        agentLabel:
          pageCtx.identity.displayName ?? pageCtx.identity.agentId,
      }),
      source:
        (pageCtx.auditSource as 'mcp' | 'cli' | 'run' | 'daemon') ?? 'mcp',
      toolName: def.name,
      ...(typeof auditArgs.page === 'number' && { pageId: auditArgs.page }),
      args: auditArgs,
      resultMeta: {
        isError: outcome.isError,
        ...(outcome.guard !== undefined && { guard: outcome.guard }),
        ...(outcome.structuredKeys !== undefined && {
          structuredKeys: outcome.structuredKeys,
        }),
      },
      durationMs: Date.now() - auditStart,
      ok: !outcome.isError,
      ...(outcome.error !== undefined && { error: outcome.error }),
      createdAt: auditStart,
    })

    // P2-3 — dual-write the same dispatch into the BrowserClaw server's audit
    // trail (fire-and-forget; never gates execution, self-disables when the
    // claw-server is unreachable). Sessions and tab claims start lazily so
    // the cockpit timeline + replay attribution follow automatically.
    clawHarnessReporter.reportDispatch({
      ...(pageCtx.identity !== undefined && {
        owner: ownerOf(pageCtx.identity),
        ...(pageCtx.identity.displayName !== undefined && {
          agentLabel: pageCtx.identity.displayName,
        }),
      }),
      toolName: def.name,
      ...(typeof auditArgs.page === 'number' && { pageId: auditArgs.page }),
      ...(dispatchTab.tabId !== undefined && { tabId: dispatchTab.tabId }),
      ...(dispatchTab.targetId !== undefined && { targetId: dispatchTab.targetId }),
      ...(dispatchTab.url !== undefined && { url: dispatchTab.url }),
      ...(dispatchTab.title !== undefined && { title: dispatchTab.title }),
      args: auditArgs,
      isError: outcome.isError,
      ...(outcome.error !== undefined && { errorHead: outcome.error }),
      ...(outcome.guard !== undefined && { guard: outcome.guard }),
      ...(outcome.structuredKeys !== undefined && {
        structuredKeys: outcome.structuredKeys,
      }),
      // Official rows summarize the result's MCP content-block count as
      // contentSummary; guard rejections produce a single text block.
      ...(outcome.contentBlockCount !== undefined && {
        contentBlockCount: outcome.contentBlockCount,
      }),
      durationMs: Date.now() - auditStart,
      createdAt: auditStart,
    })
  }

  const guardPromise = guardToolAccess(
    def,
    parsed.data as Record<string, unknown>,
    pageCtx,
  )
  if (guardPromise) {
    try {
      await guardPromise
    } catch (err) {
      if (err instanceof SpaceGuardError) {
        // P1-4 (phase C): guard rejections carry the structured contract too
        // — code + hint (+ spaceId/pageId) survive the tool boundary instead
        // of a text-only message.
        const fields = structuredErrorFields(err)
        // P2-2 — rejected dispatches audit too: an attempted violation is
        // exactly what the trail is for (guard code + message head +
        // structuredKeys for consistency with handler-failure rows).
        recordAuditRow({
          isError: true,
          error: err.message.slice(0, 200),
          guard: err.code,
          ...(fields !== undefined && {
            structuredKeys: Object.keys(fields),
          }),
          contentBlockCount: 1,
        })
        return {
          content: [{ type: 'text' as const, text: err.message }],
          isError: true,
          ...(fields !== undefined && { structuredContent: fields }),
        }
      }
      throw err
    }
  }

  const response = new ToolResponse()
  try {
    const result = await abortable(
      def.handler(parsed.data as Record<string, unknown>, pageCtx, response),
      pageCtx.signal,
    )
    if (result) response.appendResult(result)
    throwIfAborted(pageCtx.signal)
  } catch (err) {
    if (pageCtx.signal?.aborted || isAbortError(err)) throw err
    response.error(
      `${def.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    // P1-4 (phase C) error contract: structured errors (TargetError / the
    // CliError family / SpaceGuardError — from either module copy) keep
    // their {code, message, hint, ...} shape on the tool boundary. Text
    // stays message-first for compatibility; the contract rides on
    // structuredContent.
    const fields = structuredErrorFields(err)
    if (fields !== undefined) response.data(fields)
  }

  throwIfAborted(pageCtx.signal)
  const result = await abortable(
    response.buildForPage(pageCtx),
    pageCtx.signal,
  )
  throwIfAborted(pageCtx.signal)

  // P2-3 — resolve the dispatch's tab attribution. Two shapes carry a page:
  // page-scoped tools pass `args.page`, while the space.open_tab family
  // returns the fresh page in `structuredContent.pageId`. Attributing the
  // OPEN dispatch matters for claw replay ownership: the tab-claim window
  // must start at (or before) the moment the tab is created, or a quiet
  // page's recording can end before the first later claim — a real E2E
  // proved a 61ms miss breaking session-recording attribution.
  const argsPage = (parsed.data as Record<string, unknown>).page
  const openedPage = (result.structuredContent as Record<string, unknown> | undefined)?.pageId
  const pageId =
    typeof argsPage === 'number'
      ? argsPage
      : typeof openedPage === 'number'
        ? openedPage
        : undefined
  if (pageId !== undefined) {
    try {
      // Browserless tools (space.open_tab) carry no default page — bind one
      // lazily through pageFor for the tab lookup.
      const page = pageCtx.page ?? (await pageCtx.pageFor(pageId))
      const tabs = (await page.tabs()) as unknown as Array<{
        pageId: number
        tabId?: number
        targetId?: string
        url?: string
        title?: string
      }>
      const info = tabs.find((tab) => tab.pageId === pageId)
      if (info !== undefined) {
        if (typeof info.tabId === 'number') {
          result.metadata = { ...result.metadata, tabId: info.tabId }
        }
        // P2-3 — page context for the claw dual-write (official rows carry
        // url/title/targetId on every dispatch).
        dispatchTab = {
          ...(typeof info.tabId === 'number' && { tabId: info.tabId }),
          ...(typeof info.targetId === 'string' && { targetId: info.targetId }),
          ...(typeof info.url === 'string' && { url: info.url }),
          ...(typeof info.title === 'string' && { title: info.title }),
        }
      }
    } catch {
      // Tab-id metadata is best-effort; lookup failures are ignored.
    }
  }

  // P2-2 — the audit row for this dispatch. P1-4 (phase C): when the error
  // result carries the structured contract, the audit error head leads with
  // the code — rows stay searchable by platform error code, not just free
  // text.
  let auditError: string | undefined
  if (result.isError === true) {
    const contract = errorContractOf(result.structuredContent)
    auditError =
      contract !== undefined
        ? `[${contract.code}] ${contract.message.slice(0, 180)}`
        : result.content
            .find((item) => item.type === 'text')
            ?.text?.slice(0, 200)
  }
  recordAuditRow({
    isError: result.isError === true,
    ...(result.isError === true && { error: auditError }),
    ...(result.structuredContent && {
      structuredKeys: Object.keys(result.structuredContent),
    }),
    contentBlockCount: result.content.length,
  })

  return result
}
