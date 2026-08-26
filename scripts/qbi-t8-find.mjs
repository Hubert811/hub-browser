// T8 — find/inspect on this site: does find reach inside the iframe? does
// inspect deepen a main-frame ref (the AX/DOM cooperation check)?
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const DASH_URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-t8', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

const opened = await call('space.open_tab', { url: DASH_URL })
const pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
await new Promise(r => setTimeout(r, 6000))
console.log(`pageId=${pageId}`)

// 1. find by CSS in the MAIN frame (sanity): the top-nav search input
const f1 = await call('find', { page: pageId, css: 'input.ant-input', limit: 3 })
console.log('--- find css=input.ant-input (main frame) ---')
console.log(textOf(f1).slice(0, 400))

// 2. find by CSS INSIDE the iframe: the 查询 button / filter selects
//    (query iframe DOM via a selector that only exists there)
const f2 = await call('find', { page: pageId, css: 'iframe .ant-select-selection-item', limit: 5 })
console.log('--- find css="iframe .ant-select-selection-item" (iframe content?) ---')
console.log(textOf(f2).slice(0, 500))

// 3. semantic find (role/text) for the 查 询 button
const f3 = await call('find', { page: pageId, text: '查 询', limit: 5 })
console.log('--- find text="查 询" ---')
console.log(textOf(f3).slice(0, 500))

// 4. inspect a main-frame ref (e9 was the 搜索菜单名称 input in T1)
const snap = await call('snapshot', { page: pageId })
const snapText = textOf(snap)
const refMatch = snapText.match(/\[ref=(e\d+)\][^\n]*搜索菜单名称/) || snapText.match(/\[ref=(e\d+)\][^\n]*→ input/)
const ref = refMatch ? refMatch[1] : 'e9'
console.log(`--- inspect ${ref} (main frame) ---`)
const insp = await call('inspect', { page: pageId, ref })
console.log(textOf(insp).slice(0, 700))

await client.close()
console.log('DONE')
process.exit(0)
