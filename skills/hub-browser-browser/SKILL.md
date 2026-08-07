---
name: hub-browser-browser
description: 当 agent 需要用 hub 驱动真实浏览器（hub browser <session> …）时使用——检查页面、填表单、点过登录态流程、按需提取数据。覆盖 selector-first 目标契约（numeric ref / CSS + --nth）、match_level、结构化错误码分支、verify-writes、network-over-scrape、state→action→state 循环，以及 MCP 工具等价（snapshot/act/read/evaluate 等）。写适配器不归本 skill 管，见 hub-adapter-author。
allowed-tools: Bash(hub:*), Read, Edit, Write
---

# hub-browser-browser

这份 skill 的第一读者是 agent，不是人。`hub browser <session> <cmd>` 的每个子命令都返回结构化 envelope，告诉你命中了什么、置信度多高、没命中该怎么办。依赖这些 envelope，不要猜。

本 skill 用于**驱动真实浏览器**完成 agent 任务。要写可复用的适配器（`~/.hub/clis/<site>/`），用 `hub-adapter-author` 而不是这里。

---

## 前置检查

hub 直连 BrowserOS neo 的 CDP，**没有 extension / daemon 桥**，也没有 `doctor` 命令。浏览器连不上时：

- **端口一般不用手动设**（v0.1.1 起自动探测，决策 D7）：解析顺序 `BROWSEROS_CDP_PORT` → BrowserOS neo 的 `config.json` 的 `ports.cdp`（配置目录仍叫 `BrowserClaw`）→ fallback 9005；显式覆盖就设 `BROWSEROS_CDP_PORT`。
- `hub browser <session> state` 本身就是连通性探针 + 端口探针：能返回页面状态 = 桥是通的。
- 常见失败：Chrome 没启动、调试端口被 1Password 等占用 CDP 的程序挡住。`hub browser <session> state` 的错误 envelope 会告诉你是哪一种。

---

## Session 生命周期

- `hub browser *` 命令在 `browser` 后紧跟一个 `<session>` 位置参数。多步流程复用同一个 session 名；要隔离并行的浏览器工作就用不同的名字。
- 多命令或有人参与节奏的流程，用一个稳定的 session 名。例：`hub browser fb-yaya-warmup open https://example.com`，之后继续复用 `hub browser fb-yaya-warmup state` / `read` / `click` 等。
- owned session 在调用之间保持 tab lease；用完用 `hub browser <session> close` 释放，或等 daemon 空闲超时（默认 5 分钟）自动退出。
- session 指向的 tab 失效时**当前实现静默降级、无 stderr 警告**——见下方「session ↔ tab ↔ space 关系」的失效自愈一节，写操作前先用 `tab list` 确认。
- `--window foreground|background` 决定 hub 是创建/聚焦前台窗口，还是用后台窗口跑 owned session（所有 `hub browser` 子命令都接受该选项）。

### Bind 不可用

**hub 禁用 `bind`**：`hub browser <session> bind` 是禁用 throw（"browser bind not available in hub-browser"）。没有“绑定用户已开的 tab”这条路——session 一律用 **owned tab**：

- 开页用 `hub browser <session> open <url>`，由 hub 管理 tab 生命周期（`tab new` / `tab select` / `tab close` 都可用）。
- 需要登录/SSO 的站点：在浏览器里先登录一次，空间共享 cookie/localStorage，后续 `hub browser <session> open` 继承登录态，无需重登。
- 想复用一个你手动定位好的页面：开在 space 里，然后 `hub browser <session> tab list` 找到它再继续；hub 不会替你关用户窗口。

---

## session ↔ tab ↔ space 关系

三者是不同层的概念，不要混用：

| 概念 | 层级 | 作用 | 说明 |
|---|---|---|---|
| **space** | 归属容器（账本，权威） | 决定「哪些 tab 归你、tab group 双向同步」 | `hub space list/current`；MCP `space.*` |
| **session** | CLI 命令间的记忆指针 | 记住「这个 CLI 任务用的默认 tab」 | 仅 CLI：`hub browser <session> …`；**MCP 路径没有 session** |
| **tab** | 浏览器真实页面 | 实际操作的页面 | 1 space → N tab；1 tab → 1 space |

