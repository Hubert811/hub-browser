# 输入与点击类单点操作

该新增的 A 类（输入）+ B 类（点击）公共函数。

每个函数遵循 6 条设计原则：选择器参数化、iframe 可选、返回值有意义、内置 fallback、超时可配、匹配模式可配。

---

## A 类：输入

### 1. `fillInput(page, selector, value, opts?)` — 普通输入框

**适用组件**：`<input>`、`<textarea>`、Element UI `el-input`、Vue/React 管理的普通输入框

**前端背景**：Vue/React 的 `v-model` 会重写 `value` 属性的 setter。直接 `el.value = x` 走框架 setter，值进了框架内部状态，但框架可能不同步回 UI——`el.value` 读出来对，但页面上输入框是空的。

**双写解决**：同时写 DOM 底层（绕过框架）+ 框架内部 `_value` + 发事件通知框架。

**签名**：

```typescript
fillInput(page: IPage, selector: string, value: string, opts?: {
  blur?: boolean  // 是否发 blur 事件（默认 true）
}): boolean  // 是否成功找到并填充
```

**内部步骤**：
1. focus + select
2. 先试 `execCommand('insertText')` — 某些框架认这个真实输入事件
3. 失败则"双写"：原型链取原生 setter 绕过框架 + `el._value = val` 写 Vue 内部
4. `dispatchEvent` 发 `input` + `change` 事件
5. 可选 blur

**代码**：

```javascript
export async function fillInput(page, selector, value, opts = {}) {
  const { blur = true } = opts
  const ok = await page.evaluate((sel, val, doBlur) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel
    if (!el) return false
    el.focus()
    el.select()
    if (document.execCommand('insertText', false, val)) return true
    const proto = Object.getPrototypeOf(el)
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (desc && desc.set) desc.set.call(el, val)
    el._value = val
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (doBlur) el.dispatchEvent(new Event('blur', { bubbles: true }))
    return true
  }, selector, value, blur)
  return ok
}
```

**调用示例**：

```javascript
// 基本用法
await fillInput(page, '#keyword', '手机')

// 不发 blur（某些组件 blur 会触发校验，不想触发）
await fillInput(page, '#keyword', '手机', { blur: false })

// 根据返回值判断
if (!await fillInput(page, '#keyword', '手机')) {
  throw new Error('搜索框没找到')
}
```

**官方重复**：24 个文件各自写了 `getOwnPropertyDescriptor` + `set.call` + `dispatchEvent`。

---

### 2. `fillRichText(page, selector, text, opts?)` — 富编辑器

**适用组件**：`[contenteditable="true"]`、ProseMirror、tiptap、Draft.js

**前端背景**：富编辑器不监听 `value` setter，只监听 CDP 级别的 `beforeinput`/`input` 事件。`execCommand` 在 evaluate 内执行是 DOM 级别的，ProseMirror 不认。必须用 CDP `Input.insertText`。

**签名**：

```typescript
fillRichText(page: IPage, selector: string, text: string, opts?: {
  verify?: boolean       // 是否验证（默认 true）
  verifySelector?: string  // 读哪个元素验证（默认同 selector）
}): { ok: boolean, actual: string }
```

**内部步骤**：
1. evaluate: focus + 清空 `textContent` + 创建 Range 选区
2. `page.insertText(text)` — CDP Input 域
3. evaluate: 读 `innerText` 验证

**为什么不可分**：不做第 1 步，insertText 可能插到错误位置；不做第 3 步，填失败不知道。

**代码**：

```javascript
export async function fillRichText(page, selector, text, opts = {}) {
  const { verify = true, verifySelector = selector } = opts

  // 1. 准备编辑器
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    el.focus()
    el.textContent = ''
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    return true
  }, selector)

  // 2. CDP Input 插入（虚拟指针可捕获）
  try {
    await page.insertText(text)
  } catch {
    // fallback: execCommand（某些环境不支持 insertText）
    await page.evaluate((sel, val) => {
      document.execCommand('insertText', false, val)
    }, selector, text)
  }

  // 3. 验证
  if (!verify) return { ok: true, actual: text }
  const actual = await page.evaluate((sel) =>
    document.querySelector(sel)?.innerText?.trim() || ''
  , verifySelector)
  return { ok: actual === text, actual }
}
```

