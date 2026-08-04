/**
 * Phase 7 — `space.*` MCP notifications (server → client push).
 *
 * Bridges the in-process SpaceEventBus (owned by TaskSpaceManager) to the MCP
 * protocol layer: every space state transition emitted on the bus is forwarded
 * to connected clients as a one-way `notifications/space/*` notification.
 *
 * Design notes:
 *  - The event source is OPT-IN. `createBrowserMcpServer` /
 *    `registerBrowserTools` only attach this bridge when the caller explicitly
 *    passes `spaceEvents` (a SpaceEventBus reference). When omitted, nothing
 *    is subscribed and the tool contracts stay byte-for-byte unchanged.
 *  - Push is fire-and-forget: the listener never awaits the transport write,
 *    so a slow/blocked client can never delay a tool call or the ledger
 *    mutation that emitted the event. Errors (not connected, client closed,
 *    transport failure) are swallowed and logged at debug level only.
 *  - MCP notifications are one-way messages — no subscription handshake is
 *    required on the client side; clients that do not care simply ignore them.
 *  - Cross-process push (an MCP server in process A observing events emitted
 *    by the CLI in process B) stays out of scope: the ledger JSON file is the
 *    shared ground truth, and each process keeps its own in-process bus.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  SpaceEvent,
  SpaceEventBus,
  SpaceEventType,
} from '../../space/task-space-manager.js'

/** MCP notification method for each in-process space event type. */
export const SPACE_NOTIFICATION_METHODS: Readonly<
  Record<SpaceEventType, string>
> = {
  'space.created': 'notifications/space/created',
  'space.agent_active': 'notifications/space/agent_active',
  'space.handoff_requested': 'notifications/space/handoff_requested',
  'space.interrupted': 'notifications/space/interrupted',
  'space.switched': 'notifications/space/switched',
  'space.closed': 'notifications/space/closed',
  'space.tabs_recycled': 'notifications/space/tabs_recycled',
}

/** JSON-RPC notification params for a space event (JSON-safe subset). */
export type SpaceNotificationParams = {
  spaceId: string
  name?: string
  owner?: string
  ownership?: string
  /** Number of tabs involved (carried by space.tabs_recycled). */
  urls?: number
  timestamp: number
}

export interface SpaceNotification {
  method: string
  params: SpaceNotificationParams
}

/** Maps an in-process space event to its MCP notification payload. */
export function spaceEventToNotification(
  event: SpaceEvent,
): SpaceNotification {
  const params: SpaceNotificationParams = {
    spaceId: event.spaceId,
    timestamp: event.timestamp,
  }
  if (event.name !== undefined) params.name = event.name
  if (event.owner !== undefined) params.owner = event.owner
  if (event.ownership !== undefined) params.ownership = event.ownership
  if (event.urls !== undefined) params.urls = event.urls
  return { method: SPACE_NOTIFICATION_METHODS[event.type], params }
}

interface SpaceNotificationLogger {
  debug?(message: string, meta?: Record<string, unknown>): void
}

export interface AttachSpaceEventNotificationsOptions {
  /** Optional observer sink called for every event (never throws into the bus). */
  onSpaceEvent?: (event: SpaceEvent) => void
  logger?: SpaceNotificationLogger
}

/**
 * Subscribes an MCP server to a SpaceEventBus and pushes every event to
 * connected clients as a `notifications/space/*` notification. Returns an
 * unsubscribe function.
 *
 * The returned subscription is inert until the server is connected to a
 * transport; before that (and after close) pushes are silently skipped.
 */
export function attachSpaceEventNotifications(
  server: McpServer,
  bus: SpaceEventBus,
  opts: AttachSpaceEventNotificationsOptions = {},
): () => void {
  const unsubscribers = (
    Object.keys(SPACE_NOTIFICATION_METHODS) as SpaceEventType[]
  ).map((type) =>
    bus.on(type, (event: SpaceEvent) => {
      // Observer sink must never break the ledger or the push path.
      if (opts.onSpaceEvent) {
        try {
          opts.onSpaceEvent(event)
        } catch (error) {
          opts.logger?.debug?.('space notification observer threw', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const { method, params } = spaceEventToNotification(event)
      // Fire-and-forget: never block the emitting tool call on the transport.
      void server.server
        .notification({ method, params })
        .catch((error: unknown) => {
          opts.logger?.debug?.('space notification push skipped', {
            method,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }),
  )
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
