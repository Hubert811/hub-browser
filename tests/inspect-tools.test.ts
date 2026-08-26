/**
 * P3-5 — probe tools (`inspect`): deep-dive one snapshot ref into full DOM
 * detail via the vendored Observer's inspectRef channel. Tool-level tests
 * stub the channel and verify the text rendering plus structuredContent
 * passthrough; error paths (stale ref / empty probe) must degrade to
 * errorResult, never throw.
 */
import { describe, expect, it } from 'bun:test'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { inspect } from '../src/browser-mcp/src/tools/inspect.ts'
import { createFakePage, makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'

const DETAIL = {
  tag: 'input',
  id: 'q',
  classes: ['search', 'active'],
  attributes: { 'data-testid': 'search-box', placeholder: 'Search…' },
  text: '',
  ancestors: [
    { tag: 'div', id: 'hdr', classes: ['bar'] },
    { tag: 'body', classes: [] },
  ],
  candidateSelectors: [
    { strategy: 'id', selector: '#q' },
    { strategy: 'data-testid', selector: '[data-testid="search-box"]' },
  ],
  outerHtml: '<input id="q" class="search active" data-testid="search-box">',
}

describe('inspect tool (P3-5)', () => {
  it('renders full detail and passes it through structuredContent', async () => {
    const page = createFakePage({ inspectRef: async () => DETAIL })
    const result = await executeTool(inspect, { page: 1, ref: 'e1' }, makeContext(page))

    expect(result.isError).toBeFalsy()
    const text = String((result.content as { text?: string }[])[0]?.text)
    expect(text).toContain('<input id="q"> (ref e1)')
    expect(text).toContain('classes: search active')
    expect(text).toContain('data-testid = search-box')
    expect(text).toContain('path: div#hdr.bar < body')
    expect(text).toContain('[id] #q')
    expect(text).toContain('[data-testid] [data-testid="search-box"]')
    expect(text).toContain('html: <input id="q"')
    expect(result.structuredContent).toMatchObject({
      page: 1,
      ref: 'e1',
      tag: 'input',
      id: 'q',
      candidateSelectors: DETAIL.candidateSelectors,
    })
  })

  it('renders the no-unique-selector fallback line', async () => {
    const page = createFakePage({
      inspectRef: async () => ({ ...DETAIL, id: undefined, candidateSelectors: [] }),
    })
    const result = await executeTool(inspect, { page: 1, ref: 'e2' }, makeContext(page))

    expect(result.isError).toBeFalsy()
    const text = String((result.content as { text?: string }[])[0]?.text)
    expect(text).toContain('(none unique — locate via ancestors)')
  })

  it('maps a stale-ref rejection to errorResult', async () => {
    const page = createFakePage({
      inspectRef: async () => {
        throw new Error('Unknown ref e99; take a new snapshot.')
      },
    })
    const result = await executeTool(inspect, { page: 1, ref: 'e99' }, makeContext(page))

    expect(result.isError).toBeTruthy()
    const text = String((result.content as { text?: string }[])[0]?.text)
    expect(text).toContain('inspect:')
    expect(text).toContain('Unknown ref e99')
  })

  it('rejects an empty probe payload as stale', async () => {
    const page = createFakePage({ inspectRef: async () => null })
    const result = await executeTool(inspect, { page: 1, ref: 'e3' }, makeContext(page))

    expect(result.isError).toBeTruthy()
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('no detail')
  })
})
