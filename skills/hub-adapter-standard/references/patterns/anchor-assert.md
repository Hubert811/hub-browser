# 锚点断言范式（操作 → 等待锚点 → 断言）

> 适用于所有 UI 交互类适配器（`browser: true`）。核心一句话：**每个交互 = 操作（DOM，人类可见）→ 等待锚点（轮询预期状态出现）→ 断言（observed == 期望，失败带状态报错）**。
> 配套函数：`shared-js/wait-and-state.md` 的 `waitForAnchor` 与 `installRequestCapture`。

---

## 1 为什么：固定 sleep 的竞态

固定 `sleep(1500)` 后继续下一步，是适配器最隐蔽的失败来源：结果渲染快慢取决于网络/后端/浏览器负载，**同一个适配器时好时坏**。

```javascript
// ❌ 反例：固定 sleep（竞态，时好时坏）
await page.insertText('战略');
await sleep(1500);            // 结果可能还没渲染
await clickButtonByText(page, '添加左侧全部字段值'); // 点了空列表，静默失败
```

**关键认知**：「知道下一步会发生什么」= 每个操作之后的**预期状态是可枚举的**。既然可枚举，就用轮询等待它出现，而不是猜时间。

---

## 2 操作 → 等待锚点 → 断言（AAA）

每个交互三步，缺一不可：

1. **操作**：DOM 操作（人类在浏览器中可见）
2. **等待锚点**：轮询等待「预期结果出现的标志」（带超时），锚点函数见 `waitForAnchor`
3. **断言**：比对观察到的状态 == 期望；失败必须**带上观察到的实际状态**报错（而不是笼统超时）

```javascript
// ✅ 正例：锚点轮询
await waitForAnchor(page, `(() => {
  /* 返回 {ok:true, items:[...]} 当搜索结果渲染完成 */
})()`, { desc: '级联搜索结果渲染', timeoutMs: 25000 });
await clickButtonByText(page, '添加左侧全部字段值');
await waitForAnchor(page, `(() => {
  /* 已添加(N) N>=1 */
})()`);
```

`waitForAnchor` 的契约：bodyExpr 在页面/iframe 上下文求值，返回 `{ ok: true, ...observed }` 表示预期状态出现；超时抛 `CommandExecutionError` 并携带最后一次 `observed`。

---

## 3 各组件类型锚点速查表

| 操作 | 锚点（等待出现的标志） | 注意 |
|---|---|---|
| 输入搜索词 | 结果列表项渲染，且**全部叶子项都含搜索词** | 排除 加载中/占位文案；见 pitfalls/search-race.md；「暂无搜索内容」必须同时校验 inputVal(输入没生效 ≠ 无结果) |
| 点添加/勾选 | 计数变化（`已添加(N)` N>=1、勾选数>0） | 不要只信点击成功 |
| 点确定/确认 | 弹层/弹窗关闭 + 主界面值已变化 | 弹窗未关闭=未生效 |
| 设置日期 | 输入框 UI 值 == 期望 | AntD 日历格子点击后读输入值；**跨月时目标格子不在 DOM，先按可见范围字符串比较翻月(prev/next)**；格子点击失败立即报错（静默继续会点成 start==end 错值） |
| 点查询 | loading 出现→消失 + 捕获到页面自身请求 + 表格刷新 | 见 §5 |
| 下载 | downloadWillBegin → downloadProgress completed → 文件落盘 | 先武装下载捕获再点按钮 |

---

## 4 两层断言：UI 值 + 真实值

| 断言面 | 指什么 | 失败模式 | 怎么断言 |
|---|---|---|---|
| **UI 值** | 人看到的控件显示文本 | 值进了状态但没渲染 / 显示旧值 | 读控件显示文本 == 期望 |
| **真实值** | 系统实际用的值（组件状态 → 发出的请求 payload） | 显示对但没进组件状态，页面按默认/旧值查询 | 捕获**页面自己发出的请求**，解析条件 == 期望 |

