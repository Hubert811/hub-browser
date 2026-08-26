import { z } from 'zod'
import { ownerOf } from '../../../space/task-space-manager.js'
import { defineTool, errorResult, textResult } from './framework'

export const tabs = defineTool({
  name: 'tabs',
  description:
    "Manage browser tabs. Space is the precondition (decision D3): with no task space, `list` returns an empty list and every page operation is rejected until you create one (space.create / hub space create). With a task space, `list` returns the pages in your space (others are invisible); `active` shows the current front page of your space; `new` opens a fresh page attributed to your current space; `close` closes one of your pages. Page-targeted tools (snapshot, act, navigate, close, etc.) reject dispatches on pages outside your space (or with no space at all) with an error asking you to open a space tab first. `list` also accepts view=all: a tri-bucket ownership view (P1-5) of every live tab annotated as mine / user / other-agent — non-mine tabs show only their page id and the owning space's name (url/title stripped), so you learn WHO holds a tab, not WHAT is in it; operating on non-mine tabs stays rejected by the guards.",
  input: z.object({
    action: z.enum(['list', 'active', 'new', 'close']).default('list'),
    view: z
      .enum(['owned', 'all'])
      .optional()
      .describe(
        'For action="list": owned (default) returns only the pages in your space; all returns a tri-bucket ownership view of every live tab (mine / user / other-agent, with url/title stripped on non-mine tabs).',
      ),
    url: z
      .string()
      .optional()
      .describe('URL for action="new" (defaults to about:blank).'),
    background: z
      .boolean()
      .default(true)
      .describe('Open without stealing focus for action="new".'),
    page: z.number().int().optional().describe('Page id for action="close".'),
  }).strict(),
  annotations: {
    title: 'Manage tabs',
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    switch (args.action) {
      case 'list': {
        let pages = (await ctx.page.tabs()) as unknown as Array<{
          pageId: number
          url: string
          title?: string
        }>
        if (ctx.spaces && ctx.identity) {
          if (args.view === 'all') {
            // P1-5 tri-bucket view: every tab annotated mine/user/other-agent;
            // non-mine tabs are identity-only (url/title stripped).
            const classified = await ctx.spaces.classifyTabsForAgent(
              ownerOf(ctx.identity),
              pages,
            )
            const lines = classified.map((p) =>
              p.ownership === 'mine'
                ? formatPageLine(p)
                : `[${p.ownership}] page ${p.pageId}${p.ownerLabel ? ` (space "${p.ownerLabel}")` : ''}`,
            )
            return textResult(lines.join('\n') || '(no open pages)', {
              pages: classified.map((p) => ({
                page: p.pageId,
                ownership: p.ownership,
                ...(p.ownership === 'mine' && {
                  url: p.url,
                  title: p.title,
                }),
                ...(p.ownerLabel !== undefined && { ownerLabel: p.ownerLabel }),
              })),
            })
          }
          pages = (await ctx.spaces.filterTabsForAgent(
            ownerOf(ctx.identity),
            pages,
          )) as typeof pages
        }
        const lines = pages.map(formatPageLine)
        return textResult(lines.join('\n') || '(no open pages)', {
          pages: pages.map((p) => ({
            page: p.pageId,
            url: p.url,
            title: p.title,
          })),
        })
      }
      case 'active': {
        let pages = (await ctx.page.tabs()) as unknown as Array<{
          pageId: number
          url: string
          title?: string
          isActive?: boolean
        }>
        if (ctx.spaces && ctx.identity) {
          pages = (await ctx.spaces.filterTabsForAgent(
            ownerOf(ctx.identity),
            pages,
          )) as typeof pages
        }
        const page = pages.find((p) => p.isActive) ?? pages[0]
        if (!page) {
          return errorResult(
            'tabs active: no active page found in your space.',
          )
        }
        return textResult(`Active page: ${formatPageLine(page)}`, {
          action: 'active',
          page,
        })
      }
      case 'new': {
        const targetId = await ctx.page.newTab(args.url ?? 'about:blank', {
          background: args.background,
          windowId: ctx.defaultWindowId,
          tabGroupId: ctx.defaultTabGroupId,
        })
        const pages = (await ctx.page.tabs()) as unknown as Array<{
          pageId: number
          targetId?: string
        }>
        const info = pages.find((p) => p.targetId === targetId)
        const page = info?.pageId ?? targetId
        if (
          ctx.spaces &&
          ctx.identity &&
          typeof page === 'number'
        ) {
          // Attribute the fresh tab to the agent's current space so it stays
          // visible under isolation (best-effort; the guard already rejected
          // `tabs new` while the current space is user-held). ownerOf key
          // (convoId ?? agentId) — a bare agentId would look up the wrong
          // current space for MCP clientInfo identities (P1-5 漏网).
          await ctx.spaces
            .recordTabForCurrentSpace(
              ownerOf(ctx.identity),
              page,
              args.url ?? 'about:blank',
            )
            .catch(() => {})
        }
        return textResult(`opened page ${page}`, { page })
      }
      case 'close': {
        if (args.page === undefined) {
          return errorResult('tabs close: page is required.')
        }
        await ctx.page.closeTab(args.page)
        return textResult(`closed page ${args.page}`, { page: args.page })
      }
      default:
        return errorResult('tabs: unsupported action.')
    }
  },
})

function formatPageLine(page: {
  pageId: number
  url?: string
  title?: string
}) {
  return `[${page.pageId}] ${page.url ?? '(no url)'}${page.title ? ` (${page.title})` : ''}`
}
