# Phase 2 融合方案详细设计（v6 审查版）

> 九轮审查（Leibniz→Herschel→Goodall→Tesla→Darwin→Hypatia→Einstein→Hooke→Chandrasekhar）后的最终方案
> 目标：一个项目，两条路径操作同一个浏览器

## 一、目标架构

```
路径 1: Agent → opencli 命令/适配器 → UnifiedPage → BrowserSession → 浏览器
路径 2: Agent → MCP :9010 → claw-server-rust → browser-core → 浏览器
两条路径各自独立连 CDP 端口，操作同一个浏览器进程的同一批 Tab
```

OpenCLI 是入口（CLI、176 适配器、pipeline、stealth、compound、observation）。
BrowserClaw 是后端（Chromium fork、CDP、MCP server、AX tree snapshot、Diff、Trust Boundary）。

## 二、分两层交付

### Phase 2a（MVP，8 天）：核心融合

核心交互能力——snapshot、click、fillText、scroll、stealth、CDP 逃生口、原生输入。
不包含 compound 后处理和 visual ref 叠加。

### Phase 2b（增强，5 天）：compound + visual ref

snapshot 中的 compound 组件信息、annotatedScreenshot 的视觉 ref 标签。

## 三、ref 系统（2a 核心）

### 不统一格式，各走各的路

BasePage.click 已有内置双路径：

```
click(ref):
  第一步: tryClickAxRef(ref)      ← eN ref → _axRefs → backendNodeId → nativeClick
  第二步: runResolve(ref)          ← CSS 选择器 → resolveTargetJs → fingerprint → nativeClick
```

**BasePage 改动（3 处）：**

```typescript
// 1. private → protected (第 142-144 行)
protected _prevSnapshotHashes: string | null = null;
protected _axRefs = new Map<string, BrowserRef>();

// 2. 正则放宽 (第 384 行)
if (!/^e?\d+$/.test(ref)) return null;  // 接受 e12 和 5

// 3. 加 resetPageState
protected resetPageState(): void {
  this._axRefs.clear();
  this._prevSnapshotHashes = null;
  this._lastUrl = null;
}
```

### 执行路径

```
click("e12"):
  tryClickAxRef("e12") → _axRefs.get("e12") → backendNodeId: 123
    → axBoxCenter(123) via cdp('DOM.getBoxModel') → { x, y }
    → nativeClick(x, y) → Input.clickAt ✅
    失效时: resolveAxRefPoint 重查 AX tree → nativeClick ✅

click("#submit"):
  tryClickAxRef → 正则不匹配 → null
  runResolve("#submit") → resolveTargetJs → querySelectorAll → nativeClick ✅
```

## 四、snapshot 方案

### Phase 2a（MVP）：Observer + populateAxRefs

```typescript
async snapshot(opts?) {
  const result = await this.session.observe(this.pageId).snapshot();
  this.populateAxRefs(result.refs);
  return result.text;  // AX tree，含 [ref=eN]
}
```

### Phase 2b：compound 后处理（不用 injectOpenCliRefs）

**关键洞察**：compound 信息不需要注入 DOM 属性。用一次 `evaluate` 收集所有 date/select/file 元素信息，按 name 匹配到 AX tree 的 ref。

```typescript
private async collectCompoundInfo(): Promise<Map<string, string>> {
  const { COMPOUND_INFO_JS } = await import('./opencli/compound.js');
  // 一次 evaluate 收集所有 compound 元素
  const result = await this.evaluate(`
    ${COMPOUND_INFO_JS}
    (() => {
      const results = [];
      const sel = 'input[type=date],input[type=time],input[type=datetime-local],input[type=month],input[type=week],input[type=file],select';
      for (const el of document.querySelectorAll(sel)) {
        const info = compoundInfoOf(el);
        if (!info) continue;
        // 用 name/aria-label 匹配 AX tree 节点
        const name = (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('title') || (el.tagName === 'SELECT' ? '' : el.getAttribute('type') || '')).trim();
        results.push({ name, info });
      }
      return JSON.stringify(results);
    })()
  `);
  // 按 name 匹配到 _axRefs 里的 ref
  const items = JSON.parse(result || '[]');
  const map = new Map();
  for (const { name, info } of items) {
    for (const [ref, entry] of this._axRefs) {
      if (entry.name === name || name === '' ) { map.set(ref, info); break; }
    }
  }
  return map;
}
```

**合并到 snapshot 文本**——用紧凑格式，不用 JSON.stringify：

```typescript
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
```

**为什么不需要 injectOpenCliRefs**：compound 的 `compoundInfoOf(el)` 在 JS 里直接操作 DOM 元素，不需要 `data-opencli-ref` 属性。匹配 ref 用 name（AX tree 的 name 和 DOM 元素的 aria-label/name 是同一个值）。

## 五、visual ref 叠加（2b）

### 问题

OpenCLI 的 `installVisualRefOverlayJs`（visual-refs.ts）用 `Number(rawRef)` 解析 `data-opencli-ref` 属性。`Number("e12")` = NaN，元素被过滤。而且它依赖 `document.querySelectorAll('[data-opencli-ref]')` 查找元素。

### 方案：重写 visual ref overlay，用坐标而非 DOM 属性

不用 `data-opencli-ref` 属性。直接从 RefMap 的 `backendNodeId` 获取坐标，传入 overlay JS：

