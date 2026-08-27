// Filter-panel visibility probe: how many selects exist in the iframe DOM,
// how many are visible, and does expanding the panel change the AX tree?
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const t0 = Date.now()
const at = (l) => console.log(`[t+${String(Date.now() - t0).padStart(5)}ms] ${l}`)
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r4', HUB_SPACES_FILE: '/tmp/qbi-r4-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r4-filterprobe', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

await call('space.create', { name: 'qbi-r4' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])
at(`pageId=${pageId}`)
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (/no change/i.test(textOf(await call('diff', { page: pageId })))) break
}

// DOM census in the iframe: total vs visible selects + the expand affordance
const probe = await call('evaluate', {
  page: pageId, frame: 1,
  code: `const all=[...document.querySelectorAll('.ant-select')];
const vis=all.filter(e=>e.offsetWidth||e.offsetHeight);
const expandBtns=[...document.querySelectorAll('div,span,button')].filter(e=>/展开|更多筛选|收起/.test(e.textContent||'')&&(e.offsetWidth||e.offsetHeight));
return JSON.stringify({
  selectsTotal: all.length, selectsVisible: vis.length,
  visibleLabels: vis.slice(0,8).map(e=>{const l=e.closest('.filter-item,.ant-form-item,.query-item')?.querySelector('label,.filter-label');return (l?.textContent||'').trim().slice(0,10)}),
  expandCandidates: expandBtns.slice(0,3).map(e=>({tag:e.tagName,txt:(e.textContent||'').trim().slice(0,12),cls:(e.className||'').toString().slice(0,40)}))
})`,
})
const pr = textOf(probe)
console.log('filter census:', pr.slice(pr.indexOf('{'), pr.lastIndexOf('}') + 1))

// AX census for comparison
const snap = textOf(await call('snapshot', { page: pageId }))
const combos = (snap.match(/combobox/g) || []).length
at(`AX combobox count: ${combos}; snapshot lines: ${snap.split('\n').length}`)

// click the expand button if present, then re-snapshot
const expandTxt = pr.match(/expandCandidates":\[\{[^\]]*"txt":"([^"]+)"/)
if (expandTxt) {
  at(`expand affordance found: ${expandTxt[1]} — clicking via frame evaluate`)
  const clickExpand = await call('evaluate', {
    page: pageId, frame: 1,
    code: `const btns=[...document.querySelectorAll('div,span,button')].filter(e=>/展开|更多筛选/.test(e.textContent||'')&&(e.offsetWidth||e.offsetHeight));
if(btns.length){btns[0].click();return 'clicked: '+(btns[0].textContent||'').trim()}
return 'no expand button'`,
  })
  console.log('expand click:', textOf(clickExpand).slice(0, 80).replace(/\[UNTRUSTED[^\]]*\]/g, ''))
  await new Promise(r => setTimeout(r, 2500))
  const snap2 = textOf(await call('snapshot', { page: pageId }))
  at(`after expand: AX combobox count=${(snap2.match(/combobox/g) || []).length}, lines=${snap2.split('\n').length}`)
}

try {
  await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('HANG')), 20000))])
  at('closed')
} catch { at('space.close HANG (repro)') }
await client.close()
