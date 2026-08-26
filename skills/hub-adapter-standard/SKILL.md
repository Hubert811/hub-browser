---
name: hub-adapter-standard
description: "hub 适配器编写规范与标准。当需要创建 hub 适配器时使用，提供强制规范、元素定位策略和测试清单。配合官方 skill hub-adapter-author 一起使用。"
---

# hub 适配器编写标准

> 本标准是 hub 适配器的**强制规范**，每条都必须满足。
>
> **使用方式**：先加载官方 skill `hub-adapter-author` 进行适配器生成的标准流程（recon → field decoding → coding → verify），然后**严格按照本标准**作为标准和验收要求来编写和检查适配器代码。本标准在 hub-adapter-author 的基础上，针对实际业务场景中常见的筛选字段、按钮、弹窗、截图等问题做了细化约束。
>
> **参考文件**：`references/` 目录下提供了详细实现范式和工具函数模板：
> - `shared-js/overview.md` — 公共函数库总览：设计原则 + 官方已有函数 + 待实现候选清单
> - `shared-js/input-and-click.md` — 输入与点击类公共函数（10 个，完整实现）
> - `shared-js/wait-and-state.md` — 等待与状态类公共函数（7 个，完整实现）
> - `shared-js/eval-helpers.md` — EVAL 代码块常量（setVal 等）+ 适配器标准结构模板
> - `patterns/filter-input.md` — 5 种筛选字段输入范式（文本、可搜索下拉、多选、日期范围、批量输入），Element Plus vs Ant Design 对比
> - `patterns/element-location.md` — 元素定位策略：DOM 结构差异、下拉可见性检查、选项模糊匹配、隐藏字段展开
> - `patterns/button-actions.md` — 按钮前置条件、行内操作、弹窗交互、输出字段限制、截图时机
> - `patterns/implementation-patterns.md` — 策略选择（契约分级）、page.evaluate 使用模式、SPA 加载、错误处理、Vue 状态操作、stub 检测
> - `pitfalls/filterable-select.md` — 可搜索下拉固定等待 flaky 的轮询修复方案
> - `pitfalls/micro-frontend.md` — 微前端框架（wujie/qiankun）proxy 拦截坑点与 safeEval 兜底
> - `patterns/anchor-assert.md` — 锚点断言范式：操作→等待锚点→断言（AAA）、两层断言（UI 值+真实值）、页面自身 API 取数、幂等、禁止兜底
> - `pitfalls/evaluate-return.md` — page.evaluate 返回值丢失（块体不隐式返回）
> - `pitfalls/search-race.md` — 可搜索下拉：搜索竞态与「暂无结果」瞬态误判
> - `pitfalls/iframe-window-context.md` — iframe 上下文：window 指顶层
> - `pitfalls/network-capture.md` — 网络捕获通道：自带收集器无 postData、CDP 在 portal iframe 上不可靠、patch 主+CDP 次
> - `pitfalls/escaping-ladder.md` — 模板字符串/正则的跨层转义阶梯
> - `pitfalls/verify-timeout.md` — hub browser verify 30s 子进程上限
>
> 编写适配器时，应根据目标站点的技术栈和具体场景，主动查阅 `references/` 下的相关文件获取可直接复用的代码范式和解决方案。

---

## 0. 与官方 skill 的关系

| 维度 | hub-adapter-author（官方） | 本标准 |
|------|-------------------------------|--------|
| 定位 | 通用适配器创作流程指南 | 适配器的强制规范 |
| 覆盖范围 | recon → 字段解码 → 编码 → verify 全流程 | 筛选字段、按钮、弹窗、截图、命名等具体要求 |
| 使用顺序 | 先用 hub-adapter-author 做 recon 和框架搭建 | 再用本标准细化实现并通过验收清单 |

