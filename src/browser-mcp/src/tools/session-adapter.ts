/**
 * Session → UnifiedPage bridge (方案 2: 薄适配器).
 *
 * apps/server's tool-adapter.ts (vendored, read-only) calls the fork's
 * `executeTool` with the *old* vendored ToolContext shape:
 *
 *     { session: BrowserSession, signal, ... }
 *
 * The fork's tools, however, operate on UnifiedPage through
 * `{ page, pageFor, ... }`. This module adapts a vendored `BrowserSession`
 * into a fork `ToolContext` by wrapping the session (and the CdpBackend it
 * was constructed with) in `UnifiedPage` instances — the same wiring
 * `UnifiedBrowserFactory.connect()` uses. apps/server therefore needs no
 * source change: `executeTool` detects the session shape and bridges here.
 */
import { UnifiedPage } from '../../../page.js'
import type { BrowserSession } from '@browseros/browser-core'
import type { SpaceIdentity, TaskSpaceManager } from '../../../space/task-space-manager.js'
import type { ToolContext, UnifiedPageProvider } from './framework'

/** The ctx shape apps/server (vendored tool-adapter) passes today. */
export interface SessionToolContext {
  session: BrowserSession
  defaultWindowId?: number
  defaultTabGroupId?: string
  signal?: AbortSignal
  /** Phase 3 — optional identity + shared TaskSpaceManager (same semantics as ToolContext). */
  identity?: SpaceIdentity
  spaces?: TaskSpaceManager
}

/** True when the ctx is the vendored session shape (not the fork's page shape). */
export function isSessionContext(
  ctx: ToolContext | SessionToolContext,
): ctx is SessionToolContext {
  return (ctx as SessionToolContext).session !== undefined
}

/**
 * UnifiedPage needs the underlying CdpBackend for the event bridge
 * (`onSessionEvent`, used by console/network collectors) and `close()`.
 * BrowserSession stores that connection privately and exposes it through
 * `protocol` (typed as `ProtocolApi`, but at runtime it is the CdpBackend
 * instance — `new BrowserSession(cdp)` / `new Browser(cdp)`).
 */
function cdpBackendFor(session: BrowserSession): unknown {
  const conn = (session as unknown as { protocol?: unknown }).protocol
  if (
    conn !== undefined &&
    conn !== null &&
    typeof (conn as { onSessionEvent?: unknown }).onSessionEvent === 'function'
  ) {
    return conn
  }
  // Fake sessions in tests / exotic CdpConnections: provide the minimal
  // surface UnifiedPage needs (no tool starts console/network capture).
  return {
    onSessionEvent: () => () => {},
    disconnect: async () => {},
  }
}

/** Wraps a vendored BrowserSession as a UnifiedPage bound to `pageId`. */
export function pageFromSession(
  session: BrowserSession,
  pageId: number,
): UnifiedPage {
  return new UnifiedPage(session, cdpBackendFor(session) as never, pageId)
}

/** Active page on the session; falls back to 1 when listing fails/empty. */
async function resolveActivePageId(session: BrowserSession): Promise<number> {
  try {
    const pages = (await session.pages.list()) as unknown as Array<{
      pageId: number
      isActive?: boolean
    }>
    return pages.find((p) => p.isActive)?.pageId ?? pages[0]?.pageId ?? 1
  } catch {
    return 1
  }
}

/** Builds the fork's `ToolContext` from the vendored session ctx. */
export async function contextFromSession(
  ctx: SessionToolContext,
): Promise<ToolContext> {
  const pageId = await resolveActivePageId(ctx.session)
  const page = pageFromSession(ctx.session, pageId)
  const pageFor = (targetPageId: number): Promise<UnifiedPage> =>
    Promise.resolve(pageFromSession(ctx.session, targetPageId))
  return {
    page,
    pageFor,
    defaultWindowId: ctx.defaultWindowId,
    defaultTabGroupId: ctx.defaultTabGroupId,
    signal: ctx.signal,
    identity: ctx.identity,
    spaces: ctx.spaces,
  }
}

/**
 * Builds a fork `UnifiedPageProvider` from a vendored BrowserSession — the
 * legacy binding vendored consumers (apps/server `/mcp`) pass to
 * `createBrowserMcpServer({ browserSession })`. Each `connect()` wraps the
 * session in a UnifiedPage bound to the requested page id (or the active page).
 */
export function providerFromSession(session: BrowserSession): UnifiedPageProvider {
  return {
    async connect(opts) {
      const pageId = opts?.pageId ?? (await resolveActivePageId(session))
      return pageFromSession(session, pageId)
    },
  }
}
