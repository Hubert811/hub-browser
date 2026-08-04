# Phase 4 — OpenCLI 命令扩充

> 状态：✅ 完成（P0 + Tab/Group/Window + 4.2-4.7 已交付；space 由 Phase 3 交付）
> 预估：3-5 天
> 依赖：Phase 2 完成（可与 Phase 3 并行）
> 注：`space` 命令组依赖 Phase 3 内核（TaskSpaceManager）完成，若 Phase 3 未交付则本阶段先跳过该命令组。

## 目标

基于 BrowserClaw 的自定义 CDP 域和融合 Core 的新能力，给 OpenCLI 扩充新命令。

## 前置：修复现有 browser 命令路径（P0）

> 来源：Confucius 全局审查

方案 B 全量拷贝后，OpenCLI 原有的 `browser <session> <subcommand>` 命令路径不可用：

1. **`page.session` 不存在** — `cli.js` 的 `getPageSession(page)` 读取 `page.session` 字符串，但 UnifiedPage 的 `session` 是 `private BrowserSession`（对象），不是字符串。导致 `browser open`、`browser tab select`、`browser back`、`browser state` 等所有内置 browser 子命令运行即崩。
2. **CDP 连接泄漏** — `browserAction` 和 `browserSessionCommandAction` 创建 `new BrowserBridge()` 后不 close。
3. **--profile 选项无效** — `getBrowserProfileSelection()` 永远 return null，`--profile` 选项是 no-op。

修复方案：

### 4.0.1 UnifiedPage 暴露 session 字符串

```typescript
// UnifiedPage 增加 getter
get sessionName(): string {
  return `page-${this.pageId}`;
}
```

或修改 `getPageSession` 使其不再依赖 `page.session`，改用 `page.pageId` 或固定返回 `'default'`。

### 4.0.2 browserAction 连接生命周期

`browserAction` 和 `browserSessionCommandAction` 中 `new BrowserBridge()` → `connect()` 后没有 `close()`。改为复用 `UnifiedBrowserFactory` 单例，或加 try-finally close。

### 4.0.3 删除 --profile 选项

从 `cli.js` 的 program 选项中删除 `--profile`，删除 `getBrowserProfileSelection` 函数。

### 4.0.4 browser bind/unbind 命令

当前 throw error。可以删除这两个命令，或重构成走 UnifiedPage。

## 现有 OpenCLI browser 命令

```bash
opencli browser state        # 页面快照
opencli browser click @5     # 点击
opencli browser fill @5 "text" # 填表
opencli browser scroll down 500 # 滚动
opencli browser screenshot   # 截图
opencli browser tabs         # 标签列表
# ... 等基础操作
```

## 新增命令

> 本节的命令是设计稿（当时命令名仍为 `opencli browser tabs ...`）。D4 后用户可见命令统一为 `hub`，且 Tab 管理命令组实际落地为 `hub browser <session> tab list/new/select/close`（不是 `tabs`），Tab Group / Window 为 `hub browser <session> group/window ...`；最终落地清单以「实际进展」4.1/4.2-4.7 为准，命令签名可跑 `hub --help` 核对。

### 4.1 Tab/Window 管理（用 BrowserClaw 自定义 CDP 域）

```bash
# Tab 管理
opencli browser tabs list --all-windows       # 跨窗口列出所有 Tab
opencli browser tabs new --url <url> --background  # 后台打开
opencli browser tabs move <id> --window <wid> --index 0  # 移动 Tab
opencli browser tabs duplicate <id>           # 复制 Tab
opencli browser tabs pin <id>                 # 固定 Tab
opencli browser tabs close <id>              # 关闭 Tab

# Tab Group 管理
opencli browser group create --title "搜索结果" --tabs 1,2,3
opencli browser group list
opencli browser group update <id> --title "新标题" --color blue --collapsed
opencli browser group close <id>             # 关闭组内所有 Tab
opencli browser group ungroup <id>           # 解散组

# Window 管理
opencli browser window list
opencli browser window create --type popup --url <url>
opencli browser window close <wid>
opencli browser window activate <wid>
opencli browser window set-bounds <wid> --x 0 --y 0 --width 800 --height 600
```

