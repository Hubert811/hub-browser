import type { UnifiedPage } from '../../../page.js'
import {
  SpaceGuardError,
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
  /** UnifiedPage for the tool's target page (active page for browser-level tools). */
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
 *  - `tab_groups` validates every page in `pages`.
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
export function guardToolAccess(
  def: Pick<ToolDefinition, 'name'>,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> | void {
  const { spaces, identity } = ctx
  if (!spaces || !identity) return
  const owner = identity.agentId

  if (def.name === 'tabs') {
    if (args.action === 'new') {
      return spaces.assertCurrentSpaceAgentControllable(owner)
    }
    if (typeof args.page === 'number') {
      return spaces.assertPageControllable(owner, args.page)
    }
    return
  }

  if (
    def.name === 'tab_groups' &&
    Array.isArray(args.pages) &&
    args.pages.length > 0
  ) {
    return spaces.assertPagesControllable(owner, args.pages as number[])
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
  const parsed = def.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return errorResult(`Invalid arguments for ${def.name}: ${detail}`)
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
      if (err instanceof SpaceGuardError) return errorResult(err.message)
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
  }

  throwIfAborted(pageCtx.signal)
  const result = await abortable(
    response.buildForPage(pageCtx),
    pageCtx.signal,
  )
  throwIfAborted(pageCtx.signal)

  const pageId = (parsed.data as Record<string, unknown>).page
  if (typeof pageId === 'number') {
    try {
      const tabs = (await pageCtx.page.tabs()) as unknown as Array<{
        pageId: number
        tabId?: number
      }>
      const tabId = tabs.find((tab) => tab.pageId === pageId)?.tabId
      if (typeof tabId === 'number') {
        result.metadata = { ...result.metadata, tabId }
      }
    } catch {
      // Tab-id metadata is best-effort; lookup failures are ignored.
    }
  }

  return result
}