**调用示例**：

```javascript
// 基本用法
const result = await fillRichText(page, '[contenteditable="true"][placeholder*="标题"]', '我的标题')
if (!result.ok) throw new Error(`填充失败: 期望 "${result.actual}"`)

// 不验证（某些编辑器 innerText 和输入内容不一致）
await fillRichText(page, '.tiptap.ProseMirror', content, { verify: false })
```

---

### 3. `typeInAiBox(page, selector, text, opts?)` — AI 对话框

**适用组件**：ChatGPT、Gemini、豆包、Claude、DeepSeek 的消息输入框

**前端背景**：AI 对话框是高度自定义的富编辑器。`nativeType` 自带 focus（先点再打字），比 insertText 少一步。发送时合成 KeyboardEvent 某些框架不认（如 Gemini），必须用 CDP `Input.dispatchKeyEvent`。

**签名**：

```typescript
typeInAiBox(page: IPage, selector: string, text: string, opts?: {
  sendKey?: string       // 发送键（默认 'Enter'）
  sendMethod?: 'pressKey' | 'nativeKeyPress'  // 默认 'pressKey'
}): boolean
```

**内部步骤**：
1. evaluate: 找元素 + `getBoundingClientRect` 算坐标
2. `nativeClick(x, y)` — 点输入框获取焦点
3. `nativeType(text)` — 输入文字
4. `pressKey(sendKey)` 或 `nativeKeyPress(sendKey)` — 发送

**代码**：

```javascript
export async function typeInAiBox(page, selector, text, opts = {}) {
  const { sendKey = 'Enter', sendMethod = 'pressKey' } = opts

  // 1. 算坐标
  const coords = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, selector)
  if (!coords) return false

  // 2-3. 点 + 打字
  await page.nativeClick(coords.x, coords.y)
  await page.wait(0.2)
  await page.nativeType(text)

  // 4. 发送（sendKey 为 null/false 时不按发送键）
  if (sendKey) {
    await page[sendMethod](sendKey)
  }
  return true
}
```

**调用示例**：

```javascript
// ChatGPT
await typeInAiBox(page, '#prompt-textarea', '什么是量子计算')

// Gemini（需要 nativeKeyPress）
await typeInAiBox(page, '[contenteditable="true"]', '什么是量子计算', {
  sendMethod: 'nativeKeyPress'
})

// 不发送（只输入，手动点发送按钮）
await typeInAiBox(page, '#prompt-textarea', '什么是量子计算', {
  sendKey: null  // 不按发送键
})
```

---

### 4. `fillDateRange(page, labelText, from, to, opts?)` — 日期范围

**适用组件**：Element UI `el-date-editor`，两个 `input.el-range-input`

**前端背景**：日期范围选择器需要逐个 input 填值，填完必须按 Enter 确认，否则不触发 `change` 事件——框架不知道用户选了日期。

**签名**：

```typescript
fillDateRange(page: IPage, labelText: string, from: string, to: string, opts?: {
  labelSelector?: string  // 用什么选择器找 label（默认 '.el-form-item__label, .el-col > div:first-child'）
  searchIframes?: boolean // 是否遍历 iframe（默认 true）
}): boolean
```

**代码**：

```javascript
export async function fillDateRange(page, labelText, from, to, opts = {}) {
  const {
    labelSelector = '.el-form-item__label, .el-col > div:first-child',
    searchIframes = true,
  } = opts

  const ok = await page.evaluate((labelText, from, to, labelSelector, searchIframes) => {
    function nativeSet(el, v) {
      el.focus(); el.select()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(el, v)
      el._value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }

    for (const doc of docs) {
      for (const de of doc.querySelectorAll('.el-date-editor')) {
        const fi = de.closest('.el-form-item') || de.closest('.el-col')
        const le = fi?.querySelector(labelSelector)
        if (!le || !le.innerText.trim().replace(/[:：]/g, '').includes(labelText)) continue
        const inputs = de.querySelectorAll('input.el-range-input, input')
        if (inputs.length >= 2) {
          if (from) {
            inputs[0].focus(); inputs[0].click()
            nativeSet(inputs[0], from)
            inputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
          }
          if (to) {
            inputs[1].focus(); inputs[1].click()
            nativeSet(inputs[1], to)
            inputs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
          }
          return true
        }
      }
    }
    return false
  }, labelText, from, to, labelSelector, searchIframes)

  await page.wait(0.5)
  return ok
}
```

