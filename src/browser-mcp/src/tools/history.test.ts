import { describe, expect, it } from 'bun:test'
import { executeTool } from './framework'
import { history } from './history'
import { makeContext, pageFromSession, textOf } from './test-helpers'

const entries = [
  {
    id: 'entry-1',
    url: 'https://example.test/first',
    title: 'First visit',
    lastVisitTime: 1_785_456_000_000,
    visitCount: 4,
    typedCount: 1,
  },
  {
    id: 'entry-2',
    url: 'https://example.test/second',
    title: '',
    lastVisitTime: 1_785_369_600_000,
    visitCount: 1,
    typedCount: 0,
  },
]

function fakeSession(resultEntries: typeof entries) {
  const calls: Array<{ method: string; params: unknown }> = []
  const session = {
    pages: {
      list: async () => [
        {
          pageId: 1,
          targetId: 'target-1',
          url: 'https://example.test',
          title: 'Example',
        },
      ],
      getSession: async () => ({
        session: { Runtime: { evaluate: async () => ({}) } },
        sessionId: 's1',
      }),
    },
    cdpJsonForPage: async (
      _pageId: number,
      method: string,
      paramsJson: string,
    ) => {
      calls.push({ method, params: JSON.parse(paramsJson) })
      return { entries: resultEntries }
    },
    dispose: async () => {},
  }
  return { session, calls }
}

describe('history tool', () => {
  it('forwards maxResults and returns full entries', async () => {
    const { session, calls } = fakeSession(entries)
    const page = pageFromSession(session)

    const result = await executeTool(history, { maxResults: 2 }, makeContext(page))

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ entries, count: 2 })
    expect(textOf(result)).toContain('First visit')
    expect(textOf(result)).toContain('https://example.test/first')
    expect(textOf(result)).toContain('last visited 2026-07-31T00:00:00Z')
    expect(textOf(result)).toContain('4 visits')
    expect(textOf(result)).toContain('https://example.test/second')
    expect(calls).toEqual([
      { method: 'History.getRecent', params: { maxResults: 2 } },
    ])
  })

  it('defaults maxResults to 100 and handles empty history', async () => {
    const { session, calls } = fakeSession([])
    const page = pageFromSession(session)

    const result = await executeTool(history, {}, makeContext(page))

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('(no history)')
    expect(result.structuredContent).toEqual({ entries: [], count: 0 })
    expect(calls).toEqual([
      { method: 'History.getRecent', params: { maxResults: 100 } },
    ])
  })

  it('rejects invalid and unknown inputs', async () => {
    const { session, calls } = fakeSession([])
    const page = pageFromSession(session)

    for (const args of [
      { maxResults: 0 },
      { maxResults: -1 },
      { maxResults: 1.5 },
      { maxResults: '10' },
      { query: 'example' },
    ]) {
      const result = await executeTool(history, args, makeContext(page))
      expect(result.isError).toBe(true)
      expect(textOf(result)).toStartWith('Invalid arguments for history:')
    }
    expect(calls).toEqual([])
  })
})