- **1 session → 1 tab**：`hub browser <session> tab select <targetId>` 把该 tab 记为 session 的默认 tab（状态落在 `~/.hub/cache/browser-state/`，默认根 `~/.hub`、`BROWSEROS_DIR` 可覆盖；文件内容为 `{defaultPage: <targetId>, updatedAt}`）。`tab select` 同时把该 tab 激活为浏览器活跃 tab，后续 `hub browser <session> *` 经 daemon 连到活跃 tab，实现跨命令连续。
- **session 归 space 管**：session 指向的 tab 必须属于当前 space（D3/D4 guard）——`tab select` / `tab close` 对非本 space 的 tab 拒绝（`page not in your space`）。
- **MCP 无 session**：MCP 直接 `space.list_tabs` 拿 pageId，再以 `page: <id>` 传给 snapshot/act/read 等——不需要 session 名。

### 失效自愈 + 静默降级（⚠️ 必读）

session 指向的 tab 被关（MCP `space.close_tab` / `space close` / 人类关 tab / 浏览器重启）后，再用同一个 session 跑命令**不会报错**：saved 分支检测到目标 tab 不在会话里 → 自动删除 session 状态 → 落到**当前活跃 tab** 继续。

- **当前实现是静默降级，没有 stderr 警告。**
- ⚠️ 风险：你可能操作的是「人类刚切到的活跃 tab」，而不是你记忆里的页面——写操作（click/type/fill/close 等）前先 `hub browser <session> tab list` 确认目标 tab；确认错了就 `tab select <targetId>` 显式切回。

### 人类拖入 tab → 连 session

人类把 tab 拖进 space 的 tab group 后，space 会自动认领该 tab（D5 lazy sync：拖入归属、拖出移除）。CLI 要把它接进 session 步骤流，必须显式 `tab select`：

```bash
hub browser <session> tab list            # 找到人类拖入的 tab（page / targetId）
hub browser <session> tab select <targetId>   # 显式设为 session 默认 tab，再继续 state/click/...
```

MCP 不需要 session：`space.list_tabs` 拿 pageId 后直接操作。

---

## 心智模型

1. **Selector-first 目标契约。** 每个交互命令（`click`、`type`、`fill`、`select`、`get text|value|attributes`）都接收一个 `<target>`，它**要么**是 `state`/`find` 返回的数字 ref，**要么**是 CSS selector。多个 CSS 命中用 `--nth <n>` 消歧。
2. **每个 envelope 都报 `matches_n` 和 `match_level`。** `match_level` 是 `exact` / `stable` / `reidentified`——hub 已经帮你救回了中等程度的 DOM 漂移，但 level 告诉你该多放心。
3. **先紧凑输出，按需取全量。** `state` 是 budget-aware 快照；`get html --as json` 支持 `--depth/--children-max/--text-max`；`network` 只返回 shape 预览，需要时用 `--detail <key>` 取单个 body。一上来就 dump 大 payload 是在烧没必要的上下文。
4. **结构化错误是机器可读的。** 失败时返回 `{error: {code, message, hint?, candidates?}}`。按 `code` 分支，不要按 message 字符串。

---

## 关键规则

1. **先观察再行动。** 先跑 `state` 或 `find`。永远不要跨 session 从记忆里硬编码 ref 或 selector——索引是每张快照的。
2. **优先站点适配器，再裸驱动浏览器。** 如果 `hub <site> <command>` 已经覆盖任务（`hub facebook notifications`、`hub reddit read`、`hub chatgpt model <level>` 等），先用适配器。`hub browser ...` 只用于适配器覆盖不到的缺口、调试或一次性 UI 流程。
3. **一旦拿到数字 ref 就优先用它。** 数字 ref 能扛轻微 DOM 位移，因为 hub 会给每个标记元素打指纹。手写 CSS selector 在站点一重渲染就会断。
4. **每次 write 后读 `match_level`。** `exact` = 没问题。`stable` = 元素还是同一个但部分软属性漂移了——动作仍然生效。`reidentified` = 原 ref 没了，hub 找到唯一替代并重新标记——double-check 你点的是不是对的元素。
5. **表单控件用 `compound` 字段。** 不要正则猜日期格式，不要为了拿完整 `<select>` 选项列表 `state` 两次。compound envelope 里有格式串、最多 50 条的完整选项列表、溢出时的 `options_total`，以及 `<input type=file>` 的 `accept`/`multiple`。
6. **验证重要的写入。** `type <target> <text>` 之后跑 `get value <target>`；`select` 之后跑 `get value`。autocomplete 组件、React 受控输入、掩码字段都会悄悄吃字符，hub 检测不到。
7. **页面变化后走 state → action → state。** 导航、表单提交、SPA 路由切换都会让 ref 失效。换页后先拿新快照，不要复用换页前的 ref。
8. **复用刚解析出的 ref 时用 `&&` 串命令。** 一条链在同一个 shell 里跑，刚读到的 ref 直接传给下一条。分开的 shell 调用虽然保留 session，但 shell 局部变量或复制出来的 ref 在页面变化后会过期。
9. **`eval` 只读。** JS 包成 IIFE 并返回 JSON。要*改变*页面就用结构化的 `click` / `type` / `fill` / `select` / `keys` 命令——它们产出结构化输出和指纹，`eval` 不产出。
10. **优先 `network` 而不是刮 DOM。** 如果你关心的页面数据来自 JSON API，API 几乎总比刮渲染后的 DOM 可靠。先 capture 一次、看 shape，再用 `--detail <key>` 取需要的 body。