**调用示例**：

```javascript
await fillDateRange(page, '创建时间', '2026-01-01', '2026-07-29')
```

---

## B 类：点击

### 5. `clickButtonByText(page, text, opts?)` — 按文本找按钮

**适用组件**：`<button>`、`<el-button>`、`[role="button"]`

**前端背景**：普通按钮监听 `click` 事件，DOM `el.click()` 就能触发。但页面上可能有很多按钮，要靠文本区分。某些系统的按钮在 iframe 内。

**签名**：

```typescript
clickButtonByText(page: IPage, text: string, opts?: {
  searchIframes?: boolean     // 是否遍历 iframe（默认 true）
  match?: 'exact' | 'contains'  // 匹配模式（默认 'exact')
}): { ok: boolean, via: 'click' | 'none', text: string, x: number, y: number }
```

**代码**：

```javascript
export async function clickButtonByText(page, text, opts = {}) {
  const { searchIframes = true, match = 'exact' } = opts

  // 一次 evaluate 完成查找 + click + 返回坐标（备用）
  const result = await page.evaluate((text, searchIframes, match) => {
    function matchText(btnText, target) {
      if (match === 'exact') return btnText === target
      if (match === 'contains') return btnText.includes(target)
      return false
    }
    function findInDoc(doc, t) {
      return [...doc.querySelectorAll('button, .el-button, [role="button"]')]
        .filter(b => b.offsetParent !== null)
        .find(b => matchText(b.innerText?.trim() || '', t))
    }
    let btn = findInDoc(document, text)
    if (!btn && searchIframes) {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          if (iframe.contentDocument) {
            btn = findInDoc(iframe.contentDocument, text)
            if (btn) break
          }
        } catch (e) {}
      }
    }
    if (!btn) return { ok: false, via: 'none', text: '', x: 0, y: 0 }
    const r = btn.getBoundingClientRect()
    btn.click()
    return { ok: true, via: 'click', text: btn.innerText.trim(), x: r.x + r.width/2, y: r.y + r.height/2 }
  }, text, searchIframes, match)

  return result
}
```

**返回值包含 `x, y` 坐标**：DOM click 后如果发现没生效（如下拉没打开），调用方可以用返回的坐标直接 `page.nativeClick(result.x, result.y)` 升级为真实鼠标点击，不需要重新查找元素：

```javascript
const result = await clickButtonByText(page, '下拉菜单')
if (result.ok && !dropdownVisible) {
  // DOM click 没打开下拉，升级为 nativeClick
  await page.nativeClick(result.x, result.y)
}
```

**调用示例**：

```javascript
// 基本用法
await clickButtonByText(page, '搜索')

// 模糊匹配 + 自动升级 nativeClick
await clickButtonByText(page, '搜索', { match: 'contains', fallbackNative: true })

// 根据返回值判断
const result = await clickButtonByText(page, '搜索')
if (!result.ok) throw new Error('搜索按钮没找到')
```

---

### 6. `clickNativeAtCenter(page, selector, opts?)` — 真实鼠标点击

**适用组件**：自定义下拉菜单、不响应 DOM `.click()` 的按钮、特殊交互组件

**前端背景**：某些组件不监听 `click`，只监听 `mousedown`/`pointerdown`。CDP `Input.dispatchMouseEvent` 发完整的 `mousePressed`+`mouseReleased`，等价真实物理点击。

**签名**：

```typescript
clickNativeAtCenter(page: IPage, selector: string, opts?: {
  searchIframes?: boolean  // 是否遍历 iframe（默认 true）
}): boolean
```

**代码**：

