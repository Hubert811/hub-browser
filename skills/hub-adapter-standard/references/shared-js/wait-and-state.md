# 等待与状态类单点操作

该新增的 C 类（文件+导航）+ D 类（等待）+ E 类（状态）公共函数。

---

## C 类：文件与导航

### 11. `uploadFiles(page, paths, opts?)` — 文件上传

**适用组件**：`<input type="file">`、拖拽上传区域

**前端背景**：文件上传不能用 JS 直接设值（浏览器安全限制）。CDP `DOM.setFileInputFiles` 直接让浏览器读本地文件。上传后组件会显示进度条/loading，需要等 settle。

**签名**：

```typescript
uploadFiles(page: IPage, paths: string[], opts?: {
  selector?: string        // 文件输入框选择器（默认 'input[type="file"]'）
  waitMs?: number          // 等上传完成毫秒（默认 3000）
  verifySelector?: string  // 验证上传成功的选择器（如缩略图）
}): boolean
```

**代码**：

```javascript
export async function uploadFiles(page, paths, opts = {}) {
  const { selector = 'input[type="file"]', waitMs = 3000, verifySelector } = opts

  if (!page.setFileInput) throw new Error('setFileInput not available')
  await page.setFileInput(paths, selector)
  await page.wait(waitMs / 1000)

  if (verifySelector) {
    return await page.evaluate((sel) => !!document.querySelector(sel), verifySelector)
  }
  return true
}
```

**调用示例**：

```javascript
// 基本用法
await uploadFiles(page, ['/path/to/a.jpg', '/path/to/b.jpg'])

// 指定选择器 + 验证
await uploadFiles(page, [filePath], {
  selector: 'input[type="file"][accept*="image"]',
  verifySelector: '.upload-success'
})
```

**官方重复**：13 个文件（xiaohongshu、twitter、instagram、claude、deepseek、douyin、weibo 等）。

---

### 12. `navigateTo(page, url, opts?)` — 导航+等渲染

**适用场景**：所有适配器第一步

**前端背景**：SPA 应用导航后 DOM 不是立刻就绪，需要等关键元素出现。部分微前端站点第一次加载空白，需要 reload 才有内容。

**签名**：

```typescript
navigateTo(page: IPage, url: string, opts?: {
  waitUntil?: 'load' | 'domcontentloaded' | 'none'  // 默认 'domcontentloaded'
  settleMs?: number        // 导航后固定等待毫秒（默认 2000）
  reload?: boolean         // 是否需要 reload（默认 false）
  checkSelector?: string   // 等什么元素出现算就绪
  timeoutMs?: number       // 等待超时毫秒（默认 15000）
  searchIframes?: boolean  // checkSelector 是否在 iframe 里找（默认 true）
}): boolean
```

**代码**：

```javascript
export async function navigateTo(page, url, opts = {}) {
  const {
    waitUntil = 'domcontentloaded',
    settleMs = 2000,
    reload = false,
    checkSelector,
    timeoutMs = 15000,
    searchIframes = true,
  } = opts

  await page.goto(url, { waitUntil, settleMs })

  if (reload) {
    await page.evaluate(() => { location.reload() })
    await page.wait(settleMs / 1000 + 1)  // reload 后多等一会
  }

  if (!checkSelector) return true

  // 轮询等关键元素出现
  const interval = 500
  const maxAttempts = Math.ceil(timeoutMs / interval)
  for (let i = 0; i < maxAttempts; i++) {
    const found = await page.evaluate((sel, searchIframes) => {
      if (document.querySelector(sel)) return true
      if (searchIframes) {
        for (const iframe of document.querySelectorAll('iframe')) {
          try {
            if (iframe.contentDocument?.querySelector(sel)) return true
          } catch (e) {}
        }
      }
      return false
    }, checkSelector, searchIframes)
    if (found) return true
    await page.wait(interval / 1000)
  }
  return false
}
```

**调用示例**：

