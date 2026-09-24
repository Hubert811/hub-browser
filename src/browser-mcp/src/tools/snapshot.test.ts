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
    snapshot: (async (opts?: { source?: string }) => {
      calls.push(opts)
      return opts?.source === 'dom'
        ? '<dom> body > div#main </dom>'
        : '[ref=e1] button "Go"'
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

  it('default call captures the viewport (P7-B S1) and echoes the scope', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1 }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([{ scope: 'viewport' }])
    expect(textOf(result)).toContain('[ref=e1]')
    expect(
      (result as { structuredContent?: { source?: string } }).structuredContent?.source,
    ).toBeUndefined()
    expect(
      (result as { structuredContent?: { scope?: string } }).structuredContent?.scope,
    ).toBe('viewport')
  })

  it('explicit source=ax keeps the AX path but echoes the source', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1, source: 'ax' }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([{ scope: 'viewport' }])
    expect(
      (result as { structuredContent?: { source?: string } }).structuredContent?.source,
    ).toBe('ax')
  })

  it('scope=full_page keeps the legacy no-opts path and echoes the scope', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1, scope: 'full_page' }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([undefined])
    expect(
      (result as { structuredContent?: { scope?: string } }).structuredContent?.scope,
    ).toBe('full_page')
  })
})

describe('snapshot tool root focus (P7-B S2)', () => {
  it('root requests a subtree capture and echoes the root', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1, root: 'e7' }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([{ scope: 'viewport', root: 'e7' }])
    expect(
      (result as { structuredContent?: { root?: string } }).structuredContent?.root,
    ).toBe('e7')
  })

  it('root combines with compact in one call', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(
      snapshot,
      { page: 1, root: 'e7', compact: true },
      makeContext(snapshotRecorder(calls)),
    )
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([{ compact: true, scope: 'viewport', root: 'e7' }])
  })

  it('omitting root leaves the compact-only call untouched', async () => {
    const calls: Array<unknown | undefined> = []
    await executeTool(snapshot, { page: 1, compact: true }, makeContext(snapshotRecorder(calls)))
    expect(calls).toEqual([{ compact: true, scope: 'viewport' }])
  })
})

describe('snapshot tool root focus (P7-B S2)', () => {
  it('root requests a subtree capture and echoes the root', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(snapshot, { page: 1, root: 'e7' }, makeContext(snapshotRecorder(calls)))
    expect(result?.isError).not.toBe(true)
    // P7-B S1 made `scope` default to viewport, so it rides on every call.
    expect(calls).toEqual([{ root: 'e7', scope: 'viewport' }])
    expect(
      (result as { structuredContent?: { root?: string } }).structuredContent?.root,
    ).toBe('e7')
  })

  it('root combines with compact in one call', async () => {
    const calls: Array<unknown | undefined> = []
    const result = await executeTool(
      snapshot,
      { page: 1, root: 'e7', compact: true },
      makeContext(snapshotRecorder(calls)),
    )
    expect(result?.isError).not.toBe(true)
    expect(calls).toEqual([{ compact: true, root: 'e7', scope: 'viewport' }])
  })

  it('omitting root leaves the rest of the call untouched', async () => {
    const calls: Array<unknown | undefined> = []
    await executeTool(snapshot, { page: 1, compact: true }, makeContext(snapshotRecorder(calls)))
    expect(calls).toEqual([{ compact: true, scope: 'viewport' }])
  })
})
