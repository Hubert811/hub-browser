import { z } from 'zod'
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
