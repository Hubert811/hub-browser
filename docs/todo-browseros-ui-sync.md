# BrowserOS neo UI 功能同步待办

> 记录日期：2026-08-07
> 来源：BrowserOS neo v0.49.6（`vendor/browseros` 已同步到 `4d341b8`）

## 目标

让 hub-browser 对接 BrowserOS neo 本次新增的两块 UI 能力：

1. **rrweb SSE 实时预览**
   - 上游实现：`1af938c`（live per-tab session preview over rrweb SSE）
   - 上游接口：`GET /api/v1/sessions/{session_id}/recording/live`
   - 能力：运行中 agent 的逐 tab 实时预览，不再依赖截图轮询；支持 `browserTabId` 固定 tab、自动跟随、bootstrap + append 去重。
   - hub-browser 落点待定，候选形态：`hub replay live <session-id>`、MCP 工具、或未来 GUI 的 live preview 数据源。

2. **Audit 截图 Lightbox**
   - 上游实现：`3ad6454`（audit lightbox navigation）
   - 上游能力：全屏截图、上一张/下一张、`ArrowLeft`/`ArrowRight` 键盘导航、`T+` 时间偏移信息。
   - hub-browser 落点待定，候选形态：`hub replay screenshots` / `hub audit` 命令、MCP 截图浏览工具、或未来 GUI 的 audit 查看器。

## 不在本待办范围

- Product Hunt banner 仅属于 BrowserOS neo 新 tab 营销 UI，hub-browser 不需要同步。
- 上游 running card / cockpit 是浏览器 GUI 层，hub-browser 只对接其数据能力，不复制 UI。

## 验收方向

- hub-browser 能通过本地 HTTP API 读取 BrowserOS neo 的实时 rrweb 流，并按 session/tab 展示或导出。
- hub-browser 能列出 session 截图，支持全屏预览和前后导航。
- 不破坏现有 `hub --mcp` 17 个 browser tools + `space.*` 契约。

