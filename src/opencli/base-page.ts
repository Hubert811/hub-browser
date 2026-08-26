/**
 * BasePage — shared IPage method implementations for DOM helpers.
 *
 * Both Page (daemon-backed) and CDPPage (direct CDP) execute JS the same way
 * for DOM operations. This base class deduplicates ~200 lines of identical
 * click/type/scroll/wait/snapshot/interceptor methods.
 *
 * Subclasses implement the transport-specific methods: goto, evaluate,
 * getCookies, screenshot, tabs, etc.
 */

import type { BrowserCookie, BrowserEvaluateFunction, FetchJsonOptions, IPage, ScreenshotOptions, SnapshotOptions, WaitOptions } from './types.js';
import { generateSnapshotJs, getFormStateJs } from './dom-snapshot.js';
import {
  pressKeyJs,
  waitForTextJs,
  waitForCaptureJs,
  waitForSelectorJs,
  scrollJs,
  autoScrollJs,
  networkRequestsJs,
  waitForDomStableJs,
} from './dom-helpers.js';
import {
  resolveTargetJs,
  boundingRectResolvedJs,
  clickResolvedJs,
  typeResolvedJs,
  prepareNativeTypeResolvedJs,
  verifyFilledResolvedJs,
  scrollResolvedJs,
  type FillResolvedResult,
  type ResolveOptions,
  type TargetMatchLevel,
} from './target-resolver.js';
import { TargetError, type TargetErrorCode } from './target-errors.js';
import { CliError } from './errors.js';
import { formatSnapshot } from './snapshotFormatter.js';
import { installVisualRefOverlayJs, removeVisualRefOverlayJs } from './visual-refs.js';

export interface ResolveSuccess {
  matches_n: number;
  /**
   * Cascading stale-ref tier the resolver traversed. Callers surface this to
   * agents so `stable` / `reidentified` hits are visibly distinct from a
   * clean `exact` match — the page changed, the action still succeeded.
   */
  match_level: TargetMatchLevel;
}

export interface FillTextResult extends ResolveSuccess {
  filled: boolean;
  verified: boolean;
  expected: string;
  actual: string;
  length: number;
  mode?: 'input' | 'textarea' | 'contenteditable';
}

export interface SetCheckedResult extends ResolveSuccess {
  checked: boolean;
  changed: boolean;
  kind?: string;
}

export interface UploadFilesResult extends ResolveSuccess {
  uploaded: boolean;
  files: number;
  file_names: string[];
  target: string;
  multiple?: boolean;
  accept?: string;
}

export interface DragResult {
  dragged: boolean;
  source: string;
  target: string;
  source_matches_n: number;
  target_matches_n: number;
  source_match_level: TargetMatchLevel;
  target_match_level: TargetMatchLevel;
}

/**
 * Browser-core action surface for AX refs (P2-8 primitive sinking).
 *
 * The subclass with CDP access (UnifiedPage) returns an adapter over
 * browser-core's Input/Observer/geometry — element-scoped actions resolve the
 * ref (with stale-ref re-identification by role/name/nth) and dispatch on the
 * element's own frame session; coordinate actions dispatch the same trusted
 * CDP input events at viewport positions. BasePage keeps ZERO browser-core
 * imports: this structural interface is the whole contract, which keeps
 * opencli-engine portable (it is vendored standalone into dist).
 *
 * The base class prefers this channel whenever the ref is a live AX ref the
 * channel's Observer knows (`eN` from an AX snapshot); DOM-selector refs
 * (`h1`, `@3`, bare numeric state refs) keep the page-JS resolver path — that
 * is the opencli-adapter compatibility surface with the full TargetError
 * contract.
 */
