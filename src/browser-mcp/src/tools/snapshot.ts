import { z } from 'zod'
import { defineTool, textResult } from './framework'
import { pageUrl } from './page-utils'
import { formatSnapshotResult } from './snapshot-format'

export const snapshot = defineTool({
  name: 'snapshot',
  description:
    'Capture the page as an indented accessibility tree. Each actionable element carries a stable [ref=eN] you pass to `act`. Iframe content is stitched in inline. Re-snapshot after navigation or large changes (refs are invalidated). This is the start of the loop: snapshot -> act -> (reads back a diff).',
  input: z.object({
    page: z.number().int().describe('Page id from `tabs` or `navigate`.'),
  }),
  annotations: { title: 'Snapshot accessibility tree', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const text = (await page.snapshot()) as string
    const origin = await pageUrl(page, args.page)
    const formatted = await formatSnapshotResult(text, origin)
    return textResult(formatted.text, {
      page: args.page,
      ...formatted.structured,
    })
  },
})
