// T2b — workaround path: read the iframe src from the main frame, then
// open the dashboard URL directly (it may be a standalone page), and
// capture the network traffic to find the data APIs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-tester', HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-frames-b', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// stable identity (HUB_AGENT_ID) — reuse the space across this script run
const spaces = await call('space.list', {})
console.log('--- spaces (HUB_AGENT_ID=qbi-tester) ---')
console.log(textOf(spaces).slice(0, 400))

// find a tab from the earlier run or open fresh
let pageId
const tabs = await call('tabs', { action: 'list' })
const tabText = textOf(tabs)
const m = tabText.match(/"pageId"\s*:\s*(\d+)/)
if (m) {
  pageId = Number(m[1])
  console.log(`reusing pageId=${pageId}`)
} else {
  const created = await call('space.create', { name: 'qbi-timing' })
  console.log('space.create:', JSON.stringify(created.structuredContent ?? {}).slice(0, 200), created.isError === true ? `ERR: ${textOf(created).slice(0, 200)}` : '')
  const opened = await call('space.open_tab', { url: 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08' })
  console.log('open_tab structured:', JSON.stringify(opened.structuredContent ?? {}).slice(0, 300), opened.isError === true ? `ERR: ${textOf(opened).slice(0, 300)}` : '')
  pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
  if (typeof pageId !== 'number') {
    console.log('FATAL: no pageId')
    await client.close()
    process.exit(1)
  }
  await new Promise(r => setTimeout(r, 6000))
  console.log(`opened pageId=${pageId}, waited 6s for load`)
}

// 1. main-frame evaluate: iframe src + any same-origin reachability
const ev = await call('evaluate', {
  page: pageId,
  code: `const ifr = [...document.querySelectorAll('iframe')].map(f => ({src: (f.src||'').slice(0,180), name: f.name, w: f.clientWidth, h: f.clientHeight}));
let cross = 'unknown';
try { const d = document.querySelector('iframe')?.contentDocument; cross = d === null ? 'cross-origin' : (d ? 'same-origin' : 'none'); } catch(e) { cross = 'cross-origin(err)'; }
return JSON.stringify({iframes: ifr, firstFrameAccess: cross})`,
})
console.log('--- main-frame iframe probe ---')
console.log(textOf(ev).slice(0, 600))

// 2. network — what data APIs has the dashboard fired?
await new Promise(r => setTimeout(r, 1500))
const net = await call('network', { page: pageId })
console.log('--- network capture (first 1500 chars) ---')
console.log(textOf(net).slice(0, 1500))

await client.close()
console.log('DONE')
process.exit(0)
