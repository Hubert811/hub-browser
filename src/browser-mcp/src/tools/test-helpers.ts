/**
 * Shared fakes for fork unit tests.
 *
 * The fork's tools now operate on UnifiedPage. These helpers build a real
 * UnifiedPage over a minimal fake BrowserSession/CdpBackend (so the
 * page.evaluate / snapshot / tabs / cdp plumbing runs for real) and let tests
 * override specific methods where full CDP behavior is not needed.
 */
import { UnifiedPage } from '../../../page.js'
import type { ToolContext, UnifiedPageProvider } from './framework'

/** Minimal session/cdp pair that keeps UnifiedPage construction cheap. */
export function createFakePage(
  overrides: Partial<UnifiedPage> = {},
): UnifiedPage {
  const session = {
    pages: {
      list: async () => [],
      getSession: async () => ({
        session: {
          Runtime: { evaluate: async () => ({ result: { value: undefined } }) },
          Page: {
            setDownloadBehavior: async () => {},
            on: () => () => {},
          },
        },
        sessionId: 'fake-session-1',
      }),
      getInfo: () => undefined,
      newPage: async () => 2,
      close: async () => {},
    },
    observe: () => ({
      snapshot: async () => ({ text: '', refs: { byRef: new Map() } }),
      diff: async () => ({ changed: false, text: '' }),
      lastRefs: { byRef: new Map(), get: () => undefined },
    }),
    input: () => ({}),
    cdpJsonForPage: async () => ({}),
    dispose: async () => {},
  } as never

  const cdp = {
    connect: async () => {},
    disconnect: async () => {},
    onSessionEvent: () => () => {},
  } as never

  const page = new UnifiedPage(session, cdp, 1)
  return Object.assign(page, overrides)
}

export function makeContext(
  page: UnifiedPage,
  pageFor?: (pageId: number) => Promise<UnifiedPage>,
): ToolContext {
  return {
    page,
    pageFor: pageFor ?? (async () => page),
  }
}

export function makeProvider(page: UnifiedPage): UnifiedPageProvider {
  return {
    connect: async (opts?: { pageId?: number }) => {
      void opts
      return page
    },
  }
}

export function textOf(result: { content?: unknown } | undefined): string {
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

/** Wraps an arbitrary fake BrowserSession-shaped object as a UnifiedPage. */
export function pageFromSession(session: unknown, pageId = 1): UnifiedPage {
  const cdp = {
    connect: async () => {},
    disconnect: async () => {},
    onSessionEvent: () => () => {},
  } as never
  return new UnifiedPage(session as never, cdp, pageId)
}