```typescript
// UnifiedPage 覆写 annotatedScreenshot
async annotatedScreenshot(options: ScreenshotOptions = {}): Promise<string> {
  // 1. 拍 snapshot，填充 _axRefs
  const snapResult = await this.session.observe(this.pageId).snapshot();
  this.populateAxRefs(snapResult.refs);
  
  // 2. 并行获取所有 ref 的坐标（最多 120 个）
  const { session } = await this.session.pages.getSession(this.pageId);
  const refCoords = await this.getRefCoordinates(session, snapResult.refs);
  
  // 3. 注入 overlay（用坐标，不用 DOM 属性）
  await this.evaluate(this.installCoordOverlayJs(refCoords));
  try {
    return await this.screenshot({ ...options, annotate: false });
  } finally {
    await this.evaluate(removeVisualRefOverlayJs()).catch(() => {});
  }
}

private async getRefCoordinates(
  session: ProtocolApi, refs: RefMap
): Promise<Array<{ref: string; x: number; y: number; w: number; h: number}>> {
  const entries = [...refs.byRef].slice(0, 120);
  const results = await Promise.all(entries.map(async ([ref, entry]) => {
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
  return results.filter(Boolean);
}

// 新的 overlay JS：用坐标数组，不查 DOM 属性
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
        // 画红色框 + ref 标签（和原 visual-refs.ts 样式一致）
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'fixed', left: c.x + 'px', top: c.y + 'px',
          width: c.w + 'px', height: c.h + 'px',
          border: '2px solid #ff3b30', borderRadius: '4px',
          boxSizing: 'border-box',
          background: 'rgba(255,59,48,.08)',
        });
        const badge = document.createElement('div');
        badge.textContent = c.ref;  // "e12"
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
```

**P0-1/P0-2 解决**：不依赖 `data-opencli-ref` 属性，不用 `Number()`，不用 DOM snapshot。用 `DOM.getBoxModel` 并行获取坐标（最多 120 次 CDP 调用），直接画框。

**P1-1 解决**：不再对全部交互元素注入 DOM 属性。compound 用 evaluate 一次收集，visual ref 用 DOM.getBoxModel 并行获取坐标。没有 injectOpenCliRefs。

## 六、frames / evaluateInFrame（公司网站 wujie iframe 支持）

> espm-uat 公司网站适配器中 54/143 个涉及 iframe，使用 wujie 微前端框架。
> evaluateInFrame 比 contentDocument 更可靠——绕过 wujie 沙箱拦截。

```typescript
// UnifiedPage 中

private _executionContexts = new Map<string, number>();  // frameId → contextId
private _ctxEventSub: (() => void) | null = null;

async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
  const { session } = await this.session.pages.getSession(this.pageId);
  const result = await session.Page.getFrameTree();
  const tree = result.frameTree;
  const list: Array<{ index: number; frameId: string; url: string; name: string }> = [];
  let index = 0;
  function walk(node: any) {
    list.push({ index: index++, frameId: node.frame.id, url: node.frame.url || '', name: node.frame.name || '' });
    for (const child of node.childFrames || []) walk(child);
  }
  walk(tree);
  return list;
}

async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
  const { buildEvaluateExpression } = await import('./opencli/utils.js');
  const frames = await this.frames();
  const frame = frames[frameIndex];
  if (!frame) throw new Error(`Frame ${frameIndex} not found`);

  // 确保 Runtime.enable 已调用（触发 executionContextCreated 事件）
  await this.ensureRuntimeEnabled();

  const ctxId = this._executionContexts.get(frame.frameId);
  if (ctxId === undefined) throw new Error(`No execution context for frame ${frame.frameId}`);

  const { session } = await this.session.pages.getSession(this.pageId);
  const result = await session.Runtime.evaluate({
    expression: buildEvaluateExpression(js, []),
    contextId: ctxId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error('Frame eval: ' + (result.exceptionDetails.exception?.description ?? ''));
  return result.result?.value;
}

private async ensureRuntimeEnabled(): Promise<void> {
  if (this._ctxEventSub) return;  // 已订阅
  const { sessionId, session } = await this.session.pages.getSession(this.pageId);
  await session.Runtime.enable();
  this._ctxEventSub = this.cdpBackend.onSessionEvent(
    'Runtime.executionContextCreated',
    (params, sid) => {
      if (sid !== sessionId) return;
      const ctx = params as { context?: { id: number; auxData?: { frameId?: string } } };
      if (ctx.context?.auxData?.frameId) {
        this._executionContexts.set(ctx.context.auxData.frameId, ctx.context.id);
      }
    }
  );
}

// selectTab 时清理
// 在 resetPageState 或 selectTab 中:
//   this._executionContexts.clear();
//   this._ctxEventSub?.();
//   this._ctxEventSub = null;
```

## 六、event-bridge.ts 完整设计（P1-3 补充）

