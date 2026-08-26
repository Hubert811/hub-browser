import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { UnifiedPage } from '../../../page.js'
import type {
  SpaceEvent,
  SpaceEventBus,
  SpaceIdentity,
  TaskSpaceManager,
} from '../../../space/task-space-manager.js'
import type { ZodObject, ZodRawShape } from 'zod'
import { attachSpaceEventNotifications } from '../space-notifications'
import {
  executeTool,
  type ToolContext,
  type UnifiedPageProvider,
} from './framework'
import {
  type BrowserOutputFileAccess,
  withBrowserOutputFileAccess,
} from './output-file'
import { BROWSER_TOOLS, DISCOVERY_TOOLS, OBSERVATION_TOOLS, PAGE_INFO_TOOLS, PROBE_TOOLS, SPACE_TOOLS } from './registry'
import { AUDIT_TOOLS } from './audit-tools'
import { ADAPTER_TOOLS } from './adapter-tools'
import { REPLAY_TOOLS } from './replay-tools'

type RegisterFn = (
  name: string,
  config: {
    description: string
    inputSchema?: ZodObject<ZodRawShape>
    outputSchema?: ZodObject<ZodRawShape>
    annotations?: Record<string, unknown>
  },
  handler: (
    args: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<{
    content: unknown
    isError?: boolean
    structuredContent?: unknown
  }>,
) => void

export interface BrowserToolDefaults {
  defaultWindowId?: number
  defaultTabGroupId?: string
}

interface BrowserToolLogger {
  debug?(message: string, meta?: Record<string, unknown>): void
  info?(message: string, meta?: Record<string, unknown>): void
}

export type SpaceIdentityResolver =
  | SpaceIdentity
  | (() =>
      | SpaceIdentity
      | undefined
      | Promise<SpaceIdentity | undefined>)

export interface BrowserToolRegistrationOptions {
  includeStructuredContent?: boolean
  outputFileAccess?: BrowserOutputFileAccess
  onToolExecutionStart?: (event: BrowserToolLifecycleEvent) => void
  onToolExecutionEnd?: (event: BrowserToolLifecycleEvent) => void
  onToolExecuted?: (event: BrowserToolExecutionEvent) => void
  shouldLogToolRegistration?: () => boolean
  logger?: BrowserToolLogger
  source?: string
  /**
   * Phase 3 — agent identity. Static object, or a resolver evaluated per tool
   * call. Resolution order: explicit option → $HUB_AGENT_ID → MCP client info
   * (name) → undefined (tools keep the legacy open-world behavior).
   */
  identity?: SpaceIdentityResolver
  /** Phase 3 — shared TaskSpaceManager (统一 Core 单点); enables isolation + space.* tools. */
  spaces?: TaskSpaceManager
  /** Register the space.* tools (default true). */
  spaceTools?: boolean
  /** Register the audit.* observability tools (default true). */
  auditTools?: boolean
  /** Register the replay.* recording tools — list/export (default true, P2-3). */
  replayTools?: boolean
  /** Register the adapter.* execution/maintenance tools (default true, P2-7). */
  adapterTools?: boolean
  /** Register the page-info tools — frames/extract (default true, P2-6 batch 1). */
  pageInfoTools?: boolean
  /** Register the observation tools — network/console (default true, P2-6 batch 2). */
  observationTools?: boolean
  /** Register the discovery tools — find/analyze (default true, P2-6 batch 3). */
  discoveryTools?: boolean
  /** Register the probe tools — inspect (default true, P3-5). */
  probeTools?: boolean
  /**
   * P2-1 — fires once with the first resolved tool identity (the session's
   * ownership key holder) so the host can run a session-end space sweep.
   * Best-effort: throws are swallowed and never affect tool calls.
   */
  onSessionIdentity?: (identity: SpaceIdentity) => void
  /**
   * Phase 7 — OPT-IN space event source for MCP notifications. When provided,
   * every event emitted on this SpaceEventBus (created/agent_active/
   * handoff_requested/interrupted/switched/closed) is pushed to connected
   * clients as a `notifications/space/*` notification. When omitted, nothing
   * is subscribed and no notifications are sent (backwards compatible).
   */
  spaceEvents?: SpaceEventBus | null
  /**
   * Phase 7 — optional observer sink invoked for every space event (same
   * events that produce MCP notifications). Only fires when `spaceEvents` is
   * provided. Never throws into the event bus.
   */
  onSpaceEvent?: (event: SpaceEvent) => void
}

export interface BrowserToolLifecycleEvent extends Record<string, unknown> {
  tool_name: string
  source: string
}

export interface BrowserToolExecutionEvent extends Record<string, unknown> {
  tool_name: string
  duration_ms: number
  success: boolean
  source: string
  error_message?: string
}

function summarizeBrowserToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    argKeys: Object.keys(args).sort(),
  }
  if (typeof args.page === 'number') summary.page = args.page
  if (typeof args.action === 'string') summary.action = args.action
  if (typeof args.format === 'string') summary.format = args.format
  if (typeof args.timeoutMs === 'number') summary.timeoutMs = args.timeoutMs
  if (typeof args.timeout === 'number') summary.timeout = args.timeout
  if (typeof args.selector === 'string') summary.selectorPresent = true
  if (typeof args.url === 'string') {
    try {
      summary.urlOrigin = new URL(args.url).origin
    } catch {
      summary.urlPresent = true
    }
  }
  return summary
}

