// Round 2, R8 — event-level forensics on the custom filter field click.
// act click (e60, 行状态) dispatches fine but the dropdown never opens.
// Instrument the widget with mousedown/mouseup/click listeners AND record its
// viewport rect, then compare:
//   [a] what events actually arrived (and on which element)
//   [b] whether the widget is inside the iframe's visible scroll area
//   [c] a manual synthetic full sequence as a control — if the manual one
//       opens the dropdown, act's dispatch differs; if neither opens it, the
//       widget needs something else (hover? label click? double-click?).
// Reuses the standing tab; leaves it standing.
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
const client = new Client({ name: 'qbi-r8-events', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const jsonOf = (r) => { const t = textOf(r); const s = t.indexOf('{'); const e = t.lastIndexOf('}'); try { return JSON.parse(t.slice(s, e + 1)) } catch { return { parseFail: t.slice(0, 160) } } }

const tabs = textOf(await call('tabs', { action: 'list' }))
const pageId = Number(tabs.match(/\[(\d+)\]/)?.[1])
if (typeof pageId !== 'number') throw new Error('no tab')
at(`reusing tab pageId=${pageId}`)

// locate the field ref in the AX tree (anchor-0)
let fieldRef = null
for (let i = 0; i < 6; i++) {
  const snap = textOf(await call('snapshot', { page: pageId }))
  fieldRef = snap.match(/generic "行状态请选择（多选）" \[ref=(e\d+)\]/)?.[1]
  if (fieldRef) break
  await new Promise(r => setTimeout(r, 1500))
}
at(`field ref=${fieldRef}`)

// instrument: full pointer-event listeners on the whole iframe doc + widget geometry
const instrumented = await call('evaluate', {
  page: pageId, frame: 1,
  code: `window.__ev = [];
for (const t of ['pointerdown','mousedown','mouseup','click','dblclick']) {
  document.addEventListener(t, e => window.__ev.push({t, x:e.clientX, y:e.clientY, tag:e.target.tagName, cls:(e.target.className||'').toString().slice(0,36), txt:(e.target.textContent||'').trim().slice(0,16)}), true);
}
const fs=[...document.querySelectorAll('*')].filter(e=>/^(行状态请选择)/.test((e.textContent||'').trim())&&(e.offsetWidth||e.offsetHeight));
const w=fs[0];
const r=w?w.getBoundingClientRect():null;
return JSON.stringify({instrumented:true, widgetFound:!!w, rect:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}:null,
  inIframeViewport: r ? (r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) : null,
  scrollY: Math.round(scrollY), innerH: innerHeight,
  widgetCls: (w?.className||'').toString().slice(0,60)})`,
})
console.log('instrument:', JSON.stringify(jsonOf(instrumented)))

// THE ACT — click by AX ref
const act = await call('act', { page: pageId, ref: fieldRef, kind: 'click' })
at(`act click: isError=${act.isError === true}`)
await new Promise(r => setTimeout(r, 1000))

// read back the event log
const evLog = jsonOf(await call('evaluate', { page: pageId, frame: 1, code: `return JSON.stringify({events: window.__ev || []})` }))
console.log(`events arrived: ${JSON.stringify(evLog.events ?? []).slice(0, 400)}`)

// AX cross-check: dropdown options?
const snap2 = textOf(await call('snapshot', { page: pageId }))
console.log(`AX options after act click: ${snap2.split('\n').filter(l => /\boption\b|\blistbox\b/.test(l)).length}`)

// CONTROL — manual synthetic full sequence at the widget center
if (!(evLog.events ?? []).some(e => e.t === 'click')) {
  at('no click event reached the iframe — dispatch a manual one as control')
  const manual = jsonOf(await call('evaluate', {
    page: pageId, frame: 1,
    code: `const fs=[...document.querySelectorAll('*')].filter(e=>/^(行状态请选择)/.test((e.textContent||'').trim())&&(e.offsetWidth||e.offsetHeight));
const w=fs[0]; if(!w) return JSON.stringify({err:'no widget'});
const r=w.getBoundingClientRect(); const cx=r.x+r.width/2, cy=r.y+r.height/2;
const target=document.elementFromPoint(cx,cy)||w;
const opts={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy};
for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) target.dispatchEvent(new MouseEvent(t,opts));
return JSON.stringify({dispatchedAt:{cx:Math.round(cx),cy:Math.round(cy)},target:target.tagName+'.'+(target.className||'').toString().slice(0,30)})`,
  }))
  console.log('manual dispatch:', JSON.stringify(manual))
  await new Promise(r => setTimeout(r, 1000))
  const evLog2 = jsonOf(await call('evaluate', { page: pageId, frame: 1, code: `return JSON.stringify({events: (window.__ev||[]).slice(-6)})` }))
  console.log(`events after manual: ${JSON.stringify(evLog2.events ?? []).slice(0, 360)}`)
  const snap3 = textOf(await call('snapshot', { page: pageId }))
  console.log(`AX options after manual: ${snap3.split('\n').filter(l => /\boption\b|\blistbox\b/.test(l)).length}`)
  const dl = jsonOf(await call('evaluate', {
    page: pageId, frame: 1,
    code: `const sel='[class*="popup"],[class*="dropdown"]';
const ls=[...document.querySelectorAll(sel)].filter(e=>(e.offsetWidth||e.offsetHeight));
return JSON.stringify({visible:ls.length, txts:ls.slice(0,4).map(e=>(e.textContent||'').trim().slice(0,30))})`,
  }))
  console.log(`popup layers now: ${JSON.stringify(dl)}`)
}

at('done — tab left standing')
await client.close()
