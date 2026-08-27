// Round 2, R2 — the adapter core loop against the iframe-hosted report:
//   snapshot (get AX refs incl. stitched iframe content) → act click the
//   查 询 button BY REF (impossible in round 1: AX was iframe-blind) →
//   diff confirms the DOM changed → network shows the olap/query POST with
//   timing that matches the click → detail carries the request body (C1).
// This is exactly the loop an adapter runs for "apply filters and query".
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const t0 = Date.now()
const at = (label) => console.log(`[t+${String(Date.now() - t0).padStart(5)}ms] ${label}`)

const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r2', HUB_SPACES_FILE: '/tmp/qbi-r2-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r2-act', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// open + settle
await call('space.create', { name: 'qbi-r2-act' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') {
  const tabs = await call('tabs', { action: 'list' })
  const m = textOf(tabs).match(/\[(\d+)\]/)
  pageId = m ? Number(m[1]) : undefined
}
if (typeof pageId !== 'number') throw new Error('no pageId')
at(`open pageId=${pageId}`)

for (let i = 0; i < 5; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const d = textOf(await call('diff', { page: pageId }))
  if (/no change/i.test(d)) { at('page stable'); break }
}

// network bare call — auto-starts capture (A2); count the baseline BEFORE the click
const net0 = await call('network', { page: pageId })
const n0 = net0.structuredContent?.count ?? 0
at(`network baseline (auto-started): ${n0} entries; hint=${JSON.stringify(net0.structuredContent?.startedNow ?? net0.structuredContent?.captureStarted ?? '?')}`)

// snapshot — find the 查 询 button ref (stitched from the iframe)
const snap = textOf(await call('snapshot', { page: pageId }))
const btnLine = snap.split('\n').find(l => /button\s+"查\s*询"/.test(l))
const refMatch = btnLine?.match(/\[ref=(e\d+)\]/)
at(`snapshot: ${snap.split('\n').length} lines; 查 询 → ${refMatch ? refMatch[1] : 'NOT FOUND'}`)
if (!refMatch) throw new Error('query button not in AX tree: ' + btnLine)
const btnRef = refMatch[1]

// THE ACT — click inside the iframe by AX ref
const clickT0 = Date.now()
const act = await call('act', { page: pageId, ref: btnRef, kind: 'click' })
const actText = textOf(act)
at(`act click ${btnRef}: isError=${act.isError === true}; ${actText.split('\n').slice(0, 3).join(' | ').slice(0, 220)}`)

// diff — did the DOM react?
await new Promise(r => setTimeout(r, 2500))
const d1 = textOf(await call('diff', { page: pageId }))
const diffLines = d1.split('\n').filter(l => l.trim()).length
at(`diff after click: ${/no change/i.test(d1) ? 'NO CHANGE (suspicious)' : diffLines + ' changed lines'}`)

// network — new requests since baseline?
const net1 = await call('network', { page: pageId })
const n1 = net1.structuredContent?.count ?? 0
at(`network after click: ${n1} entries (+${n1 - n0})`)

// find the olap/query POST and pull its detail (C1: request body)
const netText = textOf(net1)
const olapLines = netText.split('\n').filter(l => /olap\/query/.test(l))
console.log(`\nolap/query entries: ${olapLines.length}`)
for (const l of olapLines.slice(0, 3)) console.log('  ' + l.slice(0, 140))

let requestBodyProbe = 'none'
const keyMatch = olapLines[0]?.match(/\[key=(\w+)\]/) || netText.match(/key[":\s=]+(\w+)[^\n]*olap\/query/)
if (keyMatch) {
  const detail = await call('network', { page: pageId, detail: keyMatch[1] })
  const dt = textOf(detail)
  const bodyMatch = dt.match(/"requestBody"\s*:?\s*(\{[^]{0,120})/) || dt.match(/requestBody[^\n]{0,140}/)
  requestBodyProbe = bodyMatch ? bodyMatch[1].slice(0, 140) : 'no requestBody key in detail: ' + dt.slice(0, 100)
}
console.log(`\nC1 request body: ${requestBodyProbe}`)

// cleanup
await call('space.close', {})
at('space closed')
await client.close()
