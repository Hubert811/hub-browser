# 按钮操作与截图时机

> 按钮前置条件检查、点击逻辑、输出字段超限解决方案、截图时机

---

## 1 导出按钮前置条件

**业务规则**：订单导出/详情导出必须先筛选订单（传入订单编号或客户名称）

**适配器实现**：
```javascript
const needsExport = args.export || args.detailExport;
const hasExportFilter = args.orderNumber || args.batchOrderNumbers || args.customerName;
if (needsExport && !hasExportFilter) {
  throw new ArgumentError(
    '导出操作需要先筛选订单：请传入 --orderNumber（订单编号）或 --customerName（客户名称）'
  );
}
```

**导出后错误检查**：
```javascript
if (args.export) {
  await clickButtonByText(page, '订单导出');
  await sleep(3000);
  const msg = await page.evaluate(() => {
    const message = doc.querySelector('.el-message');
    if (message && getComputedStyle(message).display !== 'none') {
      return message.innerText?.trim() || '';
    }
    return '';
  });
  if (msg && msg.includes('请输入')) {
    throw new CommandExecutionError(`订单导出失败：${msg}`);
  }
}
```

---

## 2 批量操作按钮

**业务规则**：批量快捷操作无前置条件，直接跳转页面

```javascript
if (args.batchOp) {
  await clickButtonByText(page, '批量快捷操作');
  await sleep(2000);
}
```

---

## 3 行内操作按钮

**业务规则**：查看详情点击表格第一行的"查看详情"按钮

```javascript
if (args.viewDetail) {
  await page.evaluate(() => {
    const btn = Array.from(doc.querySelectorAll('button, .el-button')).find(
      b => b.innerText?.trim() === '查看详情'
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  await sleep(2000);
}
```

---

## 4 搜索/重置按钮

**搜索**：填入筛选条件后自动点击
```javascript
if (hasAnyFilter) {
  await sleep(500);
  await clickButtonByText(page, '搜索', { match: 'contains' });
  await sleep(2000);
  // 等待 loading 完成
  for (let i = 0; i < 10; i++) {
    const loading = await page.evaluate(() => {
      const mask = doc.querySelector('.el-loading-mask');
      return mask && getComputedStyle(mask).display !== 'none';
    });
    if (!loading) break;
    await sleep(500);
  }
}
```

**重置**：每次执行前自动重置
```javascript
await resetFilters(page);  // 点击"更多" → 点击"重置" → 关闭 drawer
```

---

## 5 hub 输出字段限制

`hub browser verify` 强制约束：
- 每行顶层 key 数 **≤ 12**
- 嵌套深度 **≤ 1**（可以有子对象，但子对象内不能再嵌套数组/对象）

---

## 6 解决方案：嵌套子对象分组

**错误做法**（18 个字段全部摊平）：
```javascript
columns: ['col1', 'col2', ..., 'col18'],  // ❌ 超过 12 个
```

**正确做法**（按业务逻辑分组）：
```javascript
columns: ['orderInfo', 'customerInfo', 'deliveryInfo', 'amountInfo'],
func: async (page, args) => {
  // ...
  return rows.map(row => ({
    orderInfo: {
      orderNumber: row.orderNumber,
      createTime: row.createTime,
      orderStatus: row.orderStatus,
    },
    customerInfo: {
      customerName: row.customerName,
      customerCode: row.customerCode,
      invoiceTitle: row.invoiceTitle,
    },
    deliveryInfo: {
      deliveryStatus: row.deliveryStatus,
      receivingStatus: row.receivingStatus,
    },
    amountInfo: {
      orderAmount: row.orderAmount,
      currencySymbol: row.currencySymbol,
    },
  }));
}
```

**关键点**：
- 子对象内的字段数量不受 12 限制
- 深度不能超过 1 层（子对象内不能再嵌套）
- 分组要符合业务逻辑（订单信息、客户信息、物流信息、金额信息）

---