**工作流**：
1. **观察先行**：在真实浏览器逐步操作，对每个交互组件建立「操作→锚点→真实值」规格表（锚点=操作后轮询等待的预期状态，真实值=页面自己发出的请求 payload；等价于 MCP 观察通道，详见 `patterns/anchor-assert.md`）；再调用 `/hub-adapter-author` 进行页面探索和适配器骨架生成
2. 基于 `references/shared-js/eval-helpers.md` 的适配器标准结构创建站点的 shared.js，按 UI 框架调整选择器默认值
3. 按本标准的 10 条规范细化每个筛选字段、按钮、弹窗交互
4. 按本标准的测试清单逐项验收（配合 `hub browser verify <site>/<name>` 自动验收）
5. 输出覆盖报告（见下方"覆盖报告"章节），供用户检查覆盖完整性

---

## 1. 筛选字段全部覆盖

页面上的每一个筛选字段都必须参数化，用户可通过命令行独立传入。

- **文本输入框**：通过 placeholder 匹配定位，用 shared.js 的 `fillInput`（execCommand + native setter + `_value` 修复）填值
- **可搜索下拉框**：用 shared.js 的 `fillFilterableSelect`（输入文本 → 等待选项 → 点击匹配项）
- **普通下拉框**：用 shared.js 的 `clickDropdownOption`（打开下拉 → 匹配选项 → 点击选中）
- **多选下拉框**：用 shared.js 的 `fillMultiSelect`（打开下拉 → 逐个点击匹配选项 → 关闭）
- **日期范围选择器**：用 shared.js 的 `fillDateRange`（native setter + Enter 确认）
- **无值不操作**：用户不传某个字段时跳过该字段，保持默认值
- **隐藏字段展开**：用 shared.js 的 `expandHiddenFields`，在 `resetFilters` 后自动执行

- **锚点等待（强制）**：每个筛选操作必须「操作 → 轮询等待预期状态出现（锚点）→ 断言」，禁止固定 sleep（函数：`waitForAnchor`，范式：`patterns/anchor-assert.md`）。
- **幂等（强制）**：操作前先读当前值，已是目标值则跳过，避免重复点击把默认值 toggle 掉。
- **两层断言（强制）**：UI 值（控件显示文本）+ 真实值（页面实际请求 payload）都要校验（见 `patterns/anchor-assert.md` §4）。

所有筛选字段值**必须在页面上可见**（人类能在浏览器中看到输入的值）。

工具函数实现详见 `references/shared-js/`，输入范式详见 `references/patterns/filter-input.md`。

---

## 2. 所有按钮全覆盖

页面上的所有按钮（除跳转到其他 URL 的）都必须参数化，用户可通过命令行触发。

- **导出类按钮**（订单导出、详情导出等）：需配合筛选字段使用，适配器入口处校验前置条件
- **表单弹窗按钮**（作废、处理、创建等）：点击 → 等待弹窗 → 填写表单 → 点击确认
- **信息弹窗按钮**（详情、查看原因等）：点击 → 提取弹窗文本 → 作为返回值返回
- **下载类按钮**（下载结果等）：点击触发下载
- **直接跳转按钮**（批量快捷操作等）：点击跳转

按钮后的动作（表单填写、确认点击、信息提取等）必须参数化实现，不能只点击按钮不处理后续。

弹窗表单的必填字段应在适配器入口处做前置条件校验，未传入时抛出 `ArgumentError`。

详细实现范式见 `references/patterns/button-actions.md`。

---

## 3. 跳转 URL 的按钮/链接生成新适配器

如果按钮或链接点击后会跳转到一个新的 URL（如进入详情页、编辑页），不在当前适配器内处理，而是为该 URL 生成一个独立的适配器。

**判断规则**：点击后 URL 发生变化 → 新建适配器；点击后弹出对话框（URL 不变）→ 在当前适配器内处理。

---

## 4. 分页参数

如果筛选出来的数据有分页，适配器必须有分页参数：

