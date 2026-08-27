import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime', args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r4', HUB_SPACES_FILE: '/tmp/qbi-r4-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r4b', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
await call('space.create', { name: 'qbi-r4b' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (/no change/i.test(textOf(await call('diff', { page: pageId })))) break
}
const probe = await call('evaluate', {
  page: pageId, frame: 1,
  code: `const q = s => document.querySelectorAll(s).length;
// where did the 20+ filters go? census every filter-ish pattern + look for tab/filter-panel state
const census = {
  antSelect: q('.ant-select'), filterItem: q('[class*="filter-item"]'), queryField: q('[class*="query-field"],[class*="queryField"]'),
  formItem: q('.ant-form-item'), labels: q('label'), selectLike: q('[class*="select"]:not(script):not(style)'),
  biFilter: q('[class*="filter"]:not(script):not(style)'),
};
// any tab-like switcher inside the iframe (report vs filter panel views)?
const tabs=[...document.querySelectorAll('[class*="tab"],[role="tab"]')].filter(e=>e.offsetWidth||e.offsetHeight).map(e=>(e.textContent||'').trim().slice(0,16)).filter(Boolean).slice(0,10);
// first few visible labels to identify the panel
const labels=[...document.querySelectorAll('label,[class*="label"]')].filter(e=>e.offsetWidth||e.offsetHeight).map(e=>(e.textContent||'').trim()).filter(Boolean).slice(0,14);
return JSON.stringify({census, tabs, labels})`,
})
const pr = textOf(probe)
console.log(pr.slice(pr.indexOf('{'), pr.lastIndexOf('}') + 1).replace(/\\n/g, ' '))
try { await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 20000))]) } catch { }
await client.close()
