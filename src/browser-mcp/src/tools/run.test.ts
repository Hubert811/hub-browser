/**
 * P0-1 — run sandbox (worker_threads) tests.
 *
 * The headline case: a synchronous `while (true) {}` used to freeze the
 * whole daemon under the old `new AsyncFunction` + Promise.race design.
 * Now the script runs in a worker and `terminate()` kills it at timeout —
 * these tests completing at all (instead of hanging) is the assertion.
 */
import { describe, expect, it } from 'bun:test'
import { executeTool } from './framework'
import { run } from './run'
import { createFakePage, makeContext } from './test-helpers'
import type { ToolContext } from './framework'

function ctxFor(page: ReturnType<typeof createFakePage>): ToolContext {
  return makeContext(page)
}

function textOf(result: { content?: unknown } | undefined): string {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
}

async function runCode(
  code: string,
  timeout?: number,
  page: ReturnType<typeof createFakePage> = createFakePage(),
) {
  const result = await executeTool(run, { code, ...(timeout && { timeout }) }, ctxFor(page))
  return {
    text: textOf(result),
    isError: result?.isError === true,
    structured: (result as { structuredContent?: any } | undefined)?.structuredContent,
  }
}

describe('run sandbox (worker_threads)', () => {
  it('kills a synchronous infinite loop at timeout without freezing the host', async () => {
    const t0 = Date.now()
    const out = await runCode(
      `
        console.log('entering loop')
        while (true) { /* spin */ }
        return 'never'
      `,
      800,
    )
    const elapsed = Date.now() - t0

    expect(out.isError).toBe(true)
    expect(out.text).toContain('exceeded 800ms')
    // The console line emitted right before the loop still arrived.
    expect(out.structured?.logs).toContain('entering loop')
    // Terminated well before the 30s bun test timeout would kick in.
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)

  it('returns the script value on success', async () => {
    const out = await runCode(`const x = 21; return x * 2`)
    expect(out.isError).toBe(false)
    expect(out.structured?.ok).toBe(true)
    expect(out.structured?.value).toBe(42)
  })

  it('bridges console output in FIFO order with level prefixes', async () => {
    const out = await runCode(`
      console.log('first')
      console.warn('second')
      console.error('third')
      return 1
    `)
    expect(out.structured?.logs).toEqual(['first', 'warn: second', 'error: third'])
  })

  it('reports runtime errors as structured failures, not thrown ones', async () => {
    const out = await runCode(`throw new Error('boom')`)
    expect(out.isError).toBe(true)
    expect(out.structured?.ok).toBe(false)
    expect(out.structured?.error).toContain('boom')
  })

  it('syntax errors are caught before the worker starts', async () => {
    const out = await runCode(`this is not (valid javascript`)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('syntax error')
  })

  it('bridges SDK calls to the main-thread browser object', async () => {
    const page = createFakePage({
      tabs: async () => [{ pageId: 1, title: 'one' }, { pageId: 2, title: 'two' }] as never,
    })
    const out = await runCode(`return await browser.pages.list()`, undefined, page)
    expect(out.isError).toBe(false)
    expect(out.structured?.value).toEqual([
      { pageId: 1, title: 'one' },
      { pageId: 2, title: 'two' },
    ])
  })

  it('resolves chained SDK calls (observe(pageId).snapshot())', async () => {
    const page = createFakePage({
      snapshot: async () => '[ref=e1] button "Go"' as never,
    })
    const out = await runCode(
      `const snap = await browser.observe(1).snapshot(); return snap.text`,
      undefined,
      page,
    )
    expect(out.isError).toBe(false)
    expect(out.structured?.value).toContain('button "Go"')
  })

  it('unknown properties on the bridge are plain undefined, not crashes', async () => {
    const out = await runCode(`return typeof browser.nope`)
    expect(out.isError).toBe(false)
    expect(out.structured?.value).toBe('undefined')
  })

  it('recovers after a terminated run (worker lifecycle is per-call)', async () => {
    await runCode(`while (true) { }`, 300)
    const out = await runCode(`return 'alive'`)
    expect(out.isError).toBe(false)
    expect(out.structured?.value).toBe('alive')
  }, 20_000)

  it('aborting the tool signal terminates the worker promptly', async () => {
    const controller = new AbortController()
    const ctx = { ...makeContext(createFakePage()), signal: controller.signal }
    const t0 = Date.now()
    const promise = executeTool(
      run,
      { code: `while (true) { }`, timeout: 10_000 },
      ctx,
    )
    // Abort well before the 10s timeout: the worker must be terminated by
    // the abort (not linger until the timeout fires).
    setTimeout(() => controller.abort(), 300)
    await expect(promise).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})
