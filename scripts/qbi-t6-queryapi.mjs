// T6 — same one-process flow, but dump ALL entries (esp. the tail after
// the 查询 click) + verify the click result + drill into the data API body.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const DASH_URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-t6', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

const opened = await call('space.open_tab', { url: DASH_URL })
const pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
console.log(`pageId=${pageId}`)
await new Promise(r => setTimeout(r, 5000))

// baseline count
await call('analyze', { page: pageId, url: DASH_URL })
const net0 = await call('network', { page: pageId })
const baseCount = net0.structuredContent?.count ?? 0
console.log(`baseline after analyze: ${baseCount} requests`)

// click 查询 (dump the click result this time)
const ev = await call('evaluate', {
  page: pageId,
  code: `const f = document.querySelector('iframe');
const d = f && f.contentDocument;
if (!d) return JSON.stringify({error: 'no iframe doc'});
const btns = [...d.querySelectorAll('button, div[role="button"], span')].filter(el => el.textContent.trim() === '查 询' || el.textContent.trim() === '查询');
if (btns.length === 0) return JSON.stringify({error: 'query button not found'});
btns[0].click();
return JSON.stringify({clicked: true, matches: btns.length})`,
})
const evText = textOf(ev)
console.log('click result:', evText.replace(/\[UNTRUSTED_PAGE_CONTENT[^\]]*\]\s*|\[END_UNTRUSTED_PAGE_CONTENT\]/g, '').trim().slice(0, 200))

await new Promise(r => setTimeout(r, 5000))

// full list, tail emphasized
const net = await call('network', { page: pageId })
const entries = net.structuredContent?.entries ?? []
console.log(`--- all ${entries.length} entries (NEW ones after #${baseCount} marked *) ---`)
for (let i = 0; i < entries.length; i++) {
  const e = entries[i]
  const mark = i >= baseCount ? '*' : ' '
  console.log(`${mark} [${e.key}] ${e.method} ${String(e.url).replace('https://quickbi.zkh360.com', '').slice(0, 100)} status=${e.status}`)
}

// find the data query API: usually carries queryData / doQuery / renderModel
const dataEntries = entries.filter(e => /query|data|render|dataset|excel/i.test(String(e.url)) && !/batchDisplay|queryConfig|watermark/.test(String(e.url)))
console.log(`--- data-API candidates (${dataEntries.length}) ---`)
for (const e of dataEntries.slice(0, 8)) {
  console.log(`  [${e.key}] ${e.method} ${String(e.url).slice(0, 130)}`)
}

// detail on the first candidate (full body)
if (dataEntries.length > 0) {
  const det = await call('network', { page: pageId, detail: dataEntries[dataEntries.length - 1].key })
  console.log(`--- detail [${dataEntries[dataEntries.length - 1].key}] ---`)
  console.log(textOf(det).slice(0, 1500))
}

await client.close()
console.log('DONE')
process.exit(0)
