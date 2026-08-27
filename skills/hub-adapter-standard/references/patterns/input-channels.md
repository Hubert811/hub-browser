# 输入通道规范(Input Channels)

> 来源:QuickBI quote-detail 适配器攻坚实测(2026-08-27),四通道逐一用 network 断言定案。
> 适用:所有需要向 input 写值的适配器,尤其是 React/Vue 受控组件与 iframe 内输入框。

## 通道全景

| 通道 | API | 适用 | 坑 |
|---|---|---|---|
| **native setter + input 事件** | eval 内 `HTMLInputElement.prototype` setter + `dispatchEvent` | React 受控 input(**首选**:13ms,React 兼容,network 断言 PASS) | 需 eval focus 前置 |
| 一次性粘贴 | `page.insertText(text)`(=CDP `Input.insertText`) | **有效**(eval focus 前置后值进且条件生效) | 必须先 eval focus 让目标 input 持焦 |
| 逐键输入(真键盘) | `page.nativeType(text)` | 理论可行 | 实测裸 CDP `dispatchKeyEvent` 不路由进 iframe 焦点元素——走 hub type 命令的 AX 通道时另论 |
| eval 直接赋值 | eval 内 `el.value = x` | 仅读取;写入需谨慎 | 裸赋值不触发事件流;setter+dispatchEvent 例外 |
| eval `execCommand('insertText')` | — | 通用页面可用,iframe 聚焦场景不可靠 | QuickBI iframe 内实测返回 false(eval 上下文聚焦丢失);非 iframe 普通页面它常有效(见 shared-js/eval-helpers.md 的 setVal)——不要把 QuickBI 特例当普适否定 |

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
