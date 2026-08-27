// Round 2, R7 — anchor-driven interaction probe (user direction: reuse the
// standing tab, don't re-open/re-close; after each action, poll for the DOM
// ANCHOR that action should produce instead of sleeping blind).
//
// Question under test: clicking the custom filter field (行状态) reported
// success but the dropdown never showed in the AX tree. Where does the popup
// actually live? BI portals often mount dropdown portals OUTSIDE the iframe
// (or outside the region the AX renderer keeps). Anchor probe watches BOTH
// documents for popup-like layers before/after the click.
//
// Tab policy: REUSE the tab restored from the qbi-r6 space; do NOT close the
// space at the end (leave it standing for the next probe).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const t0 = Date.now()
const at = (label) => console.log(`[t+${String(Date.now() - t0).padStart(5)}ms] ${label}`)

const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO + '/bin/hub.mjs', '--mcp'],
  cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r6', HUB_SPACES_FILE: '/tmp/qbi-r6-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r7-anchor', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const jsonOf = (r) => { const t = textOf(r); const s = t.indexOf('{'); const e = t.lastIndexOf('}'); try { return JSON.parse(t.slice(s, e + 1)) } catch { return { parseFail: t.slice(0, 160) } } }

// [1] reuse the restored tab — anchor 0 is the filter field itself in the AX tree
const tabs = textOf(await call('tabs', { action: 'list' }))
const pageId = Number(tabs.match(/\[(\d+)\]/)?.[1])
if (typeof pageId !== 'number') throw new Error('no tab to reuse: ' + tabs.slice(0, 200))
at(`reusing tab pageId=${pageId}`)

let snap = '', fieldRef = null
for (let i = 0; i < 6; i++) {
  snap = textOf(await call('snapshot', { page: pageId }))
  fieldRef = snap.match(/generic "行状态请选择（多选）" \[ref=(e\d+)\]/)?.[1]
  if (fieldRef) break
  await new Promise(r => setTimeout(r, 1500))
}
at(`anchor-0 (field in AX tree): ${fieldRef ?? 'MISSING — snapshot has ' + snap.split('\n').length + ' lines'}`)
if (!fieldRef) throw new Error('field anchor missing; page state unknown')

// [2] popup-layer baseline in BOTH documents (the anchor probe payload)
const POPUP_PROBE = `(() => {
  const sel = '[class*="popup"],[class*="dropdown"],[class*="popover"],[class*="overlay"],[class*="modal"],[class*="panel-mask"]';
  const layers = [...document.querySelectorAll(sel)].filter(e => (e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== 'hidden');
  return { layers: layers.map(e => ({
    cls: (e.className || '').toString().slice(0, 60),
    txt: (e.textContent || '').trim().slice(0, 40),
  })).slice(0, 10) };
})()`
const probeLayer = (frame) => call('evaluate', { page: pageId, frame, code: `return JSON.stringify(${POPUP_PROBE})` })
const baseMain = jsonOf(await probeLayer(0)).layers ?? []
const baseFrame = jsonOf(await probeLayer(1)).layers ?? []
const cnt = (x) => Array.isArray(x) ? x.length : -1
at(`popup baseline: main-doc=${cnt(baseMain)} layers, iframe-doc=${cnt(baseFrame)} layers`)
console.log(`   main: ${JSON.stringify(baseMain).slice(0, 160)}`)

// [3] THE ACT — click 行状态 by AX ref
const act = await call('act', { page: pageId, ref: fieldRef, kind: 'click' })
at(`act click ${fieldRef}: isError=${act.isError === true}`)

// [4] ANCHOR POLL — watch both docs for a NEW popup layer (up to ~8s)
let anchorHit = null
for (let i = 1; i <= 13 && !anchorHit; i++) {
  await new Promise(r => setTimeout(r, 600))
  const m = jsonOf(await probeLayer(0)).layers ?? []
  const f = jsonOf(await probeLayer(1)).layers ?? []
  const newMain = m.filter(l => !baseMain.some(b => b.cls === l.cls && b.txt === l.txt))
  const newFrame = f.filter(l => !baseFrame.some(b => b.cls === l.cls && b.txt === l.txt))
  if (newMain.length || newFrame.length) {
    anchorHit = { round: i, newMain, newFrame }
    break
  }
  if (i % 3 === 0) at(`anchor poll #${i}: main=${cnt(m)} iframe=${cnt(f)} — no new layer yet`)
}
if (anchorHit) {
  at(`ANCHOR HIT (round ${anchorHit.round}): main +${anchorHit.newMain.length}, iframe +${anchorHit.newFrame.length}`)
  for (const l of anchorHit.newMain.slice(0, 4)) console.log(`   main: cls=${l.cls} txt=${l.txt}`)
  for (const l of anchorHit.newFrame.slice(0, 4)) console.log(`   iframe: cls=${l.cls} txt=${l.txt}`)
} else {
  at('ANCHOR MISS after ~8s — no new popup layer in either document. The click did not open the dropdown.')
}

// [5] cross-check: does the AX tree see any listbox/option now?
const snap2 = textOf(await call('snapshot', { page: pageId }))
const optionLines = snap2.split('\n').filter(l => /\boption\b|\blistbox\b/.test(l))
console.log(`\nAX tree option/listbox lines: ${optionLines.length}`)
for (const l of optionLines.slice(0, 6)) console.log('  ' + l.trim().slice(0, 110))

// [6] if the anchor missed, inspect what the field element itself thinks happened
if (!anchorHit) {
  const state = jsonOf(await call('evaluate', {
    page: pageId, frame: 1,
    code: `const fs=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').trim().startsWith('行状态')&&(e.offsetWidth||e.offsetHeight));
const hit=fs[fs.length-1];
let w=hit; for(let k=0;k<6&&w;k++){const s=getComputedStyle(w);if(s.cursor==='pointer'||w.onclick)break;w=w.parentElement}
return JSON.stringify({hits:fs.length, widgetCls:(w?.className||'').toString().slice(0,70), widgetHasPopup:w?!!w.querySelector('[class*="popup"],[class*="dropdown"]'):null})`,
  }))
  console.log(`field state probe: ${JSON.stringify(state).slice(0, 220)}`)
}

// leave the tab standing (user direction) — just disconnect
at('done — tab left standing for the next probe')
await client.close()
