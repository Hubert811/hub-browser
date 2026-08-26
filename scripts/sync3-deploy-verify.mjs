// sync-3 deployment verification (fork sync routine step): drive the DEPLOYED
// hub (.app bundle) over MCP, confirm the claw harness reporter creates a
// session on the redeployed fork server (port from config.json). Reusable after every
// deploy-fork-app.sh run:
//   bun scripts/sync3-deploy-verify.mjs
// then check the newest session label `sync3-verify` on the server:
//   curl -s http://127.0.0.1:9210/api/v1/sessions
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const HUB_BIN = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub/bin/hub.mjs'
const BUN = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub/bin/bun-runtime'

const transport = new StdioClientTransport({
  command: BUN,
  args: [HUB_BIN, '--mcp'],
  env: {
    ...process.env,
    HUB_SPACES_FILE: '/tmp/sync3-smoke-spaces.json',
    HUB_SPACE_REAP: 'off',
    HUB_AUDIT: 'off',
    BROWSEROS_CDP_PORT: '9110',
  },
})
const client = new Client({ name: 'sync3-verify', version: '1.0.0' })
await client.connect(transport)
console.log('connected: deployed hub --mcp')

const { tools } = await client.listTools()
console.log(`tool surface: ${tools.length} tools (expect >= 43)`)

const r = await client.callTool({ name: 'tabs', arguments: { action: 'list' } })
const text = JSON.stringify(r.content)
console.log(`tabs list: isError=${r.isError === true} — ${text.slice(0, 100)}`)

await client.close()
// give the fire-and-forget reporter queue a moment to drain
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log('done')
