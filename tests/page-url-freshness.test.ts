/**
 * `getCurrentUrl()` must answer about the page AS IT IS NOW.
 *
 * It used to be a cache (`if (this._lastUrl) return this._lastUrl`), and a
 * cache that never invalidates is wrong twice over:
 *
 *   - any navigation that does not go through `goto()` — a hash route,
 *     `pushState`, a link click, a redirect — left it stale. Measured on the
 *     real machine: the live location was `about:blank#changed` while
 *     `getCurrentUrl()` kept answering `about:blank`;
 *   - URL POLLING became impossible, because polling is precisely "read until
 *     it changes".
 *
 * The last known value is still kept, but only as the fallback for a page that
 * cannot be evaluated — the resilience the cache was really providing.
 */
import { describe, expect, test } from 'bun:test'
import { BasePage } from '../src/opencli/base-page.js'

class FakePage extends BasePage {
  /** What `evaluate('window.location.href')` answers. */
  location = 'about:blank'
  /** When set, `evaluate` throws instead of answering. */
  evaluateFails = false
  evaluateCalls = 0

  async evaluate(js: string): Promise<unknown> {
    this.evaluateCalls += 1
    if (this.evaluateFails) throw new Error('page is gone')
    return js.includes('location.href') ? this.location : null
  }

  async goto(url: string): Promise<void> {
    this.location = url
  }

  async getCookies(): Promise<never[]> {
    return []
  }
  async screenshot(): Promise<string> {
    return ''
  }
  async tabs(): Promise<never[]> {
    return []
  }
  async selectTab(): Promise<void> {}
}

describe('getCurrentUrl freshness', () => {
  test('reports an in-page navigation that did not go through goto()', async () => {
    const page = new FakePage()
    expect(await page.getCurrentUrl()).toBe('about:blank')

    // What a hash route / pushState / link click does.
    page.location = 'about:blank#changed'

    expect(await page.getCurrentUrl()).toBe('about:blank#changed')
  })

  test('supports polling for a url change', async () => {
    const page = new FakePage()
    expect(await page.getCurrentUrl()).toBe('about:blank')

    // Polling is exactly "read until it changes" — a cache makes it loop
    // forever on the first answer.
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      if (i === 2) page.location = 'https://done.example/'
      seen.push(String(await page.getCurrentUrl()))
    }
    expect(seen).toEqual(['about:blank', 'about:blank', 'https://done.example/'])
  })

  test('falls back to the last known url when the page cannot be evaluated', async () => {
    const page = new FakePage()
    page.location = 'https://known.example/'
    expect(await page.getCurrentUrl()).toBe('https://known.example/')

    page.evaluateFails = true
    expect(await page.getCurrentUrl()).toBe('https://known.example/')
  })

  test('answers null when nothing is known and the page cannot be evaluated', async () => {
    const page = new FakePage()
    page.evaluateFails = true
    expect(await page.getCurrentUrl()).toBeNull()
  })
})
