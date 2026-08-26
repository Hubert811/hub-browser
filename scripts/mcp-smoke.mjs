import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO_ROOT = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO_ROOT + '/bin/hub.mjs', '--mcp'],
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HUB_SPACES_FILE: '/tmp/smoke-spaces.json',
    HUB_SPACE_REAP: 'off',
    HUB_AUDIT: 'off',
    BROWSEROS_CDP_PORT: '9110',
  },
})
const client = new Client({ name: 'mcp-smoke', version: '1.0.0' })
await client.connect(transport)
console.log('connected: hub --mcp (client mcp-smoke)')

const ok = (label, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ' — ' + detail : ''))
  if (!cond) process.exitCode = 1
}

// 1. 工具面清单（43 工具应全注册）
const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
ok('tool surface', names.length >= 43, `${names.length} tools; replay=${names.includes('replay.list')},adapter=${names.includes('adapter.run')}`)

// 2. 真适配器 via MCP：adapter.run hackernews best
const r1 = await client.callTool({ name: 'adapter.run', arguments: { site: 'hackernews', command: 'best' } })
const text1 = JSON.stringify(r1.content)
ok('adapter.run hackernews best', r1.isError !== true, text1.slice(0, 120))

// 3. 真页面操作链：MCP 自己的身份建 space（space 按 owner 隔离——CLI 的 space 对 MCP 不可见是正确语义）→ open_tab → snapshot
const created = await client.callTool({ name: 'space.create', arguments: { name: 'mcp-smoke' } })
ok('space.create (MCP identity)', created.isError !== true, String(created.structuredContent?.space?.id ?? '').slice(0, 40))
const opened = await client.callTool({ name: 'space.open_tab', arguments: { url: 'https://news.ycombinator.com/' } })
ok('space.open_tab', opened.isError !== true, JSON.stringify(opened.structuredContent ?? {}).slice(0, 100))
const pageId = opened.structuredContent?.pageId
const snap = await client.callTool({ name: 'snapshot', arguments: { page: pageId } })
ok('snapshot', snap.isError !== true, `${String(JSON.stringify(snap.content)).length} bytes`)

// 4. replay.list（读 claw-server）
const rl = await client.callTool({ name: 'replay.list', arguments: { limit: 3 } })
ok('replay.list', rl.isError !== true, String(rl.content?.[0]?.text ?? '').slice(0, 100))

// 5. audit.query（本地审计面）
const aq = await client.callTool({ name: 'audit.query', arguments: { limit: 3 } })
ok('audit.query', aq.isError !== true, String(aq.content?.[0]?.text ?? '').slice(0, 80))

await client.close().catch(() => {})
console.log(process.exitCode ? '\nMCP SMOKE: FAILURES' : '\nMCP SMOKE: ALL PASS')
process.exit(process.exitCode || 0)
