# 公共函数总览与官方已有函数

> 适配器公共函数的设计原则 + 本仓库 `clis/_shared/` 官方已有函数

---

## 设计原则

### 1. 抽积木不抽房子

`fillInput`（填一个输入框）该抽。`fillFormFields`（填整个表单）不该抽——每个页面字段不同，抽出来反而难用。

**判断标准**：函数内部步骤不可分割（少一步就不生效），就抽。如果只是按顺序调用其他函数，就不抽。

### 2. 选择器参数化，零硬编码

```javascript
// ❌ 写死业务选择器，换一个系统就不能用
const caret = doc.querySelector('.drop-font .el-icon-caret-bottom')

// ✅ 由调用方传入
fillInput(page, selector, value)
```

框架级选择器（`.el-table`、`.el-select`、`.el-form-item`）可以写默认值，因为跨项目通用。业务选择器（`.drop-font`、`.order-list-container`）不能写死。

### 3. iframe 处理可选但默认开

所有在 DOM 上找元素的函数默认遍历 iframe（B 端系统常把内容套在 iframe 里），但允许关闭：

```javascript
clickButtonByText(page, '搜索', { searchIframes: false })
```

### 4. 返回值必须有意义

```javascript
// ❌ 返回 undefined
caret.click()

// ✅ 返回状态
return { ok: true, via: 'click', text }
return false
```

### 5. fallback 链内置

函数内部实现"先试便宜的，失败升级"策略。调用方调一次就行：

```javascript
// fillInput 内部：execCommand → 双写 setter
// fillRichText 内部：insertText → execCommand fallback
// clickButtonByText 返回坐标，调用方自行决定是否升级 nativeClick
```

### 6. 超时和匹配模式可配

```javascript
waitForElement(page, fn, { timeoutMs: 20000, intervalMs: 500 })
clickDropdownOption(page, label, val, { match: 'contains' })
```

---

## 函数文件结构

| 文件 | 内容 |
|---|---|
| `references/shared-js/overview.md` | 设计原则 + 官方已有函数（本文件） |
| `references/shared-js/input-and-click.md` | 该新增的输入+点击类单点操作（A+B 类，10 个函数） |
| `references/shared-js/wait-and-state.md` | 该新增的等待+状态类单点操作（C+D+E 类，7 个函数） |
| `references/shared-js/eval-helpers.md` | EVAL 代码块常量 + 适配器标准结构 |

---

## 函数总览

### 官方已有（直接用）

| 函数 | 文件 | 做什么 |
|---|---|---|
| `clampInt` / `clamp` | common.js | 数值约束 |
| `normalizeNumericId` | common.js | ID 校验 |
| `requireNonEmptyQuery` | common.js | 参数校验 |
| `requireSearchQuery` | search-adapter.js | 搜索参数校验 |
| `requireBoundedInteger` | search-adapter.js | 整数范围校验 |
| `unwrapBrowserResult` | search-adapter.js | 解包浏览器返回值 |
| `requireRows` | search-adapter.js | 确保返回数组 |
| `toHttpsUrl` | search-adapter.js | URL 规范化 |
| `emptySearchResults` | search-adapter.js | 构造空结果错误 |
| `registerSiteAuthCommands` | site-auth.js | 一键注册 login/whoami/logout |
| `makeScreenshotCommand` | desktop-commands.js | Electron 截图命令 |

### 该新增（按重复频率排序）