```javascript
// 基本用法 — 导航 + 等 el-table 出现
await navigateTo(page, 'https://app.example.com/orders', {
  checkSelector: '.el-table'
})

// 微前端站点特殊情况 — 需要 reload
await navigateTo(page, PAGE_URL, {
  reload: true,
  checkSelector: '.el-table',
  searchIframes: true,  // 表格在 iframe 里
  timeoutMs: 15000,
})
```

---

## D 类：等待

### 13. `waitForLoadingMask(page, opts?)` — 等 loading 遮罩消失

**适用组件**：Element UI 全组件、任何用 loading 遮罩的框架

**前端背景**：Element UI 的 loading 遮罩在 API 请求期间显示，消失表示数据加载完成。固定 sleep 不可靠——快了数据没来，慢了浪费时间。

**为什么有状态机**：如果一开始没有 loading，直接返回可能太早（loading 还没出现）。所以至少等几轮确认 loading 真的没出现过。先等出现再等消失，避免"伪消失"。

**签名**：

```typescript
waitForLoadingMask(page: IPage, opts?: {
  maskSelector?: string    // 遮罩选择器（默认 '.el-loading-mask'）
  searchIframes?: boolean  // 是否遍历 iframe（默认 true）
  timeoutMs?: number       // 超时毫秒（默认 15000）
  intervalMs?: number      // 轮询间隔毫秒（默认 300）
  requireAppear?: boolean  // 是否要求 mask 先出现再消失（默认 true）
}): boolean
```

**代码**：

```javascript
export async function waitForLoadingMask(page, opts = {}) {
  const {
    maskSelector = '.el-loading-mask',
    searchIframes = true,
    timeoutMs = 15000,
    intervalMs = 300,
    requireAppear = true,
  } = opts

  const max = Math.ceil(timeoutMs / intervalMs)
  let started = false
  for (let i = 0; i < max; i++) {
    const loading = await page.evaluate((sel, searchIframes) => {
      const docs = [document]
      if (searchIframes) {
        document.querySelectorAll('iframe').forEach(f => {
          try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
        })
      }
      for (const doc of docs) {
        const mask = doc.querySelector(sel)
        if (mask && getComputedStyle(mask).display !== 'none') return true
      }
      return false
    }, maskSelector, searchIframes)

    if (loading) started = true
    if (started && !loading) return true   // 出现过又消失 → 完成
    if (!requireAppear && !loading && i > 3) return true  // 不要求出现，等 3 轮就过
    await page.wait(intervalMs / 1000)
  }
  return false
}
```

**调用示例**：

```javascript
// 基本用法
await waitForLoadingMask(page)

// 自定义遮罩选择器
await waitForLoadingMask(page, { maskSelector: '.custom-loading' })

// 不要求先出现（某些页面 loading 很快就闪过）
await waitForLoadingMask(page, { requireAppear: false })
```

**官方重复**：多个列表页适配器写了类似逻辑（但没抽成函数）。

---

### 14. `waitForElement(page, selectorFn, opts?)` — 等元素出现

**适用场景**：页面加载完成检测、异步渲染等待

**前端背景**：SPA 路由切换后旧 DOM 消失新 DOM 异步渲染，无法预知何时完成。轮询检查元素存在性是最可靠的信号。

**签名**：

```typescript
waitForElement(page: IPage, selectorFn: () => boolean, opts?: {
  timeoutMs?: number   // 超时毫秒（默认 10000）
  intervalMs?: number  // 轮询间隔毫秒（默认 500）
}): boolean
```

**代码**：

```javascript
export async function waitForElement(page, selectorFn, opts = {}) {
  const { timeoutMs = 10000, intervalMs = 500 } = opts
  const maxAttempts = Math.ceil(timeoutMs / intervalMs)
  for (let i = 0; i < maxAttempts; i++) {
    const result = await page.evaluate(selectorFn)
    if (result) return true
    await page.wait(intervalMs / 1000)
  }
  return false
}
```

**调用示例**：

```javascript
// 等表格出现
await waitForElement(page, () => !!document.querySelector('.el-table'))

// 等按钮出现
await waitForElement(page, () => {
  return [...document.querySelectorAll('button')]
    .some(b => b.innerText.trim() === '搜索')
}, { timeoutMs: 20000 })
```

