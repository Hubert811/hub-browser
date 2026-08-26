# 元素定位策略

> DOM 结构差异、下拉可见性检查、选项模糊匹配

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
