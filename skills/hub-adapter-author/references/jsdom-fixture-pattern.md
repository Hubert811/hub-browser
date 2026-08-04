# 基于冻结 fixture 的 JSDOM 测试模式（适用于浏览器内 DOM 提取器）

## 适用场景

你正在编写一个适配器，其数据提取发生在**实时浏览器内部**，通过 `page.evaluate(...)` 执行——而非在 Node 侧的后处理中。典型信号：适配器中有一个函数被字符串化后传入 `page.evaluate('(' + fn.toString() + ')()')`，遍历 `document.querySelector` 等 DOM API。

这类提取器对 mock 的 `page.evaluate` 单元测试是不可见的——那些测试向函数喂入预制好的结果，因此真正的 DOM 遍历从未运行。历史上在 dianping 中发现过两个这样的浏览器内静默 bug，它们只在 live verify 时才暴露：

1. 店铺标题的 fallback 分割使用了 ASCII 的 `[]`，而页面渲染的是全角 `【】`，导致 `name` 始终为空。
2. `headText.replace(/\s+/g, ' ')` 将评分 "4.8" 和评价数 "21241条" 合并在一起，而一个作用域过宽的 `/\d+条/` 正则匹配出了 `4.821241` → 5。

如果你的网站存在类似可能性的情况，请冻结一份有代表性的 HTML 快照，并在单元测试中通过 JSDOM 回放它。

## 文件布局

- 测试文件：`clis/<site>/<site>.test.js`（与适配器文件同级）
- fixture 文件：`clis/<site>/__fixtures__/<command>.html`

参考实现：`clis/dianping/__fixtures__/{shop,search}.html`（原始测试 + 空白行清理后续，本文档即由此而来）。

## 创建 HTML fixture

核心目的是提交一份**实时页面 DOM 的代表性快照**——这样 JSDOM 单元测试就能走通实时提取器所遍历的真实选择器路径。

### 必要步骤（按顺序）

1. **捕获** live verify 运行中的页面 HTML：
   ```bash
   hub browser <s> open https://www.example.com/<page>
   # 导出 page content：
   hub browser <s> eval 'document.documentElement.outerHTML' \
     > /tmp/raw-<command>.html
   ```

2. **剔除噪声块**——即 JSDOM 不需要的、且每次页面加载都会变化的内容（反正提交的 fixture 在重新捕获的 diff 中也留不住）：
   - 所有 `<script>...</script>` 内容
   - 所有 `<style>...</style>` 内容
   - 所有 `<iframe>...</iframe>` 内容
   - 所有 `<!-- ... -->` HTML 注释
   - 所有 `<link rel="preload" ...>` / 追踪像素

3. **将 `<img src="...">`** 替换为占位符
   （`src="placeholder.png"`）——真实 CDN URL 会泄露账号级 token，且属于噪声。

4. **裁剪到最小子树**，即能覆盖提取器并触发你要防范的 bug 的最小部分。对于 dianping shop，那是 `.shop-head` + `.desc-info` + `.review-title`；对于 search，是 15 个结果 `<li>` 卡片中的 3 个（排名 1、2、3）。

5. **强制空白行归一化步骤**——删除所有仅含空白的行：
   ```bash
   awk 'NF>0' /tmp/raw-<command>.html > clis/<site>/__fixtures__/<command>.html
   ```
   JSDOM 的 HTML 解析器对空白是宽容的；空行对测试没有任何语义影响，但它们会撑大提交的 diff，并让审查者难以看清有意义的 DOM 子树。
   **跳过此步骤是 fixture 创建中最常见的隐性质量退化。** 历史 PR 从 dianping 的两个 fixture 中清理了 239 行残留空行（占文件内容的 84.6% / 54.8%），而 JSDOM 测试在清理后仍然原样通过。

6. **提交**到 `clis/<site>/__fixtures__/<command>.html`。

### 应避免的反模式

