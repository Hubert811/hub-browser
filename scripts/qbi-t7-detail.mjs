// T7 — drill into olap/query's full request+response body (the adapter
// contract), and check the detail envelope's completeness.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const DASH_URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-t7', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

const opened = await call('space.open_tab', { url: DASH_URL })
const pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
await new Promise(r => setTimeout(r, 5000))

// warm the capture + fire a query
await call('analyze', { page: pageId, url: DASH_URL })
await call('evaluate', {
  page: pageId,
  code: `const d = document.querySelector('iframe')?.contentDocument;
const btns = d ? [...d.querySelectorAll('button, div[role="button"], span')].filter(el => el.textContent.trim() === '查 询' || el.textContent.trim() === '查询') : [];
if (btns.length) btns[0].click();
return JSON.stringify({clicked: btns.length > 0})`,
})
await new Promise(r => setTimeout(r, 5000))

const net = await call('network', { page: pageId })
const entries = (net.structuredContent?.entries ?? []).filter(e => /olap\/query/.test(String(e.url)))
console.log(`olap entries: ${entries.length} (of ${net.structuredContent?.count ?? 0} total)`)
for (const e of entries) console.log(`  [${e.key}] ${e.method} ${String(e.url).slice(0, 90)}`)

// detail on the LAST olap/query (the click-triggered one)
const keys = net.structuredContent?.keys ?? entries.map(e => e.key)
const targetKey = entries.length > 0 ? entries[entries.length - 1].key : null
if (!targetKey) { console.log('no olap entry'); process.exit(1) }
const det = await call('network', { page: pageId, detail: targetKey })
const sc = det.structuredContent ?? {}
console.log(`--- detail [${targetKey}] structured keys: ${Object.keys(sc).join(', ')}`)
// request body + response body preview
const reqBody = sc.requestBody ?? sc.request ?? sc.requestPreview ?? null
const respBody = sc.body ?? sc.responseBody ?? sc.response ?? null
console.log('--- request body (first 1200 chars) ---')
console.log(typeof reqBody === 'string' ? reqBody.slice(0, 1200) : JSON.stringify(reqBody)?.slice(0, 1200))
console.log('--- response body (first 900 chars) ---')
console.log(typeof respBody === 'string' ? respBody.slice(0, 900) : JSON.stringify(respBody)?.slice(0, 900))

await client.close()
console.log('DONE')
process.exit(0)
