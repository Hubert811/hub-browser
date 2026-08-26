# 网络捕获通道：自带收集器无 postData，CDP 在 portal iframe 上不可靠

## 问题现象

- hub 自带 `page.startNetworkCapture/readNetworkCapture` 拿不到请求体，真实值断言没法做
- 直接订阅 CDP `Network.requestWillBeSent` 拿 `request.postData`：有时能拿到，有时 0 事件（尤其 persistent 复用标签、跳过导航时）

## 根因

1. **自带 NetworkCollector 只记录** `url / method / timestamp / responseStatus / responsePreview`，**不提供请求体 postData**（`src/event-bridge.ts`）。
2. **CDP `requestWillBeSent` 在 portal iframe 上不可靠**：页面会话的 Network 事件里，iframe 发出的请求可能不送达（实测 persistent 复用标签、跳过 goto 时 0 个 olap 事件；全新导航后才偶发可捕获）。

## 修复方案

**双通道捕获，patch 主 + CDP 次**（见 `shared-js/wait-and-state.md` 的 `installRequestCapture`）：

- **主通道：页面内 iframe `window.fetch` 补丁**——在 fetch 包装里记录 `{url, body}`（body 优先取 string，其次 `String(URLSearchParams)`，再次 `req.clone().text()`）。实测稳定拿到完整表单体。
- **次通道：CDP `Network.requestWillBeSent`（经 `page.pageSession()`）**——框架无关，万一站点代理 fetch 时可能有救；但 postData 可能缺失。
- `waitFirst` **优先返回有 body 的条目**（跳过空 body）。

```javascript
// 主通道核心（patch 在 iframe window 上）
win.fetch = async function (...a) {
  // url.includes("/olap/") → 记录 { url, body: 原始 form 字符串 }
  return origFetch.apply(this, a);
};
```

## 通用性

- 所有需要"数据与 UI 一致"（真实值断言 / payload 重放）的适配器
- iframe 套内容站点、需要请求体的站点

## 验证建议

- 用探针确认：无补丁时 CDP 能否拿到 postData；装补丁后 patch 通道是否有 body
- 连续 3 次运行，确认每次都能拿到非空 body（不能靠运气）
