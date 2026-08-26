import { z } from 'zod'
import { ownerOf } from '../../../space/task-space-manager.js'
import { defineTool, errorResult, textResult } from './framework'

const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const

interface TabGroup {
  groupId: string
  title?: string
  color?: string
  collapsed?: boolean
  tabIds: number[]
  windowId?: number
}

interface TabGroupWithPages extends Omit<TabGroup, 'tabIds'> {
  pageIds: number[]
}

function formatGroup(group: TabGroupWithPages): string {
  const collapsed = group.collapsed ? ' [COLLAPSED]' : ''
  const pages = group.pageIds.length ? group.pageIds.join(', ') : '(none)'
  return `[${group.groupId}] "${group.title || '(unnamed)'}" (${group.color})${collapsed} pages: ${pages}`
}

export const tab_groups = defineTool({
  name: 'tab_groups',
  description:
    'Manage tab groups: list groups, group pages, update a group (title/color/collapsed), ungroup pages, or close a group. Page ids come from the tabs tool.',
  input: z.object({
    action: z
      .enum(['list', 'create', 'update', 'ungroup', 'close'])
      .default('list'),
    pages: z
      .array(z.number().int())
      .optional()
      .describe('Page ids for action="create" or "ungroup".'),
    groupId: z
      .string()
      .optional()
      .describe(
        'Group id. Required for "update"/"close". Optional on "create" to add pages to an existing group.',
      ),
    title: z.string().optional().describe('Group title for "create"/"update".'),
    color: z
      .enum(TAB_GROUP_COLORS)
      .optional()
      .describe('Group color for "update".'),
    collapsed: z
      .boolean()
      .optional()
      .describe('Collapse/expand the group for "update".'),
  }).strict(),
  annotations: {
    title: 'Manage tab groups',
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const page = ctx.page

    // The tools speak page ids; the CDP tab-group API speaks tab ids. Convert in both directions.
    const toTabIds = async (pageIds: number[]): Promise<number[]> => {
      const tabs = (await page.tabs()) as unknown as Array<{
        pageId: number
        tabId: number
      }>
      return pageIds.map((pageId) => {
        const info = tabs.find((tab) => tab.pageId === pageId)
        if (!info) {
          throw new Error(
            `Unknown page ${pageId}. Use the tabs tool to list pages.`,
          )
        }
        return info.tabId
      })
    }

    const toPageIds = async (tabIds: number[]): Promise<number[]> => {
      const tabs = (await page.tabs()) as unknown as Array<{
        pageId: number
        tabId: number
      }>
      return tabIds
        .map((tabId) => tabs.find((tab) => tab.tabId === tabId)?.pageId)
        .filter((id): id is number => id !== undefined)
    }

    const withPages = async (group: TabGroup): Promise<TabGroupWithPages> => {
      const { tabIds, ...rest } = group
      return { ...rest, pageIds: await toPageIds(tabIds) }
    }

    switch (args.action) {
      case 'list': {
        const groups = (await page.tabGroupList()) as unknown as TabGroup[]
        const resolved = await Promise.all(
          groups.map(async (group) => {
            const resolvedGroup = await withPages(group)
            if (ctx.spaces && ctx.identity) {
              // Phase 3 3.4: annotate the owning space on structured groups
              // (additive field; the text line format is unchanged).
              const spaceId = await ctx.spaces.spaceIdForPage(
                resolvedGroup.pageIds[0],
              )
              if (spaceId) {
                return { ...resolvedGroup, space_id: spaceId }
              }
            }
            return resolvedGroup
          }),
        )
        const text = resolved.length
          ? resolved.map(formatGroup).join('\n')
          : '(no tab groups)'
        return textResult(text, { groups: resolved, count: resolved.length })
      }

      case 'create': {
        if (!args.pages?.length) {
          return errorResult('tab_groups create: pages is required.')
        }
        // addTabsToGroup only accepts groupId + tabIds, so title would be silently dropped here.
        if (args.groupId && args.title !== undefined) {
          return errorResult(
            'tab_groups create: title cannot be set when adding pages to an existing groupId; use action="update" to rename.',
          )
        }
        const tabIds = await toTabIds(args.pages)
        let title = args.title
        let color: TabGroup['color'] | undefined = args.color
        if (!args.groupId && ctx.spaces && ctx.identity) {
          // Phase 3 3.4: a new group created while the agent has a current
          // space defaults to the space name + a deterministic color.
          const meta = await ctx.spaces.currentSpaceGroupMeta(
            ownerOf(ctx.identity),
          )
          if (title === undefined) title = meta.title
          if (color === undefined) color = meta.color
        }
        const group = args.groupId
          ? ((await page.cdp('Browser.addTabsToGroup', {
              groupId: args.groupId,
              tabIds,
            })) as { group: TabGroup }).group
          : ((await page.cdp('Browser.createTabGroup', {
              tabIds,
              ...(title !== undefined && { title }),
              ...(color !== undefined && { color }),
            })) as { group: TabGroup }).group
        const resolved = await withPages(group)
        return textResult(`grouped into ${formatGroup(resolved)}`, {
          group: resolved,
        })
      }

      case 'update': {
        if (!args.groupId) {
          return errorResult('tab_groups update: groupId is required.')
        }
        if (
          args.title === undefined &&
          args.color === undefined &&
          args.collapsed === undefined
        ) {
          return errorResult(
            'tab_groups update: provide at least one of title, color, or collapsed.',
          )
        }
        const group = (await page.tabGroupUpdate(args.groupId, {
          title: args.title,
          color: args.color,
          collapsed: args.collapsed,
        })) as TabGroup
        const resolved = await withPages(group)
        return textResult(`updated ${formatGroup(resolved)}`, {
          group: resolved,
        })
      }

      case 'ungroup': {
        if (!args.pages?.length) {
          return errorResult('tab_groups ungroup: pages is required.')
        }
        const tabIds = await toTabIds(args.pages)
        await page.cdp('Browser.removeTabsFromGroup', { tabIds })
        return textResult(`ungrouped ${args.pages.length} page(s)`, {
          pageIds: args.pages,
          count: args.pages.length,
        })
      }

      case 'close': {
        if (!args.groupId) {
          return errorResult('tab_groups close: groupId is required.')
        }
        await page.cdp('Browser.closeTabGroup', {
          groupId: args.groupId,
        })
        return textResult(`closed tab group ${args.groupId} and all its tabs`, {
          groupId: args.groupId,
        })
      }
    }
  },
})