```javascript
export async function clickNativeAtCenter(page, selector, opts = {}) {
  const { searchIframes = true } = opts

  const coords = await page.evaluate((sel, searchIframes) => {
    function findInDoc(doc, selector) {
      const el = typeof selector === 'string' ? doc.querySelector(selector) : selector
      if (!el || el.offsetParent === null) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    let coords = findInDoc(document, sel)
    if (!coords && searchIframes) {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          if (iframe.contentDocument) {
            coords = findInDoc(iframe.contentDocument, sel)
            if (coords) break
          }
        } catch (e) {}
      }
    }
    return coords
  }, selector, searchIframes)

  if (!coords) return false
  await page.nativeClick(coords.x, coords.y)
  return true
}
```

---

### 7. `clickDropdownOption(page, selectLabel, optionText, opts?)` — 下拉选择

**适用组件**：Element UI `el-select`（普通单选）

**前端背景**：el-select 需要先打开 dropdown（点 `.el-select__wrapper`），dropdown 是渲染在 body 上的浮层。选项在 `.el-select-dropdown__item` 里，要过滤隐藏的。

**签名**：

```typescript
clickDropdownOption(page: IPage, selectLabel: string, optionText: string, opts?: {
  match?: 'exact' | 'contains' | 'fuzzy'  // 选项匹配模式（默认 'contains'）
  searchIframes?: boolean  // 是否遍历 iframe（默认 true）
  waitMs?: number          // 等 dropdown 渲染毫秒（默认 600）
}): { ok: boolean, selected: string }
```

**代码**：

```javascript
export async function clickDropdownOption(page, selectLabel, optionText, opts = {}) {
  const { match = 'contains', searchIframes = true, waitMs = 600 } = opts

  // 1. 关闭所有已打开的 dropdown
  await closeAllDropdowns(page, searchIframes)
  await page.wait(0.2)

  // 2. 打开目标 dropdown
  const opened = await page.evaluate((labelText, searchIframes) => {
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      for (const sel of doc.querySelectorAll('.el-select')) {
        const input = sel.querySelector('input')
        const ph = input?.placeholder || ''
        const fi = sel.closest('.el-form-item') || sel.closest('.el-col')
        const le = fi?.querySelector('.el-form-item__label, .el-col > div:first-child')
        const label = le?.innerText.trim().replace(/[:：]/g, '') || ''
        if (label.includes(labelText) || ph.includes(labelText)) {
          const wrapper = sel.querySelector('.el-select__wrapper, .el-select__caret') || input
          if (wrapper) { wrapper.click(); return true }
        }
      }
    }
    return false
  }, selectLabel, searchIframes)

  if (!opened) return { ok: false, selected: '' }
  await page.wait(waitMs / 1000)

  // 3. 从可见的 dropdown 中选匹配项
  const selected = await page.evaluate((val, match, searchIframes) => {
    function matchOption(text, target) {
      if (match === 'exact') return text === target
      if (match === 'contains') return text.includes(target) || target.includes(text)
      if (match === 'fuzzy') {
        const noParen = text.replace(/[（(].*?[)）]/g, '').trim()
        return text.includes(target) || target.includes(text) || noParen.includes(target)
      }
      return false
    }
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      for (const dd of doc.querySelectorAll('.el-select-dropdown')) {
        if (dd.classList.contains('el-select-dropdown-hidden')) continue
        const style = getComputedStyle(dd)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const rect = dd.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        for (const opt of dd.querySelectorAll('.el-select-dropdown__item')) {
          const text = (opt.innerText || '').trim()
          if (matchOption(text, val)) {
            opt.click()
            return text
          }
        }
      }
    }
    return ''
  }, optionText, match, searchIframes)

  await page.wait(0.3)
  return { ok: !!selected, selected }
}
```

---

### 8. `fillFilterableSelect(page, labelText, value, opts?)` — 可搜索下拉

**适用组件**：带远程搜索的 `el-select`

**前端背景**：搜索框是普通 `input`，用双写 setter 能触发 Vue 的 search handler。但选项是异步加载的，没有可靠的"加载完成"信号，只能固定 `sleep` 等待。

**签名**：

```typescript
fillFilterableSelect(page: IPage, labelText: string, value: string, opts?: {
  searchIframes?: boolean  // 默认 true
  waitMs?: number          // 等异步加载毫秒（默认 1500）
  match?: 'exact' | 'contains' | 'fuzzy'  // 默认 'contains'
}): { ok: boolean, selected: string }
```

