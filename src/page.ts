import { BasePage, type AxActionChannel } from './opencli/base-page.js';
import { callOnElement, getElementCenter, scrollIntoView } from '@browseros/browser-core/core/input/geometry';
import { generateStealthJs } from './opencli/stealth.js';
import { applyUserAgentOverride } from './opencli/ua-override.js';
import type { BrowserSession } from '@browseros/browser-core';
import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api';
import type { CdpBackend } from '@browseros/browser-core';
import type { BrowserEvaluateFunction, BrowserCookie, ScreenshotOptions, SnapshotOptions } from './opencli/types.js';
import { ConsoleCollector, NetworkCollector } from './event-bridge.js';

/**
 * B1 fix — observation collectors must outlive UnifiedPage instances.
 * The CLI rebuilds a page object per command and each MCP process caches its
 * own; collectors held on the instance (the old `_console`/`_network` fields)
 * died with it, silently zeroing captured history — the same class of bug
 * P2-8 fixed for AX refs (Observer.lastRefs on the BrowserSession singleton).
 * Keyed WeakMap on BrowserSession: alive as long as the process's connection.
 */
const consoleCollectors = new WeakMap<BrowserSession, Map<number, ConsoleCollector>>();
const networkCollectors = new WeakMap<BrowserSession, Map<number, NetworkCollector>>();
import { resolveCdpPort } from './cdp-port.js';

/**
 * Serialize registry-mutating browser operations on one BrowserSession.
 *
 * Real-browser race (2026-08-03): `spaces.restore()` runs concurrently with
 * the first tool call at hub.mjs startup. restore's live-tab list
 * (`pages.list()`) can interleave with a tool's `newPage()` — the concurrent
 * `PageManager.list()` picks up the just-created tab and assigns it a pageId,
 * while `newPage()` assigns a second pageId for the same tab (duplicate
 * targetId/tabId in the registry). Tools addressing either pageId then fail
 * with "Page N has no attached session". Serializing every UnifiedPage
 * registry operation (tabs/newTab/closeTab/selectTab) per session closes the
 * race for all hub-browser paths (CLI, daemon, MCP, restore gateway).
 */
function serialOp<T>(session: unknown, fn: () => Promise<T>): Promise<T> {
  const holder = session as { __hubOpChain?: Promise<unknown> }
  const chain = holder.__hubOpChain ?? Promise.resolve()
  // P1 (space.close hang): a wedged CDP call inside one tab op (observed:
  // Browser.closeTab occasionally never answers on the QuickBI page) left
  // the chain pending forever — every later tab op, including space.close,
  // queued behind a dead promise. Degrade a stuck op to a timeout error so
  // the chain keeps settling; the JS promise itself is not cancellable, so
  // a late CDP answer may still land, which closeTabBestEffort tolerates.
  const run = () => withDeadline(fn, TAB_OP_DEADLINE_MS, 'tab op')
  const next = chain.then(run, run)
  holder.__hubOpChain = next.catch(() => {})
  return next
}

/** Deadline for one serial tab op (open/close/select). */
const TAB_OP_DEADLINE_MS = 12_000