### 4.2 Bookmarks（用 BrowserClaw 的 Bookmarks CDP 域）

```bash
opencli bookmarks list                        # 列出所有书签
opencli bookmarks list --folder <folderId>    # 列出文件夹下的书签
opencli bookmarks search "github"            # 搜索书签
opencli bookmarks add --title "AI浏览器" --url "https://..."  # 添加书签
opencli bookmarks add --title "文件夹" --folder  # 添加文件夹
opencli bookmarks update <id> --title "新名称"  # 更新书签
opencli bookmarks move <id> --parent <parentId> --index 0  # 移动书签
opencli bookmarks remove <id>                 # 删除书签
```

### 4.3 History（用 BrowserClaw 的 History CDP 域）

```bash
opencli history list --limit 20               # 最近 20 条历史
opencli history search "AI" --limit 10       # 搜索历史
opencli history list --since "2025-01-01"     # 指定日期后
opencli history list --domain "github.com"    # 按域名过滤
```

### 4.4 Diff（用 BrowserClaw 的 diff 能力）

```bash
# 操作后查看变化
opencli browser click @5
opencli browser diff                          # 显示上次操作后的页面变化
opencli browser diff --json                   # JSON 格式输出
```

### 4.5 页面内容提取增强

```bash
# read — 多格式提取
opencli browser read                          # markdown 格式（默认）
opencli browser read --format text           # 纯文本
opencli browser read --format links          # 链接列表
opencli browser read --selector "div.main"   # CSS 选择器限定范围

# grep — 搜索页面
opencli browser grep "登录" --over ax         # 搜 AX 快照（保留 ref）
opencli browser grep "error" --over content  # 搜可见文本
opencli browser grep "price" --limit 5        # 限制结果数
```

### 4.6 录屏回放

```bash
# 会话录屏
opencli replay list                           # 列出所有录屏会话
opencli replay show <session-id>             # 查看会话详情
opencli replay show <session-id> --timeline  # 带操作时间线
opencli replay export <session-id> --format json  # 导出
```

### 4.7 PDF / Download / Upload

```bash
# PDF
opencli browser pdf                           # 当前页面存为 PDF
opencli browser pdf --path ~/Downloads/page.pdf

# Download
opencli browser download @5                   # 点击元素触发下载
opencli browser wait-download --pattern "*.csv" --timeout 30

# Upload
opencli browser upload @5 --file /path/to/file.pdf
opencli browser upload @5 --files a.pdf b.pdf
```

## 实现方式

每个命令组在 OpenCLI 的 `src/commands/` 下新建文件：

```
src/commands/
├── space.ts          # Phase 3 交付（走 TaskSpaceManager，非自定义 CDP 域）
├── tabs.ts           # Tab 管理（新增高级操作）
├── window.ts         # Window 管理
├── bookmarks.ts      # 书签
├── history.ts        # 历史
├── diff.ts           # Diff
├── replay.ts         # 录屏回放
├── pdf.ts            # PDF 导出
├── download.ts       # 下载
└── upload.ts         # 上传
```

大部分命令通过 `IPage.cdp()` 调用 BrowserClaw 的自定义 CDP 域；**`space` 命令组除外**——它由 Phase 3 的 TaskSpaceManager 驱动（服务端账本 + SpaceOwnership guard + 事件流），不经过自定义 CDP 域。示例：

```typescript
// 示例：bookmarks list
async function bookmarksList(opts: { folderId?: string }) {
  const result = await page.cdp('Bookmarks.getBookmarks', {
    folderId: opts.folderId
  })
  return result.nodes
}
```

## 验证标准

