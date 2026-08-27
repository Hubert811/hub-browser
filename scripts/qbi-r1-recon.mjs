// Round 2, R1 — full cold-start recon exactly as an agent would do it on
// first contact with the page (deployed v0.2.3 build):
//   [1] open tab, snapshot EARLY (does the lazy-AX race from round 1 recur?)
//   [2] diff-poll to stable; count AX/DOM units on the stable tree
//   [3] is the iframe content stitched? (search for the 查 询 button + a combobox)
//   [4] frames list (A5: all frames labeled)
//   [5] evaluate frame=1 — the A1 path (round 1 needed hand-written
//       contentDocument JS; now it should be a plain parameter)
// Cleanup: close the tab before exit (round-1 leftover lesson).
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
const client = new Client({ name: 'qbi-r1-recon', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

function snapshotStats(text) {
  const lines = text.split('\n')
  const refLines = lines.filter(l => /\[ref=e\d+\]/.test(l))
  const withUnit = refLines.filter(l => /→/.test(l))
  return { totalLines: lines.length, refCount: refLines.length, unitCount: withUnit.length }
}

// [1] space + open + EARLY snapshot
const sp = await call('space.create', { name: 'qbi-r1-recon' })
const open = await call('space.open_tab', { url: URL })
console.log('open_tab structuredContent:', JSON.stringify(open.structuredContent ?? {}).slice(0, 300))
let pageId = open?.structuredContent?.page?.pageId ?? open?.structuredContent?.pageId
if (typeof pageId !== 'number') {
  const tabs = await call('tabs', { action: 'list' })
  const tt = textOf(tabs)
  const m = tt.match(/\[(\d+)\]/)
  pageId = m ? Number(m[1]) : undefined
}
if (typeof pageId !== 'number') throw new Error('no pageId: ' + textOf(open).slice(0, 200))
at(`open_tab pageId=${pageId}`)

const early = await call('snapshot', { page: pageId })
const earlyStats = snapshotStats(textOf(early))
at(`EARLY snapshot: ${earlyStats.totalLines} lines, ${earlyStats.refCount} refs, ${earlyStats.unitCount} DOM units (${Math.round(earlyStats.unitCount / Math.max(earlyStats.refCount, 1) * 100)}%)`)

// [2] diff-poll to stable
let stable = false
let lastDiff = ''
for (let i = 0; i < 4; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const d = await call('diff', { page: pageId })
  const dt = textOf(d)
  const changing = !/no change/i.test(dt)
  at(`diff #${i + 1}: ${changing ? 'CHANGING — ' + dt.split('\n').filter(l => l.trim()).length + ' lines' : 'stable'}`)
  if (!changing) { stable = true; break }
  lastDiff = dt
}

const snap = await call('snapshot', { page: pageId })
const snapText = textOf(snap)
const stats = snapshotStats(snapText)
at(`STABLE snapshot: ${stats.totalLines} lines, ${stats.refCount} refs, ${stats.unitCount} DOM units (${Math.round(stats.unitCount / Math.max(stats.refCount, 1) * 100)}%)`)

// [3] iframe stitch check — do the report's controls live in the AX tree?
const queryBtn = snapText.split('\n').find(l => /button\s+"查\s*询"/.test(l))
const iframeLineIdx = snapText.split('\n').findIndex(l => l.trim().startsWith('- iframe'))
const comboCount = (snapText.match(/combobox/g) || []).length
console.log(`\n[3] iframe stitch: iframe line at ${iframeLineIdx}; combobox count=${comboCount}`)
console.log(`    查 询 button in AX tree: ${queryBtn ? 'YES → ' + queryBtn.trim().slice(0, 100) : 'NO (blind)'}`)
console.log(`    early-vs-stable refs: ${earlyStats.refCount} → ${stats.refCount}`)

// [4] frames
const fr = await call('frames', { page: pageId })
console.log(`\n[4] frames:\n${textOf(fr)}`)

// [5] evaluate frame=1 (the A1 path)
const ev = await call('evaluate', {
  page: pageId, frame: 1,
  code: `return JSON.stringify({url: location.href.slice(0, 60), title: document.title, inputs: document.querySelectorAll('input').length, selects: document.querySelectorAll('.ant-select').length})`,
})
const evRaw = textOf(ev)
const evJson = evRaw.slice(evRaw.indexOf('{'), evRaw.lastIndexOf('}') + 1)
let inside = null
try { inside = JSON.parse(evJson) } catch { }
console.log(`\n[5] evaluate frame=1: ${inside ? JSON.stringify(inside) : 'PARSE FAIL: ' + evRaw.slice(0, 120)}`)

// cleanup: close the tab we opened
await call('space.close', {})
at('space closed (tab cleaned up)')
await client.close()
