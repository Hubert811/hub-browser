/**
 * P2-5 — the snapshot tool exposes the `source` parameter: 'dom' routes
 * UnifiedPage.snapshot to the DOM backend ({source:'dom'}), while the
 * default and explicit 'ax' keep the legacy no-opts call. The structured
 * result echoes the requested source.
 */
import { describe, expect, it } from 'bun:test'
import { executeTool } from './framework'
import { snapshot } from './snapshot'
import { createFakePage, makeContext, textOf } from './test-helpers'

function snapshotRecorder(calls: Array<unknown | undefined>) {
  return createFakePage({
    snapshot: (async (opts?: unknown) => {
      calls.push(opts)
      return opts ? '<dom> body > div#main </dom>' : '[ref=e1] button "Go"'
    }) as never,
  })
}

describe('snapshot tool source parameter (P2-5)', () => {
  it('source=dom requests the DOM backend and echoes the source', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1, source: 'dom' }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([{ source: 'dom' }])
    expect(textOf(result)).toContain('<dom>')
    expect(
      (result as { structuredContent?: { source?: string } }).structuredContent?.source,
    ).toBe('dom')
  })

  it('default call keeps the legacy no-opts path', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1 }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([undefined])
    expect(textOf(result)).toContain('[ref=e1]')
    expect(
      (result as { structuredContent?: { source?: string } }).structuredContent?.source,
    ).toBeUndefined()
  })

  it('explicit source=ax keeps the legacy path but echoes the source', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1, source: 'ax' }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([undefined])
    expect(
      (result as { structuredContent?: { source?: string } }).structuredContent?.source,
    ).toBe('ax')
  })
})
