// Verify the cursor-augment frame fix on the DEV tree: the 20+ QuickBI filter
// fields (unnamed-generic custom widgets, invisible before) should now appear
// in the AX snapshot as cursor-hit nodes WITH refs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO + '/bin/hub.mjs', '--mcp'],
  cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r5', HUB_SPACES_FILE: '/tmp/qbi-r5-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r5-verify', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
await call('space.create', { name: 'qbi-r5' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (/no change/i.test(textOf(await call('diff', { page: pageId })))) break
}
const snap = textOf(await call('snapshot', { page: pageId }))
const lines = snap.split('\n')
const filters = ['清单类型','行状态','是否成交','集团客户名称','客户代码','客户名称','销售团队','销售办事处','销售组','是否目录内','销售总监','销售经理','物料组','BD销售','大客户经理','询价创建时间']
console.log(`snapshot: ${lines.length} lines`)
let found = 0
for (const f of filters) {
  const hit = lines.find(l => l.includes(f) && /\[ref=e\d+\]/.test(l))
  if (hit) { found++; if (found <= 5) console.log(`  ✓ ${f}: ${hit.trim().slice(0, 120)}`) }
}
console.log(`filter labels visible WITH refs: ${found}/${filters.length}`)
const cursorHits = lines.filter(l => /cursor:pointer/.test(l)).length
console.log(`cursor:pointer-tagged nodes in tree: ${cursorHits}`)
const refCount = lines.filter(l => /\[ref=e\d+\]/.test(l)).length
console.log(`total refs: ${refCount}`)
try { await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 20000))]) } catch { }
await client.close()
