/**
 * Phase 3 MCP stdio smoke: spawns `hub --mcp` (wired with the shared
 * TaskSpaceManager + identity) and exercises space.create / space.list /
 * guarded snapshot through a real MCP client.
 *
 * Run: BROWSEROS_CDP_PORT=9110 HUB_SPACES_FILE=/tmp/... bun tests/phase3-space-mcp-smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['bin/hub.mjs', '--mcp'],
  cwd: projectRoot,
  env: {
    ...process.env,
    BROWSEROS_CDP_PORT: process.env.BROWSEROS_CDP_PORT ?? '9110',
    HUB_AGENT_ID: 'mcp-smoke-agent',
    HUB_SPACES_FILE: process.env.HUB_SPACES_FILE ?? '/tmp/hub-spaces-mcp-smoke.json',
  },
  stderr: 'pipe',
})

const client = new Client({ name: 'phase3-smoke-client', version: '0.0.1' })
await client.connect(transport)

const tools = await client.listTools()
const spaceTools = tools.tools.filter((t) => t.name.startsWith('space.'))
console.log(`[stdio] space tools (${spaceTools.length}): ${spaceTools.map((t) => t.name).join(', ')}`)

const created = await client.callTool({
  name: 'space.create',
  arguments: { name: `mcp-smoke-${Date.now()}` },
})
const createdText = ((created.content ?? []) as Array<{ type: string; text?: string }>)
  .filter((c) => c.type === 'text')
  .map((c) => c.text ?? '')
  .join('\n')
console.log(`[stdio] space.create isError=${created.isError} | ${createdText.split('\n')[0]}`)

const listed = await client.callTool({ name: 'space.list', arguments: {} })
console.log(`[stdio] space.list isError=${listed.isError} | count=${(listed.structuredContent as { count?: number } | undefined)?.count}`)

const current = await client.callTool({ name: 'space.current', arguments: {} })
const spaceId = (current.structuredContent as { space?: { id?: string } } | undefined)?.space?.id
console.log(`[stdio] space.current isError=${current.isError} | spaceId=${spaceId}`)

await client.close()
console.log('[stdio] done')
