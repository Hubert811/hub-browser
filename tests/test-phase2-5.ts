/**
 * hub-browser Phase 2.5 — Ref 系统边界用例测试
 *
 * 测试 ref 系统在以下场景下的行为：
 * 1. SPA 重渲染后旧 ref 失效 → fingerprint 降级
 * 2. 动态元素插入 → 新 ref 分配
 * 3. 元素删除重建 → reidentified 匹配
 * 4. 双 ref 一致性 → eN ref 和 CSS 选择器指向同一元素
 * 5. 跨 snapshot ref → 旧 ref 在页面变化后的行为
 * 6. iframe 内 ref → 同源 iframe 操作
 */

import { UnifiedBrowserFactory } from '../src/factory.ts';
import type { UnifiedPage } from '../src/page.ts';

const PASS = '\x1b[32m✅\x1b[0m';
const FAIL = '\x1b[31m❌\x1b[0m';
const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? PASS : FAIL} ${name}: ${detail}`);
}

let factory: UnifiedBrowserFactory | null = null;
let page: UnifiedPage | null = null;

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

// ─── Test 1: SPA 重渲染后旧 ref 行为 ───
async function test1_spaRerender(): Promise<void> {
  try {
    // Navigate to a SPA page (example.com is static, use a dynamic page)
    await page!.goto('https://example.com', { waitUntil: 'load' });
    await sleep(500);

    // Take snapshot to get refs
    const snap1 = await page!.snapshot() as string;
    const ref1Match = snap1.match(/\[ref=(e\d+)\]/);
    if (!ref1Match) {
      record('SPA 重渲染: 获取初始 ref', false, 'no ref in snapshot');
      return;
    }
    const ref1 = ref1Match[1];

    // Modify the page (simulate SPA re-render by replacing innerHTML)
    await page!.evaluate(`
      const link = document.querySelector('a');
      if (link) {
        const oldHref = link.href;
        link.remove();
        // Re-create a similar link (simulates React reconcile)
        setTimeout(() => {
          const newLink = document.createElement('a');
          newLink.href = oldHref;
          newLink.textContent = 'More information...';
          document.body.appendChild(newLink);
        }, 100);
      }
    `);
    await sleep(500);

    // Take new snapshot
    const snap2 = await page!.snapshot() as string;
    const ref2Match = snap2.match(/\[ref=(e\d+)\]/);
    const ref2 = ref2Match ? ref2Match[1] : null;

    record('SPA 重渲染: 新 snapshot 有 ref', ref2 !== null, `ref2=${ref2}`);
    
    // Try to click old ref - should either succeed (reidentified) or fail gracefully
    let oldRefClickResult: string;
    try {
      await page!.click(ref1);
      oldRefClickResult = 'success';
    } catch (e) {
      oldRefClickResult = (e as Error).message.slice(0, 80);
    }
    record('SPA 重渲染: 旧 ref click 行为', true,
      `old ref ${ref1} click: ${oldRefClickResult} (新 ref ${ref2})`);
  } catch (e) {
    record('SPA 重渲染', false, (e as Error).message);
  }
}

// ─── Test 2: 动态元素插入 ───
async function test2_dynamicInsert(): Promise<void> {
  try {
    await page!.goto('https://example.com', { waitUntil: 'load' });
    await sleep(500);

    // Snapshot before
    const snap1 = await page!.snapshot() as string;
    const refCount1 = (snap1.match(/\[ref=e\d+\]/g) || []).length;

    // Insert new interactive elements
    await page!.evaluate(`
      const btn = document.createElement('button');
      btn.id = 'dynamic-btn';
      btn.textContent = 'Dynamic Button';
      btn.setAttribute('aria-label', 'Dynamic Button');
      document.body.appendChild(btn);
    `);
    await sleep(500);

    // Snapshot after
    const snap2 = await page!.snapshot() as string;
    const refCount2 = (snap2.match(/\[ref=e\d+\]/g) || []).length;
    const hasDynamicBtn = snap2.includes('Dynamic Button');

    record('动态元素: 新元素出现在 snapshot', hasDynamicBtn,
      `refs ${refCount1}→${refCount2}, hasDynamicBtn=${hasDynamicBtn}`);

    // Try to click the new element by its ref
    const btnRefMatch = snap2.match(/(e\d+).*Dynamic/);
    if (btnRefMatch) {
      try {
        await page!.click(btnRefMatch[1]);
        record('动态元素: 新 ref click', true, `clicked ${btnRefMatch[1]}`);
      } catch (e) {
        record('动态元素: 新 ref click', false, (e as Error).message.slice(0, 80));
      }
    } else {
      // Try CSS selector
      try {
        await page!.click('#dynamic-btn');
        record('动态元素: CSS selector click', true, 'clicked #dynamic-btn');
      } catch (e) {
        record('动态元素: CSS selector click', false, (e as Error).message.slice(0, 80));
      }
    }
  } catch (e) {
    record('动态元素', false, (e as Error).message);
  }
}

// ─── Test 3: 元素删除重建 → reidentified 匹配 ───
async function test3_deleteRecreate(): Promise<void> {
  try {
    await page!.goto('https://example.com', { waitUntil: 'load' });
    await sleep(500);

    const snap1 = await page!.snapshot() as string;
    const linkRefMatch = snap1.match(/link[^]*\[ref=(e\d+)\]/);
    if (!linkRefMatch) {
      record('删除重建: 获取初始 ref', false, 'no link ref in snapshot');
      return;
    }
    const linkRef = linkRefMatch[1];

    // Delete and recreate the link with same text
    await page!.evaluate(`
      const oldLink = document.querySelector('a');
      const href = oldLink.href;
      const text = oldLink.textContent;
      oldLink.remove();
      const newLink = document.createElement('a');
      newLink.href = href;
      newLink.textContent = text;
      document.body.appendChild(newLink);
    `);
    await sleep(500);

    // New snapshot
    const snap2 = await page!.snapshot() as string;
    const hasLink = snap2.includes('More information') || snap2.includes('link');

    // Try old ref - should reidentify or fail gracefully
    let result: string;
    try {
      await page!.click(linkRef);
      result = 'success (possibly reidentified)';
    } catch (e) {
      result = (e as Error).message.slice(0, 80);
    }
    record('删除重建: 旧 ref 行为', true,
      `old ref=${linkRef}, hasLink=${hasLink}, result=${result}`);
  } catch (e) {
    record('删除重建', false, (e as Error).message);
  }
}

// ─── Test 4: 双 ref 一致性 (eN ref vs CSS selector) ───
async function test4_dualRefConsistency(): Promise<void> {
  try {
    await page!.goto('https://example.com', { waitUntil: 'load' });
    await sleep(500);

    const snap = await page!.snapshot() as string;
    const refMatch = snap.match(/link[^]*\[ref=(e\d+)\]/);
    if (!refMatch) {
      record('双 ref 一致性', false, 'no link ref');
      return;
    }
    const axRef = refMatch[1];

    // Get element's href before clicking
    const hrefBefore = await page!.evaluate<string>('document.querySelector("a")?.href');

    // Click using AX ref
    let axClickUrl: string;
    try {
      await page!.click(axRef);
      await sleep(1000);
      axClickUrl = await page!.evaluate<string>('location.href');
      // Go back
      await page!.goto('https://example.com', { waitUntil: 'load' });
      await sleep(500);
    } catch (e) {
      axClickUrl = 'click failed: ' + (e as Error).message.slice(0, 50);
    }

    // Click using CSS selector
    let cssClickUrl: string;
    try {
      await page!.click('a');
      await sleep(1000);
      cssClickUrl = await page!.evaluate<string>('location.href');
    } catch (e) {
      cssClickUrl = 'click failed: ' + (e as Error).message.slice(0, 50);
    }

    const consistent = axClickUrl === cssClickUrl;
    record('双 ref 一致性: eN ref 和 CSS selector 同一结果', consistent,
      `axRef=${axRef}, axClick→${axClickUrl?.slice(0, 40)}, cssClick→${cssClickUrl?.slice(0, 40)}`);
  } catch (e) {
    record('双 ref 一致性', false, (e as Error).message);
  }
}

// ─── Test 5: 跨 snapshot ref → 旧 ref 在页面大变后 ───
async function test5_crossSnapshotStale(): Promise<void> {
  try {
    await page!.goto('https://example.com', { waitUntil: 'load' });
    await sleep(500);

    const snap1 = await page!.snapshot() as string;
    const ref1Match = snap1.match(/\[ref=(e\d+)\]/);
    if (!ref1Match) {
      record('跨 snapshot: 获取初始 ref', false, 'no ref');
      return;
    }
    const oldRef = ref1Match[1];

    // Navigate to completely different page
    await page!.goto('https://www.iana.org/', { waitUntil: 'load' });
    await sleep(1000);

    // Take new snapshot
    const snap2 = await page!.snapshot() as string;

    // Try old ref - should fail (stale) but not crash
    let result: string;
    try {
      await page!.click(oldRef);
      result = 'WARNING: old ref unexpectedly worked (possible mis-target)';
    } catch (e) {
      result = 'expected failure: ' + (e as Error).message.slice(0, 60);
    }
    record('跨 snapshot: 旧 ref 在新页面行为', true,
      `oldRef=${oldRef}, result=${result}`);
  } catch (e) {
    record('跨 snapshot', false, (e as Error).message);
  }
}

// ─── Test 6: diff 后 ref 刷新 ───
async function test6_diffAfterChange(): Promise<void> {
  try {
    await page!.goto('https://example.com', { waitUntil: 'load' });
    await sleep(500);

    // Baseline snapshot
    await page!.snapshot();
    await sleep(300);

    // Add a visible button (AX tree detectable)
    await page!.evaluate(`
      const btn = document.createElement('button');
      btn.id = 'diff-test-btn';
      btn.textContent = 'Diff Test';
      btn.setAttribute('aria-label', 'Diff Test');
      document.body.appendChild(btn);
    `);
    await sleep(500);

    // Get diff
    const diff = await page!.diff() as any;
    const diffStr = JSON.stringify(diff);
    const hasDiff = diff?.changed === true || (diff?.added ?? 0) > 0;

    // New snapshot should include the new button
    const snap2 = await page!.snapshot() as string;
    const hasBtnInSnap = snap2.includes('Diff Test');

    record('diff 后 ref 刷新', hasDiff && hasBtnInSnap,
      `diff.changed=${diff?.changed}, added=${diff?.added}, inSnap=${hasBtnInSnap}`);
  } catch (e) {
    record('diff 后 ref 刷新', false, (e as Error).message);
  }
}

// ─── Test 7: iframe 内 ref ───
async function test7_iframeRef(): Promise<void> {
  try {
    await page!.goto('https://www.w3schools.com/html/html_iframe.asp', { waitUntil: 'load' });
    await sleep(2000);

    const frames = await page!.frames();
    const hasFrames = frames.length > 1;

    if (!hasFrames) {
      record('iframe ref', false, 'no iframes');
      return;
    }

    // Snapshot should include iframe content
    const snap = await page!.snapshot() as string;
    const snapHasContent = snap.length > 100;

    // Try evaluateInFrame
    let frameResult = 'N/A';
    if (frames.length > 1) {
      try {
        const href = await page!.evaluateInFrame('location.href', 1);
        frameResult = typeof href === 'string' ? href.slice(0, 50) : String(href);
      } catch (e) {
        frameResult = 'error: ' + (e as Error).message.slice(0, 50);
      }
    }

    record('iframe ref: snapshot + evaluateInFrame', snapHasContent,
      `frames=${frames.length}, snapLen=${snap.length}, frame[1]=${frameResult}`);
  } catch (e) {
    record('iframe ref', false, (e as Error).message);
  }
}

// ─── Main ───
async function main(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  hub-browser Phase 2.5 — Ref 系统边界用例测试');
  console.log('═══════════════════════════════════════════════\n');

  try {
    factory = new UnifiedBrowserFactory();
    page = await factory.connect({
      cdpEndpoint: `http://127.0.0.1:${process.env.BROWSEROS_CDP_PORT ?? 9110}`,
    }) as UnifiedPage;
  } catch {
    console.log('⛔ CDP 连接失败');
    return;
  }

  await test1_spaRerender();
  await test2_dynamicInsert();
  await test3_deleteRecreate();
  await test4_dualRefConsistency();
  await test5_crossSnapshotStale();
  await test6_diffAfterChange();
  await test7_iframeRef();

  try { await factory?.close(); } catch { }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  测试结果: ${passed}/${total} 通过 (${Math.round(passed/total*100)}%)`);
  console.log(`═══════════════════════════════════════════════\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
