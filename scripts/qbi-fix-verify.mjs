// Fix verification: drive the DEV tree hub over MCP against the live
// QuickBI page and check every fix from the test round:
//   A1  evaluate {frame} lands INSIDE the iframe
//   A2  bare `network` auto-starts capture (no more silent "Captured 0")
//   B1  capture survives page-instance rebuilds within the process
//   A5  frames labels main/same-origin/cross-origin
//   C1  detail exposes requestBody for the olap/query POST
//   A3  analyze pattern renders "A/B/C/D (reason)", not [object Object]
//   A4  find renders tag + attrs, not empty entries
//   C4  data: URIs filtered out of the default network view
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO + '/bin/hub.mjs', '--mcp'],
  cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-fixcheck', HUB_SPACES_FILE: '/tmp/qbi-fix-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-fixcheck', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const results = []
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  results.push(cond)
}

// fresh page
await call('space.create', { name: 'qbi-fixcheck' })
const opened = await call('space.open_tab', { url: URL })
const pageId = opened.structuredContent?.page?.pageId ?? opened.structuredContent?.pageId
check('open page', typeof pageId === 'number', `pageId=${pageId}`)
await new Promise(r => setTimeout(r, 7000))

// A5: frames with kinds
const fr = await call('frames', { page: pageId })
const frText = textOf(fr)
check('A5 frames labels', frText.includes('(main)') && frText.includes('(same-origin)'), frText.split('\n').filter(l => l.startsWith('- [')).join(' | ').slice(0, 160))

// A1: evaluate INSIDE the iframe (frame 1)
const ev = await call('evaluate', {
  page: pageId, frame: 1,
  code: `return JSON.stringify({url: location.href.slice(0, 60), title: document.title, hasQueryBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('查'))})`,
})
const evRaw = textOf(ev)
const evJson = evRaw.slice(evRaw.indexOf('{'), evRaw.lastIndexOf('}') + 1)
let inFrame = false
try { inFrame = JSON.parse(evJson).url.includes('dashboard/view') } catch {}
check('A1 evaluate frame=1 lands inside iframe', inFrame, evJson.slice(0, 140))

// A2: bare network on a fresh process — must auto-start and hint
const net1 = await call('network', { page: pageId })
const env1 = net1.structuredContent ?? {}
check('A2 network auto-start hints', env1.capture_started_now === true || (env1.count ?? 0) > 0, `count=${env1.count} startedNow=${env1.capture_started_now}`)

// click 查询 via frame evaluate (A1 makes this natural now), then network grows
await call('evaluate', {
  page: pageId, frame: 1,
  code: `const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.replace(/\\s/g,'') === '查询'); if (btns.length) { btns[0].click(); return 'clicked' } return 'no button'`,
})
await new Promise(r => setTimeout(r, 5000))
const net2 = await call('network', { page: pageId })
const env2 = net2.structuredContent ?? {}
const entries = env2.entries ?? []
check('A2/B1 capture grows after action', (env2.count ?? 0) > (env1.count ?? 0), `count ${env1.count} -> ${env2.count}`)

// C4: no data: URIs in default view
const dataUris = entries.filter(e => /^data:/i.test(String(e.url)))
check('C4 data: URIs filtered', dataUris.length === 0, `${dataUris.length} data URIs in view`)

// C1: olap/query detail has requestBody
const olap = entries.filter(e => /olap\/query/.test(String(e.url)))
let hasReqBody = false
if (olap.length > 0) {
  const det = await call('network', { page: pageId, detail: olap[olap.length - 1].key })
  const denv = det.structuredContent ?? {}
  hasReqBody = denv.requestBody !== undefined
  check('C1 detail exposes requestBody', hasReqBody, `key=${olap[olap.length - 1].key} requestBodyKeys=${hasReqBody ? Object.keys(denv.requestBody ?? {}).slice(0, 5).join(',') : 'none'}`)
} else {
  check('C1 detail exposes requestBody', false, 'no olap entry captured (query click failed?)')
}

// A3: analyze pattern renders
const analyzed = await call('analyze', { page: pageId, url: URL })
const anText = textOf(analyzed)
check('A3 analyze pattern renders', /pattern: [A-E]/.test(anText) && !anText.includes('[object Object]'), anText.split('\n').find(l => l.includes('pattern'))?.slice(0, 120))

// A4: find renders tag/attrs
const f = await call('find', { page: pageId, css: 'input.ant-input', limit: 3 })
const fText = textOf(f)
check('A4 find renders tag+attrs', fText.includes('<input>'), fText.split('\n').filter(l => l.startsWith('- ')).join(' | ').slice(0, 160))

// B2 hardening: snapshot on this page — iframe content or explicit notice
const snap = await call('snapshot', { page: pageId })
const snapLines = textOf(snap).split('\n')
const iframeIdx = snapLines.findIndex(l => l.trim() === '- iframe' || l.trim().startsWith('- iframe'))
const after = iframeIdx >= 0 ? snapLines[iframeIdx + 1] : ''
check('B2 iframe content or notice', iframeIdx < 0 || (after.includes('ref=') || after.includes('frame content unavailable')), `line after iframe: ${after.slice(0, 70)}`)

await client.close()
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS`)
process.exit(failed > 0 ? 1 : 0)
