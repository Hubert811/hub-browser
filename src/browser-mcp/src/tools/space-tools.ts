/**
 * Phase 3 — `space.*` MCP tools (fork surface additions).
 *
 * Thin wrappers over the shared TaskSpaceManager (统一 Core 单点). The manager
 * owns the ledger, the ownership state machine, and the agent-level tab
 * isolation guard; these tools only map tool calls onto it. They require the
 * ToolContext to carry both `identity` and `spaces` (wired by
 * registerBrowserTools / createBrowserMcpServer).
 */
import { z } from 'zod'
import {
  SpaceGuardError,
  type SpaceIdentity,
  type TaskSpaceManager,
} from '../../../space/task-space-manager.js'
import type { ToolContext } from './framework'
import { defineTool, errorResult, textResult } from './framework'

function requireSpaces(ctx: ToolContext): {
  manager: TaskSpaceManager
  identity: SpaceIdentity
} {
  if (!ctx.spaces || !ctx.identity) {
    throw new SpaceGuardError(
      'not-configured',
      'space tools are not configured on this server (missing identity/spaces wiring)',
    )
  }
  return { manager: ctx.spaces, identity: ctx.identity }
}

async function resolveSpaceId(
  manager: TaskSpaceManager,
  identity: SpaceIdentity,
  spaceId?: string,
): Promise<string> {
  if (spaceId) return spaceId
  const current = await manager.currentSpace(identity.agentId)
  if (!current) {
    throw new SpaceGuardError(
      'space-not-found',
      'no current space; create one with space.create (or space.use) first',
    )
  }
  return current.id
}

function spaceLine(space: {
  id: string
  name: string
  ownership: string
  tabIds: number[]
}): string {
  return `[${space.id}] "${space.name}" (${space.ownership}) tabs: ${space.tabIds.length}`
}

const spaceIdArg = z
  .string()
  .optional()
  .describe(
    'Space id. Defaults to the agent\u2019s current space when omitted.',
  )

export const space_create = defineTool({
  name: 'space.create',
  description:
    'Create a task space (a page set scoped to this agent/conversation) and make it the current space. Browser tabs opened via space.open_tab are attributed to it.',
  input: z.object({
    name: z.string().describe('Task-space name, e.g. "search github issues".'),
    taskId: z
      .string()
      .optional()
      .describe('Optional task identifier the space belongs to.'),
  }),
  annotations: { title: 'Create task space', idempotentHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const space = await manager.create(identity.agentId, args.name, args.taskId)
    return textResult(`created space ${space.id} ("${space.name}")`, { space })
  },
})

export const space_use = defineTool({
  name: 'space.use',
  description:
    'Reuse the task space with this name for this agent/conversation, or create it when it does not exist yet. Makes it the current space. Use it at the start of a multi-step task to keep working in the same space.',
  input: z.object({
    name: z.string().describe('Task-space name (reused across calls).'),
    taskId: z.string().optional(),
  }),
  annotations: { title: 'Use or create task space', idempotentHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const before = await manager.listSpaces(identity.agentId)
    const space = await manager.useOrCreateTaskSpace(
      identity.agentId,
      args.name,
      args.taskId,
    )
    const reused = before.some((s) => s.id === space.id)
    return textResult(
      reused
        ? `using space ${space.id} ("${space.name}")`
        : `created space ${space.id} ("${space.name}")`,
      { space, reused },
    )
  },
})

export const space_list = defineTool({
  name: 'space.list',
  description:
    'List the task spaces owned by this agent/conversation (id, name, ownership, tab count).',
  input: z.object({}),
  annotations: { title: 'List task spaces', readOnlyHint: true },
  handler: async (_args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaces = await manager.listSpaces(identity.agentId)
    const text = spaces.length
      ? spaces.map(spaceLine).join('\n')
      : '(no task spaces)'
    return textResult(text, { spaces, count: spaces.length })
  },
})

