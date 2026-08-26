import { z } from 'zod'
import { defineTool, errorResult } from './framework'
import type { ToolContext, ToolResult } from './framework'
import { gatewayFromPage } from '../../../space/task-space-manager.js'

const DEFAULT_SCREENSHOT_FORMAT = 'jpeg'
const DEFAULT_SCREENSHOT_QUALITY = 80
const DEFAULT_SCREENSHOT_SIZE = { width: 1024, height: 768 } as const
const screenshotFormat = z.enum(['jpeg', 'png', 'webp'])
const screenshotSize = z.object({
  width: z.number().int().positive().max(4096).default(1024),
  height: z.number().int().positive().max(4096).default(768),
}).strict()

type ScreenshotFormat = z.infer<typeof screenshotFormat>
type ScreenshotSize = z.infer<typeof screenshotSize>

function screenshotQuality(format: ScreenshotFormat, quality?: number) {
  if (format !== 'jpeg') return undefined
  return quality ?? DEFAULT_SCREENSHOT_QUALITY
}

const MIME_BY_FORMAT: Record<ScreenshotFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** Existing actionable hint, kept byte-for-byte for agents that parse it. */
const WEDGED_HINT =
  '[hint: tab-wedged -> open a fresh tab via space.open_tab or tabs new, then retry]'

type ScreenshotArgs = {
  page: number
  format: ScreenshotFormat
  quality?: number
  size?: ScreenshotSize
  fullPage?: boolean
  annotate?: boolean
  canary: boolean
  onWedged: 'hint' | 'auto-recycle'
}

function successResult(
  args: ScreenshotArgs,
  data: string,
  pageId: number,
  recycled?: { spaceId: string; fromPage: number; page: number; recycled: number },
): ToolResult {
  return {
    content: [
      { type: 'image', data, mimeType: MIME_BY_FORMAT[args.format] },
    ],
    structuredContent: {
      page: pageId,
      format: args.format,
      bytes: Buffer.from(data, 'base64').length,
      ...(args.annotate && { annotations: [] }),
      ...(recycled ? { recycled } : {}),
    },
  }
}

/**
 * TabFreshness wedge handling (2026-08-03): the canary (or a real screenshot
 * failure flagged via page.isScreenshotWedged()) detected a wedged capture
 * pipeline on this tab.
 *
 *  - 'hint' (default): return the actionable tab-wedged error.
 *  - 'auto-recycle' (OPT-IN): when the ctx carries spaces/identity, recycle
 *    the page's task space (close every tab, reopen each URL fresh) and retry
 *    the screenshot once on the fresh tab. When the wiring is missing (no
 *    spaces/identity, page not in a space, or recycle fails) it degrades back
 *    to the hint.
 */
async function handleWedged(opts: {
  error: unknown
  args: ScreenshotArgs
  ctx: ToolContext
  sized: {
    format: 'png' | 'jpeg'
    quality?: number
    fullPage: boolean
    annotate: boolean
    width?: number
    height?: number
  }
}): Promise<ToolResult> {
  const detail = opts.error instanceof Error ? opts.error.message : String(opts.error)
  const hint = `screenshot failed: ${detail} ${WEDGED_HINT}`
  if (opts.args.onWedged !== 'auto-recycle') return errorResult(hint)
  if (!opts.ctx.spaces || !opts.ctx.identity) {
    return errorResult(
      `${hint} (auto-recycle skipped: this server has no task-space wiring)`,
    )
  }
  try {
    const manager = opts.ctx.spaces
    const spaceId = await manager.spaceIdForPage(opts.args.page)
    if (!spaceId) {
      return errorResult(
        `${hint} (auto-recycle skipped: page ${opts.args.page} is not attributed to a task space)`,
      )
    }
    const result = await manager.recycleSpaceTabs(
      opts.ctx.identity.agentId,
      spaceId,
      gatewayFromPage(opts.ctx.page),
    )
    const match = result.tabs.find((t) => t.oldPageId === opts.args.page)
    if (!match) {
      return errorResult(
        `${hint} (auto-recycle failed: recycled space ${spaceId} but could not map a fresh tab for page ${opts.args.page})`,
      )
    }
    // Retry exactly once on the fresh tab.
    const fresh = await opts.ctx.pageFor(match.newPageId)
    const data = opts.args.annotate
      ? await fresh.annotatedScreenshot(opts.sized)
      : await fresh.screenshot(opts.sized)
    return successResult(opts.args, data, match.newPageId, {
      spaceId,
      fromPage: opts.args.page,
      page: match.newPageId,
      recycled: result.recycled,
    })
  } catch (recycleErr) {
    return errorResult(
      `${hint} (auto-recycle failed: ${
        recycleErr instanceof Error ? recycleErr.message : String(recycleErr)
      })`,
    )
  }
}