**代码**：

```javascript
export async function fillFilterableSelect(page, labelText, value, opts = {}) {
  const { searchIframes = true, waitMs = 1500, match = 'contains' } = opts

  await closeAllDropdowns(page, searchIframes)
  await page.wait(0.2)

  // 1. 输入搜索词
  await page.evaluate((labelText, val, searchIframes) => {
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      for (const sel of doc.querySelectorAll('.el-select')) {
        const input = sel.querySelector('input')
        if (!input) continue
        const fi = sel.closest('.el-form-item') || sel.closest('.el-col')
        const le = fi?.querySelector('.el-form-item__label, .el-col > div:first-child')
        const label = le?.innerText.trim().replace(/[:：]/g, '') || ''
        const ph = input.placeholder || ''
        if (label.includes(labelText) || ph.includes(labelText)) {
          input.focus(); input.click(); input.select()
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          if (setter) setter.call(input, val)
          input._value = val
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }
      }
    }
    return false
  }, labelText, value, searchIframes)

  // 2. 等异步加载
  await page.wait(waitMs / 1000)

  // 3. 从可见的 dropdown 中选匹配项
  const selected = await page.evaluate((val, match, searchIframes) => {
    function matchOption(text, target) {
      if (match === 'exact') return text === target
      if (match === 'contains') return text.includes(target) || target.includes(text)
      if (match === 'fuzzy') {
        const noParen = text.replace(/[（(].*?[)）]/g, '').trim()
        return text.includes(target) || target.includes(text) || noParen.includes(target)
      }
      return false
    }
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      for (const dd of doc.querySelectorAll('.el-select-dropdown')) {
        if (dd.classList.contains('el-select-dropdown-hidden')) continue
        const style = getComputedStyle(dd)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const rect = dd.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        for (const opt of dd.querySelectorAll('.el-select-dropdown__item')) {
          const text = (opt.innerText || '').trim()
          if (matchOption(text, val)) {
            opt.click()
            return text
          }
        }
      }
    }
    return ''
  }, value, match, searchIframes)

  await page.wait(0.3)
  return { ok: !!selected, selected }
}
```

---

### 9. `fillMultiSelect(page, labelText, values, opts?)` — 多选下拉

**适用组件**：`el-select` 的 `multiple` 模式

**前端背景**：选一个值后 dropdown 可能自动关闭，要重新打开继续选下一个。

**签名**：

```typescript
fillMultiSelect(page: IPage, labelText: string, values: string, opts?: {
  match?: 'exact' | 'contains' | 'fuzzy'  // 默认 'contains'
  searchIframes?: boolean  // 默认 true
  waitMs?: number          // 默认 600
}): { ok: boolean, selected: string[] }
```

**内部步骤**：
1. `closeAllDropdowns` — 关闭其他已打开的下拉
2. evaluate: 找到匹配 label 的 el-select + click wrapper 打开
3. 循环每个值：从可见 dropdown 找匹配项 click；没找到则重新打开
4. `closeAllDropdowns`

**代码**：