export const space_current = defineTool({
  name: 'space.current',
  description:
    'Show the agent\u2019s current task space (the space subsequent space.open_tab calls and tab-group coloring use).',
  input: z.object({}),
  annotations: { title: 'Show current task space', readOnlyHint: true },
  handler: async (_args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const space = await manager.currentSpace(identity.agentId)
    if (!space) {
      return textResult('no current space', { space: null })
    }
    return textResult(`current space: ${spaceLine(space)}`, { space })
  },
})

export const space_switch = defineTool({
  name: 'space.switch',
  description:
    'Switch the agent\u2019s current task space. Only spaces owned by this agent can be switched to (user-held spaces are rejected with "user is controlling").',
  input: z.object({ spaceId: z.string().describe('Space id to switch to.') }),
  annotations: { title: 'Switch task space' },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const space = await manager.switch(identity.agentId, args.spaceId)
    return textResult(`switched to space ${space.id} ("${space.name}")`, {
      switched: space.id,
      current: space,
    })
  },
})

export const space_open_tab = defineTool({
  name: 'space.open_tab',
  description:
    'Open a tab inside the given (or current) task space, in the background so it does not steal focus. Returns the pageId to use with snapshot/act/navigate/read/... By default the URL is reused (exact): if this space already has a live tab with the same href it is switched to and the result carries reused:true instead of opening a duplicate. Pass reuse:false to force a new tab, or origin / origin+path / includes for looser matching.',
  input: z.object({
    spaceId: spaceIdArg,
    url: z.string().describe('URL to open.'),
    background: z.boolean().default(true),
    reuse: z
      .union([
        z.enum(['exact', 'origin', 'origin+path', 'includes']),
        z.literal(false),
      ])
      .optional()
      .describe(
        'URL-reuse mode for tabs already open in this space: exact (default; same normalized href), origin, origin+path (same origin and pathname), includes (tab URL string contains the requested url), or false to force a new tab. On a match the existing tab is reused (switched to) and the result has reused:true.',
      ),
  }),
  annotations: { title: 'Open tab in task space', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    const { pageId, reused } = await manager.openTabWithReuse(
      identity.agentId,
      spaceId,
      args.url,
      {
        background: args.background,
        reuse: args.reuse ?? 'exact',
      },
    )
    return textResult(
      reused
        ? `reused page ${pageId} in space ${spaceId}`
        : `opened page ${pageId} in space ${spaceId}`,
      { pageId, spaceId, reused },
    )
  },
})

export const space_list_tabs = defineTool({
  name: 'space.list_tabs',
  description:
    'List the tabs attributed to the given (or current) task space. Tabs closed externally are pruned automatically.',
  input: z.object({ spaceId: spaceIdArg }),
  annotations: { title: 'List task-space tabs', readOnlyHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    const tabs = await manager.listTabs(spaceId)
    const text = tabs.length
      ? tabs
          .map(
            (t) =>
              `[${t.pageId}] ${t.url}${t.title ? ` (${t.title})` : ''}`,
          )
          .join('\n')
      : '(no tabs in this space)'
    return textResult(text, { spaceId, tabs, count: tabs.length })
  },
})

export const space_close_tab = defineTool({
  name: 'space.close_tab',
  description:
    'Close one tab inside the given (or current) task space and remove it from the space ledger.',
  input: z.object({
    spaceId: spaceIdArg,
    pageId: z.number().int().describe('Page id from space.list_tabs / tabs.'),
  }),
  annotations: { title: 'Close task-space tab', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    await manager.closeTab(identity.agentId, spaceId, args.pageId)
    return textResult(`closed page ${args.pageId} in space ${spaceId}`, {
      closed: args.pageId,
      spaceId,
    })
  },
})

export const space_close = defineTool({
  name: 'space.close',
  description:
    'Close the given (or current) task space. By default every attributed tab is closed in the browser; pass keep=true to only close the space ledger and leave the tabs open. A user-held space must be claimed first (space.claim / space.takeover).',
  input: z.object({
    spaceId: spaceIdArg,
    keep: z
      .boolean()
      .default(false)
      .describe('Keep the browser tabs open; close only the space ledger.'),
  }),
  annotations: { title: 'Close task space', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    await manager.closeSpace(identity.agentId, spaceId, { keep: args.keep })
    return textResult(`closed space ${spaceId}`, { closed: spaceId, keep: args.keep })
  },
})