---

## MCP 工具等价

hub-browser 是 MCP 驱动（主 skill：`hub-browser`）。CLI 命令和 MCP 工具面一一对应，能走 MCP 就走 MCP（空间/tab 归属、ref 契约自动处理）；CLI 等价用于脚本化或无法直接用 MCP 的场景：

| CLI（`hub browser <session> …`） | MCP 工具 | 说明 |
|---|---|---|
| `state` | `snapshot` | 快照 + `[ref=eN]`；交互前必做 |
| `find --css/--role/--name …` | `snapshot` / `grep` | 已知 selector 的廉价查询；语义定位先于裸 CSS |
| `click` / `type` / `fill` / `select` / `keys` / `hover` / `focus` / `check` / `uncheck` / `scroll` / `drag` / `upload` | `act` | 写操作统一走 `act`（用 ref） |
| `get text` / `get value` / `read` / `extract` | `read` | 只读内容提取 |
| `grep <pattern>` | `grep` | 页内搜索，不 dump 全页 |
| `diff` | `diff` | 低成本确认动作生效 |
| `eval <js>` | `evaluate` | 页面上下文执行 JS（只读） |
| `network` | `run`（server 端 SDK） | API 抓取优先 network；复杂多步用 `run` |
| `screenshot [path] [--annotate]` | `screenshot` | 视觉确认；结构优先 `snapshot` |
| `wait selector/text/time/xhr/download` | `wait` | 没有可靠 UI 信号才用 |
| `pdf` | `pdf` | 存档/按文档读 |
| `download <ref>` | `download` | 点元素触发下载 |
| `tab list/new/select/close` | `tabs` | tab 管理（归属当前 space） |
| `group …` | `tab_groups` | tab 组管理（与 space 双向同步） |
| `window …` | `windows` | 窗口管理 |
| `open` / `back` | `navigate` | 导航；导航后 refs 失效 |
| `close` | `space.close {keep}` | 释放 session / 关 space |

---

## Sitemap

当站点有 sitemap 上下文可用、被要求使用、或需要避免盲点时，切到 `hub-browser-sitemap` 再继续多步站点流程。sitemap 是页/动作/工作流/API/pitfall 的**先验上下文，不是真相**。浏览器状态和 sitemap 冲突时，信浏览器，并把 sitemap 条目标记 stale（见 hub-browser-sitemap 的 stale/draft 写回）。

---

## Target 契约（`<target>`：click / type / fill / select / get text|value|attributes）

```
<target> ::= <numeric-ref> | <css-selector>
```

- **Numeric ref** —— `state` 或 `find` 返回的 `[N]` 索引。便宜，扛轻微 DOM 漂移。
- **CSS selector** —— 任何 `querySelectorAll` 能接受的。写操作必须无歧义，否则配 `--nth <n>`。

### 成功 envelope

```json
{ "clicked": true, "target": "3", "matches_n": 1, "match_level": "exact" }
```

```json
{ "value": "kalevin@example.com", "matches_n": 1, "match_level": "stable" }
```

### match_level

| level | 含义 | 你应该 |
|-------|------|--------|
| `exact` | 指纹在 tag + 强 ID 上一致，最多一处软漂移 | 继续。 |
| `stable` | tag + 强 ID 仍一致，软信号（aria-label、role、text）漂了 | 继续，但如果你打/点的内容很关键，用 `get value` 或 `state` 复核。 |
| `reidentified` | 原 ref 没了；hub 用指纹找到唯一活元素并重标旧 ref | 继续串更多写入前，double-check 命中正确元素。 |

