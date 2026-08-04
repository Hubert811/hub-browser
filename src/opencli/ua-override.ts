import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api';

/**
 * Full-Chrome brand fingerprint via CDP `Emulation.setUserAgentOverride`.
 *
 * BrowserClaw (port 9110) is an unbranded Chromium build:
 * `navigator.userAgentData.brands` reports `[Not/A)Brand 99, Chromium 148]`
 * and omits `"Google Chrome"`. Zhihu's risk control keys on that missing brand
 * and rejects the high-sensitivity API `/api/v4/questions/{id}/answers` with
 * 40362, while low-sensitivity endpoints (hot/search) pass. `navigator
 * .userAgentData` is read-only from page JS, so the brand list must be supplied
 * at the CDP layer, where `Emulation.setUserAgentOverride` accepts both the
 * `userAgent` string and a `userAgentMetadata` (brands / fullVersionList /
 * platform / platformVersion / architecture / ...).
 *
 * Round 3 (真实指纹): the non-brand high-entropy fields must also be
 * truthful. The previous hardcoded `platformVersion: '14.5'` /
 * `architecture: 'MacIntel'` disagreed with the real system (macOS 26.5.2 /
 * Apple Silicon → `arm`), and bilibili's QR-code login signs a payload with
 * `navigator.userAgentData` — a mismatched fingerprint breaks the signature
 * (password login works because it does not use UA data). High-entropy
 * fields (platformVersion / architecture / bitness / model / uaFullVersion)
 * are only readable asynchronously via
 * `navigator.userAgentData.getHighEntropyValues([...])` — reading them as
 * plain properties yields null. So `readLiveUaData()` reads the *real* values
 * before the override, and `buildUserAgentMetadata()` prefers them, falling
 * back to a macOS-desktop profile only when the read fails.
 *
 * The override is per-CDP-session: it applies to the page session it is sent
 * on and survives same-session navigations, but a freshly attached session
 * (new tab / re-attach) needs it set again. `ensureUserAgentOverride` in
 * `page.ts` tracks the sessionId it was applied to so re-applying is skipped
 * while the page keeps the same CDP session (idempotent).
 */

export interface ChromeVersionInfo {
  /** Major version, e.g. "148". */
  major: string;
  /** Full x.y.z.w version, e.g. "148.0.0.0". */
  full: string;
}

export interface UaBrand {
  brand: string;
  version: string;
}

/** Shape of the `userAgentMetadata` we send to Emulation.setUserAgentOverride. */
export interface UserAgentMetadataOverride {
  brands: UaBrand[];
  fullVersionList: UaBrand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
}

export interface UserAgentOverrideParams {
  userAgent: string;
  userAgentMetadata: UserAgentMetadataOverride;
}

/**
 * Fields read from the live page *before* overriding. `platform` is
 * low-entropy (readable synchronously); the rest are high-entropy and must
 * come from `navigator.userAgentData.getHighEntropyValues([...])`. They are
 * kept from the real browser so the fabricated metadata stays self-consistent
 * with what this Chromium build actually reports — only the brand lists are
 * fabricated to include "Google Chrome".
 */
export interface LiveUaData {
  platform?: string | null;
  platformVersion?: string | null;
  architecture?: string | null;
  bitness?: string | null;
  model?: string | null;
  uaFullVersion?: string | null;
}

const CHROME_VERSION_RE = /Chrome\/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/;

/** Fallback macOS profile used only when the live read is unavailable. */
const FALLBACK_PLATFORM_VERSION = '26.5.2';
const FALLBACK_BITNESS = '64';

/**
 * Parse the Chrome version out of a user-agent string.
 *
 * BrowserClaw's UA is e.g. `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
 * AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36`
 * → `{ major: '148', full: '148.0.0.0' }`.
 */
export function parseChromeVersion(ua: string): ChromeVersionInfo | null {
  const match = ua.match(CHROME_VERSION_RE);
  if (!match) return null;
  const major = match[1];
  const full = [match[1], match[2] ?? '0', match[3] ?? '0', match[4] ?? '0'].join('.');
  return { major, full };
}

/**
 * Infer the architecture the UA string advertises. The fallback must stay
 * consistent with the platform tokens in the UA string (e.g. an "Intel Mac OS
 * X" UA implies MacIntel even on real Apple-Silicon hardware, because Chrome
 * keeps the legacy UA string); the live high-entropy value is preferred when
 * available.
 */
export function inferArchitecture(ua: string): string {
  if (/Intel/i.test(ua)) return 'MacIntel';
  if (/(Macintosh|Mac OS X)/i.test(ua)) return 'arm';
  return 'MacIntel';
}

