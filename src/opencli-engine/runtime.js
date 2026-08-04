import { UnifiedBrowserFactory } from '../factory.ts';
import { TimeoutError } from './errors.js';
import { DEFAULT_BROWSER_COMMAND_TIMEOUT, DEFAULT_BROWSER_CONNECT_TIMEOUT } from './browser/config.js';
export { DEFAULT_BROWSER_COMMAND_TIMEOUT, DEFAULT_BROWSER_CONNECT_TIMEOUT };
/**
 * Returns the browser factory for hub-browser.
 * Always uses UnifiedBrowserFactory (BrowserOS CDP backend).
 */
export function getBrowserFactory(site) {
    return UnifiedBrowserFactory;
}
/**
 * Timeout with seconds unit. Used for high-level command timeouts.
 */
export async function runWithTimeout(promise, opts) {
    const label = opts.label ?? 'Operation';
    return withTimeoutMs(promise, opts.timeout * 1000, () => new TimeoutError(label, opts.timeout, opts.hint));
}
/**
 * Timeout with milliseconds unit. Used for low-level internal timeouts.
 * Accepts a factory function to create the rejection error, keeping this
 * utility decoupled from specific error types.
 */
export function withTimeoutMs(promise, timeoutMs, makeError = 'Operation timed out') {
    const reject_ = typeof makeError === 'string'
        ? () => new Error(makeError)
        : makeError;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(reject_()), timeoutMs);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
export async function browserSession(BrowserFactory, fn, opts = {}) {
    const browser = new BrowserFactory();
    try {
       const page = await browser.connect({
           timeout: DEFAULT_BROWSER_CONNECT_TIMEOUT,
           session: opts.session,
           cdpEndpoint: opts.cdpEndpoint,
       });
        // `browser` is passed to the callback so space binding can re-connect
        // to a specific pageId on the SAME underlying session/connection —
        // no second CDP connection in direct mode, daemon singleton untouched.
        return await fn(page, browser);
    }
    finally {
        await browser.close().catch(() => { });
    }
}
