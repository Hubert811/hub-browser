# page.evaluate 返回值丢失（最隐蔽的坑）

## 问题现象

- DOM 操作"看起来没生效"：填了、点了，但所有读回的断言值都是 `undefined`
- 适配器不报错、能跑通，但结果全是默认/空值——**静默失败**
- 同样的逻辑，函数式 `page.evaluate(fn)` 正常、字符串式 `page.evaluate(str)` 返回 undefined

## 根因

`(async () => { ...; (() => {...})() })()` —— **async 箭头的块体不隐式返回最后表达式**。内层 IIFE 求值出对象，但外层函数返回 undefined：

```javascript
// 结果永远是 undefined（块体最后一个语句是 IIFE 调用，没有 return）
(async () => {
  const x = compute();
  (() => { return { ok: true }; })()   // 求值了，但没被返回
})()
```

此外，**字符串 evaluate 与函数式 evaluate 语义可能不同**（字符串走 wrapForEval 原样发送，返回值依赖运行时的 awaitPromise/序列化行为），同一表达式两种写法结果可能不一样。

## 修复方案

1. **包装层必须显式 `return (body)`**，且 body 本身是表达式（IIFE）：

```javascript
const expr = '(async () => { ' + PREFIX + ' return (' + body + '); })()';
```

2. **写适配器前先跑 evaluate 探针**，摸清运行时行为：plain IIFE / async IIFE / 含内层 IIFE / 函数式 各返回什么。
3. 锚点断言依赖返回值——返回值丢失会连锁导致所有断言失效，所以这是最高优先级排查项。

## 通用性

- 所有 `browser: true` 适配器（只要用了字符串 evaluate）
- 微前端/iframe 套壳站点尤其常见（不得不走字符串 eval 时）

## 验证建议

- 每个 shared.js 函数返回后，先 `console.error(JSON.stringify(result))` 确认非 undefined 再继续
- 探针：`page.evaluate("(async () => { const f = ...; return {ok:true}; })()")` 必须返回对象