| # | 函数 | 分类 | 做什么 | 官方重复 | 文件 |
|---|---|---|---|---|---|
| 1 | `fillInput` | A 输入 | 普通输入框填值（双写 setter） | 24 个文件 | input-and-click.md |
| 2 | `fillRichText` | A 输入 | 富编辑器填值（CDP insertText） | 4 个文件 | input-and-click.md |
| 3 | `typeInAiBox` | A 输入 | AI 对话框输入+发送 | 6 个文件 | input-and-click.md |
| 4 | `fillDateRange` | A 输入 | 日期范围填值 | 18 个文件 | input-and-click.md |
| 5 | `clickButtonByText` | B 点击 | 按文本找按钮点击（返回坐标备用） | ~30 个文件 | input-and-click.md |
| 6 | `clickNativeAtCenter` | B 点击 | 真实鼠标点击 | 42 个文件 | input-and-click.md |
| 7 | `clickDropdownOption` | B 点击 | 下拉选选项 | 20+ 个文件 | input-and-click.md |
| 8 | `fillFilterableSelect` | B 点击 | 可搜索下拉选 | 10+ 个文件 | input-and-click.md |
| 9 | `fillMultiSelect` | B 点击 | 多选下拉选 | 10+ 个文件 | input-and-click.md |
| 10 | `expandHiddenFields` | B 点击 | 展开隐藏筛选条件 | 28 个文件 | input-and-click.md |
| 11 | `uploadFiles` | C 文件 | 文件上传 | 13 个文件 | wait-and-state.md |
| 12 | `navigateTo` | C 导航 | 导航+等渲染完成 | 所有适配器 | wait-and-state.md |
| 13 | `waitForLoadingMask` | D 等待 | 等 loading 遮罩消失 | 18 个文件 | wait-and-state.md |
| 14 | `waitForElement` | D 等待 | 等元素出现 | 所有交互型适配器 | wait-and-state.md |
| 15 | `waitForNetworkIdle` | D 等待 | 等网络空闲 | 6 个文件 | wait-and-state.md |
| 16 | `checkAuthCookie` | E 状态 | 登录态检查 | 110 个文件 | wait-and-state.md |
| 17 | `findActiveDoc` | E 状态 | 找活跃文档（iframe 遍历） | 310 次重复 | wait-and-state.md |
| 18 | `waitForAnchor` | D 等待 | 锚点轮询等待（AAA 核心，见 patterns/anchor-assert.md） | 所有交互型适配器 | wait-and-state.md |
| 19 | `installRequestCapture` | E 状态 | 页面自身请求捕获（patch 主 + CDP 次） | 数据需与 UI 一致时 | wait-and-state.md |

---

## 待实现候选函数（按需实现后回填本库）

以下函数来自早期的 shared.js 模板，未被上面 17 个函数覆盖。适配器模板（`eval-helpers.md`）的 import 列表中引用了其中部分函数，新站点创建 shared.js 时需要自行实现或改用等价函数；实现稳定后可回填到本库。

| 函数 | 状态 | 说明 |
|---|---|---|
| `sleep(ms)` | 直接用 | 基础延时工具，几乎所有适配器都在用 |
| `handleScreenshot(page, screenshotPath)` | 直接用 | finally 块截图（成功/失败均截图），模板 import 引用 |
| `extractTableData(page, tableSelector)` | 待实现 | 提取表格数据（先查主文档再查 iframe），模板 import 引用；默认选择器 `.el-table`（Ant Design 用 `.ant-table`） |
| `resetFilters(page)` | 待实现 | 重置筛选（展开"更多" → 点"重置" → 关闭 drawer），模板 import 引用 |
| `clickSearchButton(page, texts)` | 已取代 | 按文本列表尝试点击搜索按钮；等价于 `clickButtonByText(page, '搜索', { match: 'contains' })` |
| `clickButton(page, buttonText)` | 已取代 | 按文本点击按钮；等价于 `clickButtonByText(page, buttonText)` |
| `fillSelect(page, labelText, value)` | 已取代 | 普通单选下拉；等价于 `clickDropdownOption(page, labelText, value)` |
| `fillFormFields(page, fields)` | 不推荐 | 按 label 批量填整个表单；违反"抽积木不抽房子"原则（每页字段不同，抽出来难用），用单个函数逐个调用 |
| `readCookie(page, domain, cookieDomain)` | 待实现 | 读取页面 cookie，需参数化域名 |
| `extractFilterFields(page)` | 待实现 | 提取页面筛选字段清单（用于覆盖报告），遍历 `.el-form-item` 收集 label/placeholder/type |
| `installNetworkRecorder(page)` | 待实现 | 拦截 fetch/XHR 存到 `window.__hubBrowserNetLog`，用于 DOM 不显示完整数据时从 API 响应提取；因每个适配器拦截路径不同，暂未抽通用 |
| `drainNetworkLog(page, urlFragment)` | 待实现 | 提取拦截到的 API 响应列表 |
| `waitForNetworkLog(page, urlFragment, timeoutMs)` | 待实现 | 等待特定 API 响应出现 |
| `handleDialog(page, action, fields)` | 待实现 | 弹窗交互（确认/取消 + 表单填写），现有范式见 `patterns/button-actions.md` |
| `extractDialogText(page)` | 待实现 | 提取弹窗 innerText，现有范式见 `patterns/button-actions.md` |
| `clickTableRowAction(page, rowIndex, buttonText)` | 待实现 | 点击表格行内操作按钮（定位第 rowIndex 行 + 按文本找按钮） |
| `navigatePagination(page, pageNum)` | 待实现 | 翻页到指定页码（操作分页组件） |

---

## 官方已有函数详情

本仓库 `clis/_shared/` 目录已有的 4 个文件，直接 import 使用。

### common.js

纯工具函数，不涉及浏览器操作。

#### `clampInt(raw, fallback, min, max)`

将输入值约束到 `[min, max]` 范围内的整数。非数字返回 fallback。