```typescript
// unified-core/src/event-bridge.ts
import type { CdpBackend } from '@browseros/browser-core';

/** 订阅指定 session 的 CDP 事件 */
export function onSessionEvent(
  cdp: CdpBackend,
  sessionId: string,
  event: string,
  handler: (params: unknown) => void,
): () => void {
  return cdp.onSessionEvent(event, (params, sid) => {
    if (sid === sessionId) handler(params);
  });
}

export class ConsoleCollector {
  private messages: Array<{ type: string; text: string; timestamp: number }> = [];
  private unsub: (() => void)[] = [];
  started = false;

  async start(cdp: CdpBackend, sessionId: string) {
    if (this.started) return;
    this.started = true;
    // P0-15: 必须 enable Runtime 才能收到 console 事件
    await cdp.rawSendJson('Runtime.enable', '{}', sessionId);
    this.unsub.push(onSessionEvent(cdp, sessionId, 'Runtime.consoleAPICalled', (p) => {
      const params = p as { type?: string; args?: Array<{ value?: string; description?: string }> };
      const text = (params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
      this.messages.push({ type: params.type ?? 'log', text, timestamp: Date.now() });
      if (this.messages.length > 500) this.messages.shift();
    }));
    this.unsub.push(onSessionEvent(cdp, sessionId, 'Runtime.exceptionThrown', (p) => {
      const params = p as { exceptionDetails?: { exception?: { description?: string } } };
      const desc = params.exceptionDetails?.exception?.description ?? '';
      if (desc) {
        this.messages.push({ type: 'error', text: desc, timestamp: Date.now() });
        if (this.messages.length > 500) this.messages.shift();
      }
    }));
  }

  get(level: string = 'all') {
    if (level === 'all') return [...this.messages];
    if (level === 'error') return this.messages.filter(m => m.type === 'error' || m.type === 'warning');
    return this.messages.filter(m => m.type === level);
  }

  stop() { this.unsub.forEach(fn => fn()); this.unsub = []; this.messages = []; this.started = false; }
}

export class NetworkCollector {
  private entries: Array<Record<string, unknown>> = [];
  private pending = new Map<string, number>();
  private unsub: (() => void)[] = [];
  private cdp: CdpBackend;
  private sessionId: string;
  private capturing = false;

  constructor(cdp: CdpBackend, sessionId: string) { this.cdp = cdp; this.sessionId = sessionId; }

  async start(pattern: string = '') {
    if (this.capturing) return;
    this.capturing = true;
    this.entries = []; this.pending.clear();
    // 用 CDP enable Network domain
    await this.cdp.rawSendJson('Network.enable', '{}', this.sessionId);
    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.requestWillBeSent', (p) => {
      const params = p as { requestId: string; request: { method: string; url: string } };
      if (!pattern || params.request.url.includes(pattern)) {
        const idx = this.entries.push({ url: params.request.url, method: params.request.method, timestamp: Date.now() }) - 1;
        this.pending.set(params.requestId, idx);
      }
    }));
    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.responseReceived', (p) => {
      const params = p as { requestId: string; response: { status: number; mimeType?: string } };
      const idx = this.pending.get(params.requestId);
      if (idx !== undefined) {
        this.entries[idx].responseStatus = params.response.status;
        this.entries[idx].responseContentType = params.response.mimeType ?? '';
      }
    }));
    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.loadingFinished', async (p) => {
      const params = p as { requestId: string };
      const idx = this.pending.get(params.requestId);
      if (idx !== undefined) {
        try {
          const bodyResult = await this.cdp.rawSendJson('Network.getResponseBody', JSON.stringify({ requestId: params.requestId }), this.sessionId);
          const r = bodyResult as { body?: string; base64Encoded?: boolean };
          if (typeof r?.body === 'string') {
            this.entries[idx].responsePreview = r.base64Encoded ? `base64:${r.body.slice(0, 8192)}` : r.body.slice(0, 8192);
          }
        } catch {}
        this.pending.delete(params.requestId);
      }
    }));
  }

  read() { return [...this.entries]; }
  async stop() { this.unsub.forEach(fn => fn()); this.unsub = []; // P1-17: disable Network domain
    await this.cdp.rawSendJson('Network.disable', '{}', this.sessionId).catch(() => {});
    this.entries = []; this.pending.clear(); this.capturing = false; }
}
```

UnifiedPage 用法：

```typescript
private _console: ConsoleCollector | null = null;
private _network: NetworkCollector | null = null;

async consoleMessages(level = 'all') {
  if (!this._console) {
    const { sessionId } = await this.session.pages.getSession(this.pageId);
    this._console = new ConsoleCollector(this.cdpBackend, sessionId);
    this._console.start(this.cdpBackend, sessionId);
  }
  return this._console.get(level);
}

async startNetworkCapture(pattern = '') {
  if (!this._network) {
    const { sessionId } = await this.session.pages.getSession(this.pageId);
    this._network = new NetworkCollector(this.cdpBackend, sessionId);
  }
  await this._network.start(pattern);
  return true;
}

async readNetworkCapture() {
  return this._network?.read() ?? [];
}
```

## 七、UnifiedPage 完整代码（2a + 2b）

