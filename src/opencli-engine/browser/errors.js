/**
 * Browser connection error helpers.
 *
 * Simplified — no more token/extension/CDP classification.
 * Browser connection failure modes (BrowserOS neo CDP direct connection).
 */
 import { BrowserConnectError } from '../errors.js';
 /**
 * Browser transient patterns — service worker restarts, attach races,
 * Browser transient patterns — service worker restarts, attach races,
 * tab closure, browser connection hiccups. These warrant a longer retry delay (~1500ms)
 * because the browser needs time to recover.
 */
const EXTENSION_TRANSIENT_PATTERNS = [
    'Extension disconnected',
    'Extension not connected',
    'attach failed',
    'Detached while handling command',
    'Debugger is not attached to the tab',
    'no longer exists',
    'No tab with id',
    'CDP connection',
    'No window with id',
];
/**
 * CDP target navigation patterns — SPA client-side redirects can invalidate the
 * CDP target after chrome.tabs reports 'complete'. These warrant a shorter retry
 * delay (~200ms) because the new document is usually available quickly.
 */
const TARGET_NAVIGATION_PATTERNS = [
    'Inspected target navigated or closed',
];
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * Machine-readable error codes set by the extension at the failure site.
 * These are authoritative — the message-pattern tables below are only a
 * fallback for extensions that predate error codes.
 *
 * `detached_mid_command` and `cdp_timeout` are deliberately non-retryable:
 * both mean execution died MID-command, so a blind re-run could double-apply
 * a write. (The legacy pattern table still retries "Detached while handling
 * command" because old extensions cannot distinguish pre- from mid-execution.)
 */
const ERROR_CODE_ADVICE = {
    attach_failed: { kind: 'extension-transient', retryable: true, delayMs: 1500 },
    tab_gone: { kind: 'extension-transient', retryable: true, delayMs: 1500 },
    target_navigated: { kind: 'target-navigation', retryable: true, delayMs: 200 },
    detached_mid_command: { kind: 'non-retryable', retryable: false, delayMs: 0 },
    cdp_timeout: { kind: 'non-retryable', retryable: false, delayMs: 0 },
};
/**
 * Classify a browser error and return retry advice.
 *
 * Single source of truth for "is this error transient?" across all layers.
 * Prefers the machine-readable `code` carried by BrowserCommandError; falls
 * back to message patterns for legacy extensions.
 */
export function classifyBrowserError(err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (typeof code === 'string' && ERROR_CODE_ADVICE[code]) {
        return ERROR_CODE_ADVICE[code];
    }
    const msg = errorMessage(err);
    // Browser transient errors — longer recovery time
    if (EXTENSION_TRANSIENT_PATTERNS.some(p => msg.includes(p))) {
        return { kind: 'extension-transient', retryable: true, delayMs: 1500 };
    }
    // CDP target navigation errors — shorter recovery time
    if (TARGET_NAVIGATION_PATTERNS.some(p => msg.includes(p))) {
        return { kind: 'target-navigation', retryable: true, delayMs: 200 };
    }
    // CDP protocol error with target/context invalidation (e.g., -32000 "target closed" or
    // -32000 "Cannot find default execution context" — both indicate the inspected target
    // went away and a fresh attach should recover).
    if (msg.includes('-32000') && /target|context/i.test(msg)) {
        return { kind: 'target-navigation', retryable: true, delayMs: 200 };
    }
    return { kind: 'non-retryable', retryable: false, delayMs: 0 };
}
/**
 * Check if an error is a transient browser error worth retrying.
 * Convenience wrapper around classifyBrowserError().
 */
export function isTransientBrowserError(err) {
    return classifyBrowserError(err).retryable;
}
export function formatBrowserConnectError(kind, detail) {
    switch (kind) {
        case 'daemon-not-running':
            return new BrowserConnectError('Cannot connect to browser.' + (detail ? `\n\n${detail}` : ''), 'Make sure BrowserOS neo is running on the configured CDP port.', kind);
        case 'extension-not-connected':
            return new BrowserConnectError('Browser connection failed.' + (detail ? `\n\n${detail}` : ''), 'Make sure BrowserOS neo is running.', kind);
        case 'command-failed':
            return new BrowserConnectError(`Browser command failed: ${detail ?? 'unknown error'}`, undefined, kind);
        default:
            return new BrowserConnectError(detail ?? 'Failed to connect to browser', undefined, kind);
    }
}