### 结构化错误码

按这些分支，不要按人类可读 message：

| code | 含义 |
|------|------|
| `not_found` | 数字 ref 已不在 DOM。重新 `state`。 |
| `stale_ref` | ref 还在，但该位置的元素换了身份。重新 `state`。 |
| `invalid_selector` | CSS 被 `querySelectorAll` 拒绝。修 selector。 |
| `selector_not_found` | CSS 命中 0 个元素。用更宽的 selector 跑 `find`。 |
| `selector_ambiguous` | CSS 命中 >1 且没有 `--nth`。加 `--nth` 或收窄 selector。 |
| `selector_nth_out_of_range` | `--nth` 超出命中数。 |
| `option_not_found` | `select` 找不到匹配该 label/value 的 option。envelope 带 `available: string[]`（真实 option 标签）。 |
| `not_a_select` | 对非 `<select>` 元素调了 `select`。 |

错误 envelope 一定带 `error.code` 和 `error.message`。目标类错误（`selector_not_found`、`selector_ambiguous` 等）常带 `error.candidates: string[]`（建议 selector）；`option_not_found` 带 `error.available: string[]`。

---

## 命令参考

### Inspect

| 命令 | 用途 |
|------|------|
| `browser state` | 快照：带 `[N]` ref 的文本树、滚动提示、hidden-interactive 提示、`compounds (N):` 侧栏（date/select/file ref）。 |
| `browser state --source ax` | 可访问性树快照（opt-in）。自定义控件、portal、iframe 内容在普通 `state` 里难识别时用。AX ref 能按 role/name/nth 找回 stale 的 React 重渲染，也能路由同源 iframe ref；跨源 iframe ref 是 best-effort（Chrome 未必暴露可 attach 的 OOPIF target）。 |
| `browser state --compare-sources` | 只出指标的 DOM vs AX 对比，用来判断该不该把 AX 设为默认。它打印计数和体积，不打页面文本，适合安全分享做校验。 |
| `browser find --css <sel> [--limit N] [--text-max N]` | 跑一次 CSS 查询，每个命中返回 `{nth, ref, tag, role, text, attrs, visible, compound?}`。会给之前快照没标记的命中分配 ref。已知 selector 时比 `state` 便宜。 |
| `browser find --role button --name Save` | 语义定位查询。也支持 `--label`、`--text`、`--testid`。控件有可访问标签时，先于裸 CSS 用。 |
| `browser frames` | 列出跨源 iframe target。把 index 传给 `eval --frame`。 |
| `browser screenshot [path]` | 视口 PNG。不传 path → base64 到 stdout。只要结构就优先 `state`。 |
| `browser screenshot --annotate [path]` | 视觉 ref 图。刷新 DOM ref 并把可见 `[N]` 标签叠上去，让截图能对回 `browser click <ref>` 目标。纯图标控件、视觉布局、图表、文本状态含糊时用。 |

### Get（只读）

| 命令 | 返回 |
|------|------|
| `browser get title` | 纯文本 |
| `browser get url` | 纯文本 |
| `browser get text <target> [--nth N]` | `{value, matches_n, match_level}` |
| `browser get value <target> [--nth N]` | `{value, matches_n, match_level}` |
| `browser get attributes <target> [--nth N]` | `{value: {attr: val, ...}, matches_n, match_level}` |
| `browser get text --role option --name Travel` | 不先 `state` 的语义定位读取。flag 同 `browser find`。 |
| `browser get html [--selector <css>] [--as html\|json] [--depth N] [--children-max N] [--text-max N] [--max N]` | 原始 HTML，或 `{tag, attrs, text, children}` JSON 树（带 budget）。 |

### Act（写）

| 命令 | 用途 |
|------|------|
| `browser click <target> [--nth N]` | 点元素。返回 `{clicked, target, matches_n, match_level}`。 |
| `browser type <target> <text> [--nth N]` | 点元素再键入文本。返回 `{typed, text, target, matches_n, autocomplete}`。`autocomplete:true` 表示建议弹层开着、值还没提交，通常需要 `keys Enter` 接受第一个建议或 `click` 想要的项。 |
| `browser fill <target> <text> [--nth N]` | 对 input/textarea/contenteditable 精确替换并校验。返回 `{filled, verified, text, actual, matches_n, match_level}`。需要原样设置并校验、不要键盘/autocomplete 行为时用。 |
| `browser select <target> <option> [--nth N]` | 原生 `<select>` 按 label 优先、其次 value 匹配 option。`compound` 字段能看到真实可选项。 |
| `browser keys <key>` | `Enter`、`Escape`、`Tab`、`Control+a` 等。作用在当前焦点元素。 |
| `browser scroll <direction> [--amount px]` | `up` / `down`。默认 `500`。 |
| `browser hover` / `focus` / `dblclick` / `check` / `uncheck` / `drag` | 各自的结构化 write。`check`/`uncheck` 保证 checkbox/radio/aria-checked 状态。 |

