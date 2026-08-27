import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun', args: [REPO + '/bin/hub.mjs', '--mcp'], cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r6', HUB_SPACES_FILE: '/tmp/qbi-r6-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r10', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const tabs = textOf(await call('tabs', { action: 'list' }))
const pageId = Number(tabs.match(/\[(\d+)\]/)?.[1])
const fieldState = async () => {
  const s = textOf(await call('evaluate', { page: pageId, frame: 1, code: `const f=[...document.querySelectorAll(".query-field-wrapper")].find(e=>(e.textContent||"").includes("行状态")); return JSON.stringify({selected:(f?.querySelector(".advance-select-input-selected-value,[class*=selected]")?.textContent||"").trim().slice(0,30), popoverOpen:!!document.querySelector(".ant-popover.advance-select-popup")})` }))
  return s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)
}

// locate option + confirm refs by EXACT line match (not substring-in-tooltip)
const snap = textOf(await call('snapshot', { page: pageId }))
const lines = snap.split('\n')
const optRef = lines.find(l => /^- generic "Sales已报价"/.test(l.trim()))?.match(/\[ref=(e\d+)\]/)?.[1]
const confirmRef = lines.find(l => /button "确 定"/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
console.log(`option ref=${optRef}, confirm ref=${confirmRef}`)

// network baseline
const net0 = await call('network', { page: pageId })
const n0 = net0.structuredContent?.count ?? 0
console.log(`network baseline: ${n0}`)

// 1) click the option (REAL CDP mouse via act)
let a1 = await call('act', { page: pageId, ref: optRef, kind: 'click' })
console.log(`click option: isError=${a1.isError === true}`)
await new Promise(r => setTimeout(r, 800))
console.log(`after option click: ${await fieldState()}`)

// 2) click 确 定
let a2 = await call('act', { page: pageId, ref: confirmRef, kind: 'click' })
console.log(`click confirm: isError=${a2.isError === true}`)
await new Promise(r => setTimeout(r, 800))
console.log(`after confirm: ${await fieldState()}`)

// 3) click 查 询 (re-snapshot for a fresh ref)
const snap2 = textOf(await call('snapshot', { page: pageId }))
const qRef = snap2.split('\n').find(l => /button "查\s*询"/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
let a3 = await call('act', { page: pageId, ref: qRef, kind: 'click' })
console.log(`click 查 询 (${qRef}): isError=${a3.isError === true}`)
await new Promise(r => setTimeout(r, 3000))

// 4) network: the olap/query POSTs, with requestBody carrying the filter
const net1 = await call('network', { page: pageId })
const entries = net1.structuredContent?.entries ?? []
const olap = entries.filter(e => /olap\/query/.test(String(e.url)))
console.log(`network: ${entries.length} entries, olap/query: ${olap.length}`)
if (olap.length > 0) {
  const d = await call('network', { page: pageId, detail: olap[0].key })
  const rb = d.structuredContent?.requestBody
  const rbStr = typeof rb === 'string' ? decodeURIComponent(rb) : JSON.stringify(rb)
  // does the request body carry the selected filter?
  const hasFilter = /Sales已报价|已报价/.test(rbStr)
  console.log(`requestBody carries the filter: ${hasFilter}`)
  console.log(`requestBody head: ${rbStr.slice(0, 300)}`)
}
await client.close()
