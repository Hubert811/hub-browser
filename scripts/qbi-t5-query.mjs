// T5 — full adapter-recon flow in ONE process (network capture only lives
// as long as the process): analyze (starts capture) -> click 查询 inside
// the same-origin iframe via main-frame evaluate -> network filter/detail
// to find the data API.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const DASH_URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-t5', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// fresh page for a clean analyze run
const opened = await call('space.open_tab', { url: DASH_URL })
console.log('open_tab full:', JSON.stringify(opened.structuredContent ?? {}).slice(0, 400), opened.isError === true ? `ERR: ${textOf(opened).slice(0, 400)}` : '')
let pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
if (typeof pageId !== 'number') {
  // fall back to tabs list
  const tabs = await call('tabs', { action: 'list' })
  const m = textOf(tabs).match(/"pageId"\s*:\s*(\d+)/g)
  console.log('tabs fallback:', textOf(tabs).slice(0, 400))
  const last = m ? m[m.length - 1].match(/(\d+)/) : null
  pageId = last ? Number(last[1]) : undefined
}
console.log(`pageId=${pageId}`)
if (typeof pageId !== 'number') process.exit(1)
await new Promise(r => setTimeout(r, 5000))

// 1. analyze — starts the capture on THIS process's page instance
const t0 = Date.now()
const analyzed = await call('analyze', { page: pageId, url: DASH_URL })
console.log(`analyze done (${Date.now() - t0}ms)${analyzed.isError === true ? ' ERR: ' + textOf(analyzed).slice(0, 300) : ''} — capture should be live now`)

// 2. click 查询 inside the iframe (act is blind to iframe content; evaluate is the only path)
const ev = await call('evaluate', {
  page: pageId,
  code: `const f = document.querySelector('iframe');
const d = f && f.contentDocument;
if (!d) return JSON.stringify({error: 'no iframe doc'});
const btns = [...d.querySelectorAll('button, div[role="button"], span')].filter(el => el.textContent.trim() === '查 询' || el.textContent.trim() === '查询');
if (btns.length === 0) return JSON.stringify({error: 'query button not found', candidates: [...d.querySelectorAll('button')].slice(0,5).map(b=>b.textContent.trim().slice(0,10))});
btns[0].click();
return JSON.stringify({clicked: true, matches: btns.length})`,
})
console.log('--- click 查询 via evaluate ---')
console.log(textOf(ev).slice(0, 300))

// wait for the query to fire its API
await new Promise(r => setTimeout(r, 4000))

// 3. network — what did the query fire?
const net = await call('network', { page: pageId })
console.log('--- network after query click ---')
console.log(textOf(net).slice(0, 1800))

// 4. structured entries — find the data API
const env = net.structuredContent ?? {}
const entries = env.entries ?? []
console.log(`--- ${entries.length} entries; urls ---`)
for (const e of entries.slice(0, 25)) {
  console.log(`  [${e.key}] ${e.method} ${String(e.url).slice(0, 110)} status=${e.status}`)
}

await client.close()
console.log('DONE')
process.exit(0)