---

### 15. `waitForNetworkIdle(page, opts?)` — 等网络空闲

**适用场景**：重度异步页面、需要确保所有数据加载完

**前端背景**：某些页面加载完成后还会发多个异步请求（埋点、预加载），等所有请求结束才表示真正就绪。

**签名**：

```typescript
waitForNetworkIdle(page: IPage, opts?: {
  idleMs?: number      // 多久没新请求算空闲（默认 1000）
  timeoutMs?: number   // 超时毫秒（默认 30000）
}): boolean
```

**代码**：

```javascript
export async function waitForNetworkIdle(page, opts = {}) {
  const { idleMs = 1000, timeoutMs = 30000 } = opts
  if (!page.startNetworkCapture || !page.readNetworkCapture) return false

  await page.startNetworkCapture('')
  const deadline = Date.now() + timeoutMs
  let lastCount = 0  // 上次请求总数
  let lastChangeTime = Date.now()  // 最后一次请求数量变化的时间

  while (Date.now() < deadline) {
    const entries = await page.readNetworkCapture()
    const currentCount = Array.isArray(entries) ? entries.length : 0
    if (currentCount > lastCount) {
      // 有新请求
      lastCount = currentCount
      lastChangeTime = Date.now()
    }
    if (Date.now() - lastChangeTime >= idleMs) return true  // idleMs 内无新请求
    await page.wait(0.5)
  }
  return false
}
```

---

## E 类：状态

### 16. `checkAuthCookie(page, domain, cookieName)` — 登录态检查

**适用场景**：所有需要登录的适配器

**前端背景**：登录态通常存在 cookie 里。不同系统 cookie 名不同，但检查逻辑完全一样。

**签名**：

```typescript
checkAuthCookie(page: IPage, domain: string, cookieName: string): void
// 不登录直接 throw AuthRequiredError
```

**代码**：

```javascript
import { AuthRequiredError } from '@jackwener/opencli/errors'

export async function checkAuthCookie(page, domain, cookieName) {
  const cookies = await page.getCookies({ domain })
  if (!cookies.some(c => c.name === cookieName)) {
    throw new AuthRequiredError(`Not logged in — ${cookieName} cookie missing`)
  }
}
```

**调用示例**：

```javascript
// 基本用法
await checkAuthCookie(page, 'example.com', 'session_token')

// 多域检查
for (const domain of ['app.example.com', '.example.com']) {
  try {
    await checkAuthCookie(page, domain, 'session_token')
    break
  } catch (e) { /* 试下一个域 */ }
}
```

**官方重复**：110 个文件各自写了 `getCookies` + `some` + throw。

---

### 17. `findActiveDoc(page, targetSelector, opts?)` — 找活跃文档

**适用场景**：iframe 套内容的系统、微前端架构

**前端背景**：某些 B 端系统的内容渲染在 iframe 里，不在主文档上。每次操作都要先找到正确的 document 对象。跨域 iframe 的 `contentDocument` 会抛异常，要 catch。

**设计说明**：不返回 `evaluateHandle`（CDP 序列化对象有坑），而是返回一个标记——主文档还是哪个 iframe。调用方拿到标记后，在后续 evaluate 里用它定位正确的 document。

**签名**：

```typescript
findActiveDoc(page: IPage, targetSelector: string, opts?: {
  searchIframes?: boolean  // 默认 true
}): { doc: 'main' | number, selector: string }
// doc='main' → 主文档, doc=N → 第 N 个 iframe
```

**代码**：

```javascript
export async function findActiveDoc(page, targetSelector = '.el-table, .el-form, .el-pagination', opts = {}) {
  const { searchIframes = true } = opts

  const result = await page.evaluate((sel, searchIframes) => {
    if (document.querySelector(sel)) return { doc: 'main' }
    if (searchIframes) {
      const iframes = document.querySelectorAll('iframe')
      for (let i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentDocument?.querySelector(sel)) {
            return { doc: i }
          }
        } catch (e) {}
      }
    }
    return { doc: 'main' }  // fallback 到主文档
  }, targetSelector, searchIframes)

  return result
}
```

