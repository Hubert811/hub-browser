// v0.2.1 deployment spot check: the strict input schemas (upstream #2432
// parity) must be live in the DEPLOYED hub — a misspelled argument is
// rejected instead of silently dropped.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_SPACES_FILE: '/tmp/v021-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'v021-strict-check', version: '1.0.0' })
await client.connect(transport)

// 1. typo argument must be REJECTED (before 0.2.1 it was silently dropped)
const typo = await client.callTool({ name: 'tabs', arguments: { action: 'list', pagee: 1 } })
const typoRejected = typo.isError === true || /unrecognized|invalid|unknown/i.test(JSON.stringify(typo.content))
console.log(`${typoRejected ? 'PASS' : 'FAIL'}  typo arg rejected: ${JSON.stringify(typo.content).slice(0, 140)}`)

// 2. nested typo (screenshot size heigth) must be REJECTED
const nested = await client.callTool({ name: 'screenshot', arguments: { page: 1, size: { width: 100, heigth: 200 } } })
const nestedRejected = nested.isError === true || /unrecognized|invalid|unknown/i.test(JSON.stringify(nested.content))
console.log(`${nestedRejected ? 'PASS' : 'FAIL'}  nested typo rejected`)

// 3. valid call still works
const ok = await client.callTool({ name: 'tabs', arguments: { action: 'list' } })
console.log(`${ok.isError !== true ? 'PASS' : 'FAIL'}  valid args still work`)

await client.close()
process.exit(typoRejected && nestedRejected && ok.isError !== true ? 0 : 1)
