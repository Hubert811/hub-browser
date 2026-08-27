import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime', args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r4', HUB_SPACES_FILE: '/tmp/qbi-r4-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r4c', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
await call('space.create', { name: 'qbi-r4c' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (/no change/i.test(textOf(await call('diff', { page: pageId })))) break
}
const snap = textOf(await call('snapshot', { page: pageId }))
const lines = snap.split('\n')
// do the 20+ filter labels appear in the AX snapshot, with refs?
const filters = ['清单类型','行状态','是否成交','集团客户名称','客户代码','客户名称','销售团队','销售办事处','销售组','是否目录内','销售总监','销售经理','物料组','BD销售','大客户经理','询价创建时间']
console.log(`snapshot: ${lines.length} lines`)
let found = 0
for (const f of filters) {
  const hit = lines.find(l => l.includes(f) && /\[ref=e\d+\]/.test(l))
  if (hit) { found++; if (found <= 6) console.log(`  ✓ ${f}: ${hit.trim().slice(0, 110)}`) }
}
console.log(`filter labels visible WITH refs: ${found}/${filters.length}`)
// how many text-only (no ref) mentions?
let textOnly = 0
for (const f of filters) { if (lines.some(l => l.includes(f)) && !lines.some(l => l.includes(f) && /\[ref=e\d+\]/.test(l))) textOnly++ }
console.log(`filter labels present but WITHOUT refs: ${textOnly}`)
// also: role census of the whole tree
const roles = {}
for (const l of lines) { const m = l.match(/^\s*-\s*(\w+)/); if (m) roles[m[1]] = (roles[m[1]] || 0) + 1 }
console.log('role census:', JSON.stringify(roles))
try { await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 20000))]) } catch { }
await client.close()
