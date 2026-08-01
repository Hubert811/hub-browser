import { BasePage } from './opencli/base-page.js';
import { generateStealthJs } from './opencli/stealth.js';
import type { BrowserSession } from '@browseros/browser-core';
import type { CdpBackend } from '@browseros/browser-core';
import type { BrowserEvaluateFunction, BrowserCookie, ScreenshotOptions, SnapshotOptions } from './opencli/types.js';
import { ConsoleCollector, NetworkCollector } from './event-bridge.js';

export class UnifiedPage extends BasePage {
 private _stealthInjected = false;
 private _console: ConsoleCollector | null = null;
 private _network: NetworkCollector | null = null;
 private _executionContexts = new Map<string, number>();
private _ctxEventSub: (() => void) | null = null;
private _ctxEventSub2: (() => void) | null = null;

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
    let cookies = (result as { cookies?: BrowserCookie[] })?.cookies ?? [];
    if (opts?.domain) {
      const d = opts.domain.toLowerCase();
      cookies = cookies.filter(c => (c.domain ?? '').toLowerCase().includes(d));
    }
    return cookies;
  }

  // ── screenshot (P1-5: fullPage/width/height/path) ──
  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
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
    if (overrideWidth !== undefined || overrideHeight !== undefined) {
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
    if (!page) {
      throw new Error(`Tab not found: ${target}`);
    }
    this.pageId = (page as any).pageId;
    this.resetPageState();
    this._stealthInjected = false;
    this._console?.stop();
    this._console = null;
   await this._network?.stop();
   this._network = null;
   this.clearExecutionContexts();
   // Re-register stealth for the new tab's CDP session
    const { session } = await this.session.pages.getSession(this.pageId);
    await session.Page.addScriptToEvaluateOnNewDocument({ source: generateStealthJs() });
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
   // 2b.1: compound 后处理
   const compound = await this.collectCompoundInfo();
   return this.mergeCompoundIntoSnapshot(result.text, compound);
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
 async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
   const frames = await this.frames();
   const frame = frames[frameIndex];
   if (!frame) throw new Error(`Frame ${frameIndex} not found`);
   await this.ensureRuntimeEnabled();
   const ctxId = this._executionContexts.get(frame.frameId);
   const { buildEvaluateExpression } = await import('./opencli/utils.js');
   const expression = buildEvaluateExpression(js, []);
   // 优先用 executionContextId（支持跨域 OOPIF）
   if (ctxId !== undefined) {
     const { session } = await this.session.pages.getSession(this.pageId);
     const result = await session.Runtime.evaluate({
       expression,
       contextId: ctxId,
       returnByValue: true,
       awaitPromise: true,
     });
     if (result.exceptionDetails) throw new Error('Frame eval: ' + (result.exceptionDetails.exception?.description ?? ''));
   return result.result?.value;
 }
 // P1-1: frameIndex=0 is the main frame — just evaluate directly
 if (frameIndex === 0) {
   return this.evaluate(js);
 }
// fallback: contentWindow.eval（仅同源 iframe，跨域会抛 SecurityError）
const wrapper = `(function() {
    const iframe = document.querySelectorAll('iframe')[${frameIndex - 1}];
    if (!iframe) throw new Error('Frame ${frameIndex} not found');
    if (!iframe.contentWindow) throw new Error('Frame ${frameIndex} has no contentWindow');
     try {
       return iframe.contentWindow.eval(${JSON.stringify(expression)});
     } catch (e) {
       if (e instanceof DOMException && e.name === 'SecurityError')
         throw new Error('Frame ${frameIndex} is cross-origin (OOPIF). executionContextCreated not yet received. Retry after navigation completes.');
       throw new Error('Frame ${frameIndex} eval failed: ' + e.message);
     }
   })()`;
   return this.evaluate(wrapper);
 }

 // ── private helpers ──
 // 2b.2: UnifiedPage 覆写 annotatedScreenshot — visual ref overlay by coordinates
 async annotatedScreenshot(options: ScreenshotOptions = {}): Promise<string> {
   const snapResult = await this.session.observe(this.pageId).snapshot();
   this.populateAxRefs(snapResult.refs);
   const { session } = await this.session.pages.getSession(this.pageId);
   const refCoords = await this.getRefCoordinates(session, snapResult.refs);
   await this.evaluate(this.installCoordOverlayJs(refCoords));
   try {
     return await this.screenshot({ ...options });
   } finally {
     const { removeVisualRefOverlayJs } = await import('./opencli/visual-refs.js');
     await this.evaluate(removeVisualRefOverlayJs()).catch(() => {});
   }
 }
 
 private async getRefCoordinates(
   session: any, refs: any
 ): Promise<Array<{ref: string; x: number; y: number; w: number; h: number}>> {
   const entries = [...refs.byRef].slice(0, 120);
   const results = await Promise.all(entries.map(async ([ref, entry]: [string, any]) => {
     try {
       const r = await session.DOM.getBoxModel({ backendNodeId: entry.backendNodeId });
       const quad = r.model?.content ?? r.model?.border;
       if (!quad || quad.length < 8) return null;
       const xs = [quad[0], quad[2], quad[4], quad[6]];
       const ys = [quad[1], quad[3], quad[5], quad[7]];
       const x1 = Math.min(...xs), x2 = Math.max(...xs);
       const y1 = Math.min(...ys), y2 = Math.max(...ys);
       return { ref, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
     } catch { return null; }
   }));
   return results.filter(Boolean) as any;
 }
 
 private installCoordOverlayJs(coords: Array<{ref: string; x: number; y: number; w: number; h: number}>): string {
   return `
     (() => {
       const OVERLAY_ID = '__opencli_visual_ref_overlay';
       document.getElementById(OVERLAY_ID)?.remove();
       const overlay = document.createElement('div');
       overlay.id = OVERLAY_ID;
       overlay.setAttribute('aria-hidden', 'true');
       Object.assign(overlay.style, {
         position: 'fixed', inset: '0', zIndex: '2147483647',
         pointerEvents: 'none',
         fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
       });
       const coords = ${JSON.stringify(coords)};
       for (const c of coords) {
         if (c.w < 2 || c.h < 2) continue;
         const box = document.createElement('div');
         Object.assign(box.style, {
           position: 'fixed', left: c.x + 'px', top: c.y + 'px',
           width: c.w + 'px', height: c.h + 'px',
           border: '2px solid #ff3b30', borderRadius: '4px',
           boxSizing: 'border-box',
           background: 'rgba(255,59,48,.08)',
         });
         const badge = document.createElement('div');
         badge.textContent = c.ref;
         Object.assign(badge.style, {
           position: 'fixed', left: c.x + 'px', top: Math.max(0, c.y - 20) + 'px',
           minWidth: '18px', height: '18px', padding: '0 5px',
           borderRadius: '999px', border: '1px solid rgba(255,255,255,.95)',
           background: '#ff3b30', color: '#fff', fontSize: '12px',
           fontWeight: '700', lineHeight: '18px', textAlign: 'center',
         });
         overlay.appendChild(box);
         overlay.appendChild(badge);
       }
       document.documentElement.appendChild(overlay);
     })()
   `;
 }
 
 // 2b.1: compound 后处理
private async collectCompoundInfo(): Promise<Map<string, any>> {
  const { COMPOUND_INFO_JS } = await import('./opencli/compound.js');
  // P1-1 fix: match by backendNodeId, not by name string
  // DOM getAttribute('name') != AX accessible name, so name matching is unreliable
  const { session } = await this.session.pages.getSession(this.pageId);
  const map = new Map();
  const fnDecl = 'function() {\n' + COMPOUND_INFO_JS + '\nreturn compoundInfoOf(this);\n}';
  // Check each AX ref: resolve backendNodeId → objectId → callFunctionOn
  const entries = [...this._axRefs.entries()];
  const results = await Promise.all(entries.map(async ([ref, entry]: [string, any]) => {
    try {
      const resolved = await session.DOM.resolveNode({ backendNodeId: entry.backendNodeId });
      const objectId = resolved.object?.objectId;
      if (!objectId) return null;
      const r = await session.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: fnDecl,
        returnByValue: true,
      });
      if (r.exceptionDetails) return null;
      const info = r.result?.value;
      if (!info) return null;
      return { ref, info };
    } catch { return null; }
  }));
  for (const r of results) {
    if (r) map.set(r.ref, r.info);
  }
  return map;
}
 
 private mergeCompoundIntoSnapshot(text: string, compound: Map<string, any>): string {
   if (compound.size === 0) return text;
   return text.replace(/\[ref=(e\d+)\]/g, (match, ref) => {
     const info = compound.get(ref);
     if (!info) return match;
     let desc = '';
     if (info.control === 'select') {
       const opts = info.options?.slice(0, 5).map(o => o.label).join('/') ?? '';
       desc = `select, ${info.options_total} options${info.multiple ? ' (multi)' : ''}, current: ${info.current || 'none'}${opts ? ', e.g. ' + opts : ''}`;
     } else if (info.control === 'file') {
       desc = `file${info.multiple ? ' (multi)' : ''}${info.accept ? ', accept: ' + info.accept : ''}`;
     } else {
       desc = `${info.control}, format: ${info.format}, current: ${info.current || 'none'}`;
     }
     return `${match} [compound: ${desc}]`;
   });
 }
 
 // 2b.4.1: executionContext tracking for cross-origin OOPIF eval
 private async ensureRuntimeEnabled(): Promise<void> {
   if (this._ctxEventSub) return;
   const { sessionId, session } = await this.session.pages.getSession(this.pageId);
   // 先订阅，确保不遗漏事件
  this._ctxEventSub = this.cdpBackend.onSessionEvent(
    'Runtime.executionContextCreated',
    (params: any, sid: string) => {
      if (sid !== sessionId) return;
      const ctx = params;
      // P0-2: only accept isDefault context (avoid extension context overwriting page context)
      if (ctx.context?.auxData?.frameId && ctx.context?.auxData?.isDefault) {
        this._executionContexts.set(ctx.context.auxData.frameId, ctx.context.id);
      }
    }
  );
  // Also subscribe to context destruction to avoid stale contextId
  this._ctxEventSub2 = this.cdpBackend.onSessionEvent(
    'Runtime.executionContextDestroyed',
    (params: any, sid: string) => {
      if (sid !== sessionId) return;
      const ctx = params;
      if (ctx.context?.auxData?.frameId && ctx.context?.auxData?.isDefault) {
        this._executionContexts.delete(ctx.context.auxData.frameId);
      }
    }
  );
  // P0-1: disable first to force CDP to resend all existing execution contexts
  await session.Runtime.disable().catch(() => {});
  await session.Runtime.enable();
}

private clearExecutionContexts(): void {
  this._executionContexts.clear();
  this._ctxEventSub?.();
  this._ctxEventSub = null;
  this._ctxEventSub2?.();
  this._ctxEventSub2 = null;
}

 private populateAxRefs(refs: any): void {
    for (const [ref, entry] of refs.byRef) {
      this._axRefs.set(ref, {
        ref,
        backendNodeId: entry.backendNodeId,
        role: entry.role,
        name: entry.name,
        nth: entry.nth,
        frame: entry.frameId
          ? { frameId: entry.frameId, url: entry.frameUrl ?? undefined }
          : undefined,
      });
    }
  }

}
