# 时序与断言陷阱(Timing & Assertion Pitfalls)

> 来源:QuickBI quote-detail 攻坚(2026-08-27)。全部实证,每条都付过学费。
> (模板字符串正则双转义条已并入 `escaping-ladder.md` 统一讲,此处不重复。)

## 1. 「列表可见 ≠ 可交互」——早点击静默丢失

**现象**:enum 弹层刚渲染完就点选项,点击**静默丢失**——已添加计数不增、selected 类
不变、无任何报错。曾误诊为「点一个变两个勾」,实为污染状态乱象(幂等假阳性跳过
fill + 残留勾选)。

**对策**:**勾选证据锚点**——点选项后必须锚定「已添加(N) 计数真实增加」,不增重试一次:

```javascript
const anchorChecked = `
(() => {
  const popup = Array.from(d.querySelectorAll('.advance-select-popup')).find((p) => p.offsetParent !== null);
  if (!popup) return { ok: false, observed: 'popup-closed' };
  const m = (popup.innerText || '').match(/已添加\\\\((\\\\d+)\\\\)/);
  const n = m ? Number(m[1]) : -1;
  return n >= ${JSON.stringify(expectedCount)} ? { ok: true, added: n } : { ok: false, observed: 'added=' + n };
})()`;
try {
  await waitForAnchor(page, anchorChecked, { desc: '勾选证据: ' + val, timeoutMs: 6000 });
} catch (_) {
  await dashEval(page, pickExpr); // 重试一次
  await waitForAnchor(page, anchorChecked, { desc: '勾选重试: ' + val, timeoutMs: 8000 });
}
```

**通用原则**:每次「点选」后锚定**组件 state 的行为证据**(计数变化/勾选类/值标签
渲染),「列表出现」只是可交互的必要条件。

## 2. toggle 语义触发器——打开前必须探测当前态

**现象**:enum 触发器(箭头 icon)是 **toggle**——弹层已开时再点会关掉它;且关闭动画
中被点击会让弹层重挂载成「左侧列表空壳」坏态(右侧面板静态文案在、选项 0 个)。

**对策**:
- 打开前探测:弹层已开 → 先点「取消」+ 锚点[完全关闭],再走打开
- 「就绪」锚点必须含**左侧列表非空**(≥1 项;注意二元字段可能只有 2 项,阈值别写 ≥3)
- 空壳弹层直接点选项必然 no-option——看到 opts=0 就该怀疑这个坏态

## 3. 禁止长驻 evaluate——CDP 60s 单命令超时

**现象**:把 Node 侧的等待循环(等 loading 消失)塞进单次 `Runtime.evaluate` 的
async IIFE,页面忙时该命令应答超过 CDP 单命令超时(60s)直接炸
`CDP request timeout: Runtime.evaluate`——waitForTableSettled 曾因此 61.9s 必败。

**对策**:所有等待循环一律 **Node 侧分片轮询**——每片 evaluate 只做瞬时探测,
循环聚合在 Node:

```javascript
// ❌ 长驻:单次 evaluate 内 while 循环 + sleep
// ✅ 分片:每片瞬时探测,Node 侧循环
while (Date.now() < deadline) {
  const r = await dashEval(page, probeExpr); // 只读当前 loading 态,立即返回
  if (r && r.loading) { sawLoading = true; await sleep(300); continue; }
  if (!r.loading && sawLoading) break;
  await sleep(400);
}
```

## 4. 断言器假阴性——冤枉无辜的 fill 链

**现象**:存在性断言只收集单一操作符(`in`),而 condition-input 类字段提交
`equalTo`——页面查询条件明明带着值,断言器却报「筛选值未生效」。连锁代价:误判
整条 fill 链有 bug、把 insertText 通道错判死刑、换了三条通道反复折腾。

**对策**:
- 存在性断言的值集合 = **所有非日期条件 args 的 value 并集**,不筛 functionalOperator
- **调试断言失败时第一步审计断言器本身**,第二步才动实现
- 断言失败先做一件事:用与断言器**不同源的通道**(独立 CDP 监听/spy 脚本)看原始事实

## 5. 锚定面可信度分级

同一「值已生效」在不同层面可信度不同:

```
network requestBody(页面实际发出的查询条件)   ← 终局断言锚定这里
  > 组件 state 行为证据(选项渲染/已添加计数/值标签)
    > DOM input.value(受控组件可能假阳性:粘贴留值、state 未收)
```

**真实值断言范式**(查询类适配器标配):捕获页面自身发出的查询请求,断言
requestBody 中的条件与期望完全一致,才允许取数。DOM 值锚点只做中间检查。

## 6. CDP postData 不内联——与「事件不送达」是两个不同的坑

> 姊妹篇:`network-capture.md` 讲的是「requestWillBeSent 事件在 portal iframe 上
> 可能根本不送达」;本条讲的是**事件到了,但 `request.postData` 字段可能不内联**
> (与网络/请求大小相关)——依赖内联 postData 的解析会时好时坏。

**对策**:捕获逻辑对 postData 为空的请求用 `Network.getRequestPostData` 补拉:

```javascript
if (!r.postData) {
  const pd = await send('Network.getRequestPostData', { requestId: r.id }, 5000);
  r.postData = (pd && pd.postData) || '';
}
```

## 7. 静默不发请求的三种病因——先分清再动手

**现象**:网络异常时页面**静默**——按钮 enabled、无遮罩、无报错,点查询不发任何
olap POST;枚举值接口失败后弹层列表 idle 态空列表(非 loading)。曾误判为平台限流,
实际是网络抖动,恢复后一切正常。

order-detail 实证(2026-08-27)又拆出两种「点查询无请求」的独立病因:

| 病因 | 特征 | 对策 |
|---|---|---|
| 网络抖动 | 重试/网络恢复后自愈 | 短窗重试一次再怀疑页面 |
| 前端查询状态机卡死 | reload **可恢复**;连续多次查询后出现 | 短探×2 → R3 reload+重走 fill(自动降级) |
| 渲染挂死(reload 无效型) | reload 后 iframe 仍空壳;**人工点其他报表 tab 再切回才恢复** | **等够即失败**,错误消息里把人工恢复手段告诉用户 |

**诊断口诀**:点击后 N 秒无任何请求 → 先重试一次排除网络;reload 后仍不发请求
→ 状态机卡死走 R3;reload 后**页面本身都渲染不出来** → 渲染挂死,不要无限重试,
不可靠的人工恢复路径(切 tab)不进适配器——把决策留给人。

## 8. 多组件仪表盘——捕获必须按组件过滤

点一次「查询」会发**多个组件**的请求(明细表+富文本统计卡)。`waitFirst` 必须带
matchFn(如 componentName 含「询报价明细」),否则捕获到别的组件的响应,列映射全错。

## 9. 渲染挂死态:检测面选错会把「慢」判成「死」

order-detail 实证(2026-08-27):reload 后 iframe 45s `innerText` 仍空,但同帧
`readyState=complete`、`documentElement.outerHTML` 111KB、body 子节点 7 个、
spinner 在——**文档已加载,只是渲染慢/挂**。教训:

- 判渲染状态**别用 innerText 长度**(渲染中/挂死都可能是 0),用 DOM 计数
  (`.query-field` 数、目标 label 是否存在)——它们是就绪锚点本身,不依赖文本渲染
- 该页面确有真挂死态(用户实证 reload 无效,点其他报表 tab 再切回才恢复)。
  不可靠的人工恢复路径不进适配器:等够(45s)即失败,错误消息写明
  「iframe 疑似渲染挂死:reload 无效,请人工点其他报表 tab 再切回」——恢复决策留给人
