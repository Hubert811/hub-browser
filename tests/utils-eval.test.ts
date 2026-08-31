/**
 * F14 — the replMode decision for browser eval: does the expression, AFTER
 * buildEvaluateExpression wrapping, still contain `await` at bracket depth 0?
 * That is exactly the condition where plain Runtime.evaluate throws
 * "await is only valid in async functions" and the evaluation needs
 * `replMode: true` (the DevTools-console mechanism).
 */
import { describe, expect, test } from 'bun:test'
import { buildEvaluateExpression, hasTopLevelAwait } from '../src/opencli/utils.ts'

/** What page.ts asks before every Runtime.evaluate. */
function needsReplMode(js: string): boolean {
  return hasTopLevelAwait(buildEvaluateExpression(js, []))
}

describe('F14 top-level await detection (post-wrap)', () => {
  test('top-level await forms need replMode', () => {
    expect(needsReplMode('await Promise.resolve(42)')).toBe(true)
    expect(needsReplMode('const r = await fetch("/x"); r.status')).toBe(true)
    expect(needsReplMode('for await (const x of gen()) count++')).toBe(true)
    expect(needsReplMode('let a = 1; await f(a); a + 1')).toBe(true)
  })

  test('async contexts already wrapped by buildEvaluateExpression do not', () => {
    expect(needsReplMode('(async () => { await f() })()')).toBe(false)
    expect(needsReplMode('async () => await f()')).toBe(false)
    expect(needsReplMode('arr.map(async x => await f(x))')).toBe(false)
    expect(needsReplMode('new Promise(async r => { await f(); r() })')).toBe(false)
    expect(needsReplMode('Promise.resolve(42)')).toBe(false)
    expect(needsReplMode('new Promise(r => setTimeout(() => r(1), 100))')).toBe(false)
  })

  test('await inside strings, templates and comments never counts', () => {
    expect(needsReplMode('"await"')).toBe(false)
    expect(needsReplMode("'await f()'")).toBe(false)
    expect(needsReplMode('// await f()\n1 + 1')).toBe(false)
    expect(needsReplMode('/* await f() */ 1')).toBe(false)
    expect(needsReplMode('`await ${1 + 1}`')).toBe(false)
    expect(needsReplMode('`x${await f()}`')).toBe(false)
  })

  test('await after a closing bracket returns to depth 0', () => {
    expect(needsReplMode('[1,2].map(x => x); await f()')).toBe(true)
    expect(needsReplMode('const xs = [1, 2]; await Promise.all(xs.map(f))')).toBe(true)
  })

  test('escape sequences inside strings do not leak the scanner', () => {
    expect(needsReplMode(String.raw`"a \" await b" `)).toBe(false)
    expect(needsReplMode(String.raw`'it\'s awaiting'`)).toBe(false)
  })

  test('raw scanner: an unwrapped expression-bodied arrow reports await at depth 0 (harmless — production always wraps it first)', () => {
    expect(hasTopLevelAwait('async () => await f()')).toBe(true)
  })
})