```javascript
{ name: 'page',     type: 'int', default: 1,  help: '页码（默认 1）' },
{ name: 'pageSize', type: 'int', default: 10, help: '每页条数（默认 10）' },
```

---

## 5. finally 截图（UI 交互类适配器，可选）

`browser: false` 的纯取数适配器（Node-side fetch 直接取数）**不需要截图**。`browser: true` 的 UI 交互类适配器（点击、填表、弹窗等）建议截图：成功/失败都截，失败时保留页面现场供人排查。

需要时在适配器内加可选 `--screenshot` 参数，`finally` 中调用 `handleScreenshot`：

```javascript
args: [
  // ... 其他参数 ...
  { name: 'screenshot', type: 'string', default: '', help: '执行完毕后截图保存路径 (可选)' },
],

func: async (page, args) => {
  try {
    // ... 业务逻辑 ...
  } catch (e) {
    // ... 错误处理 ...
  } finally {
    await handleScreenshot(page, args.screenshot);
  }
}
```

调试期也可以不内置参数，直接用 `hub browser <session> screenshot` 截取当前页面。

---

## 6. 导出前置条件检查

导出类按钮（订单导出、详情导出等）通常需要先筛选数据。不同页面要求的筛选字段不同，适配器应在入口处校验：未传入筛选字段时直接抛出 `ArgumentError`，不要等到点击导出按钮后才发现系统报错。

```javascript
const needsExport = args.export || args.detailExport;
const hasExportFilter = args.orderNumber || args.customerName;
if (needsExport && !hasExportFilter) {
  throw new ArgumentError(
    '导出操作需要先筛选数据：请传入 --orderNumber 或 --customerName'
  );
}
```

---

## 7. 筛选操作通过 shared.js 函数完成

适配器应调用 shared.js 的 Node.js 层函数完成筛选操作，不内联 DOM 操作代码。

**设计原则**：
- 一个字段对应一次 shared.js 函数调用（如 `fillInput`、`fillFilterableSelect`、`fillDateRange`）
- shared.js 函数内部封装 `page.evaluate`，可能多次调用
- 允许在一次 `page.evaluate` 中完成多个同类操作（如填 5 个文本输入框），只要使用 `EVAL_HELPERS_CODE` 注入辅助函数
- 避免多次 CDP 往返导致下拉菜单关闭、焦点丢失等 DOM 状态问题

```javascript
// 适配器内调用 shared.js 函数（推荐）
if (args.orderNumber) {
  await fillInput(page, 'input[placeholder*="订单编号"]', args.orderNumber);
}
if (args.customerName) {
  await fillFilterableSelect(page, '客户名称', args.customerName);
}
if (args.createTimeFrom || args.createTimeTo) {
  await fillDateRange(page, '创建时间', args.createTimeFrom, args.createTimeTo);
}
```

如果适配器有特殊需求需要内联 `page.evaluate`，应注入 `EVAL_HELPERS_CODE` 获取 `setVal`/`closeAllDropdowns`/`getVisibleOptions`/`matchOption` 辅助函数。

详细模式说明见 `references/patterns/implementation-patterns.md`，工具函数见 `references/shared-js/`。

---

## 8. 弹窗交互完整实现

按钮点击后弹出的对话框要完整处理：

**表单弹窗**（作废、处理、创建等）：
1. 点击行内按钮
2. 等待弹窗出现
3. 填写表单字段（textarea/input/select）
4. 点击确认按钮（确定/确认）

**信息弹窗**（详情、查看原因等）：
1. 点击行内按钮
2. 等待弹窗出现
3. 提取弹窗的 `innerText`
4. 作为返回值返回（如 `{ ...tableData, detail: "详情文本" }`）
5. 如有"确定"按钮则点击关闭

**互斥选项**（radio）：
1. 点击行内按钮
2. 根据参数选择对应的单选项
3. 等待输入框切换（placeholder 随选项变化）
4. 填写对应内容
5. 点击确认

详细实现范式见 `references/patterns/button-actions.md`。

