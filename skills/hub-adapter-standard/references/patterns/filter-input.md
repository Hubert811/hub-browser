# 筛选字段输入范式

> 5 种字段类型的输入方式，Element Plus vs Ant Design 对比。
> 公共函数库（`shared-js/`）默认针对 Element Plus（Vue）实现；Ant Design（React）站点的差异在本文件中标注。

---

## 1 文本输入框

**适用场景**：订单编号、客户名称、收货人等单值文本字段

**Element Plus**：
```javascript
// 通过 placeholder 定位
var inp = Array.from(doc.querySelectorAll('input.el-input__inner')).find(i => i.placeholder?.includes('订单编号/父订单编号'));
if (inp) setVal(inp, opts.orderNumber);

// 通过索引定位同名 placeholder（如多个"请输入姓名"）
var nameInputs = Array.from(doc.querySelectorAll('input.el-input__inner[placeholder="请输入姓名"]'));
if (opts.consigneeName && nameInputs[0]) setVal(nameInputs[0], opts.consigneeName);
```

**Ant Design**：
```javascript
// 通过 placeholder 精确匹配
function byPlaceholder(ph) {
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].placeholder === ph) return inputs[i];
  }
  return null;
}
setVal(byPlaceholder('订单号/客户订单号'), p.orderNumber || '');
```

**关键点**：
- 必须用原生 setter（`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`）
- 必须 dispatch `input` + `change` 事件（`bubbles: true`）
- 无值不操作（保持默认"全部"）

---

## 2 可搜索下拉（Filterable Select）

**适用场景**：客户名称、发票抬头等远程搜索字段

**Element Plus**（公共函数 `fillFilterableSelect` 默认针对此框架）：
```javascript
async function fillFilterableSelect(labelText, value) {
  var col = findColByLabel(labelText);  // 按 .el-col 文本定位列
  var select = col.querySelector('.el-select');
  var input = select.querySelector('input.el-input__inner');

  closeAllDropdowns(); await sleep(200);
  input.focus(); input.click();
  setVal(input, value);
  await sleep(600);  // 等待下拉选项加载

  var opts = getVisibleOptions();
  for (var i = 0; i < opts.length; i++) {
    if (matchOption(opts[i], value)) { click(opts[i]); await sleep(300); return; }
  }
  closeAllDropdowns(); await sleep(200);
}
```

**Ant Design**（combobox 定位方式差异）：
```javascript
// 按 [role=combobox] + previousElementSibling 定位
var companyCombo = findCombobox('公司抬头');
closeAllDropdowns(); await sleep(200);
click(companyCombo); await sleep(600);
var opts = getVisibleOptions();
for (var i = 0; i < opts.length; i++) {
  if (opts[i].innerText.trim().indexOf(targetText) >= 0) { click(opts[i]); return sleep(300); }
}
closeDropdown(); await sleep(300);

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

**关键点**：
- 必须先关闭所有下拉，再打开目标下拉
- 等待选项渲染完成（固定 sleep 有 flaky 风险，详见 `references/pitfalls/filterable-select.md` 的轮询方案）
- 选项匹配用文本包含（`includes` 或 `indexOf`）

---

## 3 多选下拉（Multi-Select）

**适用场景**：订单状态、发货状态、开票状态等可多选字段

**Element Plus**：
```javascript
async function fillMultiSelect(labelText, values) {
  var valueList = String(values).split(',').map(s => s.trim()).filter(Boolean);

  // 找到带"可多选"标签的列
  var cols = doc.querySelectorAll('.el-col');
  var targetSelect = null;
  for (var i = 0; i < cols.length; i++) {
    var text = cols[i].innerText?.trim() || '';
    if (text.includes(labelText) && text.includes('可多选')) {
      targetSelect = cols[i].querySelector('.el-select');
      break;
    }
  }

  closeAllDropdowns(); await sleep(200);
  click(targetSelect.querySelector('.el-select__wrapper'));
  await sleep(600);

  for (var vi = 0; vi < valueList.length; vi++) {
    var opts = getVisibleOptions();
    for (var oi = 0; oi < opts.length; oi++) {
      if (matchOption(opts[oi], valueList[vi])) { click(opts[oi]); await sleep(200); break; }
    }
  }
  closeAllDropdowns(); await sleep(300);
}
```

**Ant Design**：
```javascript
var orderStatusCombo = findCombobox('订单状态');
closeAllDropdowns(); await sleep(200);
click(orderStatusCombo); await sleep(500);
for (var si = 0; si < p.webOrderStatusList.length; si++) {
  var opts = getVisibleOptions();
  for (var oi = 0; oi < opts.length; oi++) {
    if (opts[oi].innerText.trim() === label) { click(opts[oi]); await sleep(200); break; }
  }
}
closeDropdown(); await sleep(300);
```

**关键点**：
- 用户传逗号分隔的标签值（如"订单已生效，订单已取消（失效）"）
- 每次选择后重新获取可见选项（DOM 会变化）
- 选项文本可能包含括号后缀（如"订单已生效"），需模糊匹配

---

## 4 日期范围（Date Range）

**适用场景**：创建时间、生效时间、更新时间、签收时间

**Element Plus**（公共函数 `fillDateRange` 默认针对此框架）：
```javascript
function fillDateRange(labelText, from, to) {
  var col = findColByLabel(labelText);
  var dateEditor = col.querySelector('.el-date-editor');
  var inputs = dateEditor.querySelectorAll('input.el-range-input, input');
  if (inputs.length >= 2) {
    if (from) setVal(inputs[0], from);
    if (to) setVal(inputs[1], to);
  }
}
```

**Ant Design**（日期选择器是 readonly input，DOM 操作无效，必须通过 React Fiber 树遍历直接调用 useState setter）：
```javascript
var root = appEl._reactRootContainer._internalRoot;
var fiber = root.current;
function findDateState(node, depth) {
  if (!node || depth > 60) return null;
  var state = node.memoizedState;
  if (state) {
    var s = state;
    while (s) {
      if (s.queue && s.memoizedState && Array.isArray(s.memoizedState)
        && s.memoizedState.length === 2 && typeof s.memoizedState[0] === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(s.memoizedState[0])) {
        return s.queue.dispatch;
      }
      s = s.next;
    }
  }
  var r = findDateState(node.child, depth + 1);
  if (!r && node.sibling) r = findDateState(node.sibling, depth + 1);
  return r;
}
var setter = findDateState(fiber, 0);
if (setter) setter([createTimeFrom, createTimeTo]);
```

**关键点**：
- Element Plus：直接 setVal + input/change 事件即可，Vue v-model 能响应
- Ant Design：必须通过 React Fiber 调用 state setter，DOM 操作无效（readonly）
- 系统约束：部分系统要求时间范围不超过一定期限（如 6 个月），超过会触发错误弹窗并回退到默认范围

---

## 5 批量输入（Batch Input）

**适用场景**：批量查询订单编号等（如最大 1000 个）

跨框架通用，无差异：

```javascript
var binp = Array.from(doc.querySelectorAll('input.el-input__inner')).find(i => i.placeholder?.includes('批量查询，最大 1000，订单编号'));
if (binp) setVal(binp, opts.batchOrderNumbers);
```