```typescript
export class UnifiedPage extends BasePage {
  private _stealthInjected = false;
  private _console: ConsoleCollector | null = null;
  private _network: NetworkCollector | null = null;

  constructor(
    private session: BrowserSession,
    private cdpBackend: CdpBackend,
    private pageId: number,
  ) { super(); }

  // ── evaluate ──
  async evaluate<T>(js: string): Promise<T>;
  async evaluate<A extends unknown[], T>(fn: BrowserEvaluateFunction<A, T>, ...a: A): Promise<Awaited<T>>;
  async evaluate(input: string | BrowserEvaluateFunction<unknown[], unknown>, ...args: unknown[]): Promise<unknown> {
    const { buildEvaluateExpression } = await import('./opencli/utils.js');
    const { session } = await this.session.pages.getSession(this.pageId);
    const r = await session.Runtime.evaluate({ expression: buildEvaluateExpression(input, args), returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('Evaluate: ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
  }

  // ── goto ──
  async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    await this.session.nav(this.pageId).goto(url);
    this._lastUrl = url;
    if (!this._stealthInjected) { await this.evaluate(generateStealthJs()); this._stealthInjected = true; }
    if (options?.waitUntil !== 'none') {
      const { waitForDomStableJs } = await import('./opencli/dom-helpers.js');
      await this.evaluate(waitForDomStableJs(options?.settleMs ?? 1000, 500));
    }
  }

  async getCookies(opts?) {
    const r = await this.session.cdpJsonForPage(this.pageId, 'Network.getCookies', opts?.url ? JSON.stringify({ urls: [opts.url] }) : '{}');
    return (r as any)?.cookies ?? [];
  }

  async screenshot(options = {}) {
    const { session } = await this.session.pages.getSession(this.pageId);
    if (options.width || options.height) await session.Emulation.setDeviceMetricsOverride({ mobile: false, width: options.width ?? 0, height: options.height ?? 0, deviceScaleFactor: 1 });
    const r = await session.Page.captureScreenshot({ format: options.format ?? 'jpeg', quality: options.quality ?? 80, captureBeyondViewport: options.fullPage ?? false });
    if (options.width) await session.Emulation.clearDeviceMetricsOverride({});
    if (options.path) { const { writeFileSync } = await import('node:fs'); writeFileSync(options.path, Buffer.from(r.data, 'base64')); }
    return r.data;
  }

  async tabs() { return this.session.pages.list(); }

  async selectTab(target) {
    const pages = await this.session.pages.list();
    const page = typeof target === 'number' ? pages.find(p => p.pageId === target) : pages.find(p => p.url.includes(String(target)));
    if (page) { this.pageId = page.pageId; this.resetPageState(); this._stealthInjected = false; this._console?.stop(); this._console = null; this._network?.stop(); this._network = null; }
  }

  async cdp(method, params?) { return this.session.cdpJsonForPage(this.pageId, method, JSON.stringify(params ?? {})); }
  async nativeClick(x, y) { await this.session.input(this.pageId).clickAt(x, y); }
  async nativeType(text) { await this.session.input(this.pageId).type(text); }
  async nativeKeyPress(key, modifiers?) { await this.session.input(this.pageId).press(modifiers?.length ? `${modifiers.join('+')}+${key}` : key); }
  async insertText(text) { const { session } = await this.session.pages.getSession(this.pageId); await session.Input.insertText({ text }); }
  async handleJavaScriptDialog(accept, promptText?) { await this.session.input(this.pageId).handleDialog(accept, promptText); }

  // ── snapshot（2a: Observer + populateAxRefs; 2b: + compound）──
  async snapshot(opts?) {
    const result = await this.session.observe(this.pageId).snapshot();
    this.populateAxRefs(result.refs);
    // 2b: compound 后处理
    const compound = await this.collectCompoundInfo();
    return this.mergeCompoundIntoSnapshot(result.text, compound);
  }

  async diff() { return this.session.observe(this.pageId).diff(); }

  // 2b: annotatedScreenshot（用坐标 overlay，不用 DOM 属性）
  async annotatedScreenshot(options = {}) {
    const snapResult = await this.session.observe(this.pageId).snapshot();
    this.populateAxRefs(snapResult.refs);
    const { session } = await this.session.pages.getSession(this.pageId);
    const coords = await this.getRefCoordinates(session, snapResult.refs);
    await this.evaluate(this.installCoordOverlayJs(coords));
    try { return await this.screenshot({ ...options }); }
    finally { await this.evaluate(removeVisualRefOverlayJs()).catch(() => {}); }
  }

  async consoleMessages(level = 'all') { /* 见 event-bridge */ }
  async startNetworkCapture(pattern = '') { /* 见 event-bridge */ }
  async readNetworkCapture() { /* 见 event-bridge */ }

  // ── 私有 ──
  private populateAxRefs(refs: RefMap) {
    for (const [ref, e] of refs.byRef) {
      this._axRefs.set(ref, { ref, backendNodeId: e.backendNodeId, role: e.role, name: e.name, nth: e.nth, frame: e.frameId ? { frameId: e.frameId } : undefined });
    }
  }
  // collectCompoundInfo / mergeCompoundIntoSnapshot / getRefCoordinates / installCoordOverlayJs
  // 见上面第四、五节
}
```

## 八、包结构

```
packages/browseros-agent/packages/unified-core/
├── src/
│   ├── page.ts           # UnifiedPage
│   ├── factory.ts        # UnifiedBrowserFactory
│   ├── event-bridge.ts   # ConsoleCollector + NetworkCollector
│   └── opencli/          # 14 个文件
│       ├── base-page.ts          # 4 处改动（正则 + protected×2 + resetPageState）
│       ├── target-resolver.ts
│       ├── target-errors.ts
│       ├── visual-refs.ts        # 2b: removeVisualRefOverlayJs 复用，installOverlay 重写
│       ├── stealth.ts
│       ├── interceptor.ts
│       ├── compound.ts
│       ├── dom-snapshot.ts
│       ├── ax-snapshot.ts
│       ├── dom-helpers.ts
│       ├── utils.ts
│       ├── errors.ts
│       ├── snapshotFormatter.ts
│       └── types.ts
└── tests/
```

## 九、实现顺序

### Phase 2a（MVP，9 天）

| 步骤 | 内容 | 天数 |
|---|---|---|
| 2a.1 | 建包 + 拷 14 文件 + BasePage 4 处改动 + 修 import | 1 |
| 2a.2 | UnifiedPage transport（evaluate/goto/cookies/screenshot/tabs/selectTab/cdp） | 2 |
| 2a.3 | 原生输入 + handleJavaScriptDialog | 1 |
| 2a.4 | UnifiedBrowserFactory + stealth 注入 | 1 |
| 2a.5 | snapshot = Observer + populateAxRefs + opts.source 路由 | 0.5 |
| 2a.6 | frames + evaluateInFrame（wujie iframe 支持） | 1 |
| 2a.7 | event-bridge（ConsoleCollector + NetworkCollector） | 1 |
| 2a.8 | 注册 OpenCLI + 端到端验证 | 1.5 |

