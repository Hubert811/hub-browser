import { z } from 'zod'
import { defineTool, textResult } from './framework'
import { pageUrl } from './page-utils'
import { formatSnapshotResult } from './snapshot-format'

export const snapshot = defineTool({
  name: 'snapshot',
  description:
    "Capture the page as an indented accessibility tree. Each actionable element carries a stable [ref=eN] you pass to `act`. Iframe content is stitched in inline. Re-snapshot after navigation or large changes (refs are invalidated). This is the start of the loop: snapshot -> act -> (reads back a diff). Pass source=dom for a DOM-structure snapshot (element tree with tag/id/class instead of AX roles) — useful to explore page structure; refs come from the default AX snapshot.",
  input: z.object({
    page: z.number().int().describe('Page id from `tabs` or `navigate`.'),
    source: z
      .enum(['ax', 'dom'])
      .optional()
      .describe(
        'Snapshot backend: ax (default — accessibility tree with [ref=eN]) or dom (DOM-structure view of the page).',
      ),
    compact: z
      .boolean()
      .optional()
      .describe(
        'Bug #27: compact the snapshot text — strip [ref=eN] annotations and collapse whitespace (cheap assertion view; refs minted by the capture stay valid for `act`).',
      ),
  }).strict(),
  annotations: { title: 'Snapshot accessibility tree', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    // P2-5 — source:'dom' routes UnifiedPage.snapshot to the DOM backend;
    // the default (ax) call passes no opts, preserving the legacy path.
    const text = (await page.snapshot(
      args.source === 'dom' || args.compact
        ? {
            ...(args.source === 'dom' && { source: 'dom' as const }),
            ...(args.compact && { compact: true }),
          }
        : undefined,
    )) as string
    const origin = await pageUrl(page, args.page)
    const formatted = await formatSnapshotResult(text, origin)
    return textResult(formatted.text, {
      page: args.page,
      ...(args.source && { source: args.source }),
      ...formatted.structured,
    })
  },
})
