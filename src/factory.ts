import { generateStealthJs } from './opencli/stealth.js';
import type { IPage } from './opencli/types.js';
import { UnifiedPage } from './page.js';
import { resolveCdpPort } from './cdp-port.js';

/** Browser factory interface (mirrors OpenCLI's IBrowserFactory) */
export interface IBrowserFactory {
  connect(opts?: {
    timeout?: number;
    cdpEndpoint?: string;
    pageId?: number;
    session?: string;
  }): Promise<IPage>;
  close(): Promise<void>;
}

export class UnifiedBrowserFactory implements IBrowserFactory {
  private _cdp: any = null;
  private _session: any = null;
  private _establishing: Promise<void> | null = null;

  /**
   * Establishes the shared CdpBackend + BrowserSession exactly once.
   *
   * Serialized: hub.mjs MCP mode fires `spaces.restore()` at startup while the
   * first tool call also calls connect() — two concurrent establish() calls
   * each built their own CdpBackend/BrowserSession, clobbered the shared
   * `this._session`, and produced duplicate pageIds in the surviving
   * PageManager registry (same tabId registered twice), which made tools fail
   * with "Page N has no attached session". A promise guard makes concurrent
   * callers await the same connection.
   */
  private async ensureConnected(cdpEndpoint?: string): Promise<void> {
    if (this._cdp && this._session) return
    if (this._establishing) return this._establishing
    this._establishing = (async () => {
      const { CdpBackend, BrowserSession } = await import('@browseros/browser-core');
      const port = cdpEndpoint
        ? parsePortFromEndpoint(cdpEndpoint)
        : resolveCdpPort();
      const cdp = new CdpBackend({ port });
      await cdp.connect();
      this._cdp = cdp;
      this._session = new BrowserSession(cdp);
    })()
      .catch((err) => {
        // A failed establish must not leave a half-wired singleton behind.
        this._cdp = null;
        this._session = null;
        throw err;
      })
      .finally(() => {
        this._establishing = null;
      })
    return this._establishing
  }

  async connect(opts?: {
    timeout?: number;
    cdpEndpoint?: string;
    pageId?: number;
    session?: string;
  }): Promise<UnifiedPage> {
    // Daemon mode: reuse singleton connection from globalThis.__HubBrowserFactory
    const singleton = (globalThis as any).__HubBrowserFactory;
    if (singleton && singleton !== this && singleton._cdp && singleton._session) {
      const pages = await singleton._session.pages.list();
      const pageId = opts?.pageId
        ?? pages.find((p: any) => p.isActive)?.pageId
        ?? 1;
      return new UnifiedPage(singleton._session, singleton._cdp, pageId);
    }

    await this.ensureConnected(opts?.cdpEndpoint)
    if (opts?.pageId !== undefined) {
      return new UnifiedPage(this._session, this._cdp, opts.pageId);
    }
    const pages = await this._session.pages.list();
    const pageId = pages.find((p: any) => p.isActive)?.pageId
      ?? await this._session.pages.newPage('about:blank');

    const page = new UnifiedPage(this._session, this._cdp, pageId);
    // P1-3/P1-16: stealth injection at connect time
    const { session: pageSession } = await this._session.pages.getSession(pageId);
    await pageSession.Page.addScriptToEvaluateOnNewDocument({
      source: generateStealthJs(),
    });
    // P2 (方案 1): full-Chrome brand fingerprint via CDP. Emulation.setUserAgentOverride
    // is per-session, so apply it on the page session here (before the first
    // document the adapter loads). ensureUserAgentOverride is idempotent: it
    // tracks the sessionId it was applied to, so the first goto() on this page
    // does not re-send the override while the CDP session is unchanged.
    await page.ensureUserAgentOverride();

    return page;
  }

  async close(): Promise<void> {
    await this._session?.dispose?.();
    await this._cdp?.disconnect?.();
    this._session = null;
    this._cdp = null;
  }
}

function parsePortFromEndpoint(endpoint: string): number {
  const match = endpoint.match(/:(\d+)$/);
  return match ? Number(match[1]) : resolveCdpPort();
}