```javascript
export async function fillMultiSelect(page, labelText, values, opts = {}) {
  const { match = 'contains', searchIframes = true, waitMs = 600 } = opts

  const valueList = String(values).split(',').map(s => s.trim()).filter(Boolean)
  if (valueList.length === 0) return { ok: false, selected: [] }

  await closeAllDropdowns(page, searchIframes)
  await page.wait(0.2)

  // 打开 dropdown
  await page.evaluate((labelText, searchIframes) => {
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      for (const sel of doc.querySelectorAll('.el-select')) {
        const input = sel.querySelector('input')
        const ph = input?.placeholder || ''
        const fi = sel.closest('.el-form-item') || sel.closest('.el-col')
        const le = fi?.querySelector('.el-form-item__label, .el-col > div:first-child')
        const label = le?.innerText.trim().replace(/[:：]/g, '') || ''
        if (label.includes(labelText) || ph.includes(labelText)) {
          const wrapper = sel.querySelector('.el-select__wrapper') || input
          if (wrapper) { wrapper.click(); return true }
        }
      }
    }
    return false
  }, labelText, searchIframes)
  await page.wait(waitMs / 1000)

  const selected = []

  // 循环选择每个值
  for (const val of valueList) {
    const found = await page.evaluate((val, match, searchIframes) => {
      function matchOption(text, target) {
        if (match === 'exact') return text === target
        if (match === 'contains') return text.includes(target) || target.includes(text)
        if (match === 'fuzzy') {
          const noParen = text.replace(/[（(].*?[)）]/g, '').trim()
          return text.includes(target) || target.includes(text) || noParen.includes(target)
        }
        return false
      }
      const docs = [document]
      if (searchIframes) {
        document.querySelectorAll('iframe').forEach(f => {
          try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
        })
      }
      for (const doc of docs) {
        for (const dd of doc.querySelectorAll('.el-select-dropdown')) {
          if (dd.classList.contains('el-select-dropdown-hidden')) continue
          const style = getComputedStyle(dd)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const rect = dd.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          for (const opt of dd.querySelectorAll('.el-select-dropdown__item')) {
            const text = (opt.innerText || '').trim()
            if (matchOption(text, val)) {
              opt.click()
              return text
            }
          }
        }
      }
      return ''
    }, val, match, searchIframes)

    if (!found) {
      // 下拉可能关了，重新打开
      await page.evaluate((labelText, searchIframes) => {
        const docs = [document]
        if (searchIframes) {
          document.querySelectorAll('iframe').forEach(f => {
            try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
          })
        }
        for (const doc of docs) {
          for (const sel of doc.querySelectorAll('.el-select')) {
            const input = sel.querySelector('input')
            const ph = input?.placeholder || ''
            const fi = sel.closest('.el-form-item') || sel.closest('.el-col')
            const le = fi?.querySelector('.el-form-item__label, .el-col > div:first-child')
            const label = le?.innerText.trim().replace(/[:：]/g, '') || ''
            if (label.includes(labelText) || ph.includes(labelText)) {
              const wrapper = sel.querySelector('.el-select__wrapper') || input
              if (wrapper) { wrapper.click(); return }
            }
          }
        }
      }, labelText, searchIframes)
      await page.wait(0.4)
    } else {
      selected.push(found)
    }
    await page.wait(0.2)
  }

  await closeAllDropdowns(page, searchIframes)
  await page.wait(0.3)

  return { ok: selected.length > 0, selected }
}
```

**调用示例**：

```javascript
// 多选订单状态
await fillMultiSelect(page, '订单状态', '订单已生效,订单已取消（失效）')

// 精确匹配
await fillMultiSelect(page, '订单来源', '来源A,来源B', { match: 'exact' })
```

---

### 10. `expandHiddenFields(page, caretSelector, opts?)` — 展开隐藏筛选

**适用组件**：展开/收起的小三角图标（`.el-icon-caret-bottom` 等）

**前端背景**：某些系统的筛选条件默认折叠，点击小三角图标展开。三角图标虽然视觉上 hover 才显示，但 DOM 元素一直存在且可 click。

**签名**：

```typescript
expandHiddenFields(page: IPage, caretSelector: string, opts?: {
  searchIframes?: boolean   // 默认 true
  verifySelector?: string   // 验证展开成功的元素选择器
  waitMs?: number           // 默认 500
}): boolean  // 是否找到并展开
```

**代码**：

```javascript
export async function expandHiddenFields(page, caretSelector, opts = {}) {
  const { searchIframes = true, verifySelector, waitMs = 500 } = opts

  const found = await page.evaluate((sel, searchIframes) => {
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      const caret = doc.querySelector(sel)
      if (caret && caret.offsetParent !== null) {
        caret.click()
        return true
      }
      // 元素存在但不可见 → 试 click 父容器
      if (caret?.parentElement) {
        caret.parentElement.click()
        return true
      }
    }
    return false
  }, caretSelector, searchIframes)

  if (!found) return false
  await page.wait(waitMs / 1000)

  // 验证展开成功
  if (verifySelector) {
    return await page.evaluate((sel, searchIframes) => {
      const docs = [document]
      if (searchIframes) {
        document.querySelectorAll('iframe').forEach(f => {
          try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
        })
      }
      return docs.some(doc => !!doc.querySelector(sel))
    }, verifySelector, searchIframes)
  }
  return true
}
```