---

## 9. 适配器命名规范

适配器文件名 = URL 路径，`/` 替换为 `-`，去掉前导 `/`。

| URL 路径 | 适配器文件名 |
|---------|------------|
| `/v2/orderList` | `v2-orderList.js` |
| `/orderManage/pdfOrder` | `orderManage-pdfOrder.js` |
| `/operation/materialManage` | `operation-materialManage.js` |

一个网页一个适配器。基础设施文件：`login.js`（登录）、`shared.js`（公共工具函数）。

---

## 10. 数据来源与真实值断言（强制）

数据必须来自**页面自身的 API**，UI 与数据不允许分叉：

1. **数据来源**：捕获页面自己发出的请求（`installRequestCapture`，patch 主 + CDP 次）→ 解析 payload → 用页面自己的 payload 分页取数。
2. **禁止**：从 DOM 解析数据（脆弱、与展示耦合）；适配器凭空构造请求体（会与页面实际查询分叉）。
3. **真实值断言**：捕获的请求条件必须 == 期望（日期区间/团队列表/阶段等），不一致抛 `CommandExecutionError` 并带上实际条件。
4. **禁止兜底掩盖失败**：字段值必须来自控件实际选中值，取不到就报错（宁可失败得难看，不可成功得虚假）。
5. 范式与示例见 `patterns/anchor-assert.md` §4-5。

## 11. 测试数据规范

测试适配器时，**必须使用系统中已存在的真实数据**，不要编造或使用明显不存在的测试值。

- **先查后测**：测试前先通过无筛选查询（或页面肉眼观察）获取系统中已有的数据样本（如真实的订单编号、客户名称等），用这些真实值作为测试输入
- **多组数据**：每个筛选字段至少用 2 组不同的真实数据测试，确认适配器在不同输入下都能正确返回结果
- **避免重复错误**：如果某组数据返回错误结果，换一组真实数据再测，区分"适配器逻辑错误"和"该数据本身无匹配结果"
- **空结果 ≠ 适配器错误**：用不存在的值测试返回空是正常的；用真实存在的值测试返回空才是 bug

```bash
# 示例：先无筛选查询拿到真实数据
hub <site> <command> --pageSize 5

# 从返回结果中提取真实的订单编号、客户名称等
# 再用这些真实值做筛选测试
hub <site> <command> --orderNumber "真实订单号"
hub <site> <command> --customerName "真实客户名"
```

---

## 测试清单

新适配器完成后，逐项测试：

> **自动验收优先**：先跑 `hub browser verify <site>/<name>`（配合 fixture：patterns / notEmpty / rowCount），再按下表人工抽查。

- [ ] 无筛选查询（返回默认数据）
- [ ] 每个文本输入字段单独测试（使用系统中已有的真实数据）
- [ ] 每个可搜索下拉单独测试（使用系统中已有的真实数据）
- [ ] 每个多选下拉单独测试（使用系统中已有的真实数据）
- [ ] 每个日期范围单独测试（注意：部分系统要求时间范围不超过一定期限，超过会触发错误弹窗并回退到默认范围）
- [ ] 字段组合测试（至少 3 种组合，使用不同真实数据）
- [ ] 导出按钮无筛选（应报错）
- [ ] 导出按钮有筛选（应成功）
- [ ] 批量操作按钮
- [ ] 行内操作按钮（如查看详情）
- [ ] 截图验证（UI 交互类适配器：成功/失败均截图）
- [ ] 认证失败处理
- [ ] 空结果处理（用不存在的值测试确认空结果行为正确）
- [ ] 多组数据验证（每个字段至少 2 组不同真实数据，排除偶发错误）
- [ ] **筛选字段值在页面上可见**（人类能在浏览器中看到输入的值）
- [ ] **真实值断言**（捕获的页面自身请求条件 == 期望，UI 与数据一致）
- [ ] **幂等/重复运行**（同一参数连续跑 2 次，第二次不破坏已设置状态）
- [ ] **页面自身请求捕获**（查询后能拿到 payload，而非自造 body）

