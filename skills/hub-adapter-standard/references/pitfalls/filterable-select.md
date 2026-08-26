# 可搜索下拉（Filterable Select）固定等待 flaky 坑点

> `fillFilterableSelect` 中使用固定 `sleep()` 等待远程搜索结果不可靠，API 响应慢时下拉选项未加载完成，导致筛选静默失效。

---

## 问题现象

`--customerName` 等可搜索下拉筛选参数传入后，下拉未能正确选中目标选项，查询返回了未筛选的数据（所有客户的数据而非指定客户）。同一命令有时能正常工作，有时失败——典型的 flaky 行为。

## 根因

`fillFilterableSelect` 函数在输入搜索文本后使用固定 `await sleep(600)` 等待远程搜索结果加载。当 API 响应慢时（服务器负载高、网络延迟），600ms 内下拉选项尚未渲染完成，`getVisibleOptions()` 返回空数组，函数静默放弃（仅关闭下拉），导致筛选未生效。

## 修复方案

### 1. 轮询替代固定等待

将 `sleep(600)` 替换为轮询循环：

```javascript
// 轮询等待下拉选项加载（固定 sleep 不可靠）
for (let attempt = 0; attempt < 20; attempt++) {
  await sleep(300);
  var opts = getVisibleOptions();
  if (opts.length > 0) break;
  // 检查是否仍在加载
  var loading = doc.querySelector('.el-select-dropdown__loading, .el-icon-loading');
  if (!loading && attempt > 2) break;
}
```

- 每 300ms 检查一次，最多等待 6 秒
- 检查 `.el-select-dropdown__loading` 和 `.el-icon-loading` 判断是否仍在加载
- 选项出现后立即继续，不浪费时间

### 2. 2 次重试

如果第一次搜索未匹配到选项，清空输入重试一次：

```javascript
for (let retry = 0; retry < 2; retry++) {
  setVal(input, value);
  // 轮询等待...
  var opts = getVisibleOptions();
  for (var i = 0; i < opts.length; i++) {
    if (matchOption(opts[i], value)) { click(opts[i]); await sleep(300); return; }
  }
  // 未匹配，清空重试
  setVal(input, '');
  await sleep(300);
}
closeAllDropdowns();
```

### 3. 改进下拉打开方式

优先点击 `.el-select__wrapper`（比 `input.click()` 更可靠地触发 Vue 点击事件打开下拉）：

```javascript
var wrapper = select.querySelector('.el-select__wrapper');
if (wrapper) {
  wrapper.click();  // 比 input.click() 更可靠
} else {
  input.focus();
  input.click();
}
```

## 通用性

此坑点适用于所有使用 `fillFilterableSelect` 且有远程搜索行为的适配器（Element Plus 和 Ant Design 站点均可能遇到）。不限于特定站点。

## 验证建议

修复后对真实数据的可搜索下拉字段连续运行多次（如 10 次），确认每次都正确选中目标选项，排除偶发 flaky。
