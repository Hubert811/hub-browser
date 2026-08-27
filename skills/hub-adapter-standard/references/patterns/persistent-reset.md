# persistent 适配器的初始状态复位(三级复位)

> 来源:QuickBI quote-detail 攻坚(2026-08-27),R1/R2/R3 全部落地并端到端验证。
> 适用:`siteSession: 'persistent'` 的适配器(复用同一 tab 的所有命令)。

## 为什么必须复位

persistent 复用同一 tab,上一次执行(或中途失败)留下的状态会进入下一次执行:

| 残留类型 | 后果 | 实证 |
|---|---|---|
| 字段残留值 | 上次设了 `--rowStatus Sales已报价`,本次未传该参数——期望「未传=不筛选」,页面仍按旧值过滤,结果错 | 残留 成交Y+客户名+目录双值 与新条件叠加出 0 行假空 |
| 弹层残留 | popup 未关,遮挡页面且下次打开时 toggle 反向关闭 | 弹层重挂载成空壳 |
| 焦点残留 | input 仍聚焦,影响后续 mouse 事件语义 | — |
| DOM 假值 | 粘贴类失败留下「值在 DOM、state 未收」,骗过 input.value 幂等检查 | 幂等假阳性跳过 fill |
| 页面僵死 | JS 主线程卡死,evaluate 挂起,任何操作都是叠加故障 | 僵死页上连续误诊 |

## 三级复位策略

**每次执行开始时,reset 先于一切 fill**:

```
R1 字段级复位(每字段 fill 函数内置,默认级)
   - 打开控件前:若弹层残留 → 点「取消」关闭(锚点:无可见 popup)
   - 幂等检查:字段当前值 vs 目标值,一致才跳过
     · 检查必须是「双向集合相等」,不是「目标 ⊆ 字段」——
       字段=目录内,目录外 vs 目标=[目录外] 时子集成立但并集错
   - 不一致 → 清空后重选(先点「清空」/clear icon,锚点已添加(0)/值清空)

R2 面板级复位(fill 前统一执行,保证「未传 = 不筛选」语义)
   - 遍历查询面板全部字段:
     · 本次传了目标值的字段 → 交给 fill(含 R1)
     · 本次未传的字段 → 若页面有残留值则清空
   - 锚点:每个被清空字段显示占位符(「请选择…」/空 input)
   - 产物:页面筛选状态 == 本次入参的精确投影

R3 页面级复位(最后手段,自动降级)
   - 触发:fill 链前活性探测失败(eval 挂起/主 frame 1+1 探针超时)
   - 动作:goto 重载 → dashboard 就绪锚点(字段列表渲染)→ 重新走 R2/R1
   - 代价:数秒,只在前两级失败时使用
```

### 复位的时序位置

```
命令开始 → 空间绑定(tab 复用) → R3 活性探测
  → 活性 OK → R2 面板级复位 → R1 逐字段 fill → 查询 → network 断言 → 取数
  → 活性挂 → goto 重载 → dashboard 就绪锚点 → R2 → R1 → …
```

## 落地范式(可直接复用)

### R3:ensurePageAlive(shared.js 通用件)

```javascript
export async function ensurePageAlive(page, reloadUrl) {
  let alive = false;
  try { alive = (await page.evaluate('1+1')) === 2; } catch (_) {}
  if (!alive && reloadUrl) {
    try { await page.goto(reloadUrl); } catch (_) {}
    return false; // 调用方的 waitForDashboard 锚点链兜底就绪等待
  }
  return true;
}
```

### R2:resetPanelResidue(每适配器定制)

```javascript
async function resetPanelResidue(page, args) {
  // 单选:未传但字段非空 → hover+clear icon 清除(antd 惯例:mouseenter 才挂载 clear)
  if (!String(args.dealFlag || '').trim()) await clearSingleSelect(page, F_DEAL);
  // 文本:未传但 input 有值 → native setter 置空(见 input-channels.md)
  if (!String(args.customerName || '').trim()) await clearCustomerName(page);
  // enum:未传但字段有值 → 独立的 clearEnumSelect(开弹层→清空→确定→锚点验证已空)
  for (const ef of ENUM_FIELDS) {
    if (String(args[ef.arg] || '').trim()) continue;
    // 探测字段有值才清(避免空转)
    if (await fieldHasValue(page, ef.label)) await clearEnumSelect(page, ef.label);
  }
}
```

> **清空 no-op 陷阱(order-detail 实证 2026-08-27)**:「调 fill 函数传空列表」≠清空。
> fillEnumMultiSelect 的第一行就是 `if (list.length === 0) return`——空列表直接
> 返回,弹层根本不开,清空从未执行,而且**没有任何报错**(静默假成功)。本文件
> 早期版本就写着「用 fill 函数的空 list 流程」,从 quote-detail 抄到 order-detail
> 才暴露。清空必须独立实现:开弹层 → 点「清空」(已添加>0 时) → 确定 →
> **锚点验证字段显示文本确实为空**。

### R2 例外语义

带出厂默认值的字段(如 QuickBI 清单类型)未传时**保持默认**(报表作者意图,reload 后仍在),不清——除非用户显式传空。

### 幂等检查的正确写法

```javascript
// ✅ 双向集合相等
const curSet = String(text).split(/[,，]/).map(x => x.trim()).filter(Boolean);
const same = !isPlaceholder && curSet.length === list.length && list.every(v => curSet.includes(v));

// ❌ 子集检查:字段=目录内,目录外 vs 目标=[目录外] → 假阳性跳过,按并集跑,结果错
const bad = list.every(v => text.includes(v));
```

## 验证清单(persistent 专用)

- [ ] 连续跑两个不同筛选组合的 case,第二个 case 的结果**不含第一个 case 的残留条件**
- [ ] 无参默认 case 跑在「有残留的页面」上,结果与干净页面一致
- [ ] 中途失败(如锚点超时)后再跑,状态自愈
- [ ] 幂等重跑同参数,结果一致且耗时显著低于首跑
- [ ] tab 数恒定(复用而非新开)——配合引擎 v0.2.9+ 的 origin 复用与 targetId 匹配
