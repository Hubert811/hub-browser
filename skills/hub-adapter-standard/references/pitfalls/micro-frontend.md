# 微前端框架适配器坑点（框架通用）

适用范围：所有使用微前端框架（如 [wujie](https://wujie-micro.github.io/doc/)、qiankun）的站点。

> 微前端场景下的 `location.reload()` 逻辑和原因已由 shared.js 的 `navigateTo` 函数封装并注释，详见 `references/shared-js/wait-and-state.md`。此处只记录 shared.js 未覆盖的微前端特有坑点。

---

## 坑点 1：微前端 proxy 拦截 `document.querySelector`

**现象**
在微前端子应用页面上执行 `document.querySelector(selector)` 时，框架的 Proxy 拦截会主动抛出异常，错误文案类似：

> 此报错可以忽略，iframe 主动中断主应用代码在子应用运行

直接裸用 `document.querySelector` 会让 `page.evaluate` 整体挂掉，适配器中断。

**根因**
微前端通过 Proxy 劫持 `document`，对子应用上下文里的查询操作主动抛错以隔离主/子应用 DOM。这个错在框架源码里就是"故意抛错"，不是真正的 bug。

**解决方案**
封装一个 `safeEval` 兜底函数，捕获框架抛出的特定错误并返回 `null`：

```js
async function safeEval(page, fnOrExpr) {
  try {
    return await page.evaluate(fnOrExpr);
  } catch (e) {
    if (e.message?.includes('iframe主动中断') ||
        e.message?.includes('iframe interrupted')) {
      return null;
    }
    throw e;
  }
}
```

所有读 DOM 的 `page.evaluate` 都走 `safeEval`，避免一次 proxy 拦截就让适配器退出。

---

## 坑点 2：微前端 proxy 拦截 `page.click`

**现象**
对子应用页面元素调用 Playwright 的 `page.click(selector)` 时报同样的"iframe 主动中断"异常，或者点击后无任何反应（事件被子应用 proxy 吞掉）。

**根因**
`page.click` 内部会调用 `document.querySelector` 定位元素，触发 proxy 拦截。即使绕过了查询，playwright 注入的合成事件也可能被子应用 proxy 拦截。

**解决方案**
改用 `page.evaluate` 内部的 `el.click()` 直接触发原生点击：

```js
await page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (el) el.click();
}, targetSelector);
```

必要时配合 `safeEval` 包裹。对**按钮提交、链接跳转**等场景，`el.click()` 比 `page.click` 在微前端子应用里更可靠。

注意：对 **el-select 下拉选项**这类需要 mousedown/mouseup 事件链的组件，`el.click()` 不够用，仍需走原生 CDP click。

---

## 识别微前端站点的方法

在 `page.evaluate` 里跑：

```js
!!window.__POWERED_BY_WUJIE__   // wujie
!!window.__POWERED_BY_QIANKUN__ // qiankun
```

返回 `true` 即表示当前页面是微前端子应用。适配器 `run` 入口建议先探测，命中则应用上述 2 条兜底。
