import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun', args: [REPO + '/bin/hub.mjs', '--mcp'], cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r6', HUB_SPACES_FILE: '/tmp/qbi-r6-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r11', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const tabs = textOf(await call('tabs', { action: 'list' }))
const pageId = Number(tabs.match(/\[(\d+)\]/)?.[1])
// auto-start capture
await call('network', { page: pageId })
// click 查 询
const snap = textOf(await call('snapshot', { page: pageId }))
const qRef = snap.split('\n').find(l => /button "查\s*询"/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
console.log(`query ref=${qRef}`)
await call('act', { page: pageId, ref: qRef, kind: 'click' })
// poll network for up to 12s — anchor-driven (the olap POST is the anchor)
for (let i = 1; i <= 6; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const net = await call('network', { page: pageId })
  const entries = net.structuredContent?.entries ?? []
  const olap = entries.filter(e => /olap\/query/.test(String(e.url)))
  console.log(`poll ${i}: ${entries.length} entries, olap=${olap.length}`)
  if (olap.length > 0) {
    const d = await call('network', { page: pageId, detail: olap[0].key })
    const rb = d.structuredContent?.requestBody
    const rbStr = typeof rb === 'string' ? decodeURIComponent(rb) : JSON.stringify(rb ?? '')
    console.log(`requestBody has filter(已报价): ${/已报价/.test(rbStr)}`)
    const m = rbStr.match(/[^&]*已报价[^&]*/)
    console.log(`filter fragment: ${(m ?? ['(not found)'])[0].slice(0, 200)}`)
    break
  }
}
await client.close()