| 验证项 | 命令 | 预期结果 |
|---|---|---|
| Tab 管理 | `opencli browser tabs list --all-windows` | 列出所有窗口的 Tab |
| Tab Group | `opencli browser group create ...` | 创建彩色分组 |
| Bookmarks | `opencli bookmarks list` | 列出书签 |
| History | `opencli history search "AI"` | 搜索历史记录 |
| Diff | `opencli browser diff` | 显示页面变化 |
| Read | `opencli browser read --format links` | 输出链接列表 |
| Grep | `opencli browser grep "登录"` | 搜到匹配行 + ref |
| PDF | `opencli browser pdf` | 生成 PDF 文件 |
| 录屏 | `opencli replay list` | 列出会话 |

## 完成标志

- [x] Tab/Window 管理命令 ✅ (commit 5c99fc9)
- [x] Tab Group 命令 ✅ (commit 5c99fc9)
- [x] Bookmarks 命令 ✅
- [x] History 命令 ✅
- [x] Diff 命令 ✅
- [x] Read/Grep 命令增强 ✅
- [x] PDF/Download/Upload 命令 ✅
- [x] 录屏回放命令 ✅
- [x] space 命令组（Phase 3 交付，本阶段验收：`create/list/switch/close/handoff/takeover/current/refresh`）✅

## 实际进展

**状态：✅ 完成（2026-08-03 收尾）**

- P0 修复 + Tab/Window/Tab Group/Bookmarks/History/Diff/Read+Grep/PDF+Download+Upload/录屏回放 全部交付（完成标志全勾）。
- space 命令组（create/list/switch/close/handoff/takeover/current/refresh）由 Phase 3 交付并验收。
- 真实浏览器冒烟全过（tests/phase4-*.ts），并入 Phase 3 完整回归。

### P0 修复（commit 2c810e6, 2ff267d）

#### 4.0.1 UnifiedPage session 字符串 — ✅
- `private session: BrowserSession` 改名为 `_browserSession`
- 加 `get session(): string` getter 返回 `page-${this.pageId}`
- 22 处 `this.session.` 引用全部更新
- 影响：`console`、`network`、`open`、`tab select`、`tab close` 不再报 "missing a session"

#### 4.0.2 browserAction 连接生命周期 — ✅
- `browserAction` 和 `browserSessionCommandAction` 的 `finally` 块加 `page.close()` + `process.exit()`
- 修复了进程不退出导致输出被缓冲的问题（state/extract 看似"卡住"实则输出已产生）

#### 4.0.3 --profile 选项 — 未做（低优先级）

#### 4.0.4 browser bind/unbind — ✅（已禁用）
- 直接 throw error，hub-browser 不需要 bind/unbind

### 新增实现
- `tab new` / `tab close` / `getActivePage()` — ✅
- `setActivePage(targetId)` — ✅
- `tabs()` 加 `page: targetId` 字段 — ✅

### CDP 持久化 daemon（commit 2cbbd0a）
- `bin/hub.mjs` 两种模式：CLI + Daemon
- Daemon 持有 `UnifiedBrowserFactory` 单例（CdpBackend 自带 keepalive + 自动重连）
- 首次命令 0.28s，后续命令 24-42ms（之前每次约 15s）
- HTTP 转发 + argv 重写 + stdout 捕获
- 空闲 5 分钟自动退出

### Tab Group + Window 管理命令（commit 5c99fc9）— ✅

#### 4.1 Tab Group 命令 — ✅
- `group list` — 列出所有 tab group（CDP `Browser.getTabGroups`）
- `group create --title --pages` — 创建 tab group（pageId→tabId 转换 + CDP `Browser.createTabGroup`）
- `group update <groupId> --title --color --collapsed` — 更新 group（CDP `Browser.updateTabGroup`）
- `group ungroup --pages` — 从 group 移除 tab（CDP `Browser.removeTabsFromGroup`）
- `group close <groupId>` — 关闭 group 及所有 tab（CDP `Browser.closeTabGroup`）
- 颜色选项：grey/blue/red/yellow/green/pink/purple/cyan/orange
- 所有命令通过 `browserAction` 包装，支持 `--tab` 参数