**调用示例**：

```javascript
// 找到包含表格的文档
const { doc } = await findActiveDoc(page, '.el-table')

// 在后续 evaluate 里用 doc 定位
await page.evaluate((docIndex) => {
  let doc = document
  if (docIndex !== 'main') {
    doc = document.querySelectorAll('iframe')[docIndex].contentDocument
  }
  const table = doc.querySelector('.el-table')
  // ... 操作 table
}, doc)
```

**重复情况**：iframe 遍历逻辑曾散落在大量函数里，务必统一走 `findActiveDoc`。

---

### 18. `waitForAnchor(page, bodyExpr, opts?)` — 锚点轮询等待（AAA 核心）

**适用场景**：所有「操作后等预期状态出现」的交互（搜索结果渲染、计数变化、弹层关闭、输入值生效）

**前端背景**：固定 sleep 是竞态来源（见 `patterns/anchor-assert.md` §1）。预期状态可枚举，就用轮询等待它出现，而不是猜时间。

**签名**：

```typescript
waitForAnchor(page: IPage, bodyExpr: string, opts?: {
  desc?: string       // 描述（超时错误信息用）
  timeoutMs?: number  // 超时毫秒（默认 15000）
  intervalMs?: number // 轮询间隔毫秒（默认 400）
}): Promise<{ ok: true, ...observed }>
// bodyExpr 在页面/iframe 上下文求值，返回 { ok: true, ...observed } 表示预期状态出现
// 超时抛 CommandExecutionError，携带最后一次 observed（供排查）
```

**代码**：

```javascript
export async function waitForAnchor(page, bodyExpr, { desc = '条件', timeoutMs = 15000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null, lastErr = null;
  while (Date.now() < deadline) {
    try { last = await dashEval(page, bodyExpr); } catch (e) { lastErr = e; last = null; }
    if (last && last.ok === true) return last;
    await sleep(intervalMs);
  }
  const observed = last ? JSON.stringify(last)
    : (lastErr ? ('evaluate-err: ' + (lastErr.message || '').slice(0, 300)) : 'no-observed-state');
  throw new CommandExecutionError('锚点等待超时: ' + desc + ' (最后状态: ' + observed.slice(0, 600) + ')');
}
```

**调用示例**：

```javascript
// 等搜索结果过滤渲染（全部叶子项含搜索词）
await waitForAnchor(page, `(() => {
  const popup = visiblePopup(d);
  const leaves = leafItems(popup).filter((x) => !['加载中...', '请从左侧列表选择添加'].includes(x));
  return leaves.length > 0 && leaves.every((x) => x.includes('战略'))
    ? { ok: true, items: leaves }
    : { ok: false, observed: popup.innerText };
})()`, { desc: '级联搜索结果渲染', timeoutMs: 25000 });

// 等计数变化（已添加(N) N>=1）
await waitForAnchor(page, `(() => {
  const t = visiblePopup(d).innerText || '';
  const idx = t.indexOf('已添加(');
  const added = idx >= 0 ? parseInt(t.slice(idx + 4).replace(/[^0-9].*$/, ''), 10) || 0 : 0;
  return added >= 1 ? { ok: true, added } : { ok: false, added };
})()`, { desc: '添加全部字段值生效' });
```

**注意**：bodyExpr 必须由调用方保证是表达式（IIFE）；dashEval 包装层必须 `return (body)`（见 `shared-js/eval-helpers.md` 与 `pitfalls/evaluate-return.md`）。

---

### 19. `installRequestCapture(page, opts?)` — 页面自身请求捕获（patch 主 + CDP 次）

**适用场景**：需要"数据与 UI 一致"的适配器——真实值断言（校验页面实际查询条件 == 期望）与 payload 重放分页

**前端背景**：hub 自带 `readNetworkCapture` 不提供请求体 postData；CDP `requestWillBeSent` 在 portal iframe 上不可靠（见 `pitfalls/network-capture.md`）。页面内 fetch 补丁实测最稳。

