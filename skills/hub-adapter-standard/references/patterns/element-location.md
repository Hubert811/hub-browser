# 元素定位策略

> DOM 结构差异、下拉可见性检查、选项模糊匹配。
> 定位信息的**首选来源是 AX 快照**（selector 直接摆在快照行尾，见 §0）。

---

## 0 快照侦察提 selector（首选入口，2026-08-27 实证）

快照行尾的 `→ tag#id [sel="..."]`（P3-5 DOM 单元）就是「AX 语义 + DOM 定位」一体：
拍一张快照，**交互元素的稳定 class selector 直接摆在行尾**，不用裸 eval 一轮轮摸。

实测对照（QuickBI advance-select 弹层，快照 0.146s）：

| 快照给出 | 手写适配器时的老办法 | 快照优势 |
|---|---|---|
| `button.query-area-button` | innerText 正则 `/查\s*询/` 找按钮 | class 直命中，不受多个含「查询」文本的按钮干扰 |
| `button.advance-select-add-all-button` | innerText includes('添加左侧全部字段值') | 同上 |
| `button.advance-select-footer-cancel/confirm` | innerText replace(/\s/g,'') 匹配（「取 消」带空格） | 同上 |
| `div.advance-select-tip-delete-all`（清空） | 手摸多轮试出 | 完全一致，零成本 |
| `div.advance-select-max-tip`（截断警告） | innerText includes('默认展示前') | class 更直接 |
| `div.bi-tabs-tab` / `div.single-select` | 手摸 | 一致 |

**边界（快照给不了的）**：无 role 的纯容器/布局节点不进 AX 树——
`.advance-select-popup`（弹层容器）、`.advance-select-items`（列表容器）、
`.query-field`（字段容器）、`.ant-picker-cell`（日历格子）。这些用
`browser find --css "<selector>"` 验证（返回 tag/role/text/class/frame，
iframe 内自动标注 frame=N）；无 class 节点快照只能给 nth-of-type 位置路径
（脆弱，不进适配器）。

**工作流**：①侦察先 `snapshot`，提取全部 `[sel=...]` 中带 class 的作为候选；
②容器类用 `find --css` 验证；③只对动态弹层/日历这类「快照看不见的容器内部」
才裸 eval 手摸。innerText 匹配仅作为无 class 时的兜底，不作首选。

---

## 1 Element Plus

**DOM 结构**：
```html
<div class="el-col">
  <span class="filter-label">客户名称</span>
  <div class="el-select">...</div>
</div>
```

**定位方式**：
```javascript
function findColByLabel(labelText) {
  var cols = doc.querySelectorAll('.el-col');
  for (var i = 0; i < cols.length; i++) {
    var text = cols[i].innerText?.trim() || '';
    if (text.startsWith(labelText)) return cols[i];
  }
  return null;
}
```

---

## 2 Ant Design

**DOM 结构**：
```html
<span>订单状态</span>
<div role="combobox">...</div>
```

**定位方式**：
```javascript
function findCombobox(labelText) {
  var comboboxes = document.querySelectorAll('[role=combobox]');
  for (var i = 0; i < comboboxes.length; i++) {
    var cb = comboboxes[i];
    var parent = cb.parentElement;
    var prev = parent ? parent.previousElementSibling : null;
    if (prev && prev.innerText && prev.innerText.indexOf(labelText) >= 0) return cb;
  }
  return null;
}
```

---

## 3 下拉选项可见性检查

**关键修复**：不能只看 CSS class，必须用 `getBoundingClientRect()` 检查真实尺寸

```javascript
function getVisibleOptions() {
  var dropdowns = doc.querySelectorAll('.el-select-dropdown');
  for (var i = 0; i < dropdowns.length; i++) {
    var dd = dropdowns[i];
    if (dd.classList.contains('el-select-dropdown-hidden')) continue;
    var style = getComputedStyle(dd);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    var rect = dd.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;  // 关键！
    return dd.querySelectorAll('.el-select-dropdown__item');
  }
  return [];
}
```

**原因**：Element Plus 页面上有多个下拉容器都不带 hidden class，但只有一个是真正可见的（有真实尺寸）。

---

## 4 选项模糊匹配

**问题**：选项文本包含括号后缀（如"订单已生效"），用户可能传"订单生效"

```javascript
function matchOption(opt, val) {
  var text = (opt.innerText || '').trim();
  if (text === val) return true;
  if (text.includes(val)) return true;
  if (val.includes(text)) return true;
  // 去括号后匹配
  var textNoParen = text.replace(/[（(].*?[)）]/g, '').trim();
  if (textNoParen === val || textNoParen.includes(val)) return true;
  return false;
}
```

---

## 5 隐藏筛选字段展开按钮

> **部分站点的列表页存在隐藏筛选字段**（初始只显示前几个字段，其余折叠）。编写适配器时，若页面存在"更多/隐藏"展开控件，必须默认假设存在隐藏字段，并在 `resetFilters` 后自动展开。

**现象**：页面初始只显示前 3 个筛选字段，其余字段被折叠隐藏。查询条件区域下方有一个小三角图标（`.el-icon-caret-bottom`），点击后展开全部字段，图标变为向上箭头（`.el-icon-caret-top`），文字从"更多"变为"隐藏"。

**DOM 结构**：
```html
<div class="drop-font">
  <span>更多</span>
  <i class="el-icon-caret-bottom"></i>  <!-- 点击此元素展开 -->
</div>
```

**排查特征**：
- 用户反馈的筛选字段数量远多于探索到的字段数量
- 页面有"更多"按钮但点击后字段数不变（顶部导航的"更多"≠筛选展开按钮）
- 参考同站点已有适配器的字段数量来推断

**解法**：适配器在 `resetFilters` 后自动点击展开按钮（点击前先确认是筛选区下方的展开按钮，而非顶部导航的"更多"）：

```javascript
// 点击展开按钮，显示隐藏的筛选字段（存在展开控件的页面都应执行）
await page.evaluate(() => {
  const docs = [document];
  document.querySelectorAll('iframe').forEach(f => {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch(e) {}
  });
  for (const doc of docs) {
    const caret = doc.querySelector('.drop-font .el-icon-caret-bottom');
    if (caret) { caret.click(); return true; }
  }
  return false;
});
await sleep(500);
// 然后才能填充隐藏的字段
```

**注意**：
- 展开按钮在筛选条件区域下方，与顶部导航栏的"更多"按钮是两个不同的元素
- 点击顶部导航的"更多"不会展开筛选字段
- 展开后需要等待 500ms 让 DOM 重新渲染
- 如果页面没有隐藏字段（caret 不存在），代码会安全跳过，不会报错