#### 4.1 Window 命令 — ✅
- `window list` — 列出所有窗口（CDP `Browser.getWindows`，返回 windowId/type/bounds/tabCount/isActive）
- `window create` — 创建新窗口（CDP `Browser.createWindow`）
- `window close <windowId>` — 关闭窗口（CDP `Browser.closeWindow`）
- `window activate <windowId>` — 激活窗口（CDP `Browser.activateWindow`）

### 新增命令（4.2-4.7）— 已交付

### 4.2-4.7 命令（本阶段交付）— ✅

全部命令内联注册在 `hub-browser/src/opencli-engine/cli.js`（与现有 browser/space 命令同模式），
CLI 与 MCP 共用 UnifiedPage（统一 Core）；diff/read/grep/pdf/download/upload/history-list 复用
`src/browser-mcp/src/tools/` 的 fork 工具（经 `executeTool` 薄封装），bookmarks/history-search 直接走
`page.cdp('Bookmarks.*' / 'History.search')` CDP 域，replay 调 claw-server-rust 的 HTTP API。

- **4.2 bookmarks**：`list [--folder]` / `search <q> [--limit]` / `add --title [--url|--folder] [--parent] [--index]` / `update <id> --title/--url` / `move <id> --parent --index` / `remove <id>`；统一走 `Bookmarks.*` CDP 域。
- **4.3 history**：`list [--limit] [--since] [--domain]`（复用 fork `history` 工具 → `History.getRecent`，since/domain 本地过滤）、`search <q> [--limit]`（`History.search` 域）。
- **4.4 diff**：`browser diff [--json]`（复用 fork `diff` 工具，UnifiedPage observer diff）。
- **4.5 read/grep**：`browser read [--format markdown|text|links] [--selector] [--viewport-only] [--include-links] [--include-images] [--json]`、`browser grep <pattern> [--over ax|content] [--limit] [--json]`（复用 fork `read`/`grep` 工具）。
- **4.7 pdf/download/upload**：`browser pdf [--path] [--landscape] [--print-background] [--prefer-css-page-size]`、`browser download <ref>`（可带 `@` 前缀）、`browser upload <ref> --file/--files`（复用 fork `pdf`/`download`/`upload` 工具）。
- **4.6 replay**：`replay list [--limit] [--no-recordings]` / `replay show <id> [--timeline]` / `replay export <id> [--format ndjson|json] [--out]`；端点：
  `GET /api/v1/sessions`、`GET /api/v1/sessions/{id}/recording`、`GET /api/v1/sessions/{id}/recording/events`。
  base URL 解析：`--base-url` → `CLAW_SERVER_URL`/`BROWSEROS_SERVER_URL` → `BROWSEROS_SERVER_PORT` → 默认 `http://127.0.0.1:9200`；
  服务未跑时给出明确依赖错误（退出码 69）。

测试：`tests/phase4-*.test.ts`（fake bridge / mock HTTP 共 49 个用例）+ fork 57 个 + 根套件 space/isolation/notifications 等全部通过；
真实冒烟（CDP 9110）：bookmarks add/list/update/search/remove、history list/search、diff、read (markdown/text/links)、grep、pdf 均通过。

修复的 bug：
- `--no-recordings` 默认值写反导致 replay list 默认不探测录音（已修）。
- Bun fetch 连接失败抛 `name:'Error'`（非 TypeError），replay 网络错误现在按"无 HTTP status"判定，输出 claw-server 依赖提示。
- daemon 忽略命令设置的 `process.exitCode`（replay/space 错误路径返回 0）——`bin/hub.mjs` 现在传播并在每次请求后重置。

边界：replay 依赖 claw-server-rust 运行；下载/上传的真机行为依赖页面元素（有 fake 单测覆盖，未做真机下载冒烟）；
`browser wait-download` 沿用既有 `browser wait download <pattern>`（4.7 文档中的独立命令未新增）。
