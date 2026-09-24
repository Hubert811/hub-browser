import { z } from 'zod'
import { defineTool, textResult } from './framework'
import { pageUrl } from './page-utils'
import { formatSnapshotResult } from './snapshot-format'

export const snapshot = defineTool({
  name: 'snapshot',
  description:
    "Capture the page as an indented accessibility tree. Each actionable element carries a stable [ref=eN] you pass to `act`. Iframe content is stitched in inline. Re-snapshot after navigation or large changes (refs are invalidated). This is the start of the loop: snapshot -> act -> (reads back a diff). Captures the current viewport by default (scope=viewport): off-screen elements have no ref, so scroll and re-snapshot or pass scope=full_page for the whole document. Pass source=dom for a DOM-structure snapshot (element tree with tag/id/class instead of AX roles) — useful to explore page structure; refs come from the default AX snapshot.",
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
    root: z
      .string()
      .optional()
      .describe(
        'Focus on the subtree rooted at this ref (from the previous snapshot) instead of the whole page — cheaper on iframe-heavy pages. Refs outside that subtree go stale until the next full snapshot. AX backend only.',
      ),
    scope: z
      .enum(['viewport', 'full_page'])
      .optional()
      .describe(
        'What to capture: viewport (default — elements in view now) or full_page (the whole document, including off-screen content and the frames below the fold). Off-screen elements have no ref in a viewport snapshot; scroll and re-snapshot, or ask for full_page.',
      ),
  }).strict(),
  annotations: { title: 'Snapshot accessibility tree', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    // P7-B S1 — the agent-facing surface defaults to a viewport capture (token
    // cost); UnifiedPage.snapshot itself still defaults to full_page so internal
    // callers (act anchors, grep, post-action readback, adapter dumps) are unchanged.
    // Scoping is AX-only: the DOM backend keeps its own viewportExpand semantics.
    const scope = args.source === 'dom' ? undefined : (args.scope ?? 'viewport')
    const hasOpts =
      args.source === 'dom' ||
      args.compact ||
      args.root !== undefined ||
      scope === 'viewport'
    const text = (await page.snapshot(
      hasOpts
        ? {
            ...(args.source === 'dom' && { source: 'dom' as const }),
            ...(args.compact && { compact: true }),
            ...(args.root !== undefined && { root: args.root }),
            ...(scope === 'viewport' && { scope }),
          }
        : undefined,
    )) as string
    const origin = await pageUrl(page, args.page)
    const formatted = await formatSnapshotResult(text, origin)
    return textResult(formatted.text, {
      page: args.page,
      ...(scope !== undefined && { scope }),
      ...(args.source && { source: args.source }),
      ...(args.root !== undefined && { root: args.root }),
      ...formatted.structured,
    })
  },
})