## 7 截图原则（UI 交互类适配器）

1. **UI 交互类适配器（`browser: true`）可加可选 `--screenshot` 参数**；`browser: false` 的纯取数适配器不需要截图
2. **截图在 `finally` 块中执行**（成功/失败均截图）
3. **适配器必须先导航到目标页面再截图**

---

## 8 Element Plus 站点（Vue）

```javascript
func: async (page, args) => {
  try {
    // ... 业务逻辑 ...
    return tableData;
  } catch (e) {
    if (e instanceof ArgumentError || e instanceof CommandExecutionError) throw e;
    throw new CommandExecutionError('adapterName error: ' + e.message);
  } finally {
    await handleScreenshot(page, args.screenshot);
  }
}
```

**shared.js 中的 handleScreenshot**：
```javascript
export async function handleScreenshot(page, screenshotPath) {
  if (!screenshotPath) return;
  try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch (_) {}
}
```

---

## 9 Ant Design 站点（React，API 拦截型适配器）

对于 API 拦截型适配器，截图时机更复杂：

```javascript
func: async (page, args) => {
  let result;
  try {
    result = await page.evaluate(async (fetchBody, baseUrl, shouldSearch, waitForRender) => {
      // ... API 拦截逻辑 ...
      
      if (shouldSearch) {
        searchBtn.click();
        // 轮询等待 API 响应
        for (var poll = 0; poll < 20; poll++) {
          await sleep(300);
          if (capturedResponse) break;
        }
      }
      
      // 恢复拦截器
      window.fetch = origFetch;
      
      // 渲染等待（仅在需要截图时）
      if (waitForRender) {
        // 1. 等 loading spinner 消失
        for (var li = 0; li < 15; li++) {
          var hasLoading = false;
          var spinners = document.querySelectorAll('.ant-spin-spinning, .ant-spin');
          for (var si = 0; si < spinners.length; si++) {
            var st = window.getComputedStyle(spinners[si]);
            if (st.display !== 'none' && st.visibility !== 'hidden') { hasLoading = true; break; }
          }
          if (!hasLoading) break;
          await sleep(200);
        }
        
        // 2. MutationObserver 等 DOM 稳定
        await new Promise(function(resolve) {
          var root = document.querySelector('.order_box').parentElement;
          var stable = null;
          var obs = new MutationObserver(function() {
            if (stable) clearTimeout(stable);
            stable = setTimeout(function() { obs.disconnect(); resolve(); }, 800);
          });
          obs.observe(root, { childList: true, subtree: true, characterData: true });
          stable = setTimeout(function() { obs.disconnect(); resolve(); }, 800);
          setTimeout(function() { obs.disconnect(); resolve(); }, 5000);
        });
      }
      
      return capturedResponse || { __noData: true };
    }, body, BASE, doSearch, !!args.screenshot);
  } catch (error) {
    throw new CommandExecutionError(`site UI query failed: ${error?.message || error}`);
  }
  
  try {
    // ... 数据处理 ...
    return rows.map(mapRow);
  } finally {
    if (args.screenshot) {
      try { await page.screenshot({ path: args.screenshot, fullPage: true }); } catch (_) {}
    }
  }
}
```

**关键点**：
- MutationObserver 必须在同一个 `page.evaluate` 内，紧跟 API 响应捕获之后
- 稳定窗口 800ms（不是 400ms）
- observer 监听目标容器（如 `.order_box.parentElement`），不要监听整个 `#app`

---

## 10 弹窗交互模式

**问题**：行内操作按钮（作废、处理、创建等）点击后会弹出 `.el-dialog` 或 `.el-message-box`，里面包含表单字段和确认/取消按钮。只点击按钮不处理弹窗会导致操作未完成。

**统一模式**：点击按钮 → 等待弹窗 → 填写表单 → 点击确认

