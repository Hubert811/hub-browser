# EVAL 代码块常量与适配器标准结构

> `page.evaluate` 内联代码常量（SET_VAL_CODE 等）+ 适配器标准结构模板

---

## EVAL 代码块常量

以下常量在 `page.evaluate` 内部使用，通过参数注入或 EVAL_HELPERS_CODE 合并注入。

### SET_VAL_CODE

```javascript
/**
 * setVal() — 通用设值函数（execCommand 优先 + _value 修复兜底）。
 *
 * Vue 2 _value 修复:
 *   Vue 2 覆盖了原生 value getter，返回内部 _value 属性。
 *   el._value = val 确保 Vue 2 getter 返回新值，DOM 可见。
 */
export const SET_VAL_CODE = `
function setVal(el, v) {
  if (!el) return false;
  el.focus();
  el.select();
  if (document.execCommand('insertText', false, v)) return true;
  var proto = Object.getPrototypeOf(el);
  var desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc && desc.set) desc.set.call(el, v);
  el._value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
`;
```

### CLOSE_ALL_DROPDOWNS_CODE

```javascript
/**
 * closeAllDropdowns() — 关闭所有 el-select 下拉。
 * 通过 body click + Escape 键盘事件关闭。
 */
export const CLOSE_ALL_DROPDOWNS_CODE = `
function closeAllDropdowns(doc) {
  doc = doc || document;
  doc.body?.click();
  var selects = doc.querySelectorAll('.el-select');
  for (var i = 0; i < selects.length; i++) {
    var input = selects[i].querySelector('input');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
    }));
  }
}
`;
```

### GET_VISIBLE_OPTIONS_CODE

```javascript
/**
 * getVisibleOptions() — 获取可见的下拉选项。
 *
 * 关键: 不能只看 CSS class，必须用 getBoundingClientRect() 检查真实尺寸。
 * 原因: Element UI 页面上有多个下拉容器都不带 hidden class，
 * 但只有一个是真正可见的（有真实尺寸）。
 */
export const GET_VISIBLE_OPTIONS_CODE = `
function getVisibleOptions(doc) {
  doc = doc || document;
  var dropdowns = doc.querySelectorAll('.el-select-dropdown');
  for (var i = 0; i < dropdowns.length; i++) {
    var dd = dropdowns[i];
    if (dd.classList.contains('el-select-dropdown-hidden')) continue;
    var style = getComputedStyle(dd);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    var rect = dd.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    var options = dd.querySelectorAll('.el-select-dropdown__item');
    if (options.length > 0 && options[0].innerText.indexOf('条/页') >= 0) continue;
    return options;
  }
  return [];
}
`;
```

### MATCH_OPTION_CODE

```javascript
/**
 * matchOption() — 模糊匹配选项文本。
 *
 * 支持: 精确匹配、包含匹配、去括号匹配（如"订单已生效"匹配"订单已生效（生效）"）。
 */
export const MATCH_OPTION_CODE = `
function matchOption(opt, val) {
  var text = (opt.innerText || '').trim();
  if (text === val) return true;
  if (text.includes(val)) return true;
  if (val.includes(text)) return true;
  var textNoParen = text.replace(/[（(].*?[)）]/g, '').trim();
  if (textNoParen === val || textNoParen.includes(val)) return true;
  return false;
}
`;
```

### EVAL_HELPERS_CODE

```javascript
/**
 * 合并以上 4 个常量，一次性注入 page.evaluate。
 */
export const EVAL_HELPERS_CODE = SET_VAL_CODE + CLOSE_ALL_DROPDOWNS_CODE + GET_VISIBLE_OPTIONS_CODE + MATCH_OPTION_CODE;
```

---

## 注入使用方式

```javascript
import { SET_VAL_CODE, GET_VISIBLE_OPTIONS_CODE, MATCH_OPTION_CODE } from './shared.js'

// 在 evaluate 模板字符串里拼接代码块
await page.evaluate(`
  ${SET_VAL_CODE}
  ${GET_VISIBLE_OPTIONS_CODE}
  ${MATCH_OPTION_CODE}
  // 现在可以用 setVal()、getVisibleOptions()、matchOption()
  var opts = getVisibleOptions(document)
  for (var i = 0; i < opts.length; i++) {
    if (matchOption(opts[i], '目标值')) {
      opts[i].click()
      break
    }
  }
`)
```

---

## 适配器标准结构

