// Round 2, R2b — discriminate the two hypotheses for "olap/query = 0":
//   A) act click missed (iframe coordinate offset)  → no olap EVER, diff stays
//      empty, the +N entries are heartbeats/polling
//   B) close-too-early poisoned the read              → olap appears within a
//      longer observation window
// Click by AX ref, then poll network at 1s/3s/6s/10s printing EVERY new entry,
// plus diff at each checkpoint. Space closes only at the very end.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const t0 = Date.now()
const at = (label) => console.log(`[t+${String(Date.now() - t0).padStart(5)}ms] ${label}`)

const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r2', HUB_SPACES_FILE: '/tmp/qbi-r2-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r2b-timing', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// open + settle
await call('space.create', { name: 'qbi-r2b' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') {
  const tabs = await call('tabs', { action: 'list' })
  const m = textOf(tabs).match(/\[(\d+)\]/)
  pageId = m ? Number(m[1]) : undefined
}
if (typeof pageId !== 'number') throw new Error('no pageId')
at(`open pageId=${pageId}`)

for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const d = textOf(await call('diff', { page: pageId }))
  if (/no change/i.test(d)) { at('page stable'); break }
}

// capture baseline (auto-start), snapshot, locate the button
const net0 = await call('network', { page: pageId })
const baseCount = net0.structuredContent?.count ?? 0
const snap = textOf(await call('snapshot', { page: pageId }))
const btnLine = snap.split('\n').find(l => /button\s+"查\s*询"/.test(l))
const btnRef = btnLine?.match(/\[ref=(e\d+)\]/)?.[1]
at(`baseline=${baseCount}; 查 询 ref=${btnRef}`)
if (!btnRef) throw new Error('query button not in AX tree')

// ALSO capture the button's live geometry inside the iframe, to cross-check
// whether a click AT the reported point would land on the button (hypothesis A probe)
const geo = await call('evaluate', {
  page: pageId, frame: 1,
  code: `const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='查 询');
return JSON.stringify(b?{found:true,rect:b.getBoundingClientRect().toJSON(),visible:!!(b.offsetWidth||b.offsetHeight)}:{found:false})`,
})
const geoRaw = textOf(geo)
const geoJson = geoRaw.slice(geoRaw.indexOf('{'), geoRaw.lastIndexOf('}') + 1)
console.log(`button geometry in iframe: ${geoJson.slice(0, 220)}`)

// THE ACT
const act = await call('act', { page: pageId, ref: btnRef, kind: 'click' })
at(`act click ${btnRef}: isError=${act.isError === true}`)

// extended observation window: poll at 1/3/6/10s, print ALL new entries each time
let prevCount = baseCount
const checkpoints = [1000, 3000, 6000, 10000]
const clickT = Date.now()
for (const cp of checkpoints) {
  const elapsed = Date.now() - clickT
  if (elapsed < cp) await new Promise(r => setTimeout(r, cp - elapsed))
  const net = await call('network', { page: pageId })
  const count = net.structuredContent?.count ?? 0
  const nt = textOf(net)
  const lines = nt.split('\n').filter(l => /^\s*-\s*\[/.test(l) || /POST|GET/.test(l))
  const newOnes = lines.slice(prevCount > 0 ? Math.max(lines.length - (count - prevCount), 0) : lines.length - (count - prevCount))
  console.log(`\n[click+${cp}ms] network=${count} (+${count - prevCount})`)
  const allLines = nt.split('\n').filter(l => l.includes('://') || /POST|GET/.test(l))
  for (const l of allLines.slice(-Math.max(count - prevCount, 0)).slice(0, 12)) console.log('   ' + l.trim().slice(0, 130))
  prevCount = count
  const d = textOf(await call('diff', { page: pageId }))
  console.log(`   diff: ${/no change/i.test(d) ? 'no change' : d.split('\n').filter(x => x.trim()).length + ' lines changed'}`)
}

await call('space.close', {})
at('space closed')
await client.close()