```javascript
if (args.void) {
  // 1. 点击行内按钮
  await clickButtonByText(page, '作废');
  await sleep(1000);
  // 2. 在弹窗中填写表单
  await page.evaluate((reason) => {
    const dialog = document.querySelector('.el-dialog, .el-message-box');
    if (!dialog) return;
    const textarea = dialog.querySelector('textarea');
    if (textarea) {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(textarea, reason);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, args.voidReason);
  await sleep(500);
  // 3. 点击确认按钮
  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog, .el-message-box');
    if (dialog) {
      const btn = Array.from(dialog.querySelectorAll('button, .el-button'))
        .find(b => b.innerText?.trim() === '确定' || b.innerText?.trim() === '确认');
      if (btn) btn.click();
    }
  });
  await sleep(2000);
}
```

**前置条件校验**：弹窗表单字段如果是必填的，应在适配器入口处校验参数是否存在：

```javascript
if (args.void && !args.voidReason) {
  throw new ArgumentError('作废操作需要传入 --voidReason（作废理由）');
}
```

---

## 11 弹窗中的互斥单选项

**问题**：部分弹窗包含互斥单选项（radio），选中不同选项会显示不同的输入框，且 placeholder 随选项变化。

**示例**：订单取消管理的"处理"弹窗有两个单选项：
- "同意取消" → textarea placeholder "请输入同意理由(选填)"
- "驳回取消" → textarea placeholder "请输入驳回理由(必填)"

**实现**：选单选项 → 等待 textarea 切换 → 填写对应内容 → 点确认

```javascript
if (args.process) {
  await clickButtonByText(page, '处理');
  await sleep(1000);
  // 1. 选单选项
  await page.evaluate((action) => {
    const dialog = document.querySelector('.el-dialog, .el-message-box');
    if (!dialog) return;
    const radios = dialog.querySelectorAll('.el-radio');
    for (const r of radios) {
      if (r.innerText?.trim() === action) { r.click(); return; }
    }
  }, args.processAction);  // "同意取消" 或 "驳回取消"
  await sleep(500);
  // 2. 填写理由（textarea 的 placeholder 已随选项切换）
  if (args.processReason) {
    await page.evaluate((reason) => {
      const dialog = document.querySelector('.el-dialog, .el-message-box');
      const textarea = dialog?.querySelector('textarea');
      if (textarea) {
        const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(textarea, reason);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, args.processReason);
    await sleep(500);
  }
  // 3. 点击确认
  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog, .el-message-box');
    if (dialog) {
      const btn = Array.from(dialog.querySelectorAll('button, .el-button'))
        .find(b => b.innerText?.trim() === '确认' || b.innerText?.trim() === '确定');
      if (btn) btn.click();
    }
  });
  await sleep(2000);
}
```

---

## 12 信息弹窗返回数据

**问题**：详情、查看原因等按钮点击后弹窗只展示信息，最初只截图没有提取文本返回。

**解法**：提取 `.el-dialog` 的 `innerText` 并作为返回值的一部分：

```javascript
if (args.viewDetail) {
  await clickButtonByText(page, '详情');
  await sleep(2000);
  const detailText = await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog');
    if (dialog && getComputedStyle(dialog).display !== 'none') {
      return dialog.innerText?.trim() || '';
    }
    return '';
  });
  const tableData = await extractTableData(page);
  return { ...tableData, detail: detailText };
}
```

**查看原因类弹窗**（有"确定"按钮关闭）：

```javascript
if (args.viewReason) {
  await clickButtonByText(page, '查看原因');
  await sleep(1000);
  const reasonText = await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog, .el-message-box');
    if (dialog && getComputedStyle(dialog).display !== 'none') {
      const text = dialog.innerText?.trim() || '';
      // 点击确定关闭弹窗
      const btn = Array.from(dialog.querySelectorAll('button, .el-button'))
        .find(b => b.innerText?.trim() === '确定');
      if (btn) btn.click();
      return text;
    }
    return '';
  });
  await sleep(500);
  const tableData = await extractTableData(page);
  return { ...tableData, reason: reasonText };
}
```
