import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { UnifiedPage } from '../../../page.js'
import type {
  SpaceEvent,
  SpaceEventBus,
  SpaceIdentity,
  TaskSpaceManager,
} from '../../../space/task-space-manager.js'
import type { ZodRawShape } from 'zod'
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
import { BROWSER_TOOLS, SPACE_TOOLS } from './registry'

type RegisterFn = (
  name: string,
  config: {
    description: string
    inputSchema?: ZodRawShape
    outputSchema?: ZodRawShape
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
  ]

  for (const tool of allTools) {
    register(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input.shape,
        ...(tool.output && { outputSchema: tool.output.shape }),
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
          // space.* tools are ledger-only: they must work without a browser
          // connection (identity + TaskSpaceManager only). Eagerly connecting
          // here made space.list fail whenever CDP was down.
          const isSpaceTool = tool.name.startsWith('space.')
          const page =
            isSpaceTool
              ? (undefined as unknown as UnifiedPage)
              : pageArg === undefined
                ? await provider.connect()
                : await pageForCached(pageArg)
          const pageFor = pageForCached
          const resolvedIdentity = resolveToolIdentity(
            options.identity,
            server,
          )
          const ctx: ToolContext = {
            page,
            pageFor,
            defaultWindowId: defaults.defaultWindowId,
            defaultTabGroupId: defaults.defaultTabGroupId,
            signal: extra?.signal,
            identity:
              resolvedIdentity instanceof Promise
                ? await resolvedIdentity
                : resolvedIdentity,
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