**调用示例**：

```javascript
// 隐藏筛选字段默认折叠的站点
await expandHiddenFields(page, '.drop-font .el-icon-caret-bottom', {
  verifySelector: '.el-form-item:not([style*="display: none"])'
})
```

---

## 公共辅助函数（导出）

以下函数被上面的多个函数调用，单独导出供适配器直接使用：

### `closeAllDropdowns(page, searchIframes?)` — 关闭所有下拉

```javascript
export async function closeAllDropdowns(page, searchIframes = true) {
  await page.evaluate((searchIframes) => {
    const docs = [document]
    if (searchIframes) {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument) } catch(e) {}
      })
    }
    for (const doc of docs) {
      doc.body?.click()
      for (const input of doc.querySelectorAll('.el-select input')) {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
        }))
      }
    }
  }, searchIframes)
}
```

**调用示例**：

```javascript
// 填表单前先关闭所有已打开的下拉，避免干扰
await closeAllDropdowns(page)
```

---

## evaluate 内部用的 JS 代码块

以下代码块在 `page.evaluate` 模板字符串内执行，多个函数共用。
适配器也可以在自定义 evaluate 里注入这些代码块复用逻辑：

```javascript
// 双写 setter（fillInput 内部用，适配器自定义 evaluate 也可注入）
export const SET_VAL_CODE = `
function setVal(el, v) {
  if (!el) return false
  el.focus(); el.select()
  if (document.execCommand('insertText', false, v)) return true
  var proto = Object.getPrototypeOf(el)
  var desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  if (desc && desc.set) desc.set.call(el, v)
  el._value = v
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}
`

// 关闭所有下拉（evaluate 内部用）
export const CLOSE_ALL_DROPDOWNS_CODE = `
function closeAllDropdowns(doc) {
  doc = doc || document
  doc.body?.click()
  var selects = doc.querySelectorAll('.el-select')
  for (var i = 0; i < selects.length; i++) {
    var input = selects[i].querySelector('input')
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
    }))
  }
}
`

// 获取可见的下拉选项（过滤隐藏的、过滤分页条数选择器）
export const GET_VISIBLE_OPTIONS_CODE = `
function getVisibleOptions(doc) {
  doc = doc || document
  var dropdowns = doc.querySelectorAll('.el-select-dropdown')
  for (var i = 0; i < dropdowns.length; i++) {
    var dd = dropdowns[i]
    if (dd.classList.contains('el-select-dropdown-hidden')) continue
    var style = getComputedStyle(dd)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    var rect = dd.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    var options = dd.querySelectorAll('.el-select-dropdown__item')
    if (options.length > 0 && options[0].innerText.indexOf('条/页') >= 0) continue
    return options
  }
  return []
}
`

// 模糊匹配选项文本（去括号、双向 contains）
export const MATCH_OPTION_CODE = `
function matchOption(opt, val) {
  var text = (opt.innerText || '').trim()
  if (text === val) return true
  if (text.includes(val)) return true
  if (val.includes(text)) return true
  var textNoParen = text.replace(/[（(].*?[)）]/g, '').trim()
  if (textNoParen === val || textNoParen.includes(val)) return true
  return false
}
`
```

**使用方式**（在自定义 evaluate 里注入）：

```javascript
import { SET_VAL_CODE, GET_VISIBLE_OPTIONS_CODE, MATCH_OPTION_CODE } from './dom-ops.js'

// 在 evaluate 模板字符串里拼接代码块
await page.evaluate(`
  ${SET_VAL_CODE}
  ${GET_VISIBLE_OPTIONS_CODE}
  ${MATCH_OPTION_CODE}
  // 现在可以用 setVal()、getVisibleOptions()、matchOption()
  var opts = getVisibleOptions(document)
  for (var i = 0; i < opts.length; i++) {
    if (matchOption(opts[i], '目标值')) {
      opts[i].click()
      break
    }
  }
`)
```