### Phase 2b（增强，5 天）

| 步骤 | 内容 | 天数 |
|---|---|---|
| 2b.1 | compound 后处理（collectCompoundInfo + mergeCompoundIntoSnapshot） | 2 |
| 2b.2 | visual ref overlay（getRefCoordinates + installCoordOverlayJs + annotatedScreenshot 覆写） | 1.5 |
| 2b.3 | 176 适配器零改动验证 | 1.5 |
| 2b.4 | 2a 遗留问题修复（见下方明细） | 2 |

**总计 16 天**

### Phase 2b 遗留问题明细（来自 2a 第 7-8 轮审查）

以下问题在 Phase 2a 中识别，经评估不影响 MVP 核心功能，但应在 Phase 2b 中处理：

#### 2b.4.1 evaluateInFrame 跨域 OOPIF 支持（P1-3）

**现状**：`evaluateInFrame` 使用 `iframe.contentWindow.eval()` 实现，仅支持同源 iframe。对于跨域 OOPIF（Out-of-Process Iframe），浏览器安全策略阻止 `contentWindow` 访问，`eval` 抛 `SecurityError`。

**影响范围**：wujie 微前端框架的 iframe 通常同源（通过 proxy 沙箱在同源环境运行 JS），当前实现覆盖了 wujie 核心场景。但公司网站 espm-uat 的 54/143 个 iframe 适配器中，如果存在跨域 iframe 则会失败。

**Phase 2b 方案**：按设计文档原始方案实现 `executionContextCreated` + `contextId` 路径：

```typescript
private _executionContexts = new Map<string, number>();  // frameId → contextId
private _ctxEventSub: (() => void) | null = null;

private async ensureRuntimeEnabled(): Promise<void> {
  if (this._ctxEventSub) return;
  const { sessionId, session } = await this.session.pages.getSession(this.pageId);
  this._ctxEventSub = this.cdpBackend.onSessionEvent(
    'Runtime.executionContextCreated',
    (params, sid) => {
      if (sid !== sessionId) return;
      const ctx = params as { context?: { id: number; auxData?: { frameId?: string } } };
      if (ctx.context?.auxData?.frameId) {
        this._executionContexts.set(ctx.context.auxData.frameId, ctx.context.id);
      }
    }
  );
  // 必须先订阅再 enable，否则 executionContextCreated 事件可能在订阅前发出并被丢弃
  // BrowserOS 的 ensureSession() 已调用 Runtime.enable()，重复调用是幂等的（会重发事件）
  await session.Runtime.enable();
}

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
  // fallback: contentWindow.eval（仅同源 iframe，跨域会抛 SecurityError）
  const wrapper = `(function() {
    const iframe = document.querySelectorAll('iframe')[${'$'}{frameIndex}];
    if (!iframe) throw new Error('Frame ${'$'}{frameIndex} not found');
    if (!iframe.contentWindow) throw new Error('Frame ${'$'}{frameIndex} has no contentWindow');
    try {
      return iframe.contentWindow.eval(${'$'}{JSON.stringify(expression)});
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SecurityError')
        throw new Error('Frame ${'$'}{frameIndex} is cross-origin (OOPIF). executionContextCreated not yet received. Retry after navigation completes.');
      throw new Error('Frame ${'$'}{frameIndex} eval failed: ' + e.message);
    }
  })()`;
  return this.evaluate(wrapper);
}
```

**selectTab 清理**：在 UnifiedPage 中添加私有方法 `clearExecutionContexts()`，由 `selectTab` 调用（不修改 base-page.ts 的 `resetPageState`，保持 OpenCLI 副本改动最小化）：

```typescript
// UnifiedPage 私有方法
private clearExecutionContexts(): void {
  this._executionContexts.clear();
  this._ctxEventSub?.();
  this._ctxEventSub = null;
}

// selectTab 中调用：
this.clearExecutionContexts();
```

**fallback 策略**：如上方代码所示，当 `_executionContexts` 中找不到 contextId 时（iframe 尚未触发 `executionContextCreated`），降级到 `contentWindow.eval`。同源 iframe 正常执行，跨域 OOPIF 返回明确的错误信息（而非静默失败）。

#### 2b.4.2 NetworkCollector async handler 安全化（P1-8）

**现状**：`NetworkCollector` 的 `loadingFinished` 事件 handler 是 `async (p) => { ... }`，但 `onSessionEvent` 的回调签名是同步的 `(params, sid) => void`。async 回调返回的 Promise 被忽略。当前代码内部有 try-catch 包裹整个 body，所以不会产生 unhandledRejection，但如果未来移除 try-catch 会有风险。

**Phase 2b 方案**：将 async 逻辑提取到独立方法，在同步回调中 `void` 调用：

```typescript
this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.loadingFinished', (p) => {
  void this.handleLoadingFinished(p as { requestId: string });
}));

private async handleLoadingFinished(params: { requestId: string }): Promise<void> {
  const idx = this.pending.get(params.requestId);
  if (idx === undefined) return;
  try {
    const bodyResult = await this.cdp.rawSendJson(
      'Network.getResponseBody',
      JSON.stringify({ requestId: params.requestId }),
      this.sessionId,
    );
    const r = bodyResult as { body?: string; base64Encoded?: boolean };
    if (typeof r?.body === 'string') {
      this.entries[idx].responsePreview = r.base64Encoded
        ? `base64:${r.body.slice(0, 8192)}`
        : r.body.slice(0, 8192);
    }
  } catch { /* body unavailable */ }
  this.pending.delete(params.requestId);
}
```

