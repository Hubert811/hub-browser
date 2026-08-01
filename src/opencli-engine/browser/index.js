/**
 * Browser module — public API re-exports.
 *
 * This barrel replaces the former monolithic browser.ts.
 * External code should import from './browser/index.js' (or './browser.js' via Node resolution).
 */
// BrowserBridge/CDPBridge/Page/daemon-client removed — hub-browser uses UnifiedBrowserFactory
export { UnifiedBrowserFactory as BrowserBridge } from '../../factory.ts';
export { generateSnapshotJs, scrollToRefJs, getFormStateJs } from './dom-snapshot.js';
export { generateStealthJs } from './stealth.js';