### Wait

```bash
browser wait selector "<css>" [--timeout ms]    # 等到 selector 命中
browser wait text "<substring>" [--timeout ms]  # 等到文本出现
browser wait xhr "<url-regex>" [--timeout ms]   # 等到匹配 XHR
browser wait download [pattern] [--timeout ms]  # 等到 Chrome 下载（文件名/URL/mime 含 pattern）
browser wait time <seconds>                     # 硬等，最后手段
```

默认超时 `10000` ms。SPA 路由、登录跳转、懒加载列表在 `state`/`get` 前需要 `wait`。

`browser wait download` 走 Chrome 下载生命周期；传窄文件名或 URL 子串（如 `receipt.pdf`）。成功返回 `{downloaded, filename, url, state, elapsedMs}`，超时/失败返回 JSON 错误 envelope。

### Extract

- **`hub web read --url <url>`** —— 任意页面的即发 Markdown 读取器（`web` 适配器）。默认展开相关同源 iframe，老的 iframe-shell 站点比只刮顶层文档好。要完整性优先于 Markdown 噪音时用 `--frames all-same-origin`。AJAX shell 页面用 `hub web read --url <url> --wait-for "<selector>" --wait-until networkidle --diagnose`；诊断会显示 frame URL、空容器、类 API 的 XHR。如果你要的是表格/API 数据，改用 `browser network` 或专用适配器，别依赖 Markdown。
- **`browser eval <js> [--frame N]`** —— 在页面（或 `--frame` 指定跨源 frame）里跑表达式。包成 IIFE 并返回 JSON。只读：不要 `document.forms[0].submit()`，不要点击、不要导航。结果是字符串时 stdout 就是原字符串，否则是 JSON。
- **`browser read [--format markdown|text|links] [--selector <css>]`** —— 当前页内容提取，默认 Markdown，也可纯文本或链接列表。
- **`browser extract [--selector <css>] [--chunk-size N] [--start N]`** —— 长文 Markdown 提取 + 续读游标。返回 `{url, title, selector, total_chars, chunk_size, start, end, next_start_char, content}`。按 `next_start_char` 循环到 `null`。不传 `--selector` 自动收窄到 `<main>`/`<article>`/`<body>`。

### Network

```bash
browser network                        # shape 预览 + cache key 列表
browser network --detail <key>         # 单个缓存条目的完整 body
browser network --filter "field1,field2"  # 只保留 body shape 含 ALL 字段（路径段）的条目
browser network --all                  # 含静态资源（通常噪音）
browser network --raw                  # 全 body 内联——很大，省着用
browser network --ttl <ms>             # cache TTL（默认 24h）
browser network --failed               # 只看失败请求
```

列表条目形如 `{key, method, status, url, ct, size, shape, body_truncated?}`。Detail envelope：`{key, url, method, status, ct, size, shape, body, body_truncated?, body_full_size?, body_truncation_reason}`。缓存落在 `~/.hub/cache/browser-network/`，不重新触发请求也能复查。

默认输出保留 JSON/XML/纯文本和类 JS 的 API 响应，按 URL 丢明显静态资产和遥测。期望的端点没出现时，先跑一次 `browser network --all`，看是不是异常 content type 或 URL 过滤器把它藏了。

### Tabs & session

| 命令 | 用途 |
|------|------|
| `browser tab list` | JSON 数组 `{index, page, url, title, active}`。`page` 字符串是传给 `tab select` / `tab close` 或任意子命令 `--tab <targetId>` 的 tab 身份。 |
| `browser tab new [url]` | 新开 tab，打印新 `page` 串。 |
| `browser tab select [targetId]` | 把某个 tab 设为默认。所有子命令都接受 `--tab <targetId>` 不改默认地指定目标。 |
| `browser tab close [targetId]` | 按 `page` 关闭。 |
| `browser group …` | tab 组管理（list/create/update/ungroup/close）。 |
| `browser window …` | 窗口管理（list/create/close/activate）。 |
| `browser back` | 当前 tab 历史后退。 |
| `browser close` | 用完释放当前 owned session 的 tab lease。 |