/**
 * Build the full-Chrome `userAgentMetadata` for a given UA string.
 *
 * `brands` / `fullVersionList` mirror what a real Google Chrome build reports
 * (Not/A)Brand 99, Chromium <major>, Google Chrome <major>). The remaining
 * fields prefer the live high-entropy values (`platformVersion`,
 * `architecture`, `bitness`, `model`, `uaFullVersion`) so the fingerprint
 * matches the real system (macOS 26.5.2 / arm / 64 / uaFullVersion
 * 148.0.7974.97), and fall back to the macOS desktop profile this hub targets
 * only when the live read was unavailable.
 *
 * Returns null when no Chrome version can be parsed from the UA.
 */
export function buildUserAgentMetadata(
  ua: string,
  live: LiveUaData = {},
): UserAgentMetadataOverride | null {
  const version = parseChromeVersion(ua);
  if (!version) return null;
  const { major, full } = version;
  // Full version as reported by the real browser (live uaFullVersion, e.g.
  // 148.0.7974.97) — preferred so getHighEntropyValues(['uaFullVersion'])
  // after the override is identical to the value before it; fall back to the
  // version parsed from the UA string when the live read was unavailable.
  const fullVersion = live.uaFullVersion ?? full;
  return {
    brands: [
      { brand: 'Not/A)Brand', version: '99' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
    ],
    fullVersionList: [
      { brand: 'Not/A)Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
    ],
    fullVersion: fullVersion,
    platform: live.platform ?? 'macOS',
    platformVersion: live.platformVersion ?? FALLBACK_PLATFORM_VERSION,
    architecture: live.architecture ?? inferArchitecture(ua),
    model: live.model ?? '',
    // Desktop browsing context: the browser this hub targets is a desktop
    // macOS Chrome build, so the brand list is always the desktop one.
    mobile: false,
    bitness: live.bitness ?? FALLBACK_BITNESS,
  };
}

/**
 * Build the full `Emulation.setUserAgentOverride` params: the unchanged UA
 * string plus the full-Chrome metadata. Returns null when the Chrome version
 * cannot be parsed (caller should skip the override rather than send junk).
 */
export function buildUserAgentOverride(
  ua: string,
  live: LiveUaData = {},
): UserAgentOverrideParams | null {
  const userAgentMetadata = buildUserAgentMetadata(ua, live);
  if (!userAgentMetadata) return null;
  return { userAgent: ua, userAgentMetadata };
}

/** Reads the page's live UA string (null when no context / not a string). */
async function readUserAgent(session: ProtocolApi): Promise<string | null> {
  const result = await session.Runtime.evaluate({
    expression: 'navigator.userAgent',
    returnByValue: true,
  });
  if (result.exceptionDetails) return null;
  const value = result.result?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads live UA-CH fields the browser actually reports (best-effort).
 *
 * `platform` is low-entropy (synchronous). The high-entropy fields
 * (platformVersion / architecture / bitness / model / uaFullVersion) are only
 * readable through the async `getHighEntropyValues()` API — plain property
 * reads return null — so this evaluates a promise and the caller passes
 * `awaitPromise: true`. Any failure (no userAgentData / insecure context /
 * exception) resolves to an empty object, never throws.
 */
const READ_LIVE_UA_JS = `(() => {
  try {
    const d = navigator.userAgentData;
    if (!d) return null;
    return d.getHighEntropyValues([
      'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion'
    ]).then((high) => ({
      platform: typeof d.platform === 'string' ? d.platform : null,
      platformVersion: typeof high.platformVersion === 'string' ? high.platformVersion : null,
      architecture: typeof high.architecture === 'string' ? high.architecture : null,
      bitness: typeof high.bitness === 'string' ? high.bitness : null,
      model: typeof high.model === 'string' ? high.model : null,
      uaFullVersion: typeof high.uaFullVersion === 'string' ? high.uaFullVersion : null,
    }));
  } catch { return null; }
})()`;

async function readLiveUaData(session: ProtocolApi): Promise<LiveUaData> {
  try {
    const result = await session.Runtime.evaluate({
      expression: READ_LIVE_UA_JS,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = result.exceptionDetails ? null : result.result?.value;
    return value && typeof value === 'object'
      ? (value as LiveUaData)
      : {};
  } catch {
    return {};
  }
}

/**
 * Apply the full-Chrome UA override to one page CDP session. Reads the real
 * UA string from the page (so the string stays byte-identical) and the real
 * high-entropy fingerprint (so platformVersion/architecture/bitness match the
 * system), derives the metadata, then sends `Emulation.setUserAgentOverride`
 * on that session.
 *
 * Best-effort: returns false (never throws) when the page has no usable
 * execution context or the UA cannot be parsed — callers keep their normal
 * behavior and may retry on the next navigation.
 */
export async function applyUserAgentOverride(session: ProtocolApi): Promise<boolean> {
  try {
    const ua = await readUserAgent(session);
    if (!ua) return false;
    const live = await readLiveUaData(session);
    const params = buildUserAgentOverride(ua, live);
    if (!params) return false;
    await session.Emulation.setUserAgentOverride(params);
    return true;
  } catch {
    return false;
  }
}
