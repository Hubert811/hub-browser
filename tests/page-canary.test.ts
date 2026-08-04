/**
 * TabFreshness — UnifiedPage.canaryCapture unit tests (fake CDP).
 *
 * The canary is a 16×16 clipped Page.captureScreenshot used to probe the
 * per-tab capture pipeline BEFORE a real screenshot: a healthy tab answers in
 * a few ms; a wedged tab (verified 2026-08-03 — Runtime.evaluate stays
 * responsive, only the capture pipeline hangs) never answers and times out.
 */
import { describe, expect, it } from 'bun:test'
import { UnifiedPage } from '../src/page.ts'

interface CaptureCall {
  method: string
  params: Record<string, unknown>
}

function pageWithCapture(
  impl: (call: CaptureCall) => Promise<unknown>,
): { page: UnifiedPage; calls: CaptureCall[] } {
  const calls: CaptureCall[] = []
  const session = {
    pages: {
      list: async () => [],
      getSession: async () => ({ session: {}, sessionId: 'fake-s' }),
      getInfo: () => undefined,
      newPage: async () => 1,
      close: async () => {},
    },
    cdpJsonForPage: async (_pageId: number, method: string, paramsJson: string) => {
      const call = { method, params: JSON.parse(paramsJson) as Record<string, unknown> }
      calls.push(call)
      return impl(call)
    },
    dispose: async () => {},
  }
  const cdp = {
    connect: async () => {},
    disconnect: async () => {},
    onSessionEvent: () => () => {},
  }
  const page = new UnifiedPage(session as never, cdp as never, 7)
  return { page, calls }
}

const neverResolving = () =>
  new Promise<never>((_resolve, reject) => {
    // Resolves after the test's short timeout so the race wins deterministically.
    setTimeout(() => reject(new Error('late answer')), 5_000)
  })

describe('UnifiedPage.canaryCapture (TabFreshness canary)', () => {
  it('healthy capture pipeline: resolves in a few ms and returns the elapsed ms', async () => {
    const { page, calls } = pageWithCapture(async () => ({ data: 'canary' }))
    const ms = await page.canaryCapture(2500)
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(page.isScreenshotWedged()).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('Page.captureScreenshot')
    // The probe must use the tiny 16×16 clip (jpeg) that exercises the exact
    // capture pipeline — not Runtime.evaluate, which stays responsive on a
    // wedged tab.
    expect(calls[0].params).toMatchObject({
      format: 'jpeg',
      clip: { x: 0, y: 0, width: 16, height: 16, scale: 1 },
    })
  })

  it('wedged capture pipeline: times out, marks the tab wedged, and throws', async () => {
    const { page } = pageWithCapture(neverResolving)
    await expect(page.canaryCapture(30)).rejects.toThrow(/capture pipeline is wedged/i)
    expect(page.isScreenshotWedged()).toBe(true)
  })

  it('a later successful canary clears the wedged flag (same semantics as screenshot())', async () => {
    let wedged = true
    const { page } = pageWithCapture(async () => {
      if (wedged) return neverResolving()
      return { data: 'ok' }
    })
    await expect(page.canaryCapture(20)).rejects.toThrow(/wedged/i)
    expect(page.isScreenshotWedged()).toBe(true)
    wedged = false
    await page.canaryCapture(200)
    expect(page.isScreenshotWedged()).toBe(false)
  })

  it('a non-timeout CDP failure also marks the tab wedged and throws', async () => {
    const { page } = pageWithCapture(async () => {
      throw new Error('CDP error')
    })
    await expect(page.canaryCapture(50)).rejects.toThrow(/wedged/i)
    expect(page.isScreenshotWedged()).toBe(true)
  })
})