```javascript
import { clampInt } from '../_shared/common.js'

const limit = clampInt(kwargs.limit, 10, 1, 30)
// limit=5 → 5, limit=0 → 1, limit=50 → 30, limit='abc' → 10
```

#### `clamp(value, min, max)`

`clampInt` 的浮点版，不做 `Math.floor`。

#### `normalizeNumericId(value, label, example)`

校验 ID 是否为纯数字，不是则抛 `ArgumentError`。

```javascript
import { normalizeNumericId } from '../_shared/common.js'

const userId = normalizeNumericId(kwargs.id, '用户ID', '12345')
// 'abc' → throw ArgumentError
```

#### `requireNonEmptyQuery(value, label = 'query')`

校验搜索关键词非空。

```javascript
import { requireNonEmptyQuery } from '../_shared/common.js'

const query = requireNonEmptyQuery(kwargs.query)
// '' → throw ArgumentError
```

---

### search-adapter.js

搜索型适配器的公共函数。

#### `requireSearchQuery(value, label = 'keyword')`

同 `requireNonEmptyQuery`，但 label 默认值为 `'keyword'`。

#### `requireBoundedInteger(value, defaultValue, min, max, label)`

校验整数参数在指定范围内。

```javascript
import { requireBoundedInteger } from '../_shared/search-adapter.js'

const limit = requireBoundedInteger(kwargs.limit, 10, 1, 100, 'limit')
```

#### `unwrapBrowserResult(value)`

解包浏览器返回值。某些 IPage 方法返回 `{ session, data }` 包装，此函数取出 `.data`。

```javascript
import { unwrapBrowserResult } from '../_shared/search-adapter.js'

const result = unwrapBrowserResult(await page.evaluate(`...`))
```

#### `requireRows(value, label)`

确保返回值是数组，否则抛 `CommandExecutionError`。

#### `toHttpsUrl(value, baseUrl)`

将相对 URL 转为完整 https URL。无效返回空字符串。

#### `emptySearchResults(site, query)`

构造"无搜索结果"的 `EmptyResultError`。

---

### site-auth.js

一键注册认证命令（login / whoami / logout）。80+ 个适配器的 `auth.js` 都用这个。

#### `registerSiteAuthCommands(config)`

```javascript
import { registerSiteAuthCommands } from '../_shared/site-auth.js'

registerSiteAuthCommands({
  site: 'myapp',
  domain: 'myapp.com',
  loginUrl: 'https://myapp.com/login',
  columns: ['user_id', 'name'],
  quickCheck: async (page) => {
    const cookies = await page.getCookies({ domain: 'myapp.com' })
    return cookies.some(c => c.name === 'session_token')
  },
  verify: async (page) => {
    await page.goto('https://myapp.com/')
    await page.wait(2)
    const cookies = await page.getCookies({ domain: 'myapp.com' })
    return { user_id: cookies.find(c => c.name === 'uid')?.value, name: 'user' }
  },
  poll: async (page) => {
    // 登录轮询：检查是否登录成功
    return verifyIdentity(page)
  },
})
```

自动注册 3 个命令：
- `hub myapp whoami` — 检查当前登录身份
- `hub myapp login` — 打开登录页，等登录完成
- `hub myapp logout` — 清除登录态

**参数说明**：

| 参数 | 必填 | 做什么 |
|---|---|---|
| `site` | ✅ | 站点名 |
| `domain` | ✅ | cookie 域名 |
| `loginUrl` | ✅ | 登录页 URL |
| `verify` | ✅ | 验证登录态的函数 |
| `columns` | | whoami 返回的列名 |
| `quickCheck` | | 快速检查（只看 cookie，不导航） |
| `poll` | | 登录轮询函数 |
| `refresh` | | 刷新登录态的函数 |

---

### desktop-commands.js

Electron / 桌面应用适配器的命令工厂。

#### `makeScreenshotCommand(site, displayName, extra)`

注册一个 `screenshot` 命令，截取 DOM HTML + Accessibility 快照。

#### `makeStatusCommand(site, displayName, extra)`

注册一个 `status` 命令，检查 CDP 连接状态。

#### `makeNewCommand(site, displayName, extra)`

注册一个 `new` 命令，通过 Cmd/Ctrl+N 开新会话。

**使用场景**：Cursor、Codex、Chatwise 等 Electron 应用的适配器，3 行代码注册 3 个标准命令：

```javascript
import { makeScreenshotCommand, makeStatusCommand, makeNewCommand } from '../_shared/desktop-commands.js'

makeScreenshotCommand('cursor', 'Cursor')
makeStatusCommand('cursor', 'Cursor')
makeNewCommand('cursor', 'Cursor')
```