- ❌ "剔除 script/style 内容"但保留周围换行。移除内联脚本内容却不折叠由此产生的空行，正是噪声的来源——步骤 5 专门为此而存在。
- ❌ 裁剪到最小子树，但跳过步骤 5。fixture 对测试有效，但审查者看到的是几百行空行。
- ❌ 对**超长单行**做美化排版（例如源页面上压缩到一整行的 `<div>...</div>`）。有些 bug 依赖于文本节点之间无空白插邻的相邻关系（例如 `4.8` 和 `21241条` 紧邻 → `headText` 合并 bug）。美化排版会插入空白，从而掩盖你正在测试的条件。
  步骤 5 只删除空行——绝不重新排版内容。
- ❌ 从 live 重新捕获并覆盖已提交的 fixture，却不重新执行步骤 2-5。fixture 是一个**冻结的**快照；如果页面布局发生了变化，那是一个独立的决策（更新测试预期 + 重新裁剪 + 重新剔除）。

## 编写 JSDOM 单元测试

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractShopFields } from './shop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOP_FIXTURE = readFileSync(join(__dirname, '__fixtures__/shop.html'), 'utf8');

describe('shop adapter — extractor against frozen HTML fixture', () => {
    let originalDocument;
    let originalLocation;

    beforeEach(() => {
        originalDocument = globalThis.document;
        originalLocation = globalThis.location;
    });

    afterEach(() => {
        globalThis.document = originalDocument;
        globalThis.location = originalLocation;
    });

    function loadFixture(html, url) {
        const dom = new JSDOM(html, { url });
        globalThis.document = dom.window.document;
        globalThis.location = dom.window.location;
        return dom;
    }

    it('extracts the canonical fields and avoids known silent bugs', () => {
        loadFixture(SHOP_FIXTURE, 'https://www.example.com/shop/123');

        const data = extractShopFields();

        expect(data.ok).toBe(true);
        expect(data.name).toBe('...');
        // 为每个已知的静默 bug 添加显式回归守护
        expect(data.reviewsRaw).toBe('...');  // not the fused "<rating><reviews>" form
    });
});
```

要使此模式生效，适配器的提取器必须是一个**顶层函数**，使用裸的 `document` / `location`（而非 `window.document`），这样同一段代码就能被两条路径覆盖：

- 实时浏览器：通过 `${extractFn.toString()}` 注入到
  `page.evaluate`
- JSDOM 单元测试：替换 `globalThis.document`

如果你的适配器目前将提取器写为模板字面量中的 IIFE，请先重构为顶层 `export function`。
参考：`clis/dianping/{shop,search}.js` 中以裸 `document`/`location` 提取了 `extractShopFields()` 和 `extractSearchRows()`。

## 反向验证（在声称测试能捕获 bug 之前必须执行）

一个"18/18 通过"的测试并不能证明它能捕获原始 bug——只能说明它与当前实现一致。在信任一个回归守护之前：

1. 备份适配器源码。
2. 重新引入相关提取器的 bug 变体。
3. 运行测试。它必须失败，且断言指向那个静默 bug。
4. 从备份恢复。

对于 dianping bug #2（评分/评价数合并）：
```js
// BUGGY VARIANT — replaces the .reviews selector path
const buggyMatch = headText.match(/(\d+)条/);
let reviewsRaw = buggyMatch ? buggyMatch[0] : '';
```

如果在 fixture 创建步骤 5 之后，测试在此 bug 变体上仍然失败，表现为 `expected '21241条' to be '21241条'` 但实际收到 `'821241条'`（合并后的数字），则回归守护是完好的。如果测试在此 bug 变体上仍然通过，说明 fixture 被裁剪过度 / 归一化过头 / 断言太松——回去收紧它。

这与主 runbook 中 `--write-fixture` 步骤 10（验证 fixture 能捕获应捕获的内容）是同一套规范，只是应用于 JSDOM HTML fixture 而非响应 JSON fixture。

## 另请参见

- `references/adapter-template.md`——基本适配器文件结构
- `references/output-design.md`——提取后映射的列命名
- `references/success-rate-pitfalls.md`——更广泛的"验证可以通过但数据已静默错误"目录；mock 的 page.evaluate 缺口正是促成此整个模式的一个条目
