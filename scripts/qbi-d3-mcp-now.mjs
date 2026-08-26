// Is the MCP snapshot path returning the stitched tree on a LOADED page?
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-d3', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

const tabs = await call('tabs', { action: 'list' })
const t = textOf(tabs)
console.log('tabs:', t.slice(0, 300))
const m = t.match(/\[(\d+)\]/)
const pageId = m ? Number(m[1]) : null
console.log('pageId =', pageId)

const snap = await call('snapshot', { page: pageId })
const lines = textOf(snap).split('\n')
const iframeIdx = lines.findIndex(l => l.trim().startsWith('- iframe'))
console.log(`MCP snapshot: ${lines.length} lines; iframe at ${iframeIdx}`)
console.log('after iframe (first 6):')
for (const l of lines.slice(iframeIdx + 1, iframeIdx + 7)) console.log(`  ${l.slice(0, 85)}`)
await client.close()
process.exit(0)