---

## 复合表单控件

每个 date/time、select、file 输入都带 `compound` 字段。用它，不要正则解析属性。

### 日期族

```json
{
  "control": "date",
  "format": "YYYY-MM-DD",
  "current": "2026-04-21",
  "min": "2026-01-01",
  "max": "2026-12-31"
}
```

`control` 是 `date | time | datetime-local | month | week` 之一。`format` 是具体模板串——按这个精确格式键入，或当站点把原生输入包成自定义控件时用 `select` 按 label 选。

### Select

```json
{
  "control": "select",
  "multiple": false,
  "current": "United States",
  "options": [
    { "label": "United States", "value": "us", "selected": true },
    { "label": "Canada", "value": "ca" }
  ],
  "options_total": 137
}
```

`options[]` 上限 50 条。**`current` 永远正确**——即使选中项在截断列表之外，它是扫全部 option 算出来的，不是从截断列表来的。如果 `options_total > options.length` 且你要的 option 不在 `options[]` 里，直接 `browser select <target> "<label>"`——hub 对着活 DOM 匹配，不是截断列表。

### File

```json
{
  "control": "file",
  "multiple": true,
  "current": ["report.pdf", "cover.png"],
  "accept": "application/pdf,image/*"
}
```

不要编造文件路径。上传走正常点击流程（`browser upload <target> <files...>`）；告诉用户传什么时要尊重 `accept`。

### compound 出现在哪

- `browser find --css <sel>` 条目：每个命中内联。
- `browser get html --as json` 树节点：命中节点内联。
- `browser state` 快照：`compounds (N):` 侧栏按数字 ref 索引，一眼看出哪些 `[N]` 有丰富元数据。

---

## 成本指南

每次调用都想想 payload 体积。预算存在是有原因的。

| 命令 | 大概成本 | 何时用 |
|------|---------|--------|
| `state` | 中（内部 budget 封顶） | 任何页面的第一次调用、每次导航后、需要 ref 时。 |
| `find --css <sel>` | 小 | 已经知道 selector——一次查询，紧凑条目。 |
| `get title` / `get url` | 极小 | 步骤间的 sanity check。 |
| `get text/value/attributes` | 每次极小 | 校验某个具体字段。 |
| `get html`（raw） | 可能巨大 | 无界页面别用。一定配 `--selector` 和 budget。 |
| `get html --as json --depth 3 --children-max 20` | 中 | 需要推理结构、不是看某个字段时。 |
| `screenshot` | 大 | 只有页面是视觉型时（验证码、图表）。优先 `state`。 |
| `extract` | 每块中 | 长文阅读。按 `next_start_char` 循环。 |
| `network`（默认） | 小 | 先看 API。 |
| `network --detail <key>` | 视情况 | 取一个 body。 |
| `network --raw` | 巨大 | 只有 `--filter` 收窄候选后再用。 |
| `eval "JSON.stringify(...)"` | 受控 | 上面都不合适时的定向提取。 |

---

## 菜谱

### 登录态流程（session 复用）

```bash
hub space create "fb 通知检查"
hub browser fb-yaya open "https://facebook.com"
hub browser fb-yaya state
hub browser fb-yaya find --role button --name "Search"
hub browser fb-yaya click 12
hub browser fb-yaya type 12 "kalevin@example.com"
hub browser fb-yaya keys Enter
hub browser fb-yaya get value 12      # 验证输入落盘
hub browser fb-yaya read              # 提取结果
hub browser fb-yaya close             # 释放 session
```

### 自定义下拉框（不是 `<select>`）

```bash
hub browser mercury open "https://example.com/flight"
hub browser mercury state
hub browser mercury click 3           # 打开触发按钮
hub browser mercury state             # 拿选项 ref
hub browser mercury click 7           # 点想要的选项
hub browser mercury get text 7        # 验证可见选中 label
```

这类控件**不要用 `browser select`**。`browser select` 只用于原生 `<select>`。自定义下拉走 `state -> click trigger -> state -> click option -> verify`。

### DOM vs AX 观测对比

决定某站点 AX ref 是否更优时，收集指标但不分享页面内容：

