import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime', args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r4', HUB_SPACES_FILE: '/tmp/qbi-r4-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r4d', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
await call('space.create', { name: 'qbi-r4d' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (/no change/i.test(textOf(await call('diff', { page: pageId })))) break
}
const snap = textOf(await call('snapshot', { page: pageId }))
const lines = snap.split('\n')
const iframeIdx = lines.findIndex(l => l.trim().startsWith('- iframe'))
console.log(`=== iframe line at ${iframeIdx}; content after it (all ${lines.length - iframeIdx - 1} lines): ===`)
for (const l of lines.slice(iframeIdx, iframeIdx + 45)) console.log(l.slice(0, 130))
try { await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 20000))]) } catch { }
await client.close()
