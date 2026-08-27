// Round 2, R3 — remaining probes:
//   [1] find on iframe content (round-1 finding: find was main-frame-only;
//       did any of the fixes change that?)
//   [2] inspect an iframe AX ref (e59-style) — does the deep-dive work for
//       stitched nodes?
//   [3] cockpit reporting: do THIS session's dispatches land on the claw
//       server (port fix verification from the agent's perspective)?
//   [4] space.close hang discriminator: run evaluate {frame:1} first —
//       both observed hangs followed frame-evaluations.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const t0 = Date.now()
const at = (label) => console.log(`[t+${String(Date.now() - t0).padStart(5)}ms] ${label}`)

const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r3', HUB_SPACES_FILE: '/tmp/qbi-r3-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r3-coverage', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

await call('space.create', { name: 'qbi-r3' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') {
  const tabs = await call('tabs', { action: 'list' })
  pageId = Number(textOf(tabs).match(/\[(\d+)\]/)?.[1])
}
if (typeof pageId !== 'number') throw new Error('no pageId')
at(`open pageId=${pageId}`)
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const d = textOf(await call('diff', { page: pageId }))
  if (/no change/i.test(d)) { at('stable'); break }
}

// snapshot with retry (B2-residual guard), locate button + a combobox
let btnRef, snap
for (let i = 0; i < 3; i++) {
  snap = textOf(await call('snapshot', { page: pageId }))
  btnRef = snap.split('\n').find(l => /button\s+"查\s*询"/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
  if (btnRef) break
  at(`snapshot retry ${i + 1} — button missing`)
}
const comboRef = snap.split('\n').find(l => /combobox/.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
at(`btn=${btnRef} combo=${comboRef}`)

// [1] find — can it reach iframe content?
const findMain = await call('find', { page: pageId, css: 'input' })
const findCombo = await call('find', { page: pageId, css: '.ant-select' })
console.log(`\n[1] find css=input (main doc): ${textOf(findMain).split('\n').slice(0, 3).join(' | ').slice(0, 200)}`)
console.log(`    find css=.ant-select (iframe content): ${textOf(findCombo).split('\n').slice(0, 3).join(' | ').slice(0, 200)}`)

// [2] inspect the iframe-hosted button by ref
if (btnRef) {
  const insp = await call('inspect', { page: pageId, ref: btnRef })
  const it = textOf(insp)
  console.log(`\n[2] inspect ${btnRef} (iframe button): isError=${insp.isError === true}`)
  console.log('    ' + it.split('\n').slice(0, 6).join('\n    ').slice(0, 500))
}

// [4] space.close hang discriminator — evaluate in frame FIRST
const ev = await call('evaluate', {
  page: pageId, frame: 1,
  code: `return JSON.stringify({probe: 'frame-eval-before-close', inputs: document.querySelectorAll('input').length})`,
})
at(`frame evaluate done: ${textOf(ev).slice(0, 80)}`)

// [3] cockpit check happens after close attempt; first the timed close
const closeT0 = Date.now()
try {
  await Promise.race([
    call('space.close', {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HANG')), 20000)),
  ])
  at(`space.close OK in ${Date.now() - closeT0}ms`)
} catch (e) {
  at(`space.close ${String(e.message)} after ${Date.now() - closeT0}ms — CORRELATION CONFIRMED (hang follows frame-evaluate)`)
}

// [3] cockpit: did this session report? read the claw server sessions
await new Promise(r => setTimeout(r, 2500))
try {
  const sessions = await fetch('http://127.0.0.1:9211/api/v1/sessions').then(r => r.json())
  const mine = (sessions.items ?? []).filter(s => (s.startedAt ?? 0) > t0 - 60_000)
  console.log(`\n[3] cockpit sessions from the last minute: ${mine.length}`)
  for (const s of mine.slice(0, 3)) {
    console.log(`    label=${s.label} dispatches=${s.dispatchCount} tools=${JSON.stringify((s.toolSequence ?? []).slice(0, 8))} status=${s.status}`)
  }
} catch (e) {
  console.log(`[3] cockpit read failed: ${e.message}`)
}
await client.close()
