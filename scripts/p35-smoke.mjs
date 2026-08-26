/** P3-5 批次 1 真链路冒烟:快照行应带 `→ <unit> [sel=...]` DOM 单元。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO_ROOT = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO_ROOT + '/bin/hub.mjs', '--mcp'],
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    P35_DEBUG: '1',
    HUB_SPACES_FILE: '/tmp/p35-smoke-spaces.json',
    HUB_SPACE_REAP: 'off',
    HUB_AUDIT: 'off',
    BROWSEROS_CDP_PORT: '9110',
  },
})
const client = new Client({ name: 'p35-smoke', version: '1.0.0' })
await client.connect(transport)
console.log('connected')

const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

await call('space.create', { name: 'p35-smoke' })
const opened = await call('space.open_tab', { url: 'https://news.ycombinator.com/' })
const pageId = opened.structuredContent?.pageId
console.log('pageId:', pageId)
await new Promise((r) => setTimeout(r, 3000))

const snap = await call('snapshot', { page: pageId })
const text = textOf(snap)
const lines = text.split('\n')
const enriched = lines.filter((l) => l.includes(' → '))
const withSel = enriched.filter((l) => l.includes('[sel='))
console.log(`snapshot: ${lines.length} lines, ${enriched.length} enriched, ${withSel.length} with selector`)
console.log('--- enriched 样例(前 12 行)---')
for (const l of enriched.slice(0, 12)) console.log(l.trim().slice(0, 130))

// 抽样 selector 批量验证真实唯一性(一次 evaluate)
const sels = [...text.matchAll(/\[sel=(".*?")\]/g)].map((m) => JSON.parse(m[1]))
const sample = [sels[0], sels[Math.floor(sels.length / 2)], sels[sels.length - 1]]
console.log('--- selector 真实性验证(首/中/尾)---')
const ev = await call('evaluate', {
  page: pageId,
  code: `const sels=${JSON.stringify(sample)}; return sels.map(s=>[s,document.querySelectorAll(s).length]);`,
})
const counts = ev.structuredContent?.value ?? ev.structuredContent?.result
for (const pair of counts ?? []) {
  const [sel, n] = pair
  console.log(`${n === 1 ? 'UNIQUE✓' : 'count=' + n + '✗'}  ${sel}`)
}
if (counts === undefined) console.log('(structuredContent:', JSON.stringify(ev.structuredContent).slice(0, 200), ')')

// P3-5 批次 3:DOM diff——注入无 role 的 spinner div(AX 树不变但 DOM 变)
await call('snapshot', { page: pageId })  // 重置 baseline
await call('evaluate', {
  page: pageId,
  code: 'var d=document.createElement("div");d.id="p35-spinner";d.className="spinner loading";document.body.appendChild(d);return d.id;',
})
const domDiff = await call('diff', { page: pageId })
const domDiffText = textOf(domDiff)
console.log('--- diff(注入 spinner 后)---')
console.log(domDiffText.split('\n').slice(0, 8).join('\n'))
const hasDomSection = domDiffText.includes('DOM changes') && domDiffText.includes('div#p35-spinner')
console.log(hasDomSection ? 'DOM-DIFF PASS(AX 不变但 DOM 变被捕获)' : 'DOM-DIFF FAIL')

// P3-5 批次 3b:act 闭环(scroll 无导航)→ includeDiff 自动带 DOM 段
await call('snapshot', { page: pageId })  // baseline(此刻 spinner 已在,先移除)
await call('evaluate', { page: pageId, code: 'document.getElementById("p35-spinner")?.remove(); return "removed";' })
await call('snapshot', { page: pageId })  // 重置 baseline(无 spinner)
await call('evaluate', {
  page: pageId,
  code: 'var d=document.createElement("div");d.id="p35-spinner-2";d.className="spinner";document.body.appendChild(d);return d.id;',
})
const actRes = await call('act', { page: pageId, kind: 'scroll', direction: 'down', amount: 1 })
const actText = textOf(actRes)
const actHasDom = actText.includes('DOM changes') && actText.includes('p35-spinner-2')
console.log(actHasDom ? 'ACT-DOM PASS(act 后 includeDiff 自动带 DOM 段)' : 'ACT-DOM FAIL')
console.log('actText 完整:', JSON.stringify(actText).slice(0, 400))

// P3-5 批次 2:inspect 深挖(选一个 ref)
const insp = await call('inspect', { page: pageId, ref: 'e1' })
const inspText = textOf(insp)
console.log('--- inspect e1 ---')
console.log(inspText.split('\n').slice(0, 12).join('\n').slice(0, 700))

await call('space.close', {})
console.log('done')
process.exit(0)
