import { z } from 'zod'
import { ownerOf } from '../../../space/task-space-manager.js'
import { defineTool, errorResult, textResult } from './framework'

const ACTIONS = ['list', 'create', 'close', 'activate'] as const

interface RawWindowInfo {
  windowId: number
  type?: string
  windowType?: string
  tabCount?: number
  tabs?: unknown[]
  isActive?: boolean
  state?: string
}

export const windows = defineTool({
  name: 'windows',
  description:
    'Manage browser windows: list, create, close, or activate a window.',
  input: z.object({
    action: z.enum(ACTIONS).default('list'),
    windowId: z
      .number()
      .int()
      .optional()
      .describe('Window id for close and activate.'),
  }).strict(),
  annotations: {
    title: 'Manage windows',
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    switch (args.action) {
      case 'list': {
        const all = (await ctx.page.windowList()) as unknown as RawWindowInfo[]
        return textResult(formatWindowList(all), {
          action: 'list',
          windows: all,
          count: all.length,
        })
      }
      case 'create': {
        const window = (await ctx.page.windowCreate()) as unknown as {
          windowId: number
        }
        // P7-H H5 — a new window always comes with exactly one tab, and the
        // window guard derives ownership from the ledger, so claim that tab the
        // same way `tabs new` does. Without this the agent could not close the
        // window it just opened (nothing would prove the window is its own).
        if (ctx.spaces && ctx.identity) {
          const pages = (await ctx.page.tabs()) as unknown as Array<{
            pageId: number
            windowId?: number
            targetId?: string
            tabId?: number
          }>
          const fresh = pages.find((p) => p.windowId === window.windowId)
          if (fresh && typeof fresh.pageId === 'number') {
            await ctx.spaces
              .recordTabForCurrentSpace(
                ownerOf(ctx.identity),
                fresh.pageId,
                'about:blank',
                fresh.targetId,
                fresh.tabId,
              )
              .catch(() => {})
          }
        }
        return textResult(`created window ${window.windowId}`, {
          action: 'create',
          window,
        })
      }
      case 'close': {
        if (args.windowId === undefined) {
          return errorResult('windows close: windowId is required.')
        }
        await ctx.page.windowClose(args.windowId)
        return textResult(`closed window ${args.windowId}`, {
          action: 'close',
          windowId: args.windowId,
        })
      }
      case 'activate': {
        if (args.windowId === undefined) {
          return errorResult('windows activate: windowId is required.')
        }
        await ctx.page.windowActivate(args.windowId)
        return textResult(`activated window ${args.windowId}`, {
          action: 'activate',
          windowId: args.windowId,
        })
      }
      default:
        return errorResult('windows: unsupported action.')
    }
  },
})

function formatWindowList(windows: RawWindowInfo[]): string {
  if (windows.length === 0) return 'No windows found.'

  const lines = [`Found ${windows.length} windows:`, '']
  for (const window of windows) {
    const suffix =
      window.isActive || window.state === 'normal' ? ' [ACTIVE]' : ''
    const type = window.windowType ?? window.type ?? 'unknown'
    const tabCount = window.tabCount ?? window.tabs?.length ?? '?'
    lines.push(
      `Window ${window.windowId} (${type}, ${tabCount} tabs)${suffix}`,
    )
  }
  return lines.join('\n')
}