export interface AxActionChannel {
  /**
   * Whether `ref` is a live AX ref the channel's Observer knows. The Observer
   * (persisted on the browser session) is the single ref authority — NOT a
   * per-page-instance mirror — because CLI commands rebuild the page object
   * per invocation while the session's refs survive.
   */
  hasRef(ref: string): boolean;
  /** Click the element; `clickCount: 2` for dblclick. Trusted input dispatch, js-click fallback on missing geometry. */
  click(ref: string, opts?: { clickCount?: number }): Promise<void>;
  hover(ref: string): Promise<void>;
  focus(ref: string): Promise<void>;
  /** Click-focus the element, optionally clear, then type. Real key events. */
  fill(ref: string, value: string, opts?: { clear?: boolean }): Promise<void>;
  check(ref: string): Promise<boolean>;
  uncheck(ref: string): Promise<boolean>;
  /** Set local file paths on a file input via CDP DOM.setFileInputFiles. */
  uploadFile(ref: string, files: string[]): Promise<void>;
  dragRefs(sourceRef: string, targetRef: string): Promise<void>;
  scrollIntoViewRef(ref: string): Promise<void>;
  /**
   * Evaluate `expr` (a `function(){ ... this ... }` string) on the resolved
   * element and return its value — the element-state probe primitive.
   */
  readState(ref: string, expr: string): Promise<unknown>;
  /** Viewport-coordinate actions for the DOM-resolver path's native fallbacks. */
  clickAt(x: number, y: number, opts?: { clickCount?: number }): Promise<void>;
  hoverAt(x: number, y: number): Promise<void>;
  dragAt(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  /** Type into whatever currently holds focus (no ref). */
  typeText(text: string): Promise<void>;
  press(key: string, modifiers?: string[]): Promise<void>;
  /** Center point of the resolved element, or null when it has no geometry. */
  centerRef(ref: string): Promise<{ x: number; y: number } | null>;
}

/** Shared checkable-state shape for the DOM probe and the AX-channel probe. */
interface CheckableState {
  ok?: boolean;
  checked?: boolean;
  disabled?: boolean;
  kind?: string;
  reason?: string;
  tag?: string;
  role?: string;
}

// ── Element-state probes for the AX channel (P2-8) ──
// readState evaluates these as `function(){ ... this ... }` on the resolved
// element (browser-core callOnElement), mirroring the DOM-path probes
// (readCheckableState / prepareNativeTypeResolvedJs / verifyFilledResolvedJs).

const CHECKABLE_STATE_EXPR = `function(){
  const el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not_checkable' };
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    return { ok: true, checked: !!el.checked, disabled: !!el.disabled, kind: type };
  }
  if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox' || role === 'radio' || role === 'menuitemradio') {
    const aria = (el.getAttribute('aria-checked') || '').toLowerCase();
    return {
      ok: true,
      checked: aria === 'true' || aria === 'mixed',
      disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
      kind: role,
    };
  }
  return { ok: false, reason: 'not_checkable', tag, role };
}`;

const FILE_INPUT_STATE_EXPR = `function(){
  const el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not_file_input' };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (tag !== 'input' || type !== 'file') return { ok: false, reason: 'not_file_input', tag, type };
  return { ok: true, multiple: !!el.multiple, accept: el.getAttribute('accept') || '' };
}`;

const FILE_NAMES_EXPR = `function(){
  const names = [];
  try {
    if (this && this.files) { for (let i = 0; i < this.files.length; i++) names.push(this.files[i].name || ''); }
  } catch (_) {}
  return names;
}`;

function fillVerifyExpr(expected: string): string {
  return `function(){
    const el = this;
    if (!el) return { ok: false, reason: 'no_element' };
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const isInput = el instanceof HTMLInputElement;
    const isTextarea = el instanceof HTMLTextAreaElement;
    const mode = el.isContentEditable ? 'contenteditable' : isTextarea ? 'textarea' : isInput ? 'input' : '';
    if (!mode) return { ok: false, reason: 'not_editable', tag };
    const actual = mode === 'contenteditable' ? (el.innerText || '') : String(el.value || '');
    return { ok: actual === ${JSON.stringify(expected)}, actual, length: actual.length, mode };
  }`;
}

const TARGET_INFO_EXPR = `function(){
  return { tag: this.tagName ? this.tagName.toLowerCase() : '', text: (this.textContent || '').trim().slice(0, 80) };
}`;

/**
 * Execute `resolveTargetJs` once, throw structured `TargetError` on failure.
 * Single helper so click/typeText/scrollTo share one resolution pathway,
 * which is what the selector-first contract promises agents.
 */
async function runResolve(
  page: { evaluate(js: string): Promise<unknown> },
  ref: string,
  opts: ResolveOptions = {},
): Promise<ResolveSuccess> {
  const resolution = (await page.evaluate(resolveTargetJs(ref, opts))) as
    | { ok: true; matches_n: number; match_level: TargetMatchLevel }
    | { ok: false; code: TargetErrorCode; message: string; hint: string; candidates?: string[]; matches_n?: number };
  if (!resolution.ok) {
    const r = resolution as { ok: false; code: any; message: string; hint: string; candidates?: string[]; matches_n?: number };
    throw new TargetError({
      code: r.code,
      message: r.message,
      hint: r.hint,
      candidates: r.candidates,
      matches_n: r.matches_n,
    });
  }
  return { matches_n: resolution.matches_n, match_level: resolution.match_level };
}

function previewText(text: string | undefined): string | undefined {
  const preview = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return preview ? `Response preview: ${preview}` : undefined;
}

function parseKeyChord(rawKey: string): { key: string; modifiers: string[] } {
  const parts = rawKey.split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return { key: rawKey, modifiers: [] };

  const modifiers: string[] = [];
  for (const token of parts.slice(0, -1)) {
    const normalized = token.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control') modifiers.push('Ctrl');
    else if (normalized === 'cmd' || normalized === 'command' || normalized === 'meta') modifiers.push('Meta');
    else if (normalized === 'option' || normalized === 'alt') modifiers.push('Alt');
    else if (normalized === 'shift') modifiers.push('Shift');
    else return { key: rawKey, modifiers: [] };
  }

  const key = parts.at(-1);
  return key ? { key, modifiers } : { key: rawKey, modifiers: [] };
}

export abstract class BasePage implements IPage {
  protected _lastUrl: string | null = null;
  /** Cached previous snapshot hashes for incremental diff marking */
  protected _prevSnapshotHashes: string | null = null;
  private _cdpTargetMarkerSeq = 0;

  /**
   * Browser-core action surface for AX refs — see AxActionChannel. Returns
   * null on the base class; subclasses with CDP access override this. P2-8:
   * AX-ref actions ride this channel instead of hub-side page-JS resolution,
   * which fixes OOPIF input dispatch (events now go through the element's own
   * frame session) and drops the duplicated hub geometry/dispatch code.
   */
  protected axChannel(): AxActionChannel | null {
    return null;
  }

  /**
   * True when `ref` is a live AX ref (`eN`) the channel's Observer knows.
   * The format check is cheap; validity is the channel's call because the
   * Observer persists on the browser session across page-instance rebuilds.
   */
  protected isAxRef(ref: string): boolean {
    const channel = this.axChannel();
    return channel !== null && /^e?\d+$/.test(ref) && channel.hasRef(ref);
  }

  /** The action channel when `ref` is a live AX ref, else null. */
  protected axChannelForRef(ref: string): AxActionChannel | null {
    return this.isAxRef(ref) ? this.axChannel() : null;
  }

  protected resetPageState(): void {
    this._prevSnapshotHashes = null;
    this._lastUrl = null;
  }

  // ── Transport-specific methods (must be implemented by subclasses) ──