> **注意**：`handleLoadingFinished` 内部的 try-catch **不可移除**。`void` 操作符只是语法上丢弃了 Promise 引用，但如果 Promise reject 了，Node.js 仍会触发 `unhandledRejection` 事件。try-catch 是防止 unhandledRejection 的唯一保障。

#### 2b.4.3 hub.cjs 构建流程与路径健壮性（P2-10, P2-11）

**现状**：
- `bin/hub.cjs` 的 fallback 路径 `require('../src/factory.ts')` 在标准 Node.js 中无法工作（Node 不解析 .ts 文件）。
- `runtime.js` 路径用 `path.join(opencliDir, opencliPkg.main ? path.dirname(opencliPkg.main) : 'dist', 'runtime.js')` 硬编码了文件名，如果 OpenCLI 包结构变化则 patch 静默失败。
  - 实测：OpenCLI 的 `package.json` `main` 字段为 `dist/src/main.js`，`path.dirname(main)` = `dist/src`，拼接后路径 `dist/src/runtime.js` 恰好正确。但这依赖 main 字段不变，不够健壮。

**Phase 2b 方案**：
1. **明确构建流程**：在 `package.json` 中增加 `build` 脚本（`tsc --outDir dist`），文档化 `npm run build` 是部署前提。
2. **移除 .ts fallback**：`hub.cjs` 只尝试 `require('../dist/factory.js')`，失败时输出明确的错误提示（"请先运行 npm run build"）而非静默继续。
3. **runtime.js 路径解析改进**：实测确认 OpenCLI 的 `exports` 字段不包含 `./runtime` 子路径，因此不能用 exports 解析。改为多候选路径探测：

```javascript
// 改进后的 runtime 路径解析
function resolveRuntimePath(opencliDir, opencliPkg) {
  // OpenCLI exports 不含 ./runtime，用多候选路径探测
  const candidates = [
    path.join(opencliDir, 'dist', 'src', 'runtime.js'),           // OpenCLI 实际编译路径
    path.join(opencliDir, 'dist', 'runtime.js'),                   // 备选
    path.join(opencliDir, opencliPkg.main ? path.dirname(opencliPkg.main) : 'dist', 'runtime.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null; // patch 失败，hub.cjs 输出警告并降级为直接运行 opencli
}
```

4. **版本兼容性检查**：patch 成功后检查 `runtime.getBrowserFactory` 是否为 function，如果不是则输出警告。

#### 2b.4.4 已关闭问题清单（无需处理）

| 编号 | 问题 | 结论 |
 |---|---|---|
 | P2-14 | factory.ts `newPage` 返回值可能不是数字 | 伪问题。源码确认 `newPage` 返回 `Promise<number>`。 |
 | `_stealthRegistered` | write-only 死字段 | 已在 commit bf30dbb 中移除。 |
 | `_stealthInjected` 双重注入 | factory.connect() 注入 `addScriptToEvaluateOnNewDocument`（新文档），goto() 注入 `evaluate()`（当前页面） | 设计正确：两层互补，connect 时注册覆盖未来导航，goto 时注入覆盖当前页面。 |

## 十、五轮审查问题处理汇总

### P0 全部修复

| 编号 | 问题 | 轮次 | 修复 |
|---|---|---|---|
| P0-1 | target-errors.ts 遗漏 | 1 | 文件清单 |
| P0-2 | 拷错 interceptor | 1 | interceptor.ts |
| P0-3 | evaluate 缺重载 | 1 | 两个重载 + buildEvaluateExpression |
| P0-4 | errors.ts 运行时依赖 | 2 | 文件清单 |
| P0-5 | snapshotFormatter 文件名 | 2 | 驼峰 |
| P0-6 | 两个 utils.ts | 2 | 不用 src/utils.ts |
| P0-7 | ref 格式不兼容 | 3 | 正则 `/^e?\d+$/` + 不统一格式 |
| P0-8 | private 字段 | 3 | 改 protected + resetPageState |
| P0-9 | 编造 matchLevel | 3 | 不覆写 click |
| P0-10 | visual-refs Number(eN)=NaN | 4 | 重写 overlay 用坐标，不用 Number() |
| P0-11 | annotatedScreenshot source 不匹配 | 4 | 覆写 annotatedScreenshot |
| P0-12 | 共享 CdpBackend 承诺不成立 | 6 | 独立 CDP 连接，共享浏览器进程 |
| P0-13 | snapshot 默认格式变化 | 6 | opts.source 路由 |
| P0-14 | rawSendJson 解构丢 this | 5 | 直接用 this.cdp.rawSendJson() |
| P0-15 | ConsoleCollector 缺 Runtime.enable | 5 | start() 加 Runtime.enable|
| P0-12 | 共享 CdpBackend 承诺不成立 | 6 | 改为独立 CDP 连接，共享浏览器进程 |
| P0-13 | snapshot 默认格式变了 | 6 | opts.source 路由，dom 走 super.snapshot|

### P1 全部处理