export const screenshot = defineTool({
  name: 'screenshot',
  description:
    'Capture a screenshot of the page, returned inline. Defaults to JPEG quality 80 around 1024x768; prefer snapshot for structure/actions. Before capturing, a tiny 16x16 canary screenshot probes the capture pipeline so a wedged tab is reported immediately (onWedged controls the follow-up: hint by default, opt-in auto-recycle).',
  input: z.object({
    page: z.number().int(),
    format: screenshotFormat.default(DEFAULT_SCREENSHOT_FORMAT),
    quality: z.number().int().min(0).max(100).optional(),
    size: screenshotSize
      .optional()
      .describe('Max viewport capture size. Defaults to 1024x768.'),
    fullPage: z.boolean().optional().describe('Capture beyond the viewport.'),
    annotate: z
      .boolean()
      .optional()
      .describe('Overlay numbered refs from a fresh snapshot. Defaults false.'),
    canary: z
      .boolean()
      .default(true)
      .describe(
        'Probe the capture pipeline with a 16x16 clip before capturing (default true). A wedged tab is detected in ~ms instead of waiting for a real screenshot timeout.',
      ),
    onWedged: z
      .enum(['hint', 'auto-recycle'])
      .default('hint')
      .describe(
        'What to do when the canary detects a wedged capture pipeline: hint (default) returns the actionable tab-wedged error; auto-recycle (opt-in) closes this page\u2019s task space and reopens every URL in a fresh tab, then retries the screenshot once on the fresh tab.',
      ),
  }).strict(),
  annotations: { title: 'Take screenshot', readOnlyHint: true },
  handler: async (args, ctx) => {
    // defineTool types args via zod's input type (defaults optional); executeTool
    // has already applied them via safeParse, so the values are present at runtime.
    const a = args as unknown as ScreenshotArgs
    const page = await ctx.pageFor(a.page)
    const fullPage = a.fullPage ?? false
    const annotate = a.annotate ?? false
    const size = a.size ?? DEFAULT_SCREENSHOT_SIZE
    const quality = screenshotQuality(a.format, a.quality)

    // UnifiedPage.screenshot drives the same CdpBackend; annotate uses the
    // OpenCLI visual-ref overlay (UnifiedPage.annotatedScreenshot).
    const common = {
      format: a.format as 'png' | 'jpeg',
      quality,
      fullPage,
      annotate,
    }
    const sized = {
      ...common,
      ...(fullPage ? {} : { width: size.width, height: size.height }),
    }

    // TabFreshness canary — screenshot BEFORE the real capture. A wedged tab
    // answers a 16x16 clip with the same hang as a full screenshot, so this
    // detects the wedge in 2.5s max (usually a few ms on a healthy tab) instead
    // of burning the full 5s real-screenshot budget first.
    if (a.canary !== false) {
      try {
        await page.canaryCapture()
      } catch (err) {
        return handleWedged({ error: err, args: a, ctx, sized })
      }
    }

    let data: string
    try {
      data = annotate
        ? await page.annotatedScreenshot(sized)
        : await page.screenshot(sized)
    } catch (err) {
      // Per-tab capture-pipeline wedge: give the agent an actionable hint instead
      // of a bare timeout (verified 2026-08-03 — reload does not recover it).
      // With canary on this is a backstop (the canary catches wedges first);
      // with canary:false it is the only wedge detection path.
      if (typeof page.isScreenshotWedged === 'function' && page.isScreenshotWedged()) {
        return handleWedged({ error: err, args: a, ctx, sized })
      }
      throw err
    }

    return successResult(a, data, a.page)
  },
})
