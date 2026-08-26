// T4 — frames tool behavior on the same-origin iframe + network drill-down
// to find the data API (the "write an adapter fast" critical path).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-t4', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

let pageId = 4
const tabs = await call('tabs', { action: 'list' })
const m = textOf(tabs).match(/"pageId"\s*:\s*(\d+)/)
if (m) pageId = Number(m[1])
console.log(`pageId=${pageId}`)

// 1. frames — does it list the same-origin dashboard iframe?
const frames = await call('frames', { page: pageId })
console.log('--- frames ---')
console.log(textOf(frames).slice(0, 500))

// 2. network overview — the 36 captured requests (shape preview)
const net = await call('network', { page: pageId })
console.log('--- network overview ---')
console.log(textOf(net).slice(0, 1200))

// 3. trigger a fresh query inside the iframe (click 查询) then diff the network
//    Actually: filter for data APIs first — QuickBI query APIs usually carry queryData / doQuery / dataset
const netF = await call('network', { page: pageId, filter: ['data'] })
console.log('--- network filter:["data"] ---')
console.log(textOf(netF).slice(0, 900))

await client.close()
console.log('DONE')
process.exit(0)