- 两个断言面互补：只验 UI 会放过"显示对但没生效"；只验真实值会放过"生效了但人看不见"（违背"操作给人类看"）。
- **真实值的最强来源 = 系统自己发出去的那个请求**。拦截到它，等于拿到「系统认为当前筛选是什么」的答案。

### 4.1 断言语义必须随筛选语义变（关键词模式）

筛选语义改了，断言语义必须跟着改（order-detail 实证 2026-08-27）：enum 大列表字段走
关键词搜索范式（`patterns/keyword-select.md`）后，用户传的是**关键词**而非精确值，页面
实际加选的是全部匹配项——断言从「精确值 ∈ 条件值」变为：

```javascript
// ① 条件解析必须拆正向/排除——notIn（出厂排除默认）不算命中，
//    否则关键词「关联」会被排除条件「关联方」假阳性命中
if (/^not/i.test(String(c.functionalOperator))) negValues.push(...vals);
else posValues.push(...vals);

// ② 关键词只需命中正向条件值
const hit = posValues.some((x) => String(x).includes(kw));
```

同理 UI 面断言也从「字段显示文本 == 目标值」放宽为「显示文本含至少一个匹配项」。
语义不跟着变就会全部假阴性——这不是断言器 bug，是契约变了。


---

## 5 页面自身 API 取数（page-owns-query）

数据必须来自页面自身的 API，而不是：
- ❌ 从 DOM 解析数据（脆弱、与展示耦合）
- ❌ 适配器自己凭空构造请求体（会与页面实际查询分叉，UI 与数据不一致）

正确姿势（页面自己查询 + 捕获 + 重放）：

```
1. DOM 设置筛选（人类可见）
2. 安装请求捕获（installRequestCapture：iframe fetch 补丁主 + CDP 次）
3. 点查询
4. 捕获页面自己发出的 olapQueryParam（真实值断言：条件 == 期望）
5. 用页面自己的 payload 改 offset/limit 分页取全量数据 → 条件与页面所见天然一致
```

这同时满足「API 拿数据」和「操作给人类看」，并从结构上消灭 UI/数据分叉。通道选择详见 `pitfalls/network-capture.md`。

---

## 6 幂等操作

每个筛选操作都要**幂等**：操作前先读当前状态，已是目标值则直接跳过。

```javascript
// 反例：阶段默认就是 直销TGO，无条件再点一次 → 把默认值 toggle 掉了 → DOM 变空
// 正例：
const cur = await readCurrentValue(page);
if (cur && cur.includes(target)) return { unchanged: true }; // 已达标，跳过
// 否则：open → search(锚点) → select(锚点) → confirm(锚点)
```

幂等同时是 persistent 会话（复用标签页、不 reload）的前提：重复运行同一参数必须安全。

---

## 7 禁止兜底掩盖失败

**任何硬编码兜底（如把业务枚举写死为默认值）都会掩盖 DOM 失败**：API 数据"看似成功"，实际页面显示的和返回的数据不一致，调用方完全不知道。

- 字段值必须来自控件**实际选中值**；取不到（没搜出结果/没选上）就**明确报错**并带上观察到的状态。
- 原则：宁可失败得难看，不可成功得虚假。

---

## 8 完整示例（quickbi tgo-detail 流程）

```javascript
// 1) 锚点筛选（每步 waitForAnchor）
await fillCreateTimeRange(page, start, end);      // 锚点：输入框值 == start/end
const cascade = await fillCascadeSelect(page, '销售团队-销售大区', keyword); // 锚点链
await ensureStageType(page, stageType);          // 幂等：已是目标值跳过

// 2) 页面自身查询 + 真实值断言
const capture = await installRequestCapture(page, { urlPattern: "/olap/" });
await clickQueryButton(page);
const req = await capture.waitFirst();
assertRequestConditions(req.body, { start, end, teams, stageType }); // 真实值断言

// 3) 用页面自身 payload 分页取数
const { rows, total } = await fetchRowsByPayload(page, req.body, limit);
```
