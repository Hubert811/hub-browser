# iframe 上下文：window 指顶层，不是 iframe

## 问题现象

- 捕获补丁写在 iframe 上，读的时候读顶层 → 永远读不到（空数组/undefined）
- 在 iframe 里 patch 了 `window.fetch`，但请求没被拦截

## 根因

`page.evaluate` 的字符串在**顶层 frame** 执行。代码里的 `window` 是**顶层 window**，不是 iframe 的。业务 DOM/请求在 iframe 里时：

```javascript
// ❌ window 是顶层，__cap 写到了 iframe 的 window 上，读顶层永远空
win.__cap.push(...);  // 写在 iframe.contentWindow
window.__cap          // 读顶层 window → undefined
```

## 修复方案

- 写和读都显式走 `iframe.contentWindow`：

```javascript
const f = document.querySelector('iframe.portal-iframe-container');
const win = f.contentWindow;
win.fetch = ...;            // patch 在 iframe 的 fetch 上
const list = win.__cap || [];  // 读也从 contentWindow 读
```

- iframe 的 fetch 必须 patch 在 `iframe.contentWindow.fetch` 上（顶层 patch 拦截不到 iframe 发起的请求）。
- 工具函数参考：`shared-js/wait-and-state.md` 的 `findActiveDoc`。

## 通用性

- iframe 套内容、微前端（wujie/qiankun）站点

## 验证建议

- 写/读各打一次 `console.error`，确认两边都指向同一个 iframe window
- 用 `f.contentWindow === window` 打印确认不是同一对象
