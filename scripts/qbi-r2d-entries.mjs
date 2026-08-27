// Round 2, R2d — the full adapter core loop, reading network entries from
// structuredContent (R2's bug: filtered the TEXT channel which carries no
// entries). Click 查 询 by AX ref → dump ALL captured entries → pull the
// olap/query detail incl. requestBody.
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
const client = new Client({ name: 'qbi-r2d-entries', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// open + settle
await call('space.create', { name: 'qbi-r2d' })
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
  if (/no change/i.test(d)) break
}

// baseline capture (auto-start)
const net0 = await call('network', { page: pageId })
const env0 = net0.structuredContent ?? {}
at(`baseline: count=${env0.count}, capture_started_now=${env0.capture_started_now === true}`)

// locate button + click by ref — RETRY the snapshot if the button is missing
// (B2 lazy-AX race probe: how often does the first snapshot miss iframe content?)
let btnRef
let snapLines = 0
for (let attempt = 1; attempt <= 3; attempt++) {
  const snap = textOf(await call('snapshot', { page: pageId }))
  snapLines = snap.split('\n').length
  btnRef = snap.split('\n').find(l => /button\s+"查\s*询"/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
  at(`snapshot attempt ${attempt}: ${snapLines} lines, 查 询 ref=${btnRef ?? 'MISSING'}`)
  if (btnRef) break
  await new Promise(r => setTimeout(r, 2000))
}
if (!btnRef) console.log('BUTTON STILL MISSING AFTER 3 ATTEMPTS — B2 race or real blindness')
const act = await call('act', { page: pageId, ref: btnRef, kind: 'click' })
at(`act click: isError=${act.isError === true}`)

await new Promise(r => setTimeout(r, 3000))

// dump ALL entries from structuredContent
const net1 = await call('network', { page: pageId })
const env1 = net1.structuredContent ?? {}
const entries = env1.entries ?? []
console.log(`\nnetwork after click: count=${env1.count}, entries listed=${entries.length}`)
for (const e of entries) {
  console.log(`  [${e.key}] ${e.method} ${String(e.url).slice(0, 90)} → ${e.status} (${e.size}B)`)
}

// olap/query detail + requestBody
const olap = entries.filter(e => /olap\/query/.test(String(e.url)))
console.log(`\nolap/query entries: ${olap.length}`)
if (olap.length > 0) {
  const detail = await call('network', { page: pageId, detail: olap[0].key })
  const dEnv = detail.structuredContent ?? {}
  console.log(`detail keys: ${Object.keys(dEnv).join(', ')}`)
  const rb = dEnv.requestBody
  console.log(`requestBody present: ${rb !== undefined && rb !== null}; type=${typeof rb}`)
  if (typeof rb === 'object' && rb) {
    const s = JSON.stringify(rb)
    console.log(`requestBody head: ${s.slice(0, 260)}`)
  } else if (typeof rb === 'string') {
    console.log(`requestBody head: ${rb.slice(0, 260)}`)
  }
  const body = dEnv.body
  const bs = typeof body === 'string' ? body : JSON.stringify(body)
  console.log(`response body head: ${(bs ?? '').slice(0, 180)}`)
}

// cleanup with timeout guard
try {
  await Promise.race([
    call('space.close', {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
  ])
  at('space closed')
} catch {
  console.log('space.close TIMED OUT (repro #3) — tab left behind for inspection')
}
await client.close()