function withDeadline<T>(p: Promise<T> | (() => Promise<T>), ms: number, label: string): Promise<T> {
  const body = typeof p === 'function' ? p() : p
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms (wedged CDP call)`)),
      ms,
    )
    body.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export class UnifiedPage extends BasePage {
 private _stealthInjected = false;
  /**
   * sessionId of the CDP page session that already received the full-Chrome
   * UA override (Emulation.setUserAgentOverride is per-session). null until
   * the override has been applied to the current session. Reset never happens
   * manually: rebinding to another tab (selectTab/newTab/setActivePage) yields
   * a different sessionId, so ensureUserAgentOverride() re-applies naturally.
   */
  private _uaOverrideSessionId: string | null = null;
  /** Set when this tab's capture pipeline was detected wedged (screenshot hang). */
  private _screenshotWedged = false;

 private _executionContexts = new Map<string, number>();
private _ctxEventSub: (() => void) | null = null;
private _ctxEventSub2: (() => void) | null = null;

 constructor(
    private _browserSession: BrowserSession,
    private cdpBackend: CdpBackend,
    private pageId: number,
  ) {
    super();
  }


  /** Stable string identity for cli.js getPageSession / getPageScope. */
  get session(): string {
    return `page-${this.pageId}`;
  }

  /**
   * Ensure the full-Chrome UA override (Emulation.setUserAgentOverride) is
   * applied to this page's current CDP session. The override is per-session,
   * so we track the sessionId it was applied to: re-applying is skipped while
   * the page keeps the same CDP session (idempotent), and a different
   * sessionId (new tab / selectTab / setActivePage / re-attach) triggers a
   * fresh apply. Failure to apply is best-effort (returns false) and retried
   * on the next call — the caller's navigation proceeds regardless.
   */
  async ensureUserAgentOverride(): Promise<boolean> {
    const { sessionId, session } = await this._browserSession.pages.getSession(this.pageId);
    if (this._uaOverrideSessionId === sessionId) return true;
    const applied = await applyUserAgentOverride(session);
    if (applied) this._uaOverrideSessionId = sessionId;
    return applied;
  }
  // ── evaluate (P0-3: two overloads + buildEvaluateExpression) ──
  async evaluate<T = unknown>(js: string): Promise<T>;
  async evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>;
  async evaluate(input: string | BrowserEvaluateFunction<unknown[], unknown>, ...args: unknown[]): Promise<unknown> {
    const { buildEvaluateExpression, hasTopLevelAwait } = await import('./opencli/utils.js');
    const expression = buildEvaluateExpression(input as string, args);
    const { session } = await this._browserSession.pages.getSession(this.pageId);
    const result = await session.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
      // Top-level await is a SyntaxError outside modules; replMode lets the
      // evaluation accept it (DevTools-console mechanism).
      ...(hasTopLevelAwait(expression) && { replMode: true }),
    });
    if (result.exceptionDetails) {
      throw new Error('Evaluate: ' + (result.exceptionDetails.exception?.description ?? ''));
    }
    return result.result?.value;
  }

  // ── goto ──
async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number; allowBoundNavigation?: boolean }): Promise<void> {
   // P2 (方案 1): ensure the full-Chrome UA override is active before the next
   // document loads. Idempotent — a no-op while the page keeps the same CDP
   // session (the override persists across same-session navigations), and only
   // re-applies when this page rebinds to a new session (new tab / re-attach).
   await this.ensureUserAgentOverride();
   await this._browserSession.nav(this.pageId).goto(url);
   this._lastUrl = url;
   // Clear stale refs from previous page (prevent cross-page silent mis-click)
   this.resetPageState();
   // Navigation is not expected to reset a session-scoped emulation override,
   // but re-ensure after the load so a freshly attached session (or a browser
   // that did reset it) still carries the full-Chrome brand list for any
   // in-page fetches (e.g. zhihu /api/v4/questions/{id}/answers).
   await this.ensureUserAgentOverride();
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
    const result = await this._browserSession.cdpJsonForPage(this.pageId, 'Network.getCookies', params);
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
    // P1 fix: Page.captureScreenshot can hang via browser-level CdpBackend (Bun WebSocket
    // issue with large responses on browser-level sessions). Try CdpBackend first (5s
    // timeout), then fall back to a direct page-level WebSocket connection.
    // A/B verification (2026-08-03): retrying captureScreenshot on a wedged
    // renderer does not help — the primary call stays pending in CdpBackend for
    // up to CDP_REQUEST_TIMEOUT (60s), so extra attempts stack in-flight
    // captures on the same session and add latency without recovery. Keep one
    // clean primary attempt then one clean raw-WS fallback.
    const SCREENSHOT_TIMEOUT_MS = 5_000;
    let result: { data: string };
    try {
      result = await Promise.race([
        this.cdp('Page.captureScreenshot', {
          format: options.format ?? 'jpeg',
          quality: options.quality ?? 80,
          captureBeyondViewport: options.fullPage ?? false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), SCREENSHOT_TIMEOUT_MS)
        ),
      ]) as { data: string };
    } catch {
      // Fallback: direct page-level WebSocket (bypasses CdpBackend)
      try {
        result = await this.screenshotViaRawWebSocket(options) as { data: string };
      } catch {
        // Per-tab capture-pipeline wedge (verified 2026-08-03): Page.captureScreenshot
        // hangs on BOTH paths once a tab has accumulated renderer state. Reload does
        // not recover it; only a fresh tab does. Surface an actionable error instead
        // of a bare timeout so agents know to open a new tab (space.open_tab / tabs new).
        this._screenshotWedged = true;
        throw new Error(
          'Screenshot failed: this tab’s capture pipeline is wedged ' +
          '(Page.captureScreenshot timed out on both the CDP session and the raw page WebSocket). ' +
          'Reloading will not fix it — open a fresh tab (space.open_tab or tabs new) and retry.',
        );
      }
    }
    this._screenshotWedged = false;
    if (overrideWidth !== undefined || overrideHeight !== undefined) {
      await this.cdp('Emulation.clearDeviceMetricsOverride', {});
    }
    if (options.path) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(options.path, Buffer.from(result.data, 'base64'));
    }
    return result.data;
  }

  // ── tabs / selectTab / newTab / closeTab ──

  /**
   * Foreground this tab in its window (browser-level Browser.activateTab).
   *
   * Real-browser quirk (2026-08-03): Chrome does not service
   * `Input.dispatchMouseEvent` for a background/occluded tab — the renderer
   * stays silent and the CDP call never resolves (act scroll/hover/click on a
   * space.open_tab'd background tab hung for the full CDP request timeout).
   * Activation is best-effort: dispatch proceeds even if it fails, matching
   * the old foreground-tab behavior.
   */
  async activateTab(): Promise<void> {
    try {
      const tabId = this._browserSession.pages.getTabId(this.pageId)
      if (tabId !== undefined) {
        await this._browserSession.cdp('Browser.activateTab', { tabId })
        return
      }
      const info = this._browserSession.pages.getInfo(
        this.pageId,
      ) as { targetId?: string } | undefined
      if (info?.targetId) {
        await this._browserSession.cdp('Browser.activateTab', {
          targetId: info.targetId,
        })
      }
    } catch {
      // best-effort: continue with the dispatch
    }
  }

  async tabs(): Promise<unknown[]> {
    return serialOp(this._browserSession, async () => {
      const pages = await this._browserSession.pages.list();
      return pages.map((p: any) => ({ ...p, page: p.targetId }));
    })
  }

  async selectTab(target: number | string): Promise<void> {
    return serialOp(this._browserSession, () => this._selectTabInner(target))
  }

  /** F16 — bounded health probe for one tab. A tab whose renderer is hung
   * (zombie) still lists in the browser but never answers JS; every later
   * command on it would hang to its own timeout. Restore probes candidate
   * tabs through this instead of adopting them blind: the race fails fast
   * (PROBE_TIMEOUT) and the caller falls back to the reopen-by-URL path. */
  async probeTab(target: number | string): Promise<boolean> {
    try {
      const pages = await this._browserSession.pages.list();
      const tab = (pages as Array<{ pageId?: number; targetId?: string }>).find(
        (p) => (typeof target === 'number'
          ? p.pageId === target
          : p.targetId === String(target)),
      );
      if (!tab || typeof tab.pageId !== 'number') return false;
      const { session } = await this._browserSession.pages.getSession(tab.pageId);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('probe timeout')), 3_000);
        timer.unref?.();
        session.Runtime.evaluate({ expression: '1' }).then(() => resolve(), reject);
      });
      return true;
    } catch {
      return false;
    }
  }

  private async _selectTabInner(target: number | string): Promise<void> {
    const pages = await this._browserSession.pages.list();
    const page = typeof target === 'number'
      ? pages.find((p: any) => p.pageId === target)
      : pages.find((p: any) => p.targetId === String(target) || p.url.includes(String(target)));
    if (!page) {
      throw new Error(`Tab not found: ${target}`);
    }
    const previousPageId = this.pageId;
    this.pageId = (page as any).pageId;
    this.resetPageState();
    this._stealthInjected = false;
    this._screenshotWedged = false;
    await this.dropObservationCollectors(previousPageId);
    this.clearExecutionContexts();
    // Re-register stealth for the new tab's CDP session
    const { session } = await this._browserSession.pages.getSession(this.pageId);
    await session.Page.addScriptToEvaluateOnNewDocument({ source: generateStealthJs() });
    // P2: the new tab has a fresh CDP session — apply the full-Chrome UA
    // override (ensureUserAgentOverride sees a different sessionId).
    await this.ensureUserAgentOverride();
  }

  async newTab(
    url?: string,
    opts?: { background?: boolean; windowId?: number; tabGroupId?: string },
  ): Promise<string | undefined> {
    return serialOp(this._browserSession, () => this._newTabInner(url, opts))
  }

  private async _newTabInner(
    url?: string,
    opts?: { background?: boolean; windowId?: number; tabGroupId?: string },
  ): Promise<string | undefined> {
    const previousPageId = this.pageId;
    const newPageId = await this._browserSession.pages.newPage(url ?? 'about:blank', opts);
    this.pageId = newPageId;
    this.resetPageState();
    this._stealthInjected = false;
    this._screenshotWedged = false;
    await this.dropObservationCollectors(previousPageId);
    this.clearExecutionContexts();
    // Register stealth for the new tab's CDP session
    const { session } = await this._browserSession.pages.getSession(this.pageId);
    await session.Page.addScriptToEvaluateOnNewDocument({ source: generateStealthJs() });
    // P2: the new tab has a fresh CDP session — apply the full-Chrome UA
    // override before its first document finishes loading.
    await this.ensureUserAgentOverride();
    const info = this._browserSession.pages.getInfo(newPageId);
    return info?.targetId;
  }

  async closeTab(target?: number | string): Promise<void> {
    return serialOp(this._browserSession, () => this._closeTabInner(target))
  }

  private async _closeTabInner(target?: number | string): Promise<void> {
    const pages = await this._browserSession.pages.list();
    let pageId: number | undefined;
    if (typeof target === 'number') {
      pageId = pages.find((p: any) => p.pageId === target)?.pageId;
    } else if (typeof target === 'string') {
      pageId = pages.find((p: any) => p.targetId === target || p.url.includes(target))?.pageId;
    }
    if (pageId === undefined) {
      throw new Error(`Tab not found: ${target}`);
    }
    await this._browserSession.pages.close(pageId);
    // If we closed the active tab, switch to the first remaining tab
    if (pageId === this.pageId) {
      const remaining = await this._browserSession.pages.list();
      if (remaining.length > 0) {
        const closedPageId = this.pageId;
        this.pageId = (remaining[0] as any).pageId;
        this.resetPageState();
        this._stealthInjected = false;
    this._screenshotWedged = false;
        // P2: rebound to a remaining tab whose CDP session may not carry the
        // full-Chrome UA override yet (idempotent per sessionId).
        await this.ensureUserAgentOverride();
        await this.dropObservationCollectors(closedPageId);
        this.clearExecutionContexts();
      }
    }
  }

  getActivePage(): string | undefined {
    return this._browserSession.pages.getInfo(this.pageId)?.targetId;
  }

  // ── Tab Group ──
  async tabGroupList(): Promise<unknown[]> {
    const result = await this.cdp('Browser.getTabGroups');
    return (result as any)?.groups ?? [];
  }

  async tabGroupCreate(pages: number[], title?: string): Promise<unknown> {
    const allPages = await this._browserSession.pages.list();
    const tabIds = pages.map(pid => {
      const info = allPages.find((p: any) => p.pageId === pid);
      if (!info) throw new Error(`Page ${pid} not found`);
      return info.tabId;
    });
    const params: Record<string, unknown> = { tabIds };
    if (title) params.title = title;
    const result = await this.cdp('Browser.createTabGroup', params);
    return (result as any)?.group;
  }

  async tabGroupUpdate(groupId: string, opts: { title?: string; color?: string; collapsed?: boolean }): Promise<unknown> {
    const params: Record<string, unknown> = { groupId };
    if (opts.title !== undefined) params.title = opts.title;
    if (opts.color !== undefined) params.color = opts.color;
    if (opts.collapsed !== undefined) params.collapsed = opts.collapsed;
    const result = await this.cdp('Browser.updateTabGroup', params);
    return (result as any)?.group;
  }

  async tabGroupUngroup(pages: number[]): Promise<void> {
    const allPages = await this._browserSession.pages.list();
    const tabIds = pages.map(pid => {
      const info = allPages.find((p: any) => p.pageId === pid);
      if (!info) throw new Error(`Page ${pid} not found`);
      return info.tabId;
    });
    await this.cdp('Browser.removeTabsFromGroup', { tabIds });
  }

  async tabGroupClose(groupId: string): Promise<void> {
    await this.cdp('Browser.closeTabGroup', { groupId });
  }

  /** D5 (2026-08-03): move existing tabs into a tab group (space → group wiring). */
  async addTabsToGroup(pages: number[], groupId: string): Promise<void> {
    const allPages = await this._browserSession.pages.list();
    const tabIds = pages.map(pid => {
      const info = allPages.find((p: any) => p.pageId === pid);
      if (!info) throw new Error(`Page ${pid} not found`);
      return info.tabId;
    });
    await this.cdp('Browser.addTabsToGroup', { groupId, tabIds });
  }


  // ── Window ──
  async windowList(): Promise<unknown[]> {
    const result = await this.cdp('Browser.getWindows');
    return (result as any)?.windows ?? [];
  }

  async windowCreate(): Promise<unknown> {
    const result = await this.cdp('Browser.createWindow');
    return (result as any)?.window;
  }

  async windowClose(windowId: number): Promise<void> {
    await this.cdp('Browser.closeWindow', { windowId });
  }

  async windowActivate(windowId: number): Promise<void> {
    await this.cdp('Browser.activateWindow', { windowId });
  }

  /** Bind the page object to a specific tab by targetId. */
  async setActivePage(targetId?: string): Promise<void> {
    if (!targetId) return;
    const current = this._browserSession.pages.getInfo(this.pageId);
    if (current?.targetId === targetId) return;
    const pages = await this._browserSession.pages.list();
    const match = pages.find((p: any) => p.targetId === targetId);
    if (!match) throw new Error(`Tab not found: ${targetId}`);
    const previousPageId = this.pageId;
    this.pageId = (match as any).pageId;
    this.resetPageState();
    this._stealthInjected = false;
    this._screenshotWedged = false;
    // P2: the newly-bound tab has its own CDP session — apply the full-Chrome
    // UA override (idempotent per sessionId).
    await this.ensureUserAgentOverride();
    await this.dropObservationCollectors(previousPageId);
    this.clearExecutionContexts();
  }

  /** Close CDP connection and release all resources. */
  async close(): Promise<void> {
    this.clearExecutionContexts();
    await this.dropObservationCollectors(this.pageId);
    await this._browserSession?.dispose?.();
    await this.cdpBackend?.disconnect?.();
  }

  // ── CDP escape hatch ──
  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this._browserSession.cdpJsonForPage(this.pageId, method, JSON.stringify(params ?? {}));
  }

  // ── AX action channel (P2-8 primitive sinking) ──
  // Adapter over browser-core's Input/Observer/geometry — the single trusted
  // action surface that BasePage's AX-ref fast paths ride on. Element-scoped
  // actions resolve the ref through the page's Observer (stale refs are
  // re-identified by role/name/nth) and dispatch on the element's own frame
  // session, which is what fixes OOPIF input dispatch. Cached per page.
  private _axChannel: AxActionChannel | null | undefined;

  protected override axChannel(): AxActionChannel | null {
    if (this._axChannel !== undefined) return this._axChannel;
    const session = this._browserSession;
    const observer = session.observe(this.pageId);
    const input = () => session.input(this.pageId);
    this._axChannel = {
      hasRef: (ref) => observer.lastRefs.get(ref) !== undefined,
      click: (ref, opts) => input().click(ref, opts),
      hover: (ref) => input().hover(ref),
      focus: (ref) => input().focus(ref),
      fill: (ref, value, opts) => input().fill(ref, value, opts),
      check: (ref) => input().check(ref),
      uncheck: (ref) => input().uncheck(ref),
      uploadFile: (ref, files) => input().uploadFile(ref, files),
      dragRefs: async (source, target) => {
        await input().drag(source, target);
      },
      scrollIntoViewRef: async (ref) => {
        const { session: frameSession, backendNodeId } = await observer.resolveRef(ref);
        await scrollIntoView(frameSession, backendNodeId);
      },
      readState: async (ref, expr) => {
        const { session: frameSession, backendNodeId } = await observer.resolveRef(ref);
        return callOnElement(frameSession, backendNodeId, expr);
      },
      clickAt: (x, y, opts) => input().clickAt(x, y, opts),
      hoverAt: (x, y) => input().hoverAt(x, y),
      dragAt: (from, to) => input().dragAt(from, to),
      typeText: (text) => input().type(text),
      press: (key, modifiers) => {
        const combo = modifiers?.length ? `${modifiers.join('+')}+${key}` : key;
        return input().press(combo);
      },
      centerRef: async (ref) => {
        const { session: frameSession, backendNodeId } = await observer.resolveRef(ref);
        try {
          return await getElementCenter(frameSession, backendNodeId);
        } catch {
          return null;
        }
      },
    };
    return this._axChannel;
  }

  // ── native input → BrowserOS neo Input (IPage surface; BasePage routes
  //    through axChannel() internally) ──
  async nativeClick(x: number, y: number): Promise<void> {
    await this._browserSession.input(this.pageId).clickAt(x, y);
  }

  async nativeType(text: string): Promise<void> {
    await this._browserSession.input(this.pageId).type(text);
  }

  async nativeKeyPress(key: string, modifiers?: string[]): Promise<void> {
    const combo = modifiers?.length ? `${modifiers.join('+')}+${key}` : key;
    await this._browserSession.input(this.pageId).press(combo);
  }

  async insertText(text: string): Promise<void> {
    const { session } = await this._browserSession.pages.getSession(this.pageId);
    await session.Input.insertText({ text });
  }

  /** Live CDP page session for event subscriptions (e.g. Page.downloadWillBegin). */
  async pageSession(): Promise<ProtocolApi> {
    const { session } = await this._browserSession.pages.getSession(this.pageId);
    return session;
  }

  /** True when this tab's capture pipeline was detected wedged by a screenshot hang. */
  isScreenshotWedged(): boolean {
    return this._screenshotWedged;
  }

  /**
   * Cheap capture-pipeline probe (TabFreshness canary, 2026-08-03).
   *
   * Runs `Page.captureScreenshot` with a tiny 16×16 clip (jpeg) so the probe
   * exercises the exact pipeline that per-tab wedges hang — NOT just the main
   * thread (Runtime.evaluate stays responsive on a wedged tab; only the
   * capture pipeline is stuck). A healthy tab answers in a few ms; a wedged
   * tab never answers and the call times out after `timeoutMs` (default
   * 2500ms — well under the 5s real-screenshot budget).
   *
   * Returns the elapsed milliseconds on success. On timeout/failure the tab
   * is marked wedged (same `_screenshotWedged` flag `screenshot()` uses) and
   * an error is thrown — the caller decides hint vs auto-recycle.
   */
  async canaryCapture(timeoutMs: number = 2500): Promise<number> {
    const started = Date.now();
    try {
      await Promise.race([
        this.cdp('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 60,
          clip: { x: 0, y: 0, width: 16, height: 16, scale: 1 },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
    } catch {
      // Same wedge semantics as screenshot(): a canary timeout means this tab's
      // capture pipeline is wedged (reload does not recover it — fresh tab only).
      this._screenshotWedged = true;
      throw new Error(
        'Canary screenshot failed: this tab’s capture pipeline is wedged ' +
          '(Page.captureScreenshot with a 16×16 clip timed out). ' +
          'Reloading will not fix it — open a fresh tab (space.open_tab or tabs new) and retry.',
      );
    }
    this._screenshotWedged = false;
    return Date.now() - started;
  }

  // ── selectOption (6.10 fork: act select routes through UnifiedPage) ──
  // Mirrors the click cascade: AX refs (eN, from MCP-style AX snapshots) resolve
  // through backendNodeId first; OpenCLI numeric refs fall back to the DOM
  // data-opencli-ref marker path.
  async selectOption(ref: string, value: string): Promise<unknown> {
    if (/^e?\d+$/.test(ref)) {
      // P2-8: the Observer's refs are the authority (they persist on the
      // browser session across per-command page rebuilds).
      const entry = this._browserSession.observe(this.pageId).lastRefs.get(ref);
      if (entry?.backendNodeId != null) {
        try {
          const { session } = await this._browserSession.pages.getSession(this.pageId);
          const resolved = await session.DOM.resolveNode({ backendNodeId: entry.backendNodeId });
          const objectId = resolved.object?.objectId;
          if (objectId) {
            const SELECT_OPTION_FN = `function(val){
  for(var i=0;i<this.options.length;i++){
    if(this.options[i].value===val||this.options[i].textContent.trim()===val){
      this.selectedIndex=i;
      this.dispatchEvent(new Event('change',{bubbles:true}));
      return this.options[i].textContent.trim();
    }
  }
  return null;
}`;
            const r = await session.Runtime.callFunctionOn({
              functionDeclaration: SELECT_OPTION_FN,
              objectId,
              returnByValue: true,
              arguments: [{ value }],
            });
            if (r.result?.value) return r.result.value;
          }
        } catch { /* fall through to the DOM marker path */ }
      }
    }
    const { resolveTargetJs, selectResolvedJs } = await import('./opencli/target-resolver.js');
    const script = `
      (() => {
        const resolution = (${resolveTargetJs(ref)});
        if (!resolution || !resolution.ok) return { error: resolution?.message ?? 'resolution failed' };
        return (${selectResolvedJs(value)});
      })()
    `;
    return this.evaluate(script);
  }

  // ── handleJavaScriptDialog (P1-8) ──
  async handleJavaScriptDialog(accept: boolean, promptText?: string): Promise<void> {
    await this._browserSession.input(this.pageId).handleDialog(accept, promptText);
  }

 // ── snapshot (P2: opts.source routing) ──
override async snapshot(opts?: SnapshotOptions): Promise<unknown> {
  if (opts?.source === 'dom') {
    // Cap viewportExpand to avoid collecting too many elements on large pages
    const cappedOpts = { ...opts, viewportExpand: Math.min(opts?.viewportExpand ?? 2000, 1000) };
    const DOM_SNAPSHOT_TIMEOUT_MS = 15_000;
    try {
      return await Promise.race([
        super.snapshot(cappedOpts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`DOM snapshot timed out after ${DOM_SNAPSHOT_TIMEOUT_MS}ms`)), DOM_SNAPSHOT_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      if (process.env.DEBUG_SNAPSHOT) {
        process.stderr.write(`[snapshot] DOM snapshot failed, falling back to AX observer: ${(err as Error)?.message?.slice(0, 200)}\n`);
      }
      // Fall through to AX observer-based snapshot below
    }
  }
  const result = await this._browserSession.observe(this.pageId).snapshot();
   // 2b.1: compound 后处理
   const compound = await this.collectCompoundInfo();
   return this.mergeCompoundIntoSnapshot(result.text, compound);
 }

  async diff(): Promise<unknown> {
    return this._browserSession.observe(this.pageId).diff();
  }

  // P3-5 — deep-probe one snapshot ref's backing element (full classes/
  // attributes, ancestor path, verified candidate selectors, outerHTML head).
  async inspectRef(ref: string): Promise<unknown> {
    return this._browserSession.observe(this.pageId).inspectRef(ref);
  }

  // ── console messages (event-bridge, B1: session-scoped collector) ──
  override async consoleMessages(level: string = 'all'): Promise<unknown[]> {
    const collector = await this.ensureConsoleCollector();
    return collector.get(level);
  }

  private async ensureConsoleCollector(): Promise<ConsoleCollector> {
    let byPage = consoleCollectors.get(this._browserSession);
    if (!byPage) {
      byPage = new Map();
      consoleCollectors.set(this._browserSession, byPage);
    }
    let collector = byPage.get(this.pageId);
    if (!collector) {
      const { sessionId } = await this._browserSession.pages.getSession(this.pageId);
      collector = new ConsoleCollector(this.cdpBackend, sessionId);
      byPage.set(this.pageId, collector);
    }
    await collector.start(); // idempotent
    return collector;
  }

  // ── network capture (event-bridge, B1: session-scoped collector) ──
  async startNetworkCapture(pattern: string = ''): Promise<boolean> {
    const collector = await this.ensureNetworkCollector();
    await collector.start(pattern);
    return true;
  }

  /**
   * A2 fix — start capture if it is idle, so a bare `network` query never
   * reports "Captured 0 requests" just because nobody started the collector.
   * Returns true when capture was started by THIS call (the caller surfaces
   * a hint that only requests from now on are visible).
   */
  async ensureNetworkCapture(): Promise<boolean> {
    const collector = await this.ensureNetworkCollector();
    const wasIdle = !collector.capturing;
    await collector.start('');
    return wasIdle;
  }

  private async ensureNetworkCollector(): Promise<NetworkCollector> {
    let byPage = networkCollectors.get(this._browserSession);
    if (!byPage) {
      byPage = new Map();
      networkCollectors.set(this._browserSession, byPage);
    }
    let collector = byPage.get(this.pageId);
    if (!collector) {
      const { sessionId } = await this._browserSession.pages.getSession(this.pageId);
      collector = new NetworkCollector(this.cdpBackend, sessionId);
      byPage.set(this.pageId, collector);
    }
    return collector;
  }

  async readNetworkCapture(): Promise<unknown[]> {
    // Only an already-running collector has history; starting one here would
    // be a silent side effect on a read path (and still see zero requests).
    const collector = networkCollectors.get(this._browserSession)?.get(this.pageId);
    return collector?.read() ?? [];
  }

  /** Stop and forget the observation collectors of a page (tab switched away/closed). */
  private async dropObservationCollectors(pageId: number): Promise<void> {
    const cm = consoleCollectors.get(this._browserSession);
    const consoleCollector = cm?.get(pageId);
    if (consoleCollector) {
      consoleCollector.stop();
      cm!.delete(pageId);
    }
    const nm = networkCollectors.get(this._browserSession);
    const networkCollector = nm?.get(pageId);
    if (networkCollector) {
      await networkCollector.stop();
      nm!.delete(pageId);
    }
  }

  // ── frames (wujie iframe support) ──
  async frames(): Promise<
    Array<{ index: number; frameId: string; url: string; name: string; kind: 'main' | 'same-origin' | 'cross-origin' }>
  > {
    const { session } = await this._browserSession.pages.getSession(this.pageId);
    const result = await session.Page.getFrameTree();
    const tree = (result as any).frameTree;
    const list: Array<
      { index: number; frameId: string; url: string; name: string; kind: 'main' | 'same-origin' | 'cross-origin' }
    > = [];
    let index = 0;
    const originOf = (url: string): string => {
      try {
        return new URL(url).origin;
      } catch {
        return url;
      }
    };
    const walk = (node: any) => {
      if (!node?.frame) return;
      const url = node.frame.url || '';
      let kind: 'main' | 'same-origin' | 'cross-origin' = 'main';
      if (index > 0) {
        const mainUrl = tree?.frame?.url || '';
        kind = originOf(url) === originOf(mainUrl) ? 'same-origin' : 'cross-origin';
      }
      list.push({
        index: index++,
        frameId: node.frame.id || '',
        url,
        name: node.frame.name || '',
        kind,
      });
      for (const child of node.childFrames || []) walk(child);
    };
    walk(tree);
    return list;
  }

 // ── evaluateInFrame (wujie iframe support; A1: frames -> evaluate contract) ──
 async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
   const frames = await this.frames();
   const frame = frames[frameIndex];
   if (!frame) throw new Error(`Frame ${frameIndex} not found`);
   // A1: deterministic path — resolve the frame's own CDP session (page
   // session for same-origin frames, a dedicated session for OOPIF) and
   // evaluate inside a fresh isolated world. Works for both origins; the
   // legacy fallbacks below only cover same-origin frames.
   try {
     const target = this._browserSession.frameTarget(this.pageId, frame.frameId);
     const world = await target.session.Page.createIsolatedWorld({
       frameId: frame.frameId,
       worldName: 'hub-evaluate',
       grantUniveralAccess: false,
     });
     if (world.executionContextId !== undefined) {
       const { buildEvaluateExpression, hasTopLevelAwait } = await import('./opencli/utils.js');
       const expression = buildEvaluateExpression(js, []);
       const result = await target.session.Runtime.evaluate({
         expression,
         contextId: world.executionContextId,
         returnByValue: true,
         awaitPromise: true,
         ...(hasTopLevelAwait(expression) && { replMode: true }),
       });
       if (result.exceptionDetails) {
         throw new Error('Frame eval: ' + (result.exceptionDetails.exception?.description ?? ''));
       }
       return result.result?.value;
     }
   } catch (err) {
     if (frame.kind === 'cross-origin') {
       throw new Error(
         `Frame ${frameIndex} is cross-origin and its session could not be resolved: ` +
           `${(err as Error).message}`,
       );
     }
     // same-origin: fall through to the legacy paths below
   }
   await this.ensureRuntimeEnabled();
   const ctxId = this._executionContexts.get(frame.frameId);
   const { buildEvaluateExpression, hasTopLevelAwait } = await import('./opencli/utils.js');
   const expression = buildEvaluateExpression(js, []);
   // 优先用 executionContextId（支持跨域 OOPIF）
   if (ctxId !== undefined) {
     const { session } = await this._browserSession.pages.getSession(this.pageId);
     const result = await session.Runtime.evaluate({
       expression,
       contextId: ctxId,
       returnByValue: true,
       awaitPromise: true,
       ...(hasTopLevelAwait(expression) && { replMode: true }),
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
 override async annotatedScreenshot(options: ScreenshotOptions = {}): Promise<string> {
   const snapResult = await this._browserSession.observe(this.pageId).snapshot();
   const { session } = await this._browserSession.pages.getSession(this.pageId);
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
  const { session } = await this._browserSession.pages.getSession(this.pageId);
  const map = new Map();
  const fnDecl = 'function() {\n' + COMPOUND_INFO_JS + '\nreturn compoundInfoOf(this);\n}';
  // Check each AX ref: resolve backendNodeId → objectId → callFunctionOn
  // (P2-8: iterate the Observer's refs — the single ref authority.)
  const entries = [...this._browserSession.observe(this.pageId).lastRefs.byRef.entries()];
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
       const opts = info.options?.slice(0, 5).map((o: { label?: string }) => o.label).join('/') ?? '';
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
 private async screenshotViaRawWebSocket(options: ScreenshotOptions = {}): Promise<{ data: string }> {
    const port = resolveCdpPort();
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
    const pageInfo = this._browserSession.pages.getInfo(this.pageId);
    const target = pages.find((p: any) => p.targetId === pageInfo?.targetId)
      ?? pages.find((p: any) => p.type === 'page' && p.url.includes(this._lastUrl ?? ''));
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('Screenshot fallback: no page WebSocket URL');
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Screenshot fallback timed out')); }, 10_000);
      let msgId = 0;
      const send = (method: string, params?: any) => { const id = ++msgId; ws.send(JSON.stringify({ id, method, params })); return id; };
      ws.onopen = () => { send('Page.enable'); };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.id === 1) { send('Page.captureScreenshot', { format: options.format ?? 'jpeg', quality: options.quality ?? 80, captureBeyondViewport: options.fullPage ?? false }); }
        else if (msg.id === 2) { clearTimeout(timeout); ws.close(); if (msg.error) reject(new Error('CDP: ' + msg.error.message)); else resolve(msg.result); }
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket error')); };
    });
  }

 private async ensureRuntimeEnabled(): Promise<void> {
   if (this._ctxEventSub) return;
   const { sessionId, session } = await this._browserSession.pages.getSession(this.pageId);
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
}