export const space_recycle = defineTool({
  name: 'space.recycle',
  description:
    'Recycle the given (or current) task space: close every tab and reopen each URL in a fresh tab (space record id/name/ownership preserved — only the tabs are replaced). Use it to refresh a long-running task mid-way, e.g. after a tab\u2019s capture pipeline wedges (screenshot hint: tab-wedged). Requires agent control (user-held spaces must be claimed first) and a browser gateway.',
  input: z.object({ spaceId: spaceIdArg }),
  annotations: { title: 'Recycle task-space tabs', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    // The MCP registration layer passes page=undefined for space.* tools; in
    // that path the browser gateway lives on the manager (gatewayFromProvider
    // wired by hub.mjs). Fall back to it instead of crashing on ctx.page.
    const { gatewayFromPage } = await import(
      '../../../space/task-space-manager.js'
    )
    const pageGw = ctx.page ? gatewayFromPage(ctx.page) : undefined
    const result = await manager.recycleSpaceTabs(
      identity.agentId,
      spaceId,
      pageGw,
    )
    const lines = result.tabs.length
      ? result.tabs
          .map((t) => `${t.url} -> page ${t.newPageId}`)
          .join('\n')
      : '(no tabs in this space)'
    const text = `recycled ${result.recycled} tab(s) in space ${spaceId}\n${lines}`
    return textResult(text, {
      spaceId,
      recycled: result.recycled,
      tabs: result.tabs,
      ...(result.failed !== undefined ? { failed: result.failed } : {}),
    })
  },
})

export const space_handoff = defineTool({
  name: 'space.handoff',
  description:
    'Hand control of the given (or current) task space over to the user (agent → agentDelegatedToUser). While handed off, agent operations on the space fail with "user is controlling". Tell the user what to do; resume only after they confirm, with space.takeover (confirmed: true).',
  input: z.object({ spaceId: spaceIdArg }),
  annotations: { title: 'Hand off task space', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    const space = await manager.handOff(identity.agentId, spaceId)
    return textResult(`handed off space ${space.id} to the user`, { space })
  },
})

export const space_takeover = defineTool({
  name: 'space.takeover',
  description:
    'Take control of the given (or current) task space back from the user (user → agent). REQUIRES the user to have explicitly confirmed first: pass confirmed=true only after the user says to continue. Without confirmation this fails with a needs-confirmation error.',
  input: z.object({
    spaceId: spaceIdArg,
    confirmed: z
      .boolean()
      .default(false)
      .describe('Must be true — set only after the user explicitly confirms.'),
  }),
  annotations: { title: 'Take over task space', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    const space = await manager.takeOver(identity.agentId, spaceId, {
      confirmed: args.confirmed,
    })
    return textResult(`agent now controls space ${space.id}`, { space })
  },
})

export const space_claim = defineTool({
  name: 'space.claim',
  description:
    'Claim the given (or current) task space and select it as current (ego claimTaskSpace). Claiming a user-held space transfers ownership back to the agent and requires user confirmation (confirmed=true).',
  input: z.object({
    spaceId: spaceIdArg,
    confirmed: z
      .boolean()
      .default(false)
      .describe('Must be true when claiming a user-held space.'),
  }),
  annotations: { title: 'Claim task space', destructiveHint: true },
  handler: async (args, ctx) => {
    const { manager, identity } = requireSpaces(ctx)
    const spaceId = await resolveSpaceId(manager, identity, args.spaceId)
    const space = await manager.claimTaskSpace(identity.agentId, spaceId, {
      confirmed: args.confirmed,
    })
    return textResult(`agent now controls space ${space.id}`, { space })
  },
})

export const SPACE_TOOLS = [
  space_create,
  space_use,
  space_list,
  space_current,
  space_switch,
  space_open_tab,
  space_list_tabs,
  space_close_tab,
  space_close,
  space_recycle,
  space_handoff,
  space_takeover,
  space_claim,
]

