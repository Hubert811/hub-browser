/**
 * P2 / 修复 Spec 第三轮（方案 1）: CDP 层完整 Chrome brand 指纹.
 *
 * Covers the UA-override generation module (src/opencli/ua-override.ts) and
 * the idempotent per-session injection in src/page.ts / src/factory.ts.
 * Round-3 supplement: buildUserAgentMetadata must prefer live high-entropy
 * values (platformVersion/architecture/bitness/model from
 * navigator.userAgentData.getHighEntropyValues) over the old hardcoded
 * 14.5/MacIntel profile, and fall back to the macOS profile only when the
 * live read is unavailable.
 *
 * Background (confirmed on BrowserClaw 9110): the browser is an unbranded
 * Chromium build whose navigator.userAgentData.brands is
 * [Not/A)Brand 99, Chromium 148] — missing "Google Chrome" — which triggers
 * zhihu 40362 on /api/v4/questions/{id}/answers. navigator.userAgentData is
 * read-only from page JS, so the brand list must be supplied via CDP
 * Emulation.setUserAgentOverride (per-session).
 */
import { describe, expect, it } from 'bun:test'
import {
  applyUserAgentOverride,
  buildUserAgentMetadata,
  buildUserAgentOverride,
  parseChromeVersion,
} from '../src/opencli/ua-override.ts'
import { UnifiedPage } from '../src/page.ts'
import { UnifiedBrowserFactory } from '../src/factory.ts'

const BROWSERCLAW_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

