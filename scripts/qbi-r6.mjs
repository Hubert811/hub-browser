// End-to-end: click a custom filter field (行状态, e60-style) BY AX REF, verify
// the dropdown opens (diff) and options appear in the AX tree, then close it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const REPO = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO + '/bin/hub.mjs', '--mcp'],
  cwd: REPO,
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r6', HUB_SPACES_FILE: '/tmp/qbi-r6-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r6', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
await call('space.create', { name: 'qbi-r6' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])

let snap = '', ref = null
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 2000))
  snap = textOf(await call('snapshot', { page: pageId }))
  ref = snap.match(/generic "行状态请选择（多选）" \[ref=(e\d+)\]/)?.[1]
  if (ref) break
}
console.log(`行状态 field ref=${ref}`)
if (!ref) throw new Error('filter field not found in AX tree')

// click the custom filter field by ref
const act = await call('act', { page: pageId, ref, kind: 'click' })
console.log(`act click: isError=${act.isError === true}`)

await new Promise(r => setTimeout(r, 1500))
// did the dropdown open? look for options in the AX tree (listbox/option roles)
const snap2 = textOf(await call('snapshot', { page: pageId }))
const options = snap2.split('\n').filter(l => /\boption\b|listbox/.test(l))
console.log(`dropdown in AX tree: ${options.length} option/listbox lines`)
for (const l of options.slice(0, 8)) console.log('  ' + l.trim().slice(0, 110))
const d = textOf(await call('diff', { page: pageId }))
console.log(`diff: ${/no change/i.test(d) ? 'no change' : d.split('\n').filter(x => x.trim()).length + ' lines'}`)

// press Escape to close the dropdown, then cleanup
await call('act', { page: pageId, kind: 'press', key: 'Escape' }).catch(() => {})
try { await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 20000))]) } catch { console.log('close timeout') }
await client.close()