```bash
hub browser <session> state --compare-sources
```

汇报 `sources.dom.refs`、`sources.ax.refs`、`frame_sections`、`approx_tokens`、`elapsed_ms` 和各自的 `error`。想论证 AX 应该成为某站默认前，先做这个。

### 用 network 刮列表，别刮 DOM

```bash
hub browser hn open "https://news.ycombinator.com"
hub browser hn network --filter "title,score"
# -> 找到 /topstories 条目，记下 key
hub browser hn network --detail topstories-a1b2
```

### 长文分块读

```bash
hub browser article open "https://blog.example.com/long-post"
hub browser article extract --chunk-size 8000
# -> content + next_start_char: 8000
hub browser article extract --start 8000 --chunk-size 8000
# ...直到 next_start_char 为 null
```

### 跨源 iframe

```bash
hub browser checkout frames
# -> [{"index": 0, "url": "https://checkout.stripe.com/...", ...}]
hub browser checkout eval "(() => document.querySelector('input[name=cardnumber]')?.value)()" --frame 0
```

`browser state --source ax` 可能漏掉跨源 iframe 内容，或当 Chrome 不暴露可 attach 的 OOPIF target 时无法把动作路由进去。这时用 `browser frames` + `browser eval --frame`、普通 DOM `state`，或尽量直接导航到 iframe URL。

---

## 坑

- **不要用 `eval "document.forms[0].submit()"` 提交表单**——现代站点用 JS handler 拦截并静默丢弃。要么 `click` 提交按钮（用它的 ref），要么（知道 GET URL 时）直接 `open`。
- **不要在页面切换后复用 ref。** `wait` 到新状态，再重新 `state`。旧 ref 要么 404，要么（更糟）在新页面上 `reidentify` 到形状相似的元素。
- **`match_level: reidentified` 是警告，不是错误。** 动作已经执行；但如果你后面还链 5 个都依赖“点对了”的写入，先 `get text` 或 `get value` 验证再继续。
- **Budget-aware 命令会静默截断。** 默认预算下 `get html --as json` 会返回 `truncated: {...}`。下游逻辑要整棵子树就调大 `--depth` / `--children-max` 或收窄 selector。
- **`type` 响应里的 `autocomplete: true` 不是错误。** 表示建议弹层开着、值还没提交。通常 `keys Enter` 接受第一个建议，或 `click` 你想要的项。
- **`network --filter` 在路径段上是 AND 语义。** `--filter "title,score"` 保留 body shape 在任意深度同时含 `title` 和 `score` 两个路径段的条目。它不是正则。
- **截图是给人类的，不是给 agent 的。** 页面真正视觉化（验证码、图表）之前用 `state` + `find`。截图烧 token，而且很少给出 agent 能行动的信号。

---

## Troubleshooting

| 症状 | 修法 |
|------|------|
| 连不上浏览器（`state` 报连接错误） | 检查 `BROWSEROS_CDP_PORT` 端口是否可达、Chrome 是否在跑；临时关掉 1Password 等抢 CDP 的程序。 |
| `selector_not_found` 紧跟 `state` 之后 | 页面变了。`wait selector "..."` 再重试。 |
| 每条命令都 `stale_ref` | 你在复用前一页的 ref。重新 `state`。 |
| `click` 成功但没反应 | 元素可能是偷走点击的装饰性 wrapper。用更窄的 selector `find --css "..."` 在内部元素上重试。 |
| `type` 看似完成但值不对 | autocomplete、掩码输入、React 受控重渲染。用 `get value` 验证。必要时 `keys Enter` 或重打。 |
| `get html` 输出巨大 | 传 `--selector` + `--as json --depth 3 --children-max 20 --text-max 200`。 |
| network cache 看着过期 | 调小 `--ttl`，或等它过期。缓存位置：`~/.hub/cache/browser-network/`。 |
| 需要登录但被 `AUTH_REQUIRED` 挡 | 在浏览器里登录该站点一次（space 共享 cookie），再重跑。 |

---

## See also

- `hub-browser` —— MCP 工具面 + space 前提 + tab 卫生纪律的总入口。
- `hub-browser-sitemap` —— 驱动浏览器任务时消费站点 sitemap 上下文。
- `hub-adapter-author` —— 把你刚摸清的东西变成 `~/.hub/clis/<site>/<command>.js` 可复用适配器。
- `hub-autofix` —— 已有适配器坏了时，按 trace 证据修。