| 编号 | 问题 | 轮次 | 处理 |
|---|---|---|---|
| P1-1 | eN ref 降级 | 1+3 | 各走各路 |
| P1-2 | session 缓存 | 1 | 不缓存 |
| P1-3 | stealth 时机 | 1+2 | factory.connect() |
| P1-4 | consoleMessages | 1+4 | ConsoleCollector 完整实现 |
| P1-5 | screenshot 选项 | 1+2 | 从 CDPPage 搬 |
| P1-6 | networkCapture | 1+4 | NetworkCollector 完整实现 |
| P1-7 | 事件订阅模型 | 2 | onSessionEvent |
| P1-8 | handleJavaScriptDialog | 2 | Input.handleDialog |
| P1-9 | click 重复 | 3 | 不覆写 |
| P1-10 | snapshot 格式 | 3 | 统一 BrowserClaw renderSnapshot |
| P1-11 | fillText 验证 | 3 | 不覆写，BasePage 内置验证 |
| P1-12 | injectOpenCliRefs 200+ 调用 | 4 | 删除 injectOpenCliRefs，compound 用 evaluate，visual ref 用 DOM.getBoxModel |
| P1-13 | stale ref iframe 路由 | 4 | 低优先级，仅影响跨源 iframe stale ref |
| P1-14 | event-bridge 未实现 | 4 | 完整实现 ConsoleCollector + NetworkCollector |
| P1-15 | compound name 匹配不可靠 | 5 | 改用 backendNodeId → callFunctionOn |
| P1-16 | factory stealth 代码缺失 | 5 | connect() 加 addScriptToEvaluateOnNewDocument |
| P1-17 | NetworkCollector.stop 缺 Network.disable | 5 | stop() 加 Network.disable|

### P2 全部处理

| 编号 | 问题 | 轮次 | 处理 |
|---|---|---|---|
| P2-1 | selectTab 状态 | 1+3 | resetPageState() |
| P2-2 | injectOpenCliRefs 性能 | 1+4 | 删除，不需要 |
| P2-3 | fillText 验证 | 1+3 | 不覆写 |
| P2-4 | 文件清单 | 1+2 | 14 个文件 |
| P2-5 | allowBoundNavigation | 1 | 低优先级 |
| P2-6 | matchLevel 硬编码 | 3 | 可接受 |
| P2-7 | stealth guard | 2 | 确认无问题 |
| P2-8 | objectId 时序 | 4 | 可接受 |
| P2-9 | errors.ts 类型依赖 | 4 | import type 擦除 |
| P2-10 | compound JSON 格式 | 4 | 紧凑格式，不用 JSON.stringify |

## 十一、功能来源拆解

### 入口和命令执行

| 功能 | 来源 | 说明 |
|---|---|---|
| CLI 入口 (`hub` 命令) | 融合 | 新写 wrapper，monkey-patch getBrowserFactory 后转发 OpenCLI CLI |
| 参数解析 | OpenCLI | commanderAdapter |
| 命令执行引擎 | OpenCLI | execution.ts |
| 176 + 143 个适配器 | OpenCLI | clis/ 目录 |
| 声明式 pipeline | OpenCLI | pipeline/ |

### 浏览器连接和 Tab/窗口管理

| 功能 | 来源 | 说明 |
|---|---|---|
| CDP WebSocket 连接 | BrowserOS | CdpBackend，比 OpenCLI CDPBridge 更健壮（重连、session 管理） |
| Tab 列表 | BrowserOS | PageManager.list()，用 BrowserClaw 自定义 CDP Browser.getTabs |
| 新开 Tab | BrowserOS | PageManager.newPage()，Browser.createTab CDP 域 |
| 关闭 Tab | BrowserOS | PageManager.close()，Browser.closeTab CDP 域 |
| 切换 Tab | 融合 | UnifiedPage.selectTab()，改 pageId + resetPageState |
| 窗口管理 | BrowserOS | WindowManager，Browser.setWindowBounds 等 CDP 域 |
| Tab Group 着色 | BrowserOS | claw-server-rust effects |

### Snapshot

| 功能 | 来源 | 说明 |
|---|---|---|
| AX tree 捕获 | BrowserOS | Observer.snapshot()，iframe stitching、OOPIF |
| ref 分配 | BrowserOS | RefMap，eN 格式 |
| _axRefs 填充 | 融合 | 把 BrowserOS RefMap 转填到 OpenCLI 的 _axRefs |
| compound 组件识别 | OpenCLI | compoundInfoOf，通过 callFunctionOn |
| visual ref 叠加 | 融合 | DOM.getBoxModel 坐标 → 自定义 overlay JS |
| Diff | BrowserOS | Observer.diff() |
| source='dom' 路径 | OpenCLI | BasePage 的 generateSnapshotJs，通过 evaluate |

### Click / 输入

| 功能 | 来源 | 说明 |
|---|---|---|
| ref 解析（eN ref） | 融合 | OpenCLI tryClickAxRef + BrowserOS _axRefs（从 RefMap 填充） |
| ref 解析（CSS 选择器） | OpenCLI | resolveTargetJs，通过 evaluate |
| 坐标获取 | BrowserOS | DOM.getBoxModel(backendNodeId) |
| 鼠标点击 | BrowserOS | Input.clickAt，CDP dispatchMouseEvent |
| 键盘输入 | BrowserOS | Input.type/press，CDP dispatchKeyEvent |
| 文本填充 | 融合 | BasePage.fillText（fingerprint + 双写 Vue setter）→ nativeType → BrowserOS Input |
| 双击/拖拽/hover | OpenCLI | BasePage 的 tryNativeDoubleClick/tryNativeDrag，通过 CDP Input |
| 文件上传 | OpenCLI | BasePage，CDP DOM.setFileInputFiles |
| JS 对话框 | BrowserOS | Input.handleDialog |
| Stale ref 恢复 | 融合 | OpenCLI 的 resolveAxRefPoint（AX tree 重查）跑在 BrowserOS CDP session 上 |

### 导航

