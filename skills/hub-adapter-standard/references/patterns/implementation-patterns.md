# 实现模式与工作流

> 策略选择（契约分级）、page.evaluate 使用模式、SPA 页面加载、错误处理、Vue 状态操作

---

## 0 参考文件必读（强制）

> **开始 recon 前，必须阅读本 skill 的 `references/` 目录下所有文件。**

在开始任何适配器工作之前，先读取 `references/` 目录下的全部文件（`shared-js/`、`patterns/`、`pitfalls/` 三个子目录都要读）。这些文件包含已知坑点和实现模式，是避免重复犯错的关键。

**检查方式**：
1. 列出 `references/` 目录下所有文件（含子目录）
2. 逐个读取每个文件的完整内容
3. 在 recon 阶段逐条对照当前页面，标注哪些坑点命中、哪些不适用

**交付要求**：覆盖报告中必须声明"已对照坑点清单，命中 N 条（列出），不适用 M 条"。未声明的交付不予验收。

---

## 1 策略选择：按数据源契约分级

hub 的 adapter 按**数据源契约**选 strategy（详见官方 skill `hub-adapter-author` 内的 `references/strategy-selection.md`——该文件在官方 skill 目录下，不在本标准内），六类：

| Strategy 类 | 契约 | 使用时机 |
|---|---|---|
| `PUBLIC_API` | stable | 无需登录，Node-side `fetch` 直接拿目标数据 |
| `COOKIE_API` | stable | Node-side `fetch` + `page.getCookies()` / header helper 能拿数据 |
| `UI_SELECTOR` | visible-ui | publish/upload/click/表单，或页面语义比内部接口更稳 |
| `DOM_STATE` | visible-ui | 数据在 hydration state / bootstrap JSON / SSR HTML 里 |
| `PAGE_FETCH` | internal-unstable | 只能在页面上下文 `fetch` 才能复用 same-origin/session/runtime |
| `INTERCEPT` | internal-unstable | 请求签名复杂，但页面自己能自然发出请求 |

**选择规则**：优先 `PUBLIC_API` / `COOKIE_API`（Node-side fetch 最稳）。UI/DOM 语义稳定时用 `UI_SELECTOR` / `DOM_STATE`，不要为了"API-first"把稳定的 UI/DOM 实现盲目迁到无契约内部接口。只有公开接口不可用、UI/DOM 无法表达目标数据或操作时，才承担 `PAGE_FETCH` / `INTERCEPT` 的维护成本（实测 fix 频率约为 `PUBLIC_API` 的 7-8 倍）。

**强制**：写代码前必须产出 strategy note（Strategy / Contract / Evidence），不写 note 不要开始写 adapter。

**实现约定**（按所选 strategy）：
- `PUBLIC_API` / `COOKIE_API`：适配器 `browser: false`，`func: async (args)`，Node-side `fetch`；COOKIE_API 用 `page.getCookies({ domain })` 取 cookie，**不要**手动拼 `Authorization: Bearer`
- `UI_SELECTOR`：适配器 `browser: true`，通过 shared.js 函数 / `page.evaluate` 操作 DOM（点击按钮、填写表单、选择下拉选项），并从 DOM 提取数据
- `DOM_STATE`：从 hydration state / bootstrap JSON / SSR HTML 中提取
- `PAGE_FETCH` / `INTERCEPT`：通过 UI 触发请求后用 `page.waitForResponse` / `page.on('response')` 拦截响应作为数据源（仍然由页面自己发出请求）

**禁止行为**：
- 不写 strategy note 就动手
- `PUBLIC_API` / `COOKIE_API` 能满足时强行使用无契约内部接口
- 声明为 UI 类策略却用 API 返回值替代 DOM 数据提取
- 绕过验证码 / 风控 / 访问控制，或教破解签名

### 常见问题的解法

**问题 1: 接口需要 cookie / 认证**
- 正确做法：`COOKIE_API` — Node-side `fetch` + `page.getCookies({ domain })` 取 cookie（或 header helper），先 `hub browser <session> open` 登录页确认登录态
- 微前端 / 复杂签名站点：先在浏览器 session 里探明（`hub browser <session> network` / `eval fetch(...)`），再决定走 COOKIE_API 还是 INTERCEPT

**问题 2: Vue native setter 不更新 searchForm（UI_SELECTOR）**
- 正确做法：
  1. 使用 shared.js 的 `fillInput`（execCommand + `_value` 修复，兼容 Vue 2/3）
  2. 仍无效 → `page.evaluate` 内用 Vue 组件实例操作状态：`vm.searchForm.fieldName = value`
  3. 或通过 React Fiber 操作 state（Ant Design 站点）
  4. 实在不行，用 `page.type` 逐字符输入

**问题 3: 筛选参数不生效**
- 正确做法：
  1. 先通过 UI 填入筛选条件，点击搜索
  2. 用 `hub browser <session> network` 或 `page.waitForResponse` 看实际 API 请求参数
  3. 如果 API 确实不支持某筛选字段，在覆盖报告中标注"API 不支持此筛选，UI 操作已实现但筛选无效"
  4. 作为最后手段，UI 触发搜索后从 DOM 表格提取数据做客户端过滤

---

## 2 page.evaluate 使用模式

### 设计原则

shared.js 的 Node.js 层函数内部封装 `page.evaluate`，适配器调用 shared.js 函数，不内联 DOM 操作。

**关于"每次 evaluate 只做一件事"**：不是只能填一个字段。实际做法是：
- 一个字段对应一次 shared.js 函数调用（如 `fillInput`、`fillFilterableSelect`）
- shared.js 函数内部可能多次 `page.evaluate`
- 允许在一次 `page.evaluate` 中完成多个同类操作（如填 5 个文本输入框），只要使用 shared.js 提供的辅助函数
- 如果适配器有特殊需求需要内联 `page.evaluate`，应注入 `EVAL_HELPERS_CODE` 获取 setVal/closeAllDropdowns/getVisibleOptions/matchOption