---

## 覆盖报告

适配器生成完毕后，**必须输出覆盖报告**，让用户对照页面检查适配器是否覆盖全。报告格式如下：

```
## 适配器覆盖报告

### 基本信息
- 适配器名称：<name>
- 文件名：<filename>.js
- 页面 URL：<url>
- 站点：<site>

### 筛选字段覆盖
| 页面字段名 | 参数名 | 类型 | 备注 |
|-----------|--------|------|------|
| 订单编号 | orderNumber | string | 文本输入 |
| 客户名称 | customerName | string | 可搜索下拉 |
| 订单状态 | orderStatus | string | 多选下拉，逗号分隔 |
| 创建时间 | createTimeFrom / createTimeTo | string | 日期范围 |
| ... | ... | ... | ... |

### 按钮覆盖
| 页面按钮名 | 参数名 | 类型 | 动作类型 | 前置条件 |
|-----------|--------|------|---------|---------|
| 订单导出 | export | boolean | 导出 | 需传入 orderNumber 或 customerName |
| 作废 | void | boolean | 表单弹窗 | 需传入 voidReason |
| 详情 | viewDetail | boolean | 信息弹窗 | 无 |
| 批量快捷操作 | batchOp | boolean | 跳转 | 无 |
| ... | ... | ... | ... | ... |

### 弹窗表单字段覆盖
| 触发按钮 | 弹窗内字段 | 参数名 | 必填 | 备注 |
|---------|-----------|--------|------|------|
| 作废 | 作废理由 | voidReason | 是 | textarea |
| 处理 | 处理动作 | processAction | 是 | 互斥单选（同意取消/驳回取消） |
| 处理 | 处理理由 | processReason | 视选项而定 | textarea，placeholder 随选项变化 |
| ... | ... | ... | ... | ... |

### 跳转按钮（未覆盖，需新建适配器）
| 页面按钮名 | 目标 URL | 说明 |
|-----------|---------|------|
| 查看详情 | /v2/orderDetail?id=xxx | 需新建 orderDetail 适配器 |
| 编辑 | /orderManage/edit?id=xxx | 需新建 edit 适配器 |
| ... | ... | ... | ... |

### 其他参数
| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| page | int | 1 | 页码 |
| pageSize | int | 10 | 每页条数 |
| screenshot | string | '' | 截图保存路径（UI 交互类可选） |

### 输出结构
columns: ['orderInfo', 'customerInfo', 'deliveryInfo', 'amountInfo']
- orderInfo: { orderNumber, createTime, orderStatus }
- customerInfo: { customerName, customerCode, invoiceTitle }
- deliveryInfo: { deliveryStatus, receivingStatus }
- amountInfo: { orderAmount, currencySymbol }

### 真实值断言
说明该适配器如何校验 UI 与数据一致：捕获的页面自身请求条件（如日期区间/团队列表/阶段）== 期望，从结构上消灭 UI/数据分叉。

### 未覆盖项及原因
| 页面元素 | 原因 |
|---------|------|
| <元素名> | <为什么没覆盖，比如：纯展示无交互 / 需要特殊权限 / ...> |
```

**报告要求**：
- **筛选字段**：列出页面上所有筛选字段，包括隐藏字段（需展开后才能看到的），不能遗漏
- **按钮**：列出页面上所有按钮，标明动作类型和前置条件
- **弹窗表单字段**：按钮点击后弹窗内的表单字段也要列出，包括互斥单选项
- **跳转按钮**：明确列出哪些按钮因跳转 URL 而未覆盖，并给出目标 URL，提示需要新建适配器
- **未覆盖项**：页面上存在但未参数化的元素都要列出并说明原因，不能省略
- **输出结构**：列出 columns 和返回值结构，让用户确认数据分组是否合理