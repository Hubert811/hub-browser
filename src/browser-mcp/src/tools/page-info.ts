import { z } from 'zod'
import { defineTool, errorResult, textResult } from './framework'
// Engine bridge (plain JS; types from src/opencli-engine-modules.d.ts). The
// extract pipeline (HTML → markdown → paragraph-aware chunking) is the shared
// single implementation the CLI `browser extract` command already runs — the
// tool wraps the same functions so both faces extract identically.
import {
  buildExtractHtmlJs,
  runExtractFromHtml,
} from '../../../opencli-engine/browser/extract.js'

const DEFAULT_CHUNK_SIZE = 20000

/**
 * P2-6 (batch 1) — page-info tools: capabilities the CLI had but the MCP
 * surface lacked. `frames` lists cross-origin iframe targets (the index feeds
 * evaluate's frame targeting), `extract` is the agent's long-page reader:
 * denoise → markdown → paragraph-aware chunking with a `next_start_char`
 * cursor, so an agent walks a long page chunk by chunk instead of juggling
 * selectors. Both were CLI-only direct implementations; toolifying them puts
 * the CLI commands behind the same executeTool gate (guard + audit) and gives
 * MCP clients the same ability from one definition.
 */
export const frames = defineTool({
  name: 'frames',
  description:
    'List cross-origin iframe targets on the page in snapshot order. Each entry carries a target id and URL; pass the 0-based index to evaluate\'s frame option to run JS inside that frame.',
  input: z
    .object({
      page: z.number().int(),
    })
    .strict(),
  annotations: { title: 'List cross-origin frames', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const frames = (await page.frames?.()) ?? []
    if (frames.length === 0) {
      return textResult('(no cross-origin frames)', { frames: [], count: 0 })
    }
    const lines = [`Cross-origin frames (${frames.length}):`, '']
    frames.forEach((frame: unknown, i: number) => {
      const f = frame as { url?: string; targetId?: string }
      lines.push(`- [${i}] ${f.url ?? '(unknown url)'} (target ${f.targetId ?? '?'})`)
    })
    return textResult(lines.join('\n'), { frames, count: frames.length })
  },
})

export const extract = defineTool({
  name: 'extract',
  description:
    'Extract page content as markdown with paragraph-aware chunking for long pages. Returns an envelope with content, start/end offsets, total_chars and next_start_char — pass next_start_char back as start to continue reading. Denoised (ads/nav stripped) unlike raw read.',
  input: z
    .object({
      page: z.number().int(),
      selector: z
        .string()
        .optional()
        .describe('CSS selector scope; defaults to <main>/<article>/<body>.'),
      chunkSize: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_CHUNK_SIZE)
        .describe('Target chunk size in chars (default 20000).'),
      start: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe('Start offset (use next_start_char from a previous extract).'),
    })
    .strict(),
  annotations: { title: 'Extract page content (chunked)', readOnlyHint: true },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const res = (await page.evaluate(buildExtractHtmlJs(args.selector ?? null))) as
      | { html: string; url: string; title: string }
      | { invalidSelector: true; reason: string }
      | { notFound: true }
      | null

    if (!res) {
      return errorResult('extract: page returned no root element.')
    }
    if ('invalidSelector' in res) {
      return errorResult(
        `extract: selector "${args.selector ?? ''}" is not valid CSS: ${res.reason}`,
      )
    }
    if ('notFound' in res) {
      return errorResult(
        args.selector
          ? `extract: selector "${args.selector}" matched 0 elements.`
          : 'extract: page has no body/main/article element.',
      )
    }

    const envelope = runExtractFromHtml({
      html: res.html,
      url: res.url,
      title: res.title,
      selector: args.selector ?? null,
      start: args.start,
      chunkSize: args.chunkSize,
    })
    const more = envelope.next_start_char !== null
    const text = [
      `# ${envelope.title || '(untitled)'}`,
      envelope.url,
      '',
      envelope.content,
      '',
      more
        ? `[chunk ${envelope.start}-${envelope.end} of ${envelope.total_chars} chars — call again with start=${envelope.next_start_char} for the next chunk]`
        : `[complete: ${envelope.total_chars} chars]`,
    ].join('\n')
    return textResult(text, envelope)
  },
})

export const PAGE_INFO_TOOLS = [frames, extract] as const
