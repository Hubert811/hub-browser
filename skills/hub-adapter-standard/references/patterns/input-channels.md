# 输入通道规范(Input Channels)

> 来源:QuickBI quote-detail 适配器攻坚实测(2026-08-27),四通道逐一用 network 断言定案;
> order-detail 攻坚补 execCommand/insertText 的 onChange 差异定案(同日)。
> 适用:所有需要向 input 写值的适配器,尤其是 React/Vue 受控组件与 iframe 内输入框。
> 需要输入后触发组件自身搜索/联想的字段,直接看 `keyword-select.md` 的通道定论。

## 通道全景

| 通道 | API | 适用 | 坑 |
|---|---|---|---|
| **native setter + input 事件** | eval 内 `HTMLInputElement.prototype` setter + `dispatchEvent` | React 受控 input(**首选**:13ms,React 兼容,network 断言 PASS) | 需 eval focus 前置 |
| **一次性粘贴** | `page.insertText(text)`(=CDP `Input.insertText`) | 值能进(“受控组件+eval focus 前置”场景 network 断言 PASS过) | **onChange 不一定触发**:order-detail 搜索框上 DOM value 变了但 React state 没收——点组件搜索按钮后拿空 state 查询,列表空 15s 超时。填静态筛选用它 OK,**触发组件自身搜索/联想不要靠它** |
| 逐键输入(真键盘) | `page.nativeType(text)` | 理论可行 | 实测裸 CDP `dispatchKeyEvent` 不路由进 iframe 焦点元素——走 hub type 命令的 AX 通道时另论 |
| eval 直接赋值 | eval 内 `el.value = x` | 仅读取;写入需谨慎 | 裸赋值不触发事件流;setter+dispatchEvent 例外 |
| eval `execCommand('insertText')` | **focus+select+execCommand 三步同一次 eval 内完成** | 需要触发组件 onChange(搜索/联想/自动查询)的输入框**首选**——完整 input 事件序列,React state 真实收值,order-detail 搜索框一击触发自动数据库搜索(58 项实证) | 跨 eval 分步时焦点丢失返回 false(quote-detail 时代“iframe 内不可靠”的真正原因);非 iframe 普通页面它常有效(见 shared-js/eval-helpers.md 的 setVal) |

## native setter 范式(首选)

```javascript
// iframe 内受控 input(dashEval 已解出 d = iframe.contentDocument)
const setRes = await dashEval(page, `
(() => {
  const fi = /* 定位到字段容器 */;
  const i = fi.querySelector('input.ant-input');
  if (!i) return { __err: 'no-input' };
  i.focus();
  const setter = Object.getOwnPropertyDescriptor(d.defaultView.HTMLInputElement.prototype, 'value').set;
  setter.call(i, ${JSON.stringify(value)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true };
})()`);
```

要点:
- **必须用原型上的 setter**(`HTMLInputElement.prototype` 的 `value` descriptor),
  直接 `i.value = x` 对受控组件无效(React 重渲染会覆盖且 state 不收)
- `dispatchEvent(new Event('input', { bubbles: true }))` 是 React 收到变更的关键
- textarea 用 `HTMLTextAreaElement.prototype`

## 配合规范

1. 输入前 `focus() + select()`(全选替换,防残留文本拼接)
2. 输入后锚点 `input.value === 目标值` 确认真实键入(DOM 面)
3. 受控组件终局验证:**触发查询,断言 network requestBody 含该条件**(最高可信度面)
   ——DOM value 对受控组件可能假阳性,详见 `pitfalls/timing-and-assertion.md`
4. 清空同样用 setter(setter.call(i, '') + input 事件),不要依赖 clear icon 必然存在

## 通道选择决策树

```
输入后组件要自己响应(搜索/联想/自动查询)?
└─ 是 → eval 内 focus+select+execCommand('insertText') 同一 eval 完成
     (CDP insertText 只改 DOM value,onChange 不保证触发——order-detail 双通道对照实证)

否则:
目标是 React/Vue 受控 input?
├─ 是 → native setter + input 事件(首选;insertText 亦可,需 eval focus 前置)
└─ 否(原生/非受控)
   ├─ 需要触发完整键盘事件流(快捷键/联想) → page.nativeType
   └─ 普通填值 → insertText 或 setter 均可
```

## 教训链(为什么有这份文件)

- 最初 `page.insertText` 被判「对受控组件无效」写进文档——后来发现是**断言器假阴性**
  (只收集 in 操作符,漏 equalTo)冤枉了它。干净复测(eval focus + 独立 CDP spy 抓真实
  请求)平反:值进且条件生效。
- **方法论**:判定「通道 X 无效」前,必须排除验证工具自身的 bug——用与断言器不同源
  的通道(独立 CDP 监听)看原始事实。
- **同一通道两种结局 ≠ 随机**:CDP insertText 在同页同字段上时灵时不灵(有时触发
  前端过滤、有时完全不生效)——真相是「DOM value 变了但 onChange 没触发」,前者
  是碰巧被组件的 blur/change 兑现。看组件行为要盯 **React state**(下一步动作用了它),
  不能只看 input.value。
- **execCommand 平反补管**:quote-detail 判它「iframe 内返回 false」——真因是 focus 与
  execCommand 跨 eval 分步导致聚焦丢失;order-detail 把三步并在同一次 eval 里,
  一击触发组件自动搜索。“不可靠”往往是“调用方式不对”,修正方式写进范式而不是绕开通道。