> import 沿用 `hub browser <session> init` 骨架自带的 registry / errors 两个子路径（hub 运行时提供，不要手改、不要加第三方依赖）。`browser:` 字段决定 func 签名：`browser: false → func(args)`（Node-side fetch 纯取数），`browser: true → func(page, args)`（UI 交互）。下面是 UI 交互类（`browser: true`）模板；PUBLIC/COOKIE_API 纯取数类不需要 shared.js。策略选择见 `patterns/implementation-patterns.md` §1。

```javascript
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  checkAuthCookie, navigateTo, extractTableData,
  resetFilters, clickButtonByText, sleep,
  expandHiddenFields, fillDateRange, fillFilterableSelect,
  fillMultiSelect, fillInput, waitForLoadingMask,
} from './shared.js';

const HOST = 'example.com';
const PAGE_URL = `https://${HOST}/path`;

cli({
  site: 'example',
  name: 'pageName',
  strategy: Strategy.UI,   // 数据源契约：PUBLIC / COOKIE / INTERCEPT / UI / LOCAL
  browser: true,           // browser: false → func(args)；true → func(page, args)
  args: [
    { name: 'field1', type: 'string', default: '', help: '文本字段' },
    { name: 'field2', type: 'string', default: '', help: '远程搜索下拉' },
    { name: 'dateFrom', type: 'string', default: '', help: '起始日期' },
    { name: 'dateTo', type: 'string', default: '', help: '结束日期' },
  ],
  columns: ['rows', 'total'],

  func: async (page, args) => {
    await checkAuthCookie(page, HOST, 'cookieName');

    try {
      await navigateTo(page, PAGE_URL, { checkSelector: '.el-table' });
      await resetFilters(page);
      await expandHiddenFields(page, '.drop-font .el-icon-caret-bottom');

      if (args.field1) {
        await fillInput(page, 'input[placeholder*="field1"]', args.field1);
      }
      if (args.field2) {
        await fillFilterableSelect(page, 'field2', args.field2);
      }
      if (args.dateFrom || args.dateTo) {
        await fillDateRange(page, '日期', args.dateFrom, args.dateTo);
      }

      await clickButtonByText(page, '搜索', { match: 'contains' });
      await waitForLoadingMask(page);

      const tableData = await extractTableData(page);
      return tableData;
    } catch (e) {
      if (e instanceof ArgumentError || e instanceof CommandExecutionError) throw e;
      throw new CommandExecutionError(`error: ${e.message}`);
    }
  },
});
```

### iframe eval 包装规则（dashEval 强制）

在 iframe 里执行字符串 evaluate 时，包装层必须：

```javascript
// ❌ 块体不隐式返回最后表达式 → 所有结果 undefined（最隐蔽的坑，见 pitfalls/evaluate-return.md）
(async () => { ...; (() => { return {...}; })() })()   // 结果永远是 undefined

// ✅ 必须显式 return(body)，且 body 本身是表达式（IIFE）
const expr = '(async () => { ' + PREFIX + ' return (' + body + '); })()';
```

- 字符串 evaluate 与函数式 evaluate 语义可能不同（字符串走 wrapForEval 原样发送）。**写适配器前先跑探针**：plain IIFE / async IIFE / 含内层 IIFE / 函数式 各返回什么。
- 正则写在模板字面量里要**双写**（`\\s`、`\\n`），否则 evaluate 侧变成字母/换行（见 pitfalls/escaping-ladder.md）。

### 参考适配器

参考示例以各站点真实适配器为准，典型覆盖层次：
1. **完整列表页适配器** — 覆盖全量筛选字段 + 多个按钮 + 行内操作
2. **中等复杂度适配器** — 文本 + 可搜索下拉 + 日期 + 分页
3. **跨框架适配器** — Ant Design + API 拦截混合模式（参见 `patterns/button-actions.md` 第 9 节）

### 新站点开发流程

1. **观察先行**: 用 `hub browser <session> analyze <url>`（首选）或 `hub browser <session> open` 打开页面，记录 UI 框架、组件库、筛选字段类型、表格结构，并对每个交互组件建立「操作→锚点→真实值」规格表（见 patterns/anchor-assert.md）；锚点 = 操作后轮询等待的预期状态，真实值 = 页面自己发出的请求 payload
2. **创建 shared.js**: 基于函数文档（`references/shared-js/` 目录）创建，按站点 UI 框架调整选择器默认值
3. **编写适配器**: 按标准结构编写，只调用 shared.js 函数
4. **测试**: 所有筛选字段值在页面上可见、搜索功能正常、返回数据正确、截图确认