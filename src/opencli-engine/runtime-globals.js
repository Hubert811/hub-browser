/**
 * P1-4 (phase C) — the platform's process-global contract, centralized.
 *
 * hub-browser deliberately keeps a handful of values on `globalThis` because
 * they cross boundaries that cannot share a normal import: bin/hub.mjs loads
 * engine modules through a runtime-resolved path (src vs dist), and the daemon
 * shares its browser connection with in-process CLI command execution. Before
 * this module those keys were folklore — written in one file, read in another,
 * documented nowhere. All production reads/writes now go through these
 * accessors; the raw keys stay the wire format so existing tests that install
 * fakes directly keep working.
 *
 * Full inventory of the platform's five process globals:
 *
 *  - __HubDaemonMode (boolean) — set once by the hub.mjs daemon branch. Six
 *      CLI exit paths consult it: the daemon process must never exit (its
 *      in-process command execution shares the connection and event loop).
 *  - __HubBrowserFactory (UnifiedBrowserFactory) — the daemon's connected
 *      singleton. Browser commands executed in daemon-process context reuse
 *      this connection instead of dialing CDP a second time.
 *  - __HubBrowserBridgeOverride (class) — TEST SEAM ONLY. Tests inject a fake
 *      BrowserBridge (a class with connect()) so browser commands run without
 *      a live CDP connection. Production reads it through
 *      getBrowserBridgeOverride() and falls back to the real bridge; tests set
 *      the raw key and delete it on cleanup.
 *  - __opencli_registry__ (Map) — engine-internal (registry.js): module-dedup
 *      guard so two copies of the engine share one command registry. Owned
 *      entirely by registry.js — nothing outside reads or writes it.
 *  - __opencli_hooks__ (Map) — engine-internal (hooks.js): the same dedup
 *      pattern for the lifecycle hook registry. Owned by hooks.js.
 *
 * The last two are documented here for inventory completeness only — they are
 * deliberately NOT wrapped (converging them would churn engine internals for
 * zero behavioral gain; see architecture-deepdive-2026-08-13 §2 修正三).
 */

/** Mark this process as the hub daemon (bin/hub.mjs daemon branch, once). */
export function setDaemonMode() {
    globalThis.__HubDaemonMode = true;
}

/** True when running inside the hub daemon process (never process.exit()). */
export function isDaemonMode() {
    return globalThis.__HubDaemonMode === true;
}

/**
 * Publish the daemon's connected browser factory so in-process CLI command
 * execution (handleDaemonCommand) can reuse its CDP connection.
 */
export function setDaemonFactory(factory) {
    globalThis.__HubBrowserFactory = factory;
}

/** The daemon's connected factory singleton, when this process is the daemon. */
export function getDaemonFactory() {
    return globalThis.__HubBrowserFactory;
}

/**
 * Test seam: the fake BrowserBridge class tests installed (undefined in
 * production — callers fall back to the real bridge).
 */
export function getBrowserBridgeOverride() {
    return globalThis.__HubBrowserBridgeOverride;
}