function summarizeText(text: string): Record<string, unknown> {
  return {
    textLength: text.length,
    lineCount: text.length ? text.split('\n').length : 0,
  }
}

function resultTextSummary(
  content: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined
  const textBlocks = content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item) => item.text)
  if (textBlocks.length === 0) {
    return {
      contentCount: content.length,
      textBlockCount: 0,
      textLength: 0,
      lineCount: 0,
    }
  }
  return {
    contentCount: content.length,
    textBlockCount: textBlocks.length,
    ...summarizeText(textBlocks.join('\n')),
  }
}

/**
 * Registers the browser tool surface on an MCP server bound to one
 * UnifiedPage provider.
 *
 * UnifiedPage instances are cached per page id so snapshot/observer state
 * (AX refs, diff baselines) survives across tool calls — the same guarantee
 * the vendored browser-mcp got from its session-level BrowserSession, and the
 * same shared-connection reuse the daemon singleton provides to OpenCLI.
 */
/**
 * Resolves the agent identity for one tool call. Explicit option wins, then
 * $HUB_AGENT_ID, then the MCP client name (clientInfo) once initialization has
 * completed. Returning undefined keeps the legacy open-world behavior.
 */
function resolveToolIdentity(
  option: SpaceIdentityResolver | undefined,
  server: McpServer,
): SpaceIdentity | undefined | Promise<SpaceIdentity | undefined> {
  if (typeof option === 'function') {
    return Promise.resolve(option()).then(
      (resolved) => resolved ?? fallbackIdentity(server),
    )
  }
  if (option) return option
  return fallbackIdentity(server)
}

/**
 * P1-3 — builds the session-scoped identity for an MCP server.
 *
 * Layers (first match wins):
 *   1. $HUB_AGENT_ID — explicit stable identity: it is both the agent label
 *      and the ownership key (convoId), so a caller that needs continuity
 *      across restarts pins it explicitly.
 *   2. clientInfo.name — conversation-scoped identity: the agentId keeps the
 *      historical `mcp:<name>` label, while the ownership key gets a
 *      per-process unique suffix (convoId = `mcp:<name>:<suffix>`). Two MCP
 *      server processes with the same client name (two Claude Code windows)
 *      therefore own disjoint space sets — the bug-#3 identity-collapse class
 *      of issues. The suffix is generated exactly once per server session
 *      and cached; per MCP process stdio is one client, so process == session.
 */
