# Phase 4 — OpenCLI 命令扩充

> 状态：⬜ 未开始
> 预估：3-5 天
> 依赖：Phase 2 完成（可与 Phase 3 并行）

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
├── space.ts          # Phase 3 的空间命令
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

每个命令通过 `IPage.cdp()` 调用 BrowserClaw 的自定义 CDP 域：

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

- [ ] Tab/Window 管理命令
- [ ] Tab Group 命令
- [ ] Bookmarks 命令
- [ ] History 命令
- [ ] Diff 命令
- [ ] Read/Grep 命令增强
- [ ] PDF/Download/Upload 命令
- [ ] 录屏回放命令

## 实际进展

（待填写）
