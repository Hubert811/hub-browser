import type { SnapshotDiff } from '@browseros/browser-core/core/snapshot/diff'
import { z } from 'zod'
import { formatDiffResult } from './diff-format'
import { defineTool, textResult } from './framework'
import { pageUrl } from './page-utils'

export const diff = defineTool({
  name: 'diff',
  description:
    "Show what changed on the page since the last snapshot/diff - a cheap way to see an action's effect without re-dumping the whole tree.",
  input: z.object({ page: z.number().int() }),
  annotations: { title: 'Diff page state', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const d = (await page.diff()) as SnapshotDiff
    const origin = d.afterUrl ?? (await pageUrl(page, args.page))
    const formatted = await formatDiffResult(d, origin)
    return textResult(formatted.text, formatted.structured)
  },
})