describe('parseChromeVersion', () => {
  it('parses major + full version from the BrowserClaw UA (Chrome 148)', () => {
    expect(parseChromeVersion(BROWSERCLAW_UA)).toEqual({
      major: '148',
      full: '148.0.0.0',
    })
  })

  it('parses 3-part and 1-part Chrome versions (zero-filled)', () => {
    expect(parseChromeVersion('Mozilla/5.0 Chrome/120.3.4 Safari/537.36')).toEqual({
      major: '120',
      full: '120.3.4.0',
    })
    expect(parseChromeVersion('Mozilla/5.0 Chrome/120')).toEqual({
      major: '120',
      full: '120.0.0.0',
    })
  })

  it('returns null when no Chrome version is present', () => {
    expect(parseChromeVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36')).toBeNull()
    expect(parseChromeVersion('')).toBeNull()
  })
})

describe('buildUserAgentMetadata', () => {
  it('brands include Google Chrome alongside Chromium (Not/A)Brand first)', () => {
    const meta = buildUserAgentMetadata(BROWSERCLAW_UA)!
    expect(meta.brands).toEqual([
      { brand: 'Not/A)Brand', version: '99' },
      { brand: 'Chromium', version: '148' },
      { brand: 'Google Chrome', version: '148' },
    ])
  })

  it('fullVersionList mirrors brands with full versions (Google Chrome 148.0.0.0)', () => {
    const meta = buildUserAgentMetadata(BROWSERCLAW_UA)!
    expect(meta.fullVersionList).toEqual([
      { brand: 'Not/A)Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: '148.0.0.0' },
      { brand: 'Google Chrome', version: '148.0.0.0' },
    ])
    expect(meta.fullVersion).toBe('148.0.0.0')
  })

  it('derives the desktop macOS fallback profile when no live data (platform macOS, 26.5.2, MacIntel, empty model, mobile false)', () => {
    const meta = buildUserAgentMetadata(BROWSERCLAW_UA)!
    expect(meta.platform).toBe('macOS')
    expect(meta.platformVersion).toBe('26.5.2')
    expect(meta.architecture).toBe('MacIntel')
    expect(meta.model).toBe('')
    expect(meta.mobile).toBe(false)
    expect(meta.bitness).toBe('64')
  })

  it('prefers live high-entropy values (26.5.2 / arm / 64) over the hardcoded fallback', () => {
    const live = {
      platform: 'macOS',
      platformVersion: '26.5.2',
      architecture: 'arm',
      bitness: '64',
      model: '',
      uaFullVersion: '148.0.7974.97',
    }
    const meta = buildUserAgentMetadata(BROWSERCLAW_UA, live)!
    expect(meta.platformVersion).toBe('26.5.2')
    expect(meta.architecture).toBe('arm')
    expect(meta.bitness).toBe('64')
    expect(meta.model).toBe('')
    // brand fabrication is unchanged
    expect(meta.brands.map((b) => b.brand)).toEqual(['Not/A)Brand', 'Chromium', 'Google Chrome'])
    // uaFullVersion is used as fullVersion/fullVersionList so the high-entropy
    // report after the override matches the real build (148.0.7974.97)
    expect(meta.fullVersion).toBe('148.0.7974.97')
    expect(meta.fullVersionList).toEqual([
      { brand: 'Not/A)Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: '148.0.7974.97' },
      { brand: 'Google Chrome', version: '148.0.7974.97' },
    ])
  })

  it('falls back to arm when the UA is a Mac UA without an Intel token', () => {
    const meta = buildUserAgentMetadata('Mozilla/5.0 (Macintosh; Mac OS X 26_5_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36')!
    expect(meta.architecture).toBe('arm')
  })

  it('prefers live platform when the browser exposes it (self-consistency)', () => {
    const meta = buildUserAgentMetadata(BROWSERCLAW_UA, { platform: 'Windows' })!
    expect(meta.platform).toBe('Windows')
    expect(meta.brands[2]).toEqual({ brand: 'Google Chrome', version: '148' })
  })

  it('returns null for a non-Chrome UA (no override should be sent)', () => {
    expect(buildUserAgentMetadata('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/140.0')).toBeNull()
  })
})

describe('buildUserAgentOverride', () => {
  it('keeps the userAgent string byte-identical and attaches the metadata', () => {
    const params = buildUserAgentOverride(BROWSERCLAW_UA)!
    expect(params.userAgent).toBe(BROWSERCLAW_UA)
    expect(params.userAgentMetadata.brands.map((b) => b.brand)).toContain('Google Chrome')
    expect(params.userAgentMetadata.fullVersionList[2]).toEqual({
      brand: 'Google Chrome',
      version: '148.0.0.0',
    })
  })
})

/** Minimal page CDP session mock recording Emulation.setUserAgentOverride. */
function mockPageSession(ua = BROWSERCLAW_UA) {
  const setUaCalls: Array<Record<string, unknown>> = []
  const session = {
    Page: {
      addScriptToEvaluateOnNewDocument: async () => ({ identifier: 1 }),
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression === 'navigator.userAgent') {
          return { result: { type: 'string', value: ua } }
        }
        if (expression.includes('getHighEntropyValues')) {
          return {
            result: {
              type: 'object',
              value: {
                platform: 'macOS',
                platformVersion: '26.5.2',
                architecture: 'arm',
                bitness: '64',
                model: '',
                uaFullVersion: '148.0.7974.97',
              },
            },
          }
        }
        if (expression.includes('navigator.userAgentData')) {
          return { result: { type: 'object', value: { platform: 'macOS' } } }
        }
        // stealth / dom-stable JS: pretend it applied
        return { result: { type: 'string', value: 'applied' } }
      },
    },
    Emulation: {
      setUserAgentOverride: async (params: Record<string, unknown>) => {
        setUaCalls.push(params)
      },
    },
  }
  return { session, setUaCalls }
}

/** Fake BrowserSession + CdpBackend shaped like @browseros/browser-core. */
function mockBridge(pageSession: unknown, sessionId = 's1') {
  let sid = sessionId
  const browserSession = {
    pages: {
      list: async () => [{ pageId: 7, targetId: 't7', isActive: true, url: 'about:blank' }],
      getInfo: () => ({ pageId: 7, targetId: 't7', isActive: true, url: 'about:blank' }),
      getSession: async () => ({
        session: pageSession,
        sessionId: sid,
        url: 'about:blank',
      }),
      newPage: async () => 7,
      close: async () => {},
    },
    nav: () => ({ goto: async () => {}, reload: async () => {}, back: async () => {}, forward: async () => {} }),
    cdpJsonForPage: async () => ({}),
    dispose: async () => {},
  }
  const cdp = { connect: async () => {}, disconnect: async () => {}, onSessionEvent: () => () => {} }
  return { browserSession, cdp, setSessionId: (s: string) => { sid = s } }
}

describe('applyUserAgentOverride (session level)', () => {
  it('reads the UA, builds metadata, and sends Emulation.setUserAgentOverride with correct params', async () => {
    const { session, setUaCalls } = mockPageSession()
    const applied = await applyUserAgentOverride(session as never)
    expect(applied).toBe(true)
    expect(setUaCalls).toHaveLength(1)
    const params = setUaCalls[0] as {
      userAgent: string
      userAgentMetadata: {
        brands: Array<{ brand: string; version: string }>
        platformVersion: string
        architecture: string
        bitness: string
      }
    }
    expect(params.userAgent).toBe(BROWSERCLAW_UA)
    expect(params.userAgentMetadata.brands).toEqual([
      { brand: 'Not/A)Brand', version: '99' },
      { brand: 'Chromium', version: '148' },
      { brand: 'Google Chrome', version: '148' },
    ])
    // live high-entropy values flow through (not the old 14.5 / MacIntel)
    expect(params.userAgentMetadata.platformVersion).toBe('26.5.2')
    expect(params.userAgentMetadata.architecture).toBe('arm')
    expect(params.userAgentMetadata.bitness).toBe('64')
    expect(params.userAgentMetadata.fullVersion).toBe('148.0.7974.97')
    expect(params.userAgentMetadata.fullVersionList[2]).toEqual({
      brand: 'Google Chrome',
      version: '148.0.7974.97',
    })
  })

  it('does not send the override when the page has no Chrome version in its UA', async () => {
    const { session, setUaCalls } = mockPageSession(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/140.0',
    )
    const applied = await applyUserAgentOverride(session as never)
    expect(applied).toBe(false)
    expect(setUaCalls).toHaveLength(0)
  })
})

describe('UnifiedPage.ensureUserAgentOverride (per-session idempotency)', () => {
  it('applies once per CDP session and re-applies on a new session', async () => {
    const { session, setUaCalls } = mockPageSession()
    const { browserSession, cdp, setSessionId } = mockBridge(session, 's1')
    const page = new UnifiedPage(browserSession as never, cdp as never, 7)

    // First ensure: applies to session s1.
    expect(await page.ensureUserAgentOverride()).toBe(true)
    // Same session: idempotent — no second send.
    expect(await page.ensureUserAgentOverride()).toBe(true)
    expect(setUaCalls).toHaveLength(1)

    // Page rebinds to a new session (selectTab/newTab/re-attach): applies again.
    setSessionId('s2')
    expect(await page.ensureUserAgentOverride()).toBe(true)
    expect(setUaCalls).toHaveLength(2)
    const params = setUaCalls[1] as { userAgentMetadata: { brands: Array<{ brand: string }> } }
    expect(params.userAgentMetadata.brands.map((b) => b.brand)).toContain('Google Chrome')
  })

  it('goto() applies the override once and does not re-send on a second navigation', async () => {
    const { session, setUaCalls } = mockPageSession()
    const { browserSession, cdp } = mockBridge(session, 's1')
    const page = new UnifiedPage(browserSession as never, cdp as never, 7)

    await page.goto('https://www.zhihu.com/question/1', { waitUntil: 'none' })
    expect(setUaCalls).toHaveLength(1)
    const params = setUaCalls[0] as { userAgentMetadata: { brands: Array<{ brand: string }> } }
    expect(params.userAgentMetadata.brands.map((b) => b.brand)).toContain('Google Chrome')

    await page.goto('https://www.zhihu.com/question/2', { waitUntil: 'none' })
    expect(setUaCalls).toHaveLength(1)
  })
})

describe('UnifiedBrowserFactory.connect (connect-time injection)', () => {
  it('applies the UA override to the newly bound page session right after stealth injection', async () => {
    const { session, setUaCalls } = mockPageSession()
    const { browserSession, cdp } = mockBridge(session, 's1')
    const factory = new UnifiedBrowserFactory() as unknown as {
      _session: unknown
      _cdp: unknown
      connect: () => Promise<UnifiedPage>
    }
    factory._session = browserSession
    factory._cdp = cdp

    const page = await factory.connect()
    expect(page).toBeInstanceOf(UnifiedPage)
    expect(setUaCalls).toHaveLength(1)
    const params = setUaCalls[0] as { userAgentMetadata: { brands: Array<{ brand: string }> } }
    expect(params.userAgentMetadata.brands.map((b) => b.brand)).toEqual([
      'Not/A)Brand',
      'Chromium',
      'Google Chrome',
    ])

    // The page already recorded the sessionId, so a subsequent goto does not
    // re-send the override (end-to-end "set once" semantics).
    await page.goto('https://www.zhihu.com/question/2067235011804320517', { waitUntil: 'none' })
    expect(setUaCalls).toHaveLength(1)
  })
})