export function makeMcpSessionIdentityResolver(
  server: McpServer,
): () => SpaceIdentity | undefined {
  let cached: SpaceIdentity | undefined
  return () => {
    const env = process.env.HUB_AGENT_ID
    if (env) {
      return { agentId: env, convoId: env, displayName: env }
    }
    if (cached) return cached
    const clientInfo = server?.server?.getClientVersion?.()
    if (clientInfo?.name) {
      cached = {
        agentId: `mcp:${clientInfo.name}`,
        convoId: `mcp:${clientInfo.name}:${randomSessionSuffix()}`,
        displayName: clientInfo.name,
      }
    }
    return cached
  }
}

function randomSessionSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

function fallbackIdentity(
  server: McpServer,
): SpaceIdentity | undefined {
  const env = process.env.HUB_AGENT_ID
  if (env) return { agentId: env, displayName: env }
  const clientInfo = server?.server?.getClientVersion?.()
  if (clientInfo?.name) {
    return { agentId: `mcp:${clientInfo.name}`, displayName: clientInfo.name }
  }
  return undefined
}

export function registerBrowserTools(
  server: McpServer,
  provider: UnifiedPageProvider,
  defaults: BrowserToolDefaults = {},
  options: BrowserToolRegistrationOptions = {},
): void {
  const register = server.registerTool.bind(server) as unknown as RegisterFn
  const sessionIdentityResolver = makeMcpSessionIdentityResolver(server)
  let sessionIdentityNotified = false

  const pageCache = new Map<number, Promise<UnifiedPage>>()
  const pageForCached = (pageId: number): Promise<UnifiedPage> => {
    let entry = pageCache.get(pageId)
    if (!entry) {
      entry = provider.connect({ pageId })
      pageCache.set(pageId, entry)
    }
    return entry
  }

  const allTools = [
    ...BROWSER_TOOLS,
    ...(options.spaceTools === false ? [] : SPACE_TOOLS),
    ...(options.auditTools === false ? [] : AUDIT_TOOLS),
    ...(options.replayTools === false ? [] : REPLAY_TOOLS),
    ...(options.adapterTools === false ? [] : ADAPTER_TOOLS),
    ...(options.pageInfoTools === false ? [] : PAGE_INFO_TOOLS),
    ...(options.observationTools === false ? [] : OBSERVATION_TOOLS),
    ...(options.discoveryTools === false ? [] : DISCOVERY_TOOLS),
    ...(options.probeTools === false ? [] : PROBE_TOOLS),
  ]

  for (const tool of allTools) {
    register(
      tool.name,
      {
        description: tool.description,
        // Pass the ZodObject itself, NOT its .shape: the SDK's
        // normalizeObjectSchema rebuilds a raw shape into a plain (permissive)
        // z.object and strips unknown keys BEFORE our executeTool strict
        // check ever runs — silently defeating the .strict() contract
        // (upstream #2432 parity). A constructed ZodObject (strict or not) is
        // used as-is by the SDK, so unknown keys fail at the SDK's own
        // Input validation error with a clear message. Nested schemas ride
        // along by reference either way.
        inputSchema: tool.input,
        ...(tool.output && { outputSchema: tool.output }),
        ...(tool.annotations && {
          annotations: tool.annotations as Record<string, unknown>,
        }),
      },
      async (args, extra) => {
        const source = options.source ?? 'mcp'
        const startTime = performance.now()
        const duration = () => Math.round(performance.now() - startTime)
        const logBase = {
          toolName: tool.name,
          source,
        }
        const lifecycleEvent = {
          tool_name: tool.name,
          source,
        }
        options.logger?.debug?.('MCP browser tool started', {
          ...logBase,
          args: summarizeBrowserToolArgs(args),
          defaultWindowId: defaults.defaultWindowId,
          defaultTabGroupId: defaults.defaultTabGroupId,
        })
        options.onToolExecutionStart?.(lifecycleEvent)
        try {
          const pageArg = typeof args.page === 'number' ? args.page : undefined
          // space.*/audit.* tools are ledger/platform-metadata tools: they
          // must work without a browser connection (identity +
          // TaskSpaceManager / audit DB only). Eagerly connecting here made
          // space.list fail whenever CDP was down.
          //
          // adapter.* tools manage their own sessions: adapter.run builds its
          // browser session inside executeCommand (the engine chain), so the
          // MCP provider connection would be wasted — and would wrongly fail
          // adapter.run/validate when this server's CDP face is down.
          //
          // replay.* tools read the BrowserClaw server over HTTP (P2-3): no
          // CDP connection either — recording capture lives in the browser
          // extension, hub only queries the index and exports files.
          const isBrowserlessTool =
            tool.name.startsWith('space.') ||
            tool.name.startsWith('audit.') ||
            tool.name.startsWith('adapter.') ||
            tool.name.startsWith('replay.')
          const page =
            isBrowserlessTool
              ? (undefined as unknown as UnifiedPage)
              : pageArg === undefined
                ? await provider.connect()
                : await pageForCached(pageArg)
          const pageFor = pageForCached
          // P1-3: without an explicit identity option, tool calls share one
          // session-scoped identity (env override or clientInfo + unique
          // convoId, generated once per server session). Called synchronously
          // — the fallback must not add microtask ticks to the tool pipeline
          // (some callers rely on the old fallbackIdentity timing).
          const resolvedIdentity = options.identity
            ? resolveToolIdentity(options.identity, server)
            : sessionIdentityResolver()
          const identity =
            resolvedIdentity instanceof Promise
              ? await resolvedIdentity
              : resolvedIdentity
          // P2-1 — notify once with the first resolved tool identity so the
          // host process (hub.mjs) knows this session's ownership key for its
          // session-end space sweep. Observer failures never touch the tool
          // pipeline.
          if (identity && !sessionIdentityNotified) {
            sessionIdentityNotified = true
            try {
              options.onSessionIdentity?.(identity)
            } catch {
              // best-effort observer
            }
          }
          const ctx: ToolContext = {
            page,
            pageFor,
            defaultWindowId: defaults.defaultWindowId,
            defaultTabGroupId: defaults.defaultTabGroupId,
            signal: extra?.signal,
            identity,
            spaces: options.spaces,
          }
          const result = await withBrowserOutputFileAccess(
            options.outputFileAccess,
            () => executeTool(tool, args, ctx),
          )
          options.onToolExecuted?.({
            tool_name: tool.name,
            duration_ms: duration(),
            success: !result.isError,
            source,
          })
          const durationMs = duration()
          const errorSummary = result.isError
            ? resultTextSummary(result.content)
            : undefined
          const structuredContent =
            (options.includeStructuredContent ?? true) ||
            tool.output !== undefined
              ? result.structuredContent
              : undefined
          options.logger?.debug?.('MCP browser tool completed', {
            ...logBase,
            durationMs,
            isError: Boolean(result.isError),
            hasStructuredContent: structuredContent !== undefined,
          })
          if (result.isError) {
            options.logger?.info?.('MCP browser tool returned error', {
              ...logBase,
              durationMs,
              errorSummary,
            })
          }
          return {
            content: result.content,
            isError: result.isError,
            ...(structuredContent !== undefined && { structuredContent }),
          }
        } catch (error) {
          const errorText =
            error instanceof Error ? error.message : String(error)
          options.onToolExecuted?.({
            tool_name: tool.name,
            duration_ms: duration(),
            success: false,
            error_message: errorText,
            source,
          })
          options.logger?.info?.('MCP browser tool threw', {
            ...logBase,
            durationMs: duration(),
            error: errorText,
          })
          return {
            content: [{ type: 'text' as const, text: errorText }],
            isError: true,
          }
        } finally {
          options.onToolExecutionEnd?.(lifecycleEvent)
        }
      },
    )
  }

  if (options.shouldLogToolRegistration?.()) {
    options.logger?.info?.('Registered browser MCP tools', {
      count: allTools.length,
      toolNames: allTools.map((t) => t.name),
      source: options.source ?? 'mcp',
    })
  }

  // Phase 7 — bridge the in-process space event bus to MCP notifications.
  // Opt-in: only subscribes when the caller passes `spaceEvents`. The push is
  // fire-and-forget and never fails a tool call.
  if (options.spaceEvents) {
    attachSpaceEventNotifications(server, options.spaceEvents, {
      onSpaceEvent: options.onSpaceEvent,
      logger: options.logger,
    })
  }
}
