// Round 2, R2c — instrumented click forensics. Installs capture-phase click
// listeners on BOTH documents (main frame + iframe), clicks the 查 询 button
// via act by AX ref, then reads back exactly where the click landed:
// which document, which viewport coordinates, which element. Also probes
// elementFromPoint at the iframe-local coords in the main viewport, and
// computes the button's true main-viewport position from the iframe offset.
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
const client = new Client({ name: 'qbi-r2c-instrument', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const jsonOf = (r) => { const t = textOf(r); const s = t.indexOf('{'); const e = t.lastIndexOf('}'); try { return JSON.parse(t.slice(s, e + 1)) } catch { return { parseFail: t.slice(0, 150) } } }

// open + settle
await call('space.create', { name: 'qbi-r2c' })
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

// locate button ref
const snap = textOf(await call('snapshot', { page: pageId }))
const btnRef = snap.split('\n').find(l => /button\s+"查\s*询"/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
at(`查 询 ref=${btnRef}`)
if (!btnRef) throw new Error('button not in AX tree')

// install click instrumentation on BOTH documents
await call('evaluate', {
  page: pageId,
  code: `window.__clicks = [];
document.addEventListener('click', e => window.__clicks.push({doc:'main', x:e.clientX, y:e.clientY, target:e.target.tagName, cls:(e.target.className||'').toString().slice(0,40)}), true);
return 'main instrumented'`,
})
await call('evaluate', {
  page: pageId, frame: 1,
  code: `window.__clicks = [];
document.addEventListener('click', e => window.__clicks.push({doc:'iframe', x:e.clientX, y:e.clientY, target:e.target.tagName, txt:(e.target.textContent||'').trim().slice(0,20)}), true);
return 'iframe instrumented'`,
})

// geometry: iframe rect in main viewport + button rect in iframe doc
const geo = jsonOf(await call('evaluate', {
  page: pageId,
  code: `const f=document.querySelector('iframe'); if(!f) return JSON.stringify({err:'no iframe'});
const r=f.getBoundingClientRect();
return JSON.stringify({iframeMainRect:{x:r.x,y:r.y,w:r.width,h:r.height},
  elementAt951_66: (()=>{const el=document.elementFromPoint(951,66); return el?el.tagName+'.'+(el.className||'').toString().slice(0,30):null})()})`,
}))
console.log('main-frame geometry:', JSON.stringify(geo))

const btnGeo = jsonOf(await call('evaluate', {
  page: pageId, frame: 1,
  code: `const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='查 询');
return JSON.stringify(b?{rect:b.getBoundingClientRect().toJSON()}:{err:'no btn'})`,
}))
console.log('iframe button rect:', JSON.stringify(btnGeo))

// THE ACT
const act = await call('act', { page: pageId, ref: btnRef, kind: 'click' })
at(`act click ${btnRef}: isError=${act.isError === true}`)

await new Promise(r => setTimeout(r, 1200))

// read back where the click landed
const mainClicks = jsonOf(await call('evaluate', { page: pageId, code: `return JSON.stringify(window.__clicks || [])` }))
const iframeClicks = jsonOf(await call('evaluate', { page: pageId, frame: 1, code: `return JSON.stringify(window.__clicks || [])` }))
console.log(`\nmain-frame clicks:  ${JSON.stringify(mainClicks)}`)
console.log(`iframe clicks:      ${JSON.stringify(iframeClicks)}`)

// cleanup with a timeout guard (space.close hung once already)
try {
  await Promise.race([
    call('space.close', {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('space.close timeout 15s')), 15000)),
  ])
  at('space closed')
} catch (e) {
  console.log(`space.close: ${String(e.message).slice(0, 80)} — leaving tab; manual cleanup needed`)
}
await client.close()
