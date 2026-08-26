// T1 — QuickBI dashboard load-timing observation.
// One MCP process drives: open_tab -> immediate snapshot (early) ->
// repeated diff polls (mid) -> settled snapshot. Every step reports
// AX tree size, ref count, DOM-unit coverage, and DOM-diff signals,
// so we can judge whether "loading finished" is observable.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'

const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-timing', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

function snapshotStats(text) {
  const lines = text.split('\n')
  const refLines = lines.filter(l => /\[ref=e\d+\]/.test(l))
  const withUnit = refLines.filter(l => /→/.test(l))
  return { totalLines: lines.length, refCount: refLines.length, unitCount: withUnit.length }
}

// 1. create space + open the dashboard — t=0
const t0 = Date.now()
const created = await call('space.create', { name: 'qbi-timing' })
if (created.isError === true) {
  console.log('space.create failed:', textOf(created).slice(0, 300))
  process.exit(1)
}
const opened = await call('space.open_tab', { url: URL })
const pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
console.log(`[t+${Date.now() - t0}ms] open_tab -> pageId=${JSON.stringify(opened.structuredContent?.page ?? opened.structuredContent).slice(0, 120)}`)
if (typeof pageId !== 'number') {
  console.log('open_tab failed:', textOf(opened).slice(0, 300))
  process.exit(1)
}

// 2. immediate snapshot — what does the agent see BEFORE anything loads?
const snap1 = await call('snapshot', { page: pageId })
const s1 = snapshotStats(textOf(snap1))
console.log(`[t+${Date.now() - t0}ms] EARLY snapshot: ${s1.totalLines} lines, ${s1.refCount} refs, ${s1.unitCount} DOM units (${s1.refCount ? Math.round(s1.unitCount / s1.refCount * 100) : 0}%)`)

// 3. diff polls — watch the loading process
for (const waitMs of [2000, 3000, 3000]) {
  await new Promise(r => setTimeout(r, waitMs))
  const d = await call('diff', { page: pageId })
  const dt = textOf(d)
  const head = dt.split('\n').slice(0, 6).join(' | ')
  console.log(`[t+${Date.now() - t0}ms] DIFF (${waitMs}ms later): ${dt.length} chars — ${head.slice(0, 220)}`)
}

// 4. settled snapshot
const snap2 = await call('snapshot', { page: pageId })
const s2 = snapshotStats(textOf(snap2))
console.log(`[t+${Date.now() - t0}ms] SETTLED snapshot: ${s2.totalLines} lines, ${s2.refCount} refs, ${s2.unitCount} DOM units (${s2.refCount ? Math.round(s2.unitCount / s2.refCount * 100) : 0}%)`)

// 5. dump the settled AX tree head/tail for manual inspection
const full = textOf(snap2).split('\n')
console.log('--- settled AX head (first 25 lines) ---')
console.log(full.slice(0, 25).join('\n'))
console.log('--- settled AX tail (last 15 lines) ---')
console.log(full.slice(-15).join('\n'))

await client.close()
console.log('DONE')
process.exit(0)
