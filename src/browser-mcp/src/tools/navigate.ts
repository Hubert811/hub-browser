import { z } from 'zod'
import { defineTool, errorResult } from './framework'
import { pageUrl } from './page-utils'

export const navigate = defineTool({
  name: 'navigate',
  description:
    'Navigate a page: load a url, or go back/forward/reload. Returns a fresh snapshot of the resulting page (navigation invalidates refs, so old [ref=eN] handles no longer apply).',
  input: z.object({
    page: z.number().int().describe('Page id from `tabs`.'),
    action: z.enum(['url', 'back', 'forward', 'reload']).default('url'),
    url: z.string().optional().describe('Required when action is "url".'),
  }).strict(),
  annotations: {
    title: 'Navigate page',
    destructiveHint: true,
  },
  handler: async (args, ctx, response) => {
    const page = await ctx.pageFor(args.page)
    switch (args.action) {
      case 'url':
        if (!args.url)
          return errorResult('navigate: url is required for action="url".')
        await page.goto(args.url)
        break
      case 'back':
        await page.cdp('Page.goBack')
        break
      case 'forward':
        await page.cdp('Page.goForward')
        break
      case 'reload':
        await page.cdp('Page.reload', { ignoreCache: false })
        break
    }

    const origin = await pageUrl(page, args.page)
    response.text(`navigated (${args.action}) -> ${origin}`)
    response.data({ page: args.page, url: origin })
    response.includeSnapshot(args.page)
    return undefined
  },
})