**签名**：

```typescript
installRequestCapture(page: IPage, opts?: {
  urlPattern?: string   // URL 包含匹配（默认 '/olap/'）
  frameSelector?: string // 补丁打在哪个 iframe（默认 'iframe.portal-iframe-container'）
  cdpSecondary?: boolean // 是否同时订阅 CDP（默认 true）
}): Promise<{
  waitFirst(timeoutMs?: number): Promise<{ url: string, body: string, via: 'patch' | 'cdp' }>
  stop(): Promise<void>
}>
```

**代码**：

```javascript
export async function installRequestCapture(page, opts = {}) {
  const { urlPattern = '/olap/', frameSelector = 'iframe.portal-iframe-container', cdpSecondary = true } = opts;
  const cdpEntries = [];
  let unsubNet = null;
  if (cdpSecondary) {
    try {
      const session = await page.pageSession();
      await session.Network.enable().catch(() => {});
      unsubNet = session.Network.on('requestWillBeSent', (params) => {
        try {
          const req = params && params.request;
          const url = req && (req.url || '');
          if (url.includes(urlPattern)) {
            cdpEntries.push({ url, body: req.postData || '', at: Date.now(), via: 'cdp' });
          }
        } catch (_) {}
      });
    } catch (e) { /* CDP 订阅失败则仅靠补丁 */ }
  }
  // 主通道：iframe window.fetch 补丁（写/读都走 contentWindow）
  const res = await dashEval(page, `(() => {
    const f = document.querySelector('${frameSelector}');
    if (!f || !f.contentWindow) return { __err: 'no-iframe' };
    const win = f.contentWindow;
    if (win.__reqCapInstalled) { win.__reqCap.length = 0; return { ok: true, cleared: true }; }
    win.__reqCap = [];
    const origFetch = win.fetch.bind(win);
    win.fetch = async function (...a) {
      const req = a[0], opts2 = a[1] || {};
      let url = '';
      if (typeof req === 'string') url = req;
      else if (req && req.url) url = req.url;
      if (url.includes('${urlPattern}')) {
        let raw = '';
        try {
          if (typeof opts2.body === 'string') raw = opts2.body;
          else if (opts2.body && typeof opts2.body.get === 'function') raw = String(opts2.body);
          else if (req && typeof req.clone === 'function') { const c = req.clone(); raw = await c.text(); }
        } catch (e) {}
        win.__reqCap.push({ url, body: raw, at: Date.now(), via: 'patch' });
      }
      return origFetch.apply(this, a);
    };
    win.__reqCapInstalled = true;
    return { ok: true };
  })()`);
  if (res && res.__err) throw new CommandExecutionError('安装请求捕获失败: ' + res.__err);
  return {
    waitFirst: async (timeoutMs = 25000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const list = await dashEval(page, `(() => { const f = document.querySelector('${frameSelector}'); return (f && f.contentWindow && f.contentWindow.__reqCap) || []; })()`);
        if (Array.isArray(list) && list.length > 0) {
          const withBody = list.find((e) => String(e.body || '').length > 0);
          if (withBody) return withBody;
        }
        const withBodyCdp = cdpEntries.find((e) => String(e.body || '').length > 0);
        if (withBodyCdp) return withBodyCdp;
        await sleep(400);
      }
      throw new CommandExecutionError('等待页面自身请求超时（' + timeoutMs + 'ms）——查询按钮可能未触发请求');
    },
    stop: async () => { if (unsubNet) { try { unsubNet(); } catch (_) {} unsubNet = null; } },
  };
}
```

**调用示例**：

```javascript
const capture = await installRequestCapture(page, { urlPattern: '/olap/' });
await clickButtonByText(page, '查询');
await waitForLoadingMask(page);
const req = await capture.waitFirst(25000);   // { url, body: form-urlencoded 表单体 }
await capture.stop();
// 真实值断言 + payload 重放分页见 patterns/anchor-assert.md §4-5
```

**通用性**：需要请求体做真实值断言/重放的适配器；iframe 套内容站点。
