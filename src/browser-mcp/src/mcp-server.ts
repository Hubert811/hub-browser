import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BROWSER_MCP_INSTRUCTIONS } from './mcp-prompt'
import type {
  SpaceEvent,
  SpaceEventBus,
  SpaceIdentity,
  TaskSpaceManager,
} from '../../space/task-space-manager.js'
import {
  type BrowserToolDefaults,
  type BrowserToolRegistrationOptions,
  type SpaceIdentityResolver,
  registerBrowserTools,
} from './register'
import type { BrowserSession } from '@browseros/browser-core'
import { providerFromSession } from './tools/session-adapter'
import type { UnifiedPageProvider } from './tools/framework'

export interface BrowserMcpServerOptions extends BrowserToolDefaults {
  name: string
  title: string
  version: string
  /**
   * UnifiedPage provider (e.g. `UnifiedBrowserFactory`). Replaces the
   * `BrowserSession` binding of the vendored browser-mcp: every tool resolves
   * its target page through `connect()` and operates on UnifiedPage.
   */
  browser?: UnifiedPageProvider
  /**
   * Legacy vendored binding. Vendored consumers (apps/server `/mcp`) call
   * `createBrowserMcpServer({ browserSession })`; when `browser` is omitted
   * the session is bridged to the fork via session-adapter.providerFromSession
   * so the 17 tools + space.* run unchanged.
   */
  browserSession?: BrowserSession
  instructions?: string
  registration?: BrowserToolRegistrationOptions
  /**
   * Phase 3 — agent identity for space ownership/guard. Static object or a
   * per-call resolver (see SpaceIdentityResolver in ./register). When omitted,
   * the registration layer falls back to $HUB_AGENT_ID then MCP client info.
   */
  identity?: SpaceIdentity | SpaceIdentityResolver
  /** Phase 3 — shared TaskSpaceManager (统一 Core 单点); enables space.* tools + isolation. */
  spaces?: TaskSpaceManager
  /**
   * Phase 7 — OPT-IN space event source for MCP notifications. When provided,
   * every event emitted on this SpaceEventBus (created/agent_active/
   * handoff_requested/interrupted/switched/closed) is pushed to connected
   * clients as a `notifications/space/*` notification. When omitted, nothing
   * is subscribed and no notifications are sent (backwards compatible).
   *
   * Typical wiring: `spaceEvents: spaces.events ?? undefined`.
   */
  spaceEvents?: SpaceEventBus | null
  /**
   * Phase 7 — optional observer sink invoked for every space event (same
   * events that produce MCP notifications). Only fires when `spaceEvents` is
   * provided. Never throws into the event bus.
   */
  onSpaceEvent?: (event: SpaceEvent) => void
}

/** Creates a hub-browser MCP server with only the shared browser tool surface. */
export function createBrowserMcpServer(
  options: BrowserMcpServerOptions,
): McpServer {
  const provider: UnifiedPageProvider | undefined =
    options.browser ??
    (options.browserSession
      ? providerFromSession(options.browserSession)
      : undefined)
  if (!provider) {
    throw new Error(
      'createBrowserMcpServer requires either `browser` (UnifiedPageProvider) ' +
        'or `browserSession` (vendored BrowserSession)',
    )
  }
  const server = new McpServer(
    {
      name: options.name,
      title: options.title,
      version: options.version,
    },
    {
      capabilities: { logging: {} },
      instructions: options.instructions ?? BROWSER_MCP_INSTRUCTIONS,
    },
  )

  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {}
  })

  registerBrowserTools(
    server,
    provider,
    {
      defaultWindowId: options.defaultWindowId,
      defaultTabGroupId: options.defaultTabGroupId,
    },
    {
      ...(options.registration ?? {}),
      identity: (options.identity ?? options.registration?.identity) as
        | SpaceIdentityResolver
        | undefined,
      spaces: options.spaces ?? options.registration?.spaces,
      spaceTools: options.registration?.spaceTools,
      spaceEvents: options.spaceEvents ?? options.registration?.spaceEvents,
      onSpaceEvent: options.onSpaceEvent ?? options.registration?.onSpaceEvent,
    },
  )

  return server
}
