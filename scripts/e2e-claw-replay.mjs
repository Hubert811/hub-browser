#!/usr/bin/env node
/**
 * P2-3 batch 4 — end-to-end acceptance (one-shot, real stack):
 *   hub --mcp (real CDP @ 9110) -> space.create + space.open_tab + snapshot
 *   -> ClawHarnessReporter dual-write -> claw-server audit trail
 *   -> cockpit session + replay attribution + dispatch timeline
 *   -> replay export = self-contained HTML with seeking timeline.
 * Run: bun scripts/e2e-claw-replay.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { setTimeout as delay } from 'node:timers/promises'

const REPO_ROOT = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const HUB_BIN = REPO_ROOT + '/bin/hub.mjs'
const CLAW = 'http://127.0.0.1:9210'
const LEDGER = '/tmp/e2e-claw-replay-ledger.json'

const clawJson = async (path) => {
  const res = await fetch(CLAW + path)
  return { status: res.status, body: await res.json() }
}

const ok = (label, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ' — ' + detail : ''))
  if (!cond) process.exitCode = 1
}

const before = (await clawJson('/api/v1/sessions?limit=50')).body.items ?? []
const beforeIds = new Set(before.map((s) => s.sessionId))
console.log('baseline sessions: ' + before.length + ' (hub-slug: ' + before.filter((s) => s.slug === 'hub').length + ')')

const transport = new StdioClientTransport({
  command: "/opt/homebrew/bin/bun",
  args: [HUB_BIN, '--mcp'],
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HUB_SPACES_FILE: LEDGER,
    HUB_SPACE_REAP: 'off',
    HUB_AUDIT: 'off',
    BROWSEROS_CDP_PORT: '9110',
  },
})
const client = new Client({ name: 'p23-verify', version: '1.0.0' })
await client.connect(transport)
console.log('hub --mcp connected (client: p23-verify)')

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(name + ' failed: ' + JSON.stringify(res.content).slice(0, 200))
  return res
}

const created = await call('space.create', { name: 'p23-e2e-verify' })
const spaceId = created.structuredContent?.space?.id
ok('space.create', typeof spaceId === 'string', 'spaceId=' + spaceId)

const opened = await call('space.open_tab', { spaceId, url: 'http://example.com/', background: true })
const pageId = opened.structuredContent?.pageId
ok('space.open_tab', typeof pageId === 'number', 'pageId=' + pageId)

await call('snapshot', { page: pageId })
console.log('dispatches: space.create + space.open_tab + snapshot')

await delay(6000)

let hubSession
for (let i = 0; i < 20 && hubSession === undefined; i++) {
  const { body } = await clawJson('/api/v1/sessions?limit=50')
  hubSession = (body.items ?? []).find((s) => !beforeIds.has(s.sessionId) && s.slug === 'hub')
  if (hubSession === undefined) await delay(500)
}
ok('cockpit session list shows the hub session', hubSession !== undefined,
  hubSession ? hubSession.sessionId + ' dispatchCount=' + hubSession.dispatchCount + ' status=' + hubSession.status : 'not found')
if (hubSession === undefined) {
  await client.close().catch(() => {})
  process.exit(1)
}

const detail = await clawJson('/api/v1/sessions/' + hubSession.sessionId)
const dispatches = detail.body.dispatches ?? []
ok('session detail carries the dispatch timeline', dispatches.length >= 3,
  dispatches.length + ' rows: ' + dispatches.map((d) => d.toolName).join(', '))
const withTab = dispatches.find((d) => typeof d.tabId === 'number')
ok('open_tab dispatch carries tabId attribution', withTab !== undefined,
  withTab ? 'tabId=' + withTab.tabId : 'none')

const recording = await clawJson('/api/v1/sessions/' + hubSession.sessionId + '/recording')
ok('session recording attribution (hasData)', recording.body.hasData === true,
  'tabs=' + JSON.stringify((recording.body.tabs ?? []).map((t) => ({ doc: String(t.documentId ?? '').slice(0, 8), events: t.eventCount ?? t.events ?? '?' }))))

const tabId = withTab?.tabId
const streams = await fetch(CLAW + '/api/v1/recordings/streams?tabId=' + tabId + '&limit=5').then((r) => r.json())
const stream = (streams.streams ?? [])[0]
ok('stream discovery lists the tab recording', stream !== undefined,
  stream ? 'doc=' + stream.documentId.slice(0, 12) + ' events=' + stream.eventCount + ' ' + Math.round(stream.sizeBytes / 1024) + 'KB' : 'none')

if (stream !== undefined) {
  const { exportClawReplay } = await import(REPO_ROOT + '/dist/browser-mcp/src/tools/replay-tools.js')
  const exported = await exportClawReplay({
    documentId: stream.documentId,
    sessionId: hubSession.sessionId,
    out: '/tmp/e2e-claw-replay.html',
  })
  ok('replay export succeeds', exported.ok === true,
    exported.ok ? exported.value.eventCount + ' events, ' + exported.value.dispatchCount + ' dispatches, ' + Math.round(exported.value.bytes / 1024) + 'KB' : JSON.stringify(exported.error))

  const fs = await import('node:fs')
  const html = fs.readFileSync('/tmp/e2e-claw-replay.html', 'utf8')
  ok('exported HTML inlines the player', html.includes('rrwebPlayer'))
  ok('exported HTML embeds the dispatch timeline with seek offsets', /data-t="[0-9.]+"/.test(html))
  const tools = [...html.matchAll(/class="tool">([^<]+)</g)].map((m) => m[1])
  ok('timeline rows carry the real tool names', tools.includes('space.create') && tools.includes('snapshot'), tools.join(', '))
}

await client.close().catch(() => {})
await delay(2500)
const ended = await clawJson('/api/v1/sessions/' + hubSession.sessionId)
ok('session end settles (status done, claims released)', ended.body.session?.status === 'done',
  'status=' + ended.body.session?.status)

console.log(process.exitCode ? '\nE2E: FAILURES ABOVE' : '\nE2E: ALL PASS')
