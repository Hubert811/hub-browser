/**
 * Stdio MCP smoke: spawns `hub --mcp` and drives it with a real MCP client.
 * Run: BROWSEROS_CDP_PORT=9110 bun run src/browser-mcp/smoke-stdio-client.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['bin/hub.mjs', '--mcp'],
  cwd: projectRoot,
  env: {
    ...process.env,
    BROWSEROS_CDP_PORT: process.env.BROWSEROS_CDP_PORT ?? '9110',
  },
  stderr: 'pipe',
})

const client = new Client({ name: 'smoke-client', version: '0.0.1' })
await client.connect(transport)

const tools = await client.listTools()
console.log(`[stdio] tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`)

const tabs = await client.callTool({ name: 'tabs', arguments: { action: 'list' } })
const text = ((tabs.content ?? []) as Array<{ type: string; text?: string }>)
  .filter((c) => c.type === 'text')
  .map((c) => c.text ?? '')
  .join('\n')
console.log(`[stdio] tabs list isError=${tabs.isError} | ${text.split('\n')[0] ?? ''}`)

const snap = await client.callTool({ name: 'snapshot', arguments: { page: 1 } })
console.log(`[stdio] snapshot isError=${snap.isError}`)

await client.close()
console.log('[stdio] done')
