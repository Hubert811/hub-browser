import { generateStealthJs } from './opencli/stealth.js';
import type { IPage } from './opencli/types.js';
import { UnifiedPage } from './page.js';

/** Browser factory interface (mirrors OpenCLI's IBrowserFactory) */
export interface IBrowserFactory {
  connect(opts?: {
    timeout?: number;
    cdpEndpoint?: string;
    pageId?: number;
    session?: string;
    contextId?: string;
    preferredContextId?: string;
    idleTimeout?: number;
    windowMode?: 'foreground' | 'background';
    surface?: 'browser' | 'adapter';
    siteSession?: 'ephemeral' | 'persistent';
  }): Promise<IPage>;
  close(): Promise<void>;
}

export class UnifiedBrowserFactory implements IBrowserFactory {
  private _cdp: any = null;
  private _session: any = null;

  async connect(opts?: {
    timeout?: number;
    cdpEndpoint?: string;
    pageId?: number;
    session?: string;
  }): Promise<IPage> {
    if (this._cdp && this._session) {
      const pageId = opts?.pageId ?? 1;
      return new UnifiedPage(this._session, this._cdp, pageId);
    }

    const { CdpBackend, BrowserSession } = await import('@browseros/browser-core');

    const port = opts?.cdpEndpoint
      ? parsePortFromEndpoint(opts.cdpEndpoint)
      : Number(process.env.BROWSEROS_CDP_PORT ?? 9005);

    this._cdp = new CdpBackend({ port });
    await this._cdp.connect();
    this._session = new BrowserSession(this._cdp);

    const pages = await this._session.pages.list();
    const pageId = opts?.pageId
      ?? pages.find((p: any) => p.isActive)?.pageId
      ?? await this._session.pages.newPage('about:blank');

    // P1-3/P1-16: stealth injection at connect time
    const { session: pageSession } = await this._session.pages.getSession(pageId);
    await pageSession.Page.addScriptToEvaluateOnNewDocument({
      source: generateStealthJs(),
    });

    return new UnifiedPage(this._session, this._cdp, pageId);
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
  return match ? Number(match[1]) : 9005;
}
