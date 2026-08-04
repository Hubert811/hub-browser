import { TOOL_LIMITS } from '@browseros/shared/constants/limits'
import { z } from 'zod'
import { clampTimeout, defineTool, errorResult, textResult } from './framework'
import { writeTempToolOutputFile } from './output-file'
import { pageUrl } from './page-utils'
import { wrapUntrusted } from './trust-boundary'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 30_000

const DESCRIPTION = `Evaluate JavaScript in a page context through CDP Runtime.evaluate. Use this for page-state reads or small DOM scripts that are awkward with read/grep. Return a value to read it back.`

export const evaluate = defineTool({
  name: 'evaluate',
  description: DESCRIPTION,
  input: z.object({
    page: z.number().int().describe('Page id from `tabs`.'),
    code: z
      .string()
      .describe(
        'Async-capable JS body evaluated inside the page. Use `return` to read a value.',
      ),
    timeout: z
      .number()
      .optional()
      .describe('Max evaluation time in ms (default 30000).'),
  }),
  annotations: {
    title: 'Run JavaScript in page',
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const page = await ctx.pageFor(args.page)
    const timeout = clampTimeout(
      args.timeout,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    let value: unknown
    try {
      value = await withTimeout(
        page.evaluate(`(async () => {\n${args.code}\n})()`),
        timeout,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResult(`evaluate: ${message.replace(/^Evaluate:\s*/, '')}`)
    }

    const text = value === undefined ? 'undefined' : safeStringify(value)
    const origin = await pageUrl(page, args.page)
    if (text.length > TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS) {
      const excerpt = text.slice(0, TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS)
      const wrappedText = wrapUntrusted(text, origin)
      const contentLength = wrappedText.length
      try {
        const path = await writeTempToolOutputFile({
          toolName: 'evaluate',
          extension: 'txt',
          content: wrappedText,
        })
        return textResult(
          [
            wrapUntrusted(excerpt, origin),
            `Evaluate result truncated at ${TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS} chars. Full result (${text.length} chars) saved to: ${path}`,
          ].join('\n\n'),
          {
            page: args.page,
            contentLength,
            writtenToFile: true,
            path,
          },
        )
      } catch (error) {
        const saveError = error instanceof Error ? error.message : String(error)
        return textResult(
          [
            wrapUntrusted(excerpt, origin),
            `Evaluate result truncated at ${TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS} chars. Full result (${text.length} chars) could not be saved to a BrowserOS output file: ${saveError}`,
          ].join('\n\n'),
          {
            page: args.page,
            contentLength,
            writtenToFile: false,
            outputWriteFailed: true,
            error: saveError,
          },
        )
      }
    }

    return textResult(wrapUntrusted(text, origin), {
      page: args.page,
      value,
    })
  },
})

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`evaluate exceeded ${timeoutMs}ms`)),
      timeoutMs,
    )
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