**批量操作的取舍**：一次大 `page.evaluate` 填完所有字段能减少 IPC 调用次数，但代码重复严重、难以维护。推荐"一个字段对应一次 shared.js 调用"作为默认风格，仅对同类批量操作（如多个文本输入框）合并在一次 evaluate 内。

### 允许的内联 evaluate 模式

当适配器有特殊需求（如批量操作、复杂表单交互）需要内联 `page.evaluate` 时：

```javascript
await page.evaluate(async (opts) => {
  // 注入 EVAL_HELPERS_CODE 获取辅助函数
  // 1. 填入文本输入框（使用 setVal）
  // 2. 填入可搜索下拉（使用 closeAllDropdowns + getVisibleOptions + matchOption）
  // 3. 填入多选下拉
  return true;
}, fillOpts);
```

**关键点**：
- 函数必须是 `async`（因为有下拉操作需要 await）
- 所有操作在同一浏览器上下文内顺序执行
- 避免多次 CDP 往返导致的 DOM 状态丢失

> EVAL 常量和适配器结构参见 `references/shared-js/eval-helpers.md`。

---

## 3 SPA 页面加载问题

### 微前端页面不渲染

使用微前端框架（如 wujie）的站点，`page.goto()` 后子应用内容可能为空。`location.reload()` 触发完整浏览器 reload 流程，微前端才能正确加载子应用。

**shared.js 的 `navigateTo` 已内置此逻辑**（goto + reload + 轮询等待元素），所有适配器应直接复用。详见 `references/shared-js/wait-and-state.md` 中 `navigateTo` 函数。

普通 SPA（无微前端）站点使用默认的 `reload: false` 即可，无需 reload。

### iframe 内容访问

页面内容可能在 iframe 中。shared.js 的 `findActiveDoc` 函数封装了 iframe 查找逻辑，`extractTableData`、`resetFilters`、`clickButtonByText` 等函数已内置 iframe 遍历。

---

## 4 常见错误处理

### 认证失败
```javascript
if (result?.code === '401' || result?.code === '403') {
  throw new AuthRequiredError(HOST);
}
```

### 空结果
```javascript
if (rows.length === 0) {
  throw new EmptyResultError('adapterName', 'no rows');
}
```

### API 错误
```javascript
if (result?.code !== '0000') {
  throw new CommandExecutionError(`API error: ${result?.msg || 'unknown'}`);
}
```

### 导出前置条件不满足
```javascript
if (needsExport && !hasExportFilter) {
  throw new ArgumentError(
    '导出操作需要先筛选数据：请传入筛选字段'
  );
}
```

---

## 5 Vue 组件状态直接操作

### 什么时候需要直接操作 Vue 状态

shared.js 的 `fillInput` 已通过 execCommand + `_value` 修复兼容 Vue 2/3。大多数情况下不需要直接操作 Vue 状态。

**仅在以下情况使用 `__vue__.$set`**：
- 自定义 form-search 组件（如 `.drop-box.g-box`），DOM 设值无法触发 Vue 响应式更新
- 标准的 native setter + execCommand 都已尝试且无效

### Recon 决策树

```
筛选字段设值无效？
├── 先用 shared.js fillInput（execCommand + _value 修复）
│   └── 仍无效 → 检查 __vue__，用 $set
├── 有 .drop-box.g-box（自定义组件）→ 直接 __vue__.$set
└── 都没有 → 检查 iframe、shadow DOM、或是否是静态配置页
```

### Vue 2 _value 坑点

详见 `references/shared-js/eval-helpers.md` 中 `SET_VAL_CODE` 的注释。核心：Vue 2 覆盖了原生 value getter 返回内部 `_value`，必须 `el._value = val` 修复。

---

## 6 Stub 页面检测

**问题**：部分页面处于"开发中"状态，无表格/筛选/分页，只有占位文本（如"其它功能开发中，敬请期待！"）。适配器若按正常流程等待表格 / 分页元素，会一直等到超时抛 TimeoutError。

**解法**：在 recon 阶段检查页面是否是 stub，若是则返回明确提示：

```javascript
const isStub = await page.evaluate(() => {
  var bodyText = document.body.innerText || '';
  return bodyText.indexOf('开发中') >= 0 || bodyText.indexOf('敬请期待') >= 0;
});
if (isStub) {
  return { stub: true, message: '该页面尚未开发完成，无可用数据' };
}
```

---

## 7 文件上传限制

**问题**：hub adapter 的 `page` 对象没有 Playwright 的 `$` 方法（ElementHandle），无法调用 `page.$('input[type=file]')` + `setInputFiles()` 实现自动文件上传。

**解法**：
- 优先使用 shared.js 的 `uploadFiles`（已封装 CDP `DOM.setFileInputFiles`，见 `references/shared-js/wait-and-state.md`）
- 若页面不兼容，适配器只负责填写表单字段，文件上传步骤返回提示告知用户需手动操作

---

## 8 Disabled 表单字段自动跳过

**问题**：部分表单字段被设置为 `disabled`（如预填的实体类型、只读的关联 ID），适配器不应尝试设值。

**解法**：在设值前检查 disabled 状态：

```javascript
var inputs = form.querySelectorAll('input, select, textarea');
for (var i = 0; i < inputs.length; i++) {
  if (inputs[i].disabled || inputs[i].readOnly) continue;
}
```

---

> **测试清单**：见 SKILL.md「测试清单」章节（本文不重复）。
