import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun', args: [REPO + '/bin/hub.mjs', '--mcp'], cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r6', HUB_SPACES_FILE: '/tmp/qbi-r6-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r9', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const tabs = textOf(await call('tabs', { action: 'list' }))
const pageId = Number(tabs.match(/\[(\d+)\]/)?.[1])
console.log(`pageId=${pageId}`)
// AX snapshot on dev tree — are the dropdown options visible with refs now?
const snap = textOf(await call('snapshot', { page: pageId }))
const lines = snap.split('\n')
const optLines = lines.filter(l => /Sales已报价|Sales退回|advance|option|listbox/.test(l))
console.log(`snapshot: ${lines.length} lines; option-ish lines: ${optLines.length}`)
for (const l of optLines.slice(0, 10)) console.log('  ' + l.trim().slice(0, 120))
// find the ref for the Sales已报价 option if present
const ref = optLines.find(l => /Sales已报价/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
console.log(`Sales已报价 option ref: ${ref ?? 'NOT IN AX'}`)
if (ref) {
  const act = await call('act', { page: pageId, ref, kind: 'click' })
  console.log(`act click option: isError=${act.isError === true}`)
  await new Promise(r => setTimeout(r, 1200))
  const sel = textOf(await call('evaluate', { page: pageId, frame: 1, code: `const f=[...document.querySelectorAll(".query-field-wrapper")].find(e=>(e.textContent||"").includes("行状态")); return JSON.stringify({selected:f?f.querySelector(".advance-select-input-selected-value,[class*=selected]")?.textContent?.trim().slice(0,30):"?", popoverOpen:!!document.querySelector(".ant-popover.advance-select-popup")})` }))
  const t = sel.slice(sel.indexOf('{'), sel.lastIndexOf('}') + 1)
  console.log(`field state after REAL click: ${t}`)
}
await client.close()