  abstract goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number; allowBoundNavigation?: boolean }): Promise<void>;
  abstract evaluate<T = unknown>(js: string): Promise<T>;
  abstract evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>;

  /**
   * Safely evaluate JS with pre-serialized arguments.
   * Each key in `args` becomes a `const` declaration with JSON-serialized value,
   * wrapped in a lexical block to avoid polluting the global execution context.
   *
   * Why a block: Chrome's Runtime.evaluate shares a single global context per page.
   * Top-level `const` declarations persist across calls, so re-declaring the same
   * variable name (e.g. `markerAttr` in both click resolution and file upload)
   * throws "SyntaxError: Identifier has already been declared". A block keeps
   * the args scoped without forcing callers to pass expression-only code.
   *
   * Usage:
   *   page.evaluateWithArgs(`(async () => { return sym; })()`, { sym: userInput })
   */
  async evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown> {
    const declarations = Object.entries(args)
      .map(([key, value]) => {
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
          throw new Error(`evaluateWithArgs: invalid key "${key}"`);
        }
        return `const ${key} = ${JSON.stringify(value)};`;
      })
      .join('\n');
    return this.evaluate(`{\n${declarations}\n${js}\n}`);
  }

  async fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
    const request = {
      url,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      body: opts.body,
      hasBody: opts.body !== undefined,
      timeoutMs: opts.timeoutMs ?? 15_000,
    };

    const result = await this.evaluateWithArgs(`
      (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), request.timeoutMs);
        try {
          const headers = { Accept: 'application/json', ...request.headers };
          const init = {
            method: request.method,
            credentials: 'include',
            headers,
            signal: ctrl.signal,
          };
          if (request.hasBody) {
            if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
              headers['Content-Type'] = 'application/json';
            }
            init.body = JSON.stringify(request.body);
          }
          const resp = await fetch(request.url, init);
          const text = await resp.text();
          return {
            ok: resp.ok,
            status: resp.status,
            statusText: resp.statusText,
            url: resp.url,
            contentType: resp.headers.get('content-type') || '',
            text,
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            statusText: '',
            url: request.url,
            contentType: '',
            text: '',
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          clearTimeout(timer);
        }
      })()
    `, { request }) as {
      ok?: boolean;
      status?: number;
      statusText?: string;
      url?: string;
      contentType?: string;
      text?: string;
      error?: string;
    };

    const targetUrl = result.url || url;
    if (result.error) {
      throw new CliError(
        'FETCH_ERROR',
        `Browser fetch failed for ${targetUrl}: ${result.error}`,
        'Check that the page is reachable and the current browser profile has access.',
      );
    }
    if (!result.ok) {
      throw new CliError(
        'FETCH_ERROR',
        `HTTP ${result.status ?? 0}${result.statusText ? ` ${result.statusText}` : ''} from ${targetUrl}`,
        previewText(result.text),
      );
    }

    const text = result.text ?? '';
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      const contentType = result.contentType ? ` (${result.contentType})` : '';
      throw new CliError(
        'FETCH_ERROR',
        `Expected JSON from ${targetUrl}${contentType}`,
        previewText(text),
      );
    }
  }

  abstract getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]>;
  abstract screenshot(options?: ScreenshotOptions): Promise<string>;

  async annotatedScreenshot(options: ScreenshotOptions = {}): Promise<string> {
    // Refresh DOM refs first so visual labels map to immediate `browser click <ref>` targets.
    await this.snapshot({ source: 'dom', viewportExpand: 0 });
    try {
      await this.evaluate(installVisualRefOverlayJs());
      return await this.screenshot({ ...options, annotate: false });
    } finally {
      await this.evaluate(removeVisualRefOverlayJs()).catch(() => {});
    }
  }
  abstract tabs(): Promise<unknown[]>;
  abstract selectTab(target: number | string): Promise<void>;

  // ── Shared DOM helper implementations ──

  async click(ref: string, opts: ResolveOptions = {}): Promise<ResolveSuccess> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        // Channel resolution re-identifies stale refs by (role, name, nth)
        // internally; from hub's vantage a resolved ref is an exact match.
        await ax.click(ref);
        return { matches_n: 1, match_level: 'exact' };
      } catch {
        // Stale beyond the channel's re-identification, or a CDP hiccup —
        // the DOM-resolver path below re-resolves with the TargetError contract.
      }
    }

    // Phase 1: Resolve target with fingerprint verification
    const resolved = await runResolve(this, ref, opts);
    const nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');

    // Phase 2: measure first so native click can run before DOM el.click().
    // Custom dropdowns often listen to pointer/mouse down/up; DOM el.click()
    // only fires click and can silently report success without opening/selecting.
    const rect = await this.evaluate(boundingRectResolvedJs({ skipScroll: nativeScrolled })) as
      | { x: number; y: number; w: number; h: number; visible: boolean }
      | null;

    if (rect?.visible === true) {
      const success = await this.tryNativeClick(rect.x, rect.y);
      if (success) return resolved;
    }

    // JS fallback for older backends or zero-rect targets.
    const result = await this.evaluate(clickResolvedJs({ skipScroll: nativeScrolled })) as
      | string
      | { status: string; x?: number; y?: number; w?: number; h?: number; error?: string }
      | null;

    if (typeof result === 'string' || result == null) return resolved;

    if (result.status === 'clicked') return resolved;

    // JS click failed — try CDP native click if coordinates available
    if (result.x != null && result.y != null) {
      const success = await this.tryNativeClick(result.x, result.y);
      if (success) return resolved;
    }

    throw new Error(`Click failed: ${result.error ?? 'JS click and CDP fallback both failed'}`);
  }

  /** Trusted CDP click at viewport coordinates via the action channel. */
  protected async tryNativeClick(x: number, y: number): Promise<boolean> {
    const ax = this.axChannel();
    if (!ax) return false;
    try {
      await ax.clickAt(x, y);
      return true;
    } catch {
      return false;
    }
  }

  /** Trusted CDP hover (mouseMoved) at viewport coordinates via the action channel. */
  protected async tryNativeMouseMove(x: number, y: number): Promise<boolean> {
    const ax = this.axChannel();
    if (!ax) return false;
    try {
      await ax.hoverAt(x, y);
      return true;
    } catch {
      return false;
    }
  }

  protected async tryNativeDoubleClick(x: number, y: number): Promise<boolean> {
    const ax = this.axChannel();
    if (!ax) return false;
    try {
      await ax.clickAt(x, y, { clickCount: 2 });
      return true;
    } catch {
      return false;
    }
  }

  protected async tryNativeDrag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<boolean> {
    const ax = this.axChannel();
    if (!ax) return false;
    try {
      await ax.dragAt(from, to);
      return true;
    } catch {
      return false;
    }
  }

  /** Trusted CDP key events (type into current focus) via the action channel. */
  protected async tryNativeType(text: string): Promise<boolean> {
    const ax = this.axChannel();
    if (!ax) return false;
    try {
      await ax.typeText(text);
      return true;
    } catch {
      return false;
    }
  }

  protected async isResolvedFocused(): Promise<boolean> {
    try {
      return await this.evaluate(`
        (() => {
          const el = window.__resolved;
          return !!el && (document.activeElement === el || (typeof el.matches === 'function' && el.matches(':focus')));
        })()
      `) as boolean;
    } catch {
      return false;
    }
  }

  /**
   * Run a DOM-domain CDP command against `window.__resolved`.
   *
   * CDP DOM.focus / DOM.scrollIntoViewIfNeeded need a nodeId, while our
   * resolver stores the live Element in page JS. Bridge the two worlds with a
   * short-lived marker attribute, then query it through CDP.
   */
  protected async tryCdpOnResolvedElement(method: 'DOM.focus' | 'DOM.scrollIntoViewIfNeeded'): Promise<boolean> {
    const cdp = (this as IPage).cdp;
    if (typeof cdp !== 'function') return false;

    const markerAttr = 'data-opencli-cdp-target';
    const markerValue = `${Date.now().toString(36)}-${++this._cdpTargetMarkerSeq}`;
    const selector = `[${markerAttr}="${markerValue}"]`;
    let marked = false;

    try {
      const marker = await this.evaluateWithArgs(`
        (() => {
          const el = window.__resolved;
          if (!el || el.nodeType !== 1 || typeof el.setAttribute !== 'function') {
            return { ok: false };
          }
          el.setAttribute(markerAttr, markerValue);
          return { ok: true };
        })()
      `, { markerAttr, markerValue }) as { ok?: boolean } | null;
      marked = marker?.ok === true;
      if (!marked) return false;

      await cdp.call(this, 'DOM.enable', {}).catch(() => undefined);
      const doc = await cdp.call(this, 'DOM.getDocument', {}) as { root?: { nodeId?: unknown } } | null;
      const rootNodeId = doc?.root?.nodeId;
      if (typeof rootNodeId !== 'number') return false;

      const query = await cdp.call(this, 'DOM.querySelector', {
        nodeId: rootNodeId,
        selector,
      }) as { nodeId?: unknown } | null;
      const nodeId = query?.nodeId;
      if (typeof nodeId !== 'number' || nodeId <= 0) return false;

      await cdp.call(this, method, { nodeId });
      return true;
    } catch {
      return false;
    } finally {
      if (marked) {
        await this.evaluateWithArgs(`
          (() => {
            for (const el of document.querySelectorAll(selector)) {
              el.removeAttribute(markerAttr);
            }
          })()
        `, { selector, markerAttr }).catch(() => undefined);
      }
    }
  }

  async typeText(ref: string, text: string, opts: ResolveOptions = {}): Promise<ResolveSuccess> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        // clear:false = click-focus the element and type at the caret, which
        // matches the opencli `type` semantics (append, don't wipe).
        await ax.fill(ref, text, { clear: false });
        return { matches_n: 1, match_level: 'exact' };
      } catch {
        // Fall through to the DOM-resolver path (TargetError contract).
      }
    }
    const resolved = await runResolve(this, ref, opts);
    let typed = false;
    let nativeScrolled = false;
    let nativeFocused = false;

    if (typeof (this as IPage).nativeType === 'function' || typeof (this as IPage).insertText === 'function') {
      try {
        nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
        nativeFocused = await this.tryCdpOnResolvedElement('DOM.focus');
        const preparation = await this.evaluate(prepareNativeTypeResolvedJs({
          skipScroll: nativeScrolled,
          skipFocus: nativeFocused,
        })) as
          | { ok?: boolean; mode?: string; reason?: string }
          | null;
        typed = preparation?.ok === true && await this.tryNativeType(text);
      } catch {
        // Native input is a reliability upgrade, not the only path. Preserve
        // the existing DOM setter fallback if preparation fails.
      }
    }

    if (!typed) {
      await this.evaluate(typeResolvedJs(text));
    }
    return resolved;
  }

  async hover(ref: string, opts: ResolveOptions = {}): Promise<ResolveSuccess> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        await ax.hover(ref);
        return { matches_n: 1, match_level: 'exact' };
      } catch {
        // Fall through to the DOM-resolver path.
      }
    }
    const resolved = await runResolve(this, ref, opts);
    const nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
    const rect = await this.evaluate(boundingRectResolvedJs({ skipScroll: nativeScrolled })) as
      | { x: number; y: number; w: number; h: number; visible: boolean }
      | null;
    if (rect?.visible === true && await this.tryNativeMouseMove(rect.x, rect.y)) return resolved;

    await this.evaluate(`
      (() => {
        const el = window.__resolved;
        if (!el) throw new Error('No resolved element');
        if (${nativeScrolled ? 'false' : 'true'}) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
        };
        try { el.dispatchEvent(new PointerEvent('pointerover', init)); } catch (_) {}
        try { el.dispatchEvent(new PointerEvent('pointermove', init)); } catch (_) {}
        el.dispatchEvent(new MouseEvent('mouseover', init));
        el.dispatchEvent(new MouseEvent('mousemove', init));
      })()
    `);
    return resolved;
  }

  async focus(ref: string, opts: ResolveOptions = {}): Promise<ResolveSuccess & { focused: boolean }> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        await ax.focus(ref);
        // Channel focus succeeds unless CDP throws; the DOM path below is the
        // one that adds the activeElement double-check.
        return { matches_n: 1, match_level: 'exact', focused: true };
      } catch {
        // Fall through to the DOM-resolver path.
      }
    }
    const resolved = await runResolve(this, ref, opts);
    let focused = await this.tryCdpOnResolvedElement('DOM.focus') && await this.isResolvedFocused();
    if (!focused) {
      focused = await this.evaluate(`
        (() => {
          const el = window.__resolved;
          if (!el || typeof el.focus !== 'function') return false;
          try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
          return document.activeElement === el || (typeof el.matches === 'function' && el.matches(':focus'));
        })()
      `) as boolean;
    }
    return { ...resolved, focused: !!focused };
  }

  async dblClick(ref: string, opts: ResolveOptions = {}): Promise<ResolveSuccess> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        await ax.click(ref, { clickCount: 2 });
        return { matches_n: 1, match_level: 'exact' };
      } catch {
        // Fall through to the DOM-resolver path.
      }
    }
    const resolved = await runResolve(this, ref, opts);
    const nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
    const rect = await this.evaluate(boundingRectResolvedJs({ skipScroll: nativeScrolled })) as
      | { x: number; y: number; w: number; h: number; visible: boolean }
      | null;
    if (rect?.visible === true && await this.tryNativeDoubleClick(rect.x, rect.y)) return resolved;

    await this.evaluate(`
      (() => {
        const el = window.__resolved;
        if (!el) throw new Error('No resolved element');
        if (${nativeScrolled ? 'false' : 'true'}) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
          button: 0,
          detail: 2,
        };
        el.dispatchEvent(new MouseEvent('dblclick', init));
      })()
    `);
    return resolved;
  }

  /**
   * Shared pre-click guards for both setChecked paths (AX channel and DOM
   * probe): the TargetError contract (not_checkable / disabled / radio) is
   * identical no matter which surface executed the state probe.
   */
  private assertCheckable(before: CheckableState, ref: string, checked: boolean): void {
    if (before.disabled) {
      throw new TargetError({
        code: 'not_checkable',
        message: `Target "${ref}" is disabled and cannot be ${checked ? 'checked' : 'unchecked'}.`,
        hint: 'Pick an enabled control, or inspect the form state before retrying.',
      });
    }
    if ((before.kind === 'radio' || before.kind === 'menuitemradio') && !checked) {
      throw new TargetError({
        code: 'not_checkable',
        message: `Target "${ref}" is a radio button and cannot be unchecked directly.`,
        hint: 'Select another radio option in the same group instead.',
      });
    }
  }

  private async readCheckableState(): Promise<CheckableState | null> {
    return await this.evaluate(`
      (() => {
        const el = window.__resolved;
        if (!el || el.nodeType !== 1) return { ok: false, reason: 'not_checkable' };
        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
          return {
            ok: true,
            checked: !!el.checked,
            disabled: !!el.disabled,
            kind: type,
          };
        }
        if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox' || role === 'radio' || role === 'menuitemradio') {
          const aria = (el.getAttribute('aria-checked') || '').toLowerCase();
          return {
            ok: true,
            checked: aria === 'true' || aria === 'mixed',
            disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
            kind: role,
          };
        }
        return { ok: false, reason: 'not_checkable', tag, role };
      })()
    `) as CheckableState | null;
  }

  async setChecked(ref: string, checked: boolean, opts: ResolveOptions = {}): Promise<SetCheckedResult> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      let before: CheckableState | null = null;
      try {
        before = await ax.readState(ref, CHECKABLE_STATE_EXPR) as CheckableState | null;
      } catch {
        before = null; // channel/resolve failure — fall through to the DOM path
      }
      if (before && before.ok === true) {
        this.assertCheckable(before, ref, checked);
        if (before.checked === checked) {
          return {
            matches_n: 1,
            match_level: 'exact',
            checked,
            changed: false,
            ...(before.kind ? { kind: before.kind } : {}),
          };
        }
        await (checked ? ax.check(ref) : ax.uncheck(ref));
        const after = await ax.readState(ref, CHECKABLE_STATE_EXPR).catch(() => null) as CheckableState | null;
        if (after?.ok !== true || after.checked !== checked) {
          throw new TargetError({
            code: 'not_checkable',
            message: `Target "${ref}" did not become ${checked ? 'checked' : 'unchecked'} after click.`,
            hint: 'The control may be custom, disabled by app logic, or require a different target such as its visible label.',
          });
        }
        return {
          matches_n: 1,
          match_level: 'exact',
          checked,
          changed: true,
          ...(after.kind ? { kind: after.kind } : {}),
        };
      }
      if (before && before.ok === false) {
        // The element answered but is not checkable — same contract as DOM path.
        throw new TargetError({
          code: 'not_checkable',
          message: `Target "${ref}" is not a checkbox, radio, switch, or aria-checked control.`,
          hint: 'Use `hub browser state` or `browser find` to pick an input[type=checkbox], input[type=radio], or role=checkbox/switch target.',
        });
      }
    }
    const resolved = await runResolve(this, ref, opts);
    const before = await this.readCheckableState();
    if (before?.ok !== true) {
      throw new TargetError({
        code: 'not_checkable',
        message: `Target "${ref}" is not a checkbox, radio, switch, or aria-checked control.`,
        hint: 'Use `hub browser state` or `browser find` to pick an input[type=checkbox], input[type=radio], or role=checkbox/switch target.',
      });
    }
    this.assertCheckable(before, ref, checked);
    if (before.checked === checked) {
      return {
        ...resolved,
        checked,
        changed: false,
        ...(before.kind ? { kind: before.kind } : {}),
      };
    }

    const clicked = await this.click(ref, opts);
    const after = await this.readCheckableState();
    if (after?.ok !== true || after.checked !== checked) {
      throw new TargetError({
        code: 'not_checkable',
        message: `Target "${ref}" did not become ${checked ? 'checked' : 'unchecked'} after click.`,
        hint: 'The control may be custom, disabled by app logic, or require a different target such as its visible label.',
      });
    }
    return {
      matches_n: clicked.matches_n,
      match_level: clicked.match_level,
      checked,
      changed: true,
      ...(after.kind ? { kind: after.kind } : {}),
    };
  }

  private async setFileInputBySelector(files: string[], selector: string): Promise<void> {
    const setFileInput = (this as IPage).setFileInput;
    if (typeof setFileInput === 'function') {
      await setFileInput.call(this, files, selector);
      return;
    }

    const cdp = (this as IPage).cdp;
    if (typeof cdp !== 'function') {
      throw new Error('File upload requires setFileInput or CDP support from the active browser backend.');
    }
    await cdp.call(this, 'DOM.enable', {}).catch(() => undefined);
    const doc = await cdp.call(this, 'DOM.getDocument', {}) as { root?: { nodeId?: unknown } } | null;
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== 'number') throw new Error('DOM.getDocument returned no root node.');
    const query = await cdp.call(this, 'DOM.querySelector', { nodeId: rootNodeId, selector }) as { nodeId?: unknown } | null;
    const nodeId = query?.nodeId;
    if (typeof nodeId !== 'number' || nodeId <= 0) throw new Error(`No element found matching selector: ${selector}`);
    await cdp.call(this, 'DOM.setFileInputFiles', { files, nodeId });
  }

  async uploadFiles(ref: string, files: string[], opts: ResolveOptions = {}): Promise<UploadFilesResult> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new TargetError({
        code: 'not_file_input',
        message: 'No files were provided for upload.',
        hint: 'Pass one or more local file paths after the target.',
      });
    }
    const ax = this.axChannelForRef(ref);
    if (ax) {
      let state: { ok?: boolean; multiple?: boolean; accept?: string; reason?: string; tag?: string; type?: string } | null = null;
      try {
        state = await ax.readState(ref, FILE_INPUT_STATE_EXPR) as typeof state;
      } catch {
        state = null; // channel/resolve failure — fall through to the DOM path
      }
      if (state && state.ok === true) {
        if (files.length > 1 && !state.multiple) {
          throw new TargetError({
            code: 'not_file_input',
            message: `Target "${ref}" does not allow multiple files, but ${files.length} files were provided.`,
            hint: 'Pass one file, or choose a file input with the multiple attribute.',
          });
        }
        await ax.uploadFile(ref, files);
        const names = await ax.readState(ref, FILE_NAMES_EXPR).catch(() => null) as string[] | null;
        const fileNames = Array.isArray(names) ? names.map((value) => String(value)) : [];
        return {
          matches_n: 1,
          match_level: 'exact',
          uploaded: true,
          files: fileNames.length || files.length,
          file_names: fileNames,
          target: ref,
          multiple: !!state.multiple,
          ...(state.accept ? { accept: state.accept } : {}),
        };
      }
      if (state && state.ok === false) {
        // The element answered but is not a file input — same contract as DOM path.
        throw new TargetError({
          code: 'not_file_input',
          message: `Target "${ref}" is not an input[type=file].`,
          hint: 'Use `hub browser find --css "input[type=file]"` or inspect `compound` output from browser state/find.',
        });
      }
    }
    const resolved = await runResolve(this, ref, opts);
    const markerAttr = 'data-opencli-upload-target';
    const markerValue = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const selector = `[${markerAttr}="${markerValue}"]`;
    let marked = false;
    let info: { ok?: boolean; multiple?: boolean; accept?: string; reason?: string; tag?: string; type?: string } | null = null;

    try {
      info = await this.evaluateWithArgs(`
        (() => {
          const el = window.__resolved;
          if (!el || el.nodeType !== 1) return { ok: false, reason: 'not_file_input' };
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (tag !== 'input' || type !== 'file') return { ok: false, reason: 'not_file_input', tag, type };
          el.setAttribute(markerAttr, markerValue);
          return {
            ok: true,
            multiple: !!el.multiple,
            accept: el.getAttribute('accept') || '',
          };
        })()
      `, { markerAttr, markerValue }) as { ok?: boolean; multiple?: boolean; accept?: string; reason?: string; tag?: string; type?: string } | null;
      marked = info?.ok === true;
      if (!marked) {
        throw new TargetError({
          code: 'not_file_input',
          message: `Target "${ref}" is not an input[type=file].`,
          hint: 'Use `hub browser find --css "input[type=file]"` or inspect `compound` output from browser state/find.',
        });
      }
      if (files.length > 1 && !info?.multiple) {
        throw new TargetError({
          code: 'not_file_input',
          message: `Target "${ref}" does not allow multiple files, but ${files.length} files were provided.`,
          hint: 'Pass one file, or choose a file input with the multiple attribute.',
        });
      }

      await this.setFileInputBySelector(files, selector);
      const verification = await this.evaluate(`
        (() => {
          const el = window.__resolved;
          const names = [];
          try {
            if (el && el.files) {
              for (let i = 0; i < el.files.length; i++) names.push(el.files[i].name || '');
            }
          } catch (_) {}
          return names;
        })()
      `) as unknown;
      const fileNames = Array.isArray(verification)
        ? verification.map((value) => String(value))
        : [];

      return {
        ...resolved,
        uploaded: true,
        files: fileNames.length || files.length,
        file_names: fileNames,
        target: ref,
        multiple: !!info?.multiple,
        ...(info?.accept ? { accept: info.accept } : {}),
      };
    } finally {
      if (marked) {
        await this.evaluateWithArgs(`
          (() => {
            for (const el of document.querySelectorAll(selector)) {
              el.removeAttribute(markerAttr);
            }
          })()
        `, { selector, markerAttr }).catch(() => undefined);
      }
    }
  }

  async drag(
    source: string,
    target: string,
    opts: { from?: ResolveOptions; to?: ResolveOptions } = {},
  ): Promise<DragResult> {
    const ax = this.axChannel();
    if (ax && this.isAxRef(source) && this.isAxRef(target)) {
      try {
        // Input.drag rejects cross-frame-session pairs; the DOM path below
        // measures hub-side geometry and drags in viewport coordinates.
        await ax.dragRefs(source, target);
        return {
          dragged: true,
          source,
          target,
          source_matches_n: 1,
          target_matches_n: 1,
          source_match_level: 'exact',
          target_match_level: 'exact',
        };
      } catch {
        // Fall through to the DOM-resolver path.
      }
    }
    const sourceResolved = await runResolve(this, source, opts.from ?? {});
    const sourceScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
    const sourceRect = await this.evaluate(`
      (() => {
        const el = window.__resolved;
        if (!el) throw new Error('No resolved drag source');
        window.__opencli_drag_source = el;
        if (${sourceScrolled ? 'false' : 'true'}) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const visible = w > 0 && h > 0 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
        return { x, y, w, h, visible };
      })()
    `) as
      | { x: number; y: number; w: number; h: number; visible: boolean }
      | null;
    if (sourceRect?.visible !== true) {
      throw new Error(`Drag source "${source}" has no visible bounding box.`);
    }

    try {
      const targetResolved = await runResolve(this, target, opts.to ?? {});
      const targetScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
      const endpoints = await this.evaluate(`
        (() => {
          const sourceEl = window.__opencli_drag_source;
          const targetEl = window.__resolved;
          if (!sourceEl) throw new Error('No resolved drag source');
          if (!targetEl) throw new Error('No resolved drag target');
          if (${targetScrolled ? 'false' : 'true'}) targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
          const measure = (el) => {
            const rect = el.getBoundingClientRect();
            const w = Math.round(rect.width);
            const h = Math.round(rect.height);
            const x = Math.round(rect.left + rect.width / 2);
            const y = Math.round(rect.top + rect.height / 2);
            const visible = w > 0 && h > 0 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
            return { x, y, w, h, visible };
          };
          return { source: measure(sourceEl), target: measure(targetEl) };
        })()
      `) as
        | {
          source?: { x: number; y: number; w: number; h: number; visible: boolean };
          target?: { x: number; y: number; w: number; h: number; visible: boolean };
        }
        | null;

      if (endpoints?.source?.visible !== true) {
        throw new Error(`Drag source "${source}" is not visible at drag time.`);
      }
      if (endpoints?.target?.visible !== true) {
        throw new Error(`Drag target "${target}" has no visible bounding box.`);
      }

      const dragged = await this.tryNativeDrag(
        { x: endpoints.source.x, y: endpoints.source.y },
        { x: endpoints.target.x, y: endpoints.target.y },
      );
      if (!dragged) throw new Error('Native drag requires CDP Input.dispatchMouseEvent support.');

      return {
        dragged: true,
        source,
        target,
        source_matches_n: sourceResolved.matches_n,
        target_matches_n: targetResolved.matches_n,
        source_match_level: sourceResolved.match_level,
        target_match_level: targetResolved.match_level,
      };
    } finally {
      await this.evaluate('delete window.__opencli_drag_source').catch(() => {});
    }
  }

  async fillText(ref: string, text: string, opts: ResolveOptions = {}): Promise<FillTextResult> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        await ax.fill(ref, text);
        const verification = await ax.readState(ref, fillVerifyExpr(text)).catch(() => null) as FillResolvedResult | null;
        if (verification && verification.ok === false && (verification as { reason?: string }).reason === 'not_editable') {
          // The element answered but is not fillable — same contract as DOM path.
          throw new TargetError({
            code: 'not_editable',
            message: `Target "${ref}" is not a fillable input, textarea, or contenteditable element.`,
            hint: 'Use `hub browser state` to pick an editable target, or use `browser type` for keyboard-like interactions.',
          });
        }
        const actual = verification && 'actual' in verification ? verification.actual : '';
        const mode = verification && 'mode' in verification ? verification.mode : undefined;
        return {
          matches_n: 1,
          match_level: 'exact',
          filled: true,
          verified: verification?.ok === true,
          expected: text,
          actual,
          length: actual.length,
          ...(mode ? { mode } : {}),
        };
      } catch (err) {
        if (err instanceof TargetError) throw err;
        // Channel/resolve failure — fall through to the DOM-resolver path.
      }
    }
    const resolved = await runResolve(this, ref, opts);
    let nativeScrolled = false;
    let nativeFocused = false;

    try {
      nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
      nativeFocused = await this.tryCdpOnResolvedElement('DOM.focus');
    } catch {
      // CDP focus/scroll is best-effort; DOM preparation below remains authoritative.
    }

    const preparation = await this.evaluate(prepareNativeTypeResolvedJs({
      skipScroll: nativeScrolled,
      skipFocus: nativeFocused,
    })) as
      | { ok?: boolean; mode?: string; reason?: string; tag?: string }
      | null;

    if (preparation?.ok !== true) {
      throw new TargetError({
        code: 'not_editable',
        message: `Target "${ref}" is not a fillable input, textarea, or contenteditable element.`,
        hint: 'Use `hub browser state` to pick an editable target, or use `browser type` for keyboard-like interactions.',
      });
    }

    const usedNativeInput = await this.tryNativeType(text);
    if (!usedNativeInput) {
      await this.evaluate(typeResolvedJs(text));
    }

    let verification = await this.evaluate(verifyFilledResolvedJs(text)) as FillResolvedResult | null;
    if (usedNativeInput && verification?.ok !== true) {
      await this.evaluate(typeResolvedJs(text));
      verification = await this.evaluate(verifyFilledResolvedJs(text)) as FillResolvedResult | null;
    }
    const actual = verification && 'actual' in verification ? verification.actual : '';
    const mode = verification && 'mode' in verification ? verification.mode : undefined;

    return {
      ...resolved,
      filled: true,
      verified: verification?.ok === true,
      expected: text,
      actual,
      length: actual.length,
      ...(mode ? { mode } : {}),
    };
  }

  async pressKey(key: string): Promise<void> {
    const parsed = parseKeyChord(key);
    const ax = this.axChannel();
    if (ax) {
      try {
        await ax.press(parsed.key, parsed.modifiers);
        return;
      } catch {
        // Fall through to page-JS KeyboardEvents (synthetic, but portable).
      }
    }
    await this.evaluate(pressKeyJs(parsed.key, parsed.modifiers));
  }

  async scrollTo(ref: string, opts: ResolveOptions = {}): Promise<unknown> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      try {
        await ax.scrollIntoViewRef(ref);
        const info = await ax.readState(ref, TARGET_INFO_EXPR).catch(() => null) as { tag?: string; text?: string } | null;
        return {
          ...(info ?? {}),
          scrolled: true,
          matches_n: 1,
          match_level: 'exact',
        };
      } catch {
        // Fall through to the DOM-resolver path.
      }
    }
    const resolved = await runResolve(this, ref, opts);
    const nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
    const result = (await this.evaluate(scrollResolvedJs({ skipScroll: nativeScrolled }))) as Record<string, unknown> | null;
    // Fold match_level into the scroll payload so the user-facing envelope
    // carries it the same way click / type do.
    if (result && typeof result === 'object') {
      return { ...result, matches_n: resolved.matches_n, match_level: resolved.match_level };
    }
    return { matches_n: resolved.matches_n, match_level: resolved.match_level };
  }

  async getFormState(): Promise<Record<string, unknown>> {
    return (await this.evaluate(getFormStateJs())) as Record<string, unknown>;
  }

  /**
   * Resolve a ref (AX `eN` or OpenCLI `@N`) to its on-screen center point,
   * using the same cascade as `click()`. Returns null when the target cannot
   * be resolved or measured — callers fall back to their normal path.
   */
  async refCenter(ref: string): Promise<{ x: number; y: number } | null> {
    const ax = this.axChannelForRef(ref);
    if (ax) {
      const point = await ax.centerRef(ref).catch(() => null);
      if (point) return point;
    }
    try {
      await runResolve(this, ref);
      const nativeScrolled = await this.tryCdpOnResolvedElement('DOM.scrollIntoViewIfNeeded');
      const rect = (await this.evaluate(
        boundingRectResolvedJs({ skipScroll: nativeScrolled }),
      )) as { x: number; y: number; w: number; h: number; visible: boolean } | null;
      if (rect?.visible && rect.w > 0 && rect.h > 0) {
        return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
      }
    } catch {
      // unresolved ref — return null and let the caller fall back
    }
    return null;
  }

  async scroll(direction: string = 'down', amount: number = 500): Promise<void> {
    await this.evaluate(scrollJs(direction, amount));
  }

  async autoScroll(options?: { times?: number; delayMs?: number }): Promise<void> {
    const times = options?.times ?? 3;
    const delayMs = options?.delayMs ?? 2000;
    await this.evaluate(autoScrollJs(times, delayMs));
  }

  async networkRequests(includeStatic: boolean = false): Promise<unknown[]> {
    const result = await this.evaluate(networkRequestsJs(includeStatic));
    return Array.isArray(result) ? result : [];
  }

  async consoleMessages(_level: string = 'info'): Promise<unknown[]> {
    return [];
  }

  async wait(options: number | WaitOptions): Promise<void> {
    if (typeof options === 'number') {
      if (options >= 1) {
        try {
          const maxMs = options * 1000;
          await this.evaluate(waitForDomStableJs(maxMs, Math.min(500, maxMs)));
          return;
        } catch {
          // Fallback: fixed sleep
        }
      }
      await new Promise(resolve => setTimeout(resolve, options * 1000));
      return;
    }
    if (typeof options.time === 'number') {
      await new Promise(resolve => setTimeout(resolve, options.time! * 1000));
      return;
    }
    if (options.selector) {
      const timeout = (options.timeout ?? 10) * 1000;
      await this.evaluate(waitForSelectorJs(options.selector, timeout));
      return;
    }
    if (options.text) {
      const timeout = (options.timeout ?? 30) * 1000;
      await this.evaluate(waitForTextJs(options.text, timeout));
    }
  }

  async snapshot(opts: SnapshotOptions = {}): Promise<unknown> {
    // P2-8: the AX capture path (`source: 'ax'` and the default on UnifiedPage)
    // lives in the subclass override on browser-core's Observer channel — this
    // base implementation only carries the DOM-generator view (opencli
    // compatibility surface). AX refs stay valid on the Observer across views;
    // their lifecycle is the Observer's documentId semantics.
    const snapshotJs = generateSnapshotJs({
      viewportExpand: opts.viewportExpand ?? 2000,
      maxDepth: Math.max(1, Math.min(Number(opts.maxDepth) || 50, 200)),
      interactiveOnly: opts.interactive ?? false,
      maxTextLength: opts.maxTextLength ?? 120,
      includeScrollInfo: true,
      bboxDedup: true,
      previousHashes: this._prevSnapshotHashes,
    });

    try {
      const result = await this.evaluate(snapshotJs);
      // Read back the hashes stored by the snapshot for next diff
      try {
        const hashes = await this.evaluate('window.__opencli_prev_hashes') as string | null;
        this._prevSnapshotHashes = typeof hashes === 'string' ? hashes : null;
      } catch {
        // Non-fatal: diff is best-effort
      }
      return result;
    } catch (err) {
      // Log snapshot failure for debugging, then fallback to basic accessibility tree
      if (process.env.DEBUG_SNAPSHOT) {
        process.stderr.write(`[snapshot] DOM snapshot failed, falling back to accessibility tree: ${(err as Error)?.message?.slice(0, 200)}\n`);
      }
      return this._basicSnapshot(opts);
    }
  }

  async getCurrentUrl(): Promise<string | null> {
    if (this._lastUrl) return this._lastUrl;
    try {
      const current = await this.evaluate('window.location.href');
      if (typeof current === 'string' && current) {
        this._lastUrl = current;
        return current;
      }
    } catch {
      // Best-effort
    }
    return null;
  }

  async installInterceptor(pattern: string): Promise<void> {
    const { generateInterceptorJs } = await import('./interceptor.js');
    await this.evaluate(generateInterceptorJs(JSON.stringify(pattern), {
      arrayName: '__opencli_xhr',
      patchGuard: '__opencli_interceptor_patched',
    }));
  }

  async getInterceptedRequests(): Promise<unknown[]> {
    const { generateReadInterceptedJs } = await import('./interceptor.js');
    const result = await this.evaluate(generateReadInterceptedJs('__opencli_xhr'));
    return Array.isArray(result) ? result : [];
  }

  async waitForCapture(timeout: number = 10): Promise<void> {
    const maxMs = timeout * 1000;
    await this.evaluate(waitForCaptureJs(maxMs));
  }

  /** Fallback basic snapshot */
  protected async _basicSnapshot(opts: Pick<SnapshotOptions, 'interactive' | 'compact' | 'maxDepth' | 'raw'> = {}): Promise<unknown> {
    const maxDepth = Math.max(1, Math.min(Number(opts.maxDepth) || 50, 200));
    const code = `
      (async () => {
        function buildTree(node, depth) {
          if (depth > ${maxDepth}) return '';
          const role = node.getAttribute?.('role') || node.tagName?.toLowerCase() || 'generic';
          const name = node.getAttribute?.('aria-label') || node.getAttribute?.('alt') || node.textContent?.trim().slice(0, 80) || '';
          const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(node.tagName?.toLowerCase()) || node.getAttribute?.('tabindex') != null;

          ${opts.interactive ? 'if (!isInteractive && !node.children?.length) return "";' : ''}

          let indent = '  '.repeat(depth);
          let line = indent + role;
          if (name) line += ' "' + name.replace(/"/g, '\\\\\\"') + '"';
          if (node.tagName?.toLowerCase() === 'a' && node.href) line += ' [' + node.href + ']';
          if (node.tagName?.toLowerCase() === 'input') line += ' [' + (node.type || 'text') + ']';

          let result = line + '\\n';
          if (node.children) {
            for (const child of node.children) {
              result += buildTree(child, depth + 1);
            }
          }
          return result;
        }
        return buildTree(document.body, 0);
      })()
    `;
    const raw = await this.evaluate(code);
    if (opts.raw) return raw;
    if (typeof raw === 'string') return formatSnapshot(raw, opts);
    return raw;
  }
}
