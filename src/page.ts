import { BasePage } from './opencli/base-page.js';
import { generateStealthJs } from './opencli/stealth.js';
import type { BrowserSession } from '@browseros/browser-core';
import type { CdpBackend } from '@browseros/browser-core';
import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api';
import type { BrowserEvaluateFunction, BrowserCookie, ScreenshotOptions, SnapshotOptions } from './opencli/types.js';
import { ConsoleCollector, NetworkCollector } from './event-bridge.js';

export class UnifiedPage extends BasePage {
  private _stealthInjected = false;
  private _console: ConsoleCollector | null = null;
  private _network: NetworkCollector | null = null;

  constructor(
    private session: BrowserSession,
    private cdpBackend: CdpBackend,
    private pageId: number,
  ) {
    super();
  }

  // ── evaluate (P0-3: two overloads + buildEvaluateExpression) ──
  async evaluate<T = unknown>(js: string): Promise<T>;
  async evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>;
  async evaluate(input: string | BrowserEvaluateFunction<unknown[], unknown>, ...args: unknown[]): Promise<unknown> {
    const { buildEvaluateExpression } = await import('./opencli/utils.js');
    const expression = buildEvaluateExpression(input as string, args);
    const { session } = await this.session.pages.getSession(this.pageId);
    const result = await session.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error('Evaluate: ' + (result.exceptionDetails.exception?.description ?? ''));
    }
    return result.result?.value;
  }

  // ── goto ──
 async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number; allowBoundNavigation?: boolean }): Promise<void> {
    await this.session.nav(this.pageId).goto(url);
    this._lastUrl = url;
    if (!this._stealthInjected) {
      await this.evaluate(generateStealthJs());
      this._stealthInjected = true;
    }
    if (options?.waitUntil !== 'none') {
      const { waitForDomStableJs } = await import('./opencli/dom-helpers.js');
      const maxMs = options?.settleMs ?? 1000;
      await this.evaluate(waitForDomStableJs(maxMs, Math.min(500, maxMs)));
    }
  }

  // ── getCookies ──
  async getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]> {
    const params = opts?.url ? JSON.stringify({ urls: [opts.url] }) : '{}';
    const result = await this.session.cdpJsonForPage(this.pageId, 'Network.getCookies', params);
    const cookies = (result as { cookies?: BrowserCookie[] })?.cookies ?? [];
    return cookies;
  }

  // ── screenshot (P1-5: fullPage/width/height/path) ──
  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    const { session } = await this.session.pages.getSession(this.pageId);
    const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
    const overrideHeight = !options.fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
    if (overrideWidth !== undefined || overrideHeight !== undefined) {
      await this.cdp('Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth ?? 0,
        height: overrideHeight ?? 0,
        deviceScaleFactor: 1,
      });
    }
    const result = await this.cdp('Page.captureScreenshot', {
      format: options.format ?? 'jpeg',
      quality: options.quality ?? 80,
      captureBeyondViewport: options.fullPage ?? false,
    }) as { data: string };
    if (overrideWidth !== undefined) {
      await this.cdp('Emulation.clearDeviceMetricsOverride', {});
    }
    if (options.path) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(options.path, Buffer.from(result.data, 'base64'));
    }
    return result.data;
  }

  // ── tabs / selectTab ──
  async tabs(): Promise<unknown[]> {
    return this.session.pages.list();
  }

  async selectTab(target: number | string): Promise<void> {
    const pages = await this.session.pages.list();
    const page = typeof target === 'number'
      ? pages.find((p: any) => p.pageId === target)
      : pages.find((p: any) => p.url.includes(String(target)));
    if (page) {
      this.pageId = (page as any).pageId;
      this.resetPageState();
      this._stealthInjected = false;
      this._console?.stop();
      this._console = null;
      this._network?.stop();
      this._network = null;
    }
  }

  // ── CDP escape hatch ──
  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.session.cdpJsonForPage(this.pageId, method, JSON.stringify(params ?? {}));
  }

  // ── native input → BrowserClaw Input ──
  async nativeClick(x: number, y: number): Promise<void> {
    await this.session.input(this.pageId).clickAt(x, y);
  }

  async nativeType(text: string): Promise<void> {
    await this.session.input(this.pageId).type(text);
  }

  async nativeKeyPress(key: string, modifiers?: string[]): Promise<void> {
    const combo = modifiers?.length ? `${modifiers.join('+')}+${key}` : key;
    await this.session.input(this.pageId).press(combo);
  }

  async insertText(text: string): Promise<void> {
    const { session } = await this.session.pages.getSession(this.pageId);
    await session.Input.insertText({ text });
  }

  // ── handleJavaScriptDialog (P1-8) ──
  async handleJavaScriptDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.session.input(this.pageId).handleDialog(accept, promptText);
  }

  // ── snapshot (P2: opts.source routing) ──
  async snapshot(opts?: SnapshotOptions): Promise<unknown> {
    if (opts?.source === 'dom') {
      return super.snapshot(opts);
    }
    const result = await this.session.observe(this.pageId).snapshot();
    this.populateAxRefs(result.refs);
    return result.text;
  }

  async diff(): Promise<unknown> {
    return this.session.observe(this.pageId).diff();
  }

  // ── consoleMessages (event-bridge) ──
  async consoleMessages(level: string = 'all'): Promise<unknown[]> {
    if (!this._console) {
      const { sessionId } = await this.session.pages.getSession(this.pageId);
      this._console = new ConsoleCollector(this.cdpBackend, sessionId);
      await this._console.start();
    }
    return this._console.get(level);
  }

  // ── network capture (event-bridge) ──
  async startNetworkCapture(pattern: string = ''): Promise<boolean> {
    if (!this._network) {
      const { sessionId } = await this.session.pages.getSession(this.pageId);
      this._network = new NetworkCollector(this.cdpBackend, sessionId);
    }
    await this._network.start(pattern);
    return true;
  }

  async readNetworkCapture(): Promise<unknown[]> {
    return this._network?.read() ?? [];
  }

  // ── frames (wujie iframe support) ──
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    const { session } = await this.session.pages.getSession(this.pageId);
    const result = await session.Page.getFrameTree();
    const tree = (result as any).frameTree;
    const list: Array<{ index: number; frameId: string; url: string; name: string }> = [];
    let index = 0;
    function walk(node: any) {
      if (!node?.frame) return;
      list.push({
        index: index++,
        frameId: node.frame.id || '',
        url: node.frame.url || '',
        name: node.frame.name || '',
      });
      for (const child of node.childFrames || []) walk(child);
    }
    walk(tree);
    return list;
  }

  // ── evaluateInFrame (wujie iframe support) ──
  // Uses contentWindow.eval for same-origin iframes — no executionContextCreated
  // tracking needed. Cross-origin OOPIF requires a dedicated CDP session (future).
  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
    const { buildEvaluateExpression } = await import('./opencli/utils.js');
    const expression = buildEvaluateExpression(js, []);
    const wrapper = `(function() {
      const iframe = document.querySelectorAll('iframe')[${frameIndex}];
      if (!iframe) throw new Error('Frame ${frameIndex} not found');
      if (!iframe.contentWindow) throw new Error('Frame ${frameIndex} has no contentWindow');
      try {
        return iframe.contentWindow.eval(${JSON.stringify(expression)});
      } catch (e) {
        throw new Error('Frame ${frameIndex} eval failed: ' + e.message);
      }
    })()`;
    return this.evaluate(wrapper);
  }

  // ── private helpers ──

  private populateAxRefs(refs: any): void {
    for (const [ref, entry] of refs.byRef) {
      this._axRefs.set(ref, {
        ref,
        backendNodeId: entry.backendNodeId,
        role: entry.role,
        name: entry.name,
        nth: entry.nth,
        frame: entry.frameId ? { frameId: entry.frameId } : undefined,
      });
    }
  }

}