| 功能 | 来源 | 说明 |
|---|---|---|
| goto/back/forward/reload | BrowserOS | Navigation |
| Stealth 反检测 | OpenCLI | stealth.ts，evaluate + addScriptToEvaluateOnNewDocument |
| DOM 稳定等待 | OpenCLI | waitForDomStableJs，evaluate |

### 网络

| 功能 | 来源 | 说明 |
|---|---|---|
| JS 级拦截（fetch/XHR） | OpenCLI | installInterceptor，evaluate 注入 patch |
| CDP 级捕获（response body） | 融合 | NetworkCollector，onSessionEvent 事件链 |
| 网络请求列表 | OpenCLI | BasePage.networkRequests，读拦截 buffer |

### Console

| 功能 | 来源 | 说明 |
|---|---|---|
| Console 消息捕获 | 融合 | ConsoleCollector，onSessionEvent + Runtime.consoleAPICalled |

### iframe

| 功能 | 来源 | 说明 |
|---|---|---|
| AX tree iframe stitching | BrowserOS | Observer 递归捕获子 frame |
| Frame 列表 | 融合 | frames()，CDP Page.getFrameTree |
| Frame 内 JS 执行 | 融合 | evaluateInFrame，Runtime.evaluate + executionContextId |
| 同源 iframe DOM 访问 | OpenCLI | 适配器里 evaluate + contentDocument 模式 |

### 截图

| 功能 | 来源 | 说明 |
|---|---|---|
| 截图捕获 | CDP | Page.captureScreenshot |
| viewport 覆盖 | OpenCLI | 从 CDPPage 搬的 Emulation.setDeviceMetricsOverride |
| 全页截图 | OpenCLI | captureBeyondViewport |
| 文件保存 | 融合 | fs.writeFileSync（不用 OpenCLI 的 saveBase64ToFile） |
| 视觉标注 | 融合 | DOM.getBoxModel 坐标 → 自定义 overlay |

### 安全

| 功能 | 来源 | 说明 |
|---|---|---|
| Stealth 反检测 | OpenCLI | navigator.webdriver = false 等 |
| Trust Boundary nonce 包裹 | BrowserOS | trust-boundary.ts |

### MCP（路径 2，独立于 hub-browser）

| 功能 | 来源 | 说明 |
|---|---|---|
| MCP server | BrowserOS | claw-server-rust，:9010 |
| 17 个 MCP 工具 | BrowserOS | browser-mcp |
| 录屏回放 | BrowserOS | recording_index + replay |
| 审计日志 | BrowserOS | audit_log |

### 总结

**OpenCLI 贡献**：入口、CLI、176+143 适配器、pipeline、stealth、compound、fingerprint ref、网络拦截、observation、DOM 稳定等待、Vue 双写 setter、visual ref overlay、viewport 覆盖

**BrowserOS 贡献**：CDP 连接、Tab/窗口管理、AX tree snapshot、Input（鼠标/键盘）、Diff、Trust Boundary、MCP server、录屏、审计、iframe stitching

**融合层（新写）**：UnifiedPage（transport 桥接）、_axRefs 填充、ConsoleCollector、NetworkCollector、frames/evaluateInFrame、视觉 ref 坐标 overlay、bin/hub 入口

## 十二、依赖管理

### BrowserOS 引用方式：git submodule

```bash
git submodule add https://github.com/browseros-ai/BrowserOS.git vendor/browseros
cd vendor/browseros && git checkout <commit-hash>
```

package.json：
```json
{
  "workspaces": [
    "vendor/browseros/packages/browseros-agent/packages/*"
  ],
  "dependencies": {
    "@browseros/browser-core": "workspace:*",
    "@browseros/cdp-protocol": "workspace:*",
    "@browseros/shared": "workspace:*"
  }
}
```

别人 clone：
```bash
git clone --recurse-submodules https://github.com/Hubert811/hub-browser.git
bun install
```

BrowserOS 更新：
```bash
cd vendor/browseros && git pull origin main && cd -
git add vendor/browseros && git commit -m "update browseros to latest"
```

### OpenCLI 引用方式：npm 依赖 + 拷贝 14 个源文件

package.json：
```json
{
  "dependencies": {
    "@jackwener/opencli": "latest"
  }
}
```

OpenCLI 的 14 个源文件拷贝到 `src/opencli/`，修改在副本上做。OpenCLI 的 npm 包提供 CLI 引擎（execution.ts、cli.ts、registry 等运行时代码），但 BasePage 等被修改的文件用我们的副本。

### 仓库结构

```
hub-browser/
├── .gitmodules               # BrowserOS submodule
├── vendor/
│   └── browseros/             # BrowserOS git submodule（只读）
├── package.json              # @hub/browser
├── tsconfig.json
├── bin/
│   └── hub                   # CLI 入口（monkey-patch + 转发 opencli）
├── src/
│   ├── page.ts               # UnifiedPage
│   ├── factory.ts            # UnifiedBrowserFactory
│   ├── event-bridge.ts       # ConsoleCollector + NetworkCollector
│   └── opencli/              # 14 个文件（从 OpenCLI 拷贝，BasePage 改 4 处）
│       ├── base-page.ts      # 正则 + protected + resetPageState
│       ├── target-resolver.ts
│       ├── target-errors.ts
│       ├── visual-refs.ts
│       ├── stealth.ts
│       ├── interceptor.ts
│       ├── compound.ts
│       ├── dom-snapshot.ts
│       ├── ax-snapshot.ts
│       ├── dom-helpers.ts
│       ├── utils.ts
│       ├── errors.ts
│       ├── snapshotFormatter.ts
│       └── types.ts
└── tests/
```
