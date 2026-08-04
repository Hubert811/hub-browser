import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_LIMITS } from '@browseros/shared/constants/limits'
import { evaluate } from './evaluate'
import { executeTool } from './framework'
import { makeContext, pageFromSession, textOf } from './test-helpers'
import { wrapUntrusted } from './trust-boundary'

function sessionWithEvaluateValue(value: unknown): unknown {
  return {
    pages: {
      list: async () => [
        {
          pageId: 3,
          targetId: 'target-3',
          url: 'https://example.com/evaluate',
          title: 'Evaluate',
        },
      ],
      getSession: async () => ({
        session: {
          Runtime: {
            evaluate: async () => ({ result: { value } }),
          },
        },
        sessionId: 's1',
      }),
      getInfo: () => ({ url: 'https://example.com/evaluate' }),
    },
    dispose: async () => {},
  }
}

async function withBrowserosDir<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.BROWSEROS_DIR
  const browserosDir = mkdtempSync(join(tmpdir(), 'evaluate-test-'))
  process.env.BROWSEROS_DIR = browserosDir
  try {
    return await run()
  } finally {
    restoreBrowserosDir(previous)
    rmSync(browserosDir, { recursive: true, force: true })
  }
}

async function withOutputWriteFailure<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.BROWSEROS_DIR
  const browserosDir = mkdtempSync(join(tmpdir(), 'evaluate-fail-'))
  const filePath = join(browserosDir, 'not-a-directory')
  writeFileSync(filePath, 'x')
  process.env.BROWSEROS_DIR = filePath
  try {
    return await run()
  } finally {
    restoreBrowserosDir(previous)
    rmSync(browserosDir, { recursive: true, force: true })
  }
}

function restoreBrowserosDir(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.BROWSEROS_DIR
  } else {
    process.env.BROWSEROS_DIR = previous
  }
}

describe('evaluate tool', () => {
  it('keeps small values inline with the existing structured value', async () => {
    const page = pageFromSession(sessionWithEvaluateValue('page-value'))
    const result = await executeTool(
      evaluate,
      { page: 3, code: 'return document.title' },
      makeContext(page),
    )

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ page: 3, value: 'page-value' })
    expect(textOf(result)).toContain('page-value')
  })

  it('spills huge string results and omits structured value', async () => {
    await withBrowserosDir(async () => {
      const tail = 'tail-marker'
      const value = `${'x'.repeat(TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS + 1)}${tail}`
      const page = pageFromSession(sessionWithEvaluateValue(value))
      const result = await executeTool(
        evaluate,
        { page: 3, code: 'return document.documentElement.outerHTML' },
        makeContext(page),
      )
      const data = result.structuredContent as
        | {
            page: number
            contentLength: number
            writtenToFile: boolean
            path: string
            value?: unknown
          }
        | undefined
      const text = textOf(result)

      expect(result.isError).toBeFalsy()
      expect(data).toMatchObject({
        page: 3,
        writtenToFile: true,
      })
      const path = data?.path
      expect(typeof path).toBe('string')
      if (typeof path !== 'string') throw new Error('expected output path')
      expect(data).not.toHaveProperty('value')
      expect(path.endsWith('.txt')).toBe(true)
      expect(text).toContain(path)
      expect(text).not.toContain(tail)
      const savedContent = readFileSync(path, 'utf8')
      expect(savedContent).toContain(tail)
      expect(data?.contentLength).toBe(savedContent.length)
    })
  })

  it('spills huge object results to a text output file', async () => {
    await withBrowserosDir(async () => {
      const value = {
        html: 'x'.repeat(TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS + 1),
      }
      const page = pageFromSession(sessionWithEvaluateValue(value))
      const result = await executeTool(
        evaluate,
        { page: 3, code: 'return window.__largeObject' },
        makeContext(page),
      )
      const data = result.structuredContent as
        | {
            contentLength: number
            writtenToFile: boolean
            path: string
            value?: unknown
          }
        | undefined

      expect(result.isError).toBeFalsy()
      expect(data).toMatchObject({
        writtenToFile: true,
      })
      const path = data?.path
      expect(typeof path).toBe('string')
      if (typeof path !== 'string') throw new Error('expected output path')
      expect(data).not.toHaveProperty('value')
      expect(path.endsWith('.txt')).toBe(true)
      const savedContent = readFileSync(path, 'utf8')
      expect(savedContent).toContain('"html"')
      expect(data?.contentLength).toBe(savedContent.length)
    })
  })

  it('returns metadata-only structured content when large result writes fail', async () => {
    await withOutputWriteFailure(async () => {
      const value = 'x'.repeat(TOOL_LIMITS.INLINE_PAGE_CONTENT_MAX_CHARS + 1)
      const page = pageFromSession(sessionWithEvaluateValue(value))
      const result = await executeTool(
        evaluate,
        { page: 3, code: 'return document.body.innerText' },
        makeContext(page),
      )

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        page: 3,
        contentLength: wrapUntrusted(value, 'https://example.com/evaluate')
          .length,
        writtenToFile: false,
        outputWriteFailed: true,
        error: expect.any(String),
      })
      expect(result.structuredContent).not.toHaveProperty('value')
      expect(textOf(result)).toContain('could not be saved')
    })
  })
})
