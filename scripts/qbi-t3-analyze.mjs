// T3 — two paths around the network-capture gap:
//   A) analyze tool (starts its own capture, navigates, classifies APIs)
//   B) same-origin iframe direct read via main-frame evaluate
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const DASH_URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-t3', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// reuse the qbi-tester space, find pageId 4 (or any)
let pageId = 4
const tabs = await call('tabs', { action: 'list' })
const m = textOf(tabs).match(/"pageId"\s*:\s*(\d+)/)
if (m) pageId = Number(m[1])
console.log(`pageId=${pageId}`)

// B first (before analyze navigates away): read the same-origin iframe content
const ev = await call('evaluate', {
  page: pageId,
  code: `const f = document.querySelector('iframe');
if (!f) return JSON.stringify({error: 'no iframe'});
const d = f.contentDocument;
if (!d) return JSON.stringify({error: 'contentDocument null'});
const canvases = d.querySelectorAll('canvas').length;
const texts = d.body ? d.body.innerText.replace(/\\s+/g, ' ').slice(0, 500) : '(no body)';
const charts = [...d.querySelectorAll('[class*="chart"], [class*="bi-"], canvas')].slice(0, 10).map(el => el.className.toString().slice(0, 60));
return JSON.stringify({canvases, textHead: texts, chartEls: charts})`,
})
console.log('--- iframe content (same-origin direct read) ---')
console.log(textOf(ev).slice(0, 700))

// A: analyze — navigates this page, starts capture, classifies
const t0 = Date.now()
const analyzed = await call('analyze', { page: pageId, url: DASH_URL })
console.log(`--- analyze (${Date.now() - t0}ms) ---`)
console.log(textOf(analyzed).slice(0, 2200))

// after analyze: does the network tool now see anything (capture was started by analyze)?
const net = await call('network', { page: pageId })
console.log('--- network after analyze ---')
console.log(textOf(net).slice(0, 900))

await client.close()
console.log('DONE')
process.exit(0)
