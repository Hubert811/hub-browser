/**
 * 正常场景验收：零环境变量覆盖（默认账本/默认审计 ON/默认 claw 上报），
 * 模拟真实 agent 任务「查 HN 上的 rust 讨论」——完整 observe → act → verify 流。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { setTimeout as delay } from 'node:timers/promises'

const REPO_ROOT = '/Users/hubertxie/Downloads/opencli + browserClaw/hub-browser'
const CLAW = 'http://127.0.0.1:9210'
const ok = (label, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ' — ' + detail : ''))
  if (!cond) process.exitCode = 1
}

const clawSessions = async () =>
  (await (await fetch(`${CLAW}/api/v1/sessions?limit=50`)).json()).items ?? []
const beforeIds = new Set((await clawSessions()).map((s) => s.sessionId))

// 默认账本 + 默认审计 ON + 默认 claw 上报（无任何 HUB_* / BROWSEROS_* 覆盖；
// BROWSEROS_CDP_PORT 默认 9110）
const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/bun',
  args: [REPO_ROOT + '/bin/hub.mjs', '--mcp'],
  cwd: REPO_ROOT,
})
const client = new Client({ name: 'claude-code', version: '1.0.0' })
await client.connect(transport)
console.log('connected: hub --mcp（默认配置，client: claude-code）')

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  const text = Array.isArray(res.content)
    ? (res.content.find((c) => c.type === 'text')?.text ?? '')
    : ''
  return { isError: res.isError === true, text, structured: res.structuredContent }
}

// ── 任务开始：建 space（真实任务名）──
const created = await call('space.create', { name: '查 HN rust 讨论' })
const spaceId = created.structured?.space?.id
ok('1. space.create（默认账本）', !created.isError && typeof spaceId === 'string', String(spaceId).slice(0, 40))

// ── 开页面（真实网站）──
const opened = await call('space.open_tab', { spaceId, url: 'https://news.ycombinator.com/' })
const pageId = opened.structured?.pageId
ok('2. space.open_tab', !opened.isError && typeof pageId === 'number', `pageId=${pageId}${opened.structured?.reused ? ' reused' : ''}`)

// ── 观察：snapshot 拿 refs ──
const snap = await call('snapshot', { page: pageId })
const m = snap.text.match(/link\s+"[^"]*\d+\s*comments?[^"]*"\s+\[ref=(e\d+)\]/i) ?? snap.text.match(/link\s+"(?:comments|discuss)"\s+\[ref=(e\d+)\]/i)
ok('3. snapshot（ax 观察拿 refs）', !snap.isError && m !== null, m ? `讨论链接 ref=${m[1]}（快照 ${snap.text.length} 字符）` : '未找到可点目标')

// ── 真实操作：act 点击「comments/discuss」进入讨论页 ──
if (m) {
  const act = await call('act', { page: pageId, kind: 'click', ref: m[1] })
  ok('4. act click（真实 CDP 输入）', !act.isError, act.text.slice(0, 80).replace(/\n/g, ' '))
  await delay(1200)
  const after = await call('read', { page: pageId, format: 'text' })
  const onItem = /item\?id=|comments|points/i.test(after.text)
  ok('5. read 验证点击生效', !after.isError && onItem, `页面含讨论内容（${after.text.length} 字符）`)
}

// ── 厚命令：适配器搜索（带参数）──
const search = await call('adapter.run', { site: 'hackernews', command: 'search', args: { query: 'rust' } })
const hits = (search.text.match(/"rank":/g) ?? []).length
ok('6. adapter.run hackernews search rust', !search.isError && hits > 0, `${hits} 条结果，首条：${search.text.split('\n').find((l) => l.includes('title:'))?.slice(0, 70) ?? '?'}`)

// ── 可观测面：本地审计（默认 ON，应有真实行）──
const audit = await call('audit.query', { limit: 5 })
ok('7. audit.query（本地 SQLite，默认 ON）', !audit.isError && !audit.text.includes('not active'), audit.text.split('\n').slice(0, 2).join(' | ').slice(0, 110))

// ── 录制回放：列出 + 导出本会话回放 ──
await delay(4000) // 等 recorder flush + reporter 队列排空
const rl = await call('replay.list', { limit: 5 })
ok('8. replay.list', !rl.isError, rl.text.split('\n')[0]?.slice(0, 90))

// 本会话的 claw session id（client name claude-code → owner mcp:claude-code:<suffix>）
// 直接从 claw 找新 session
const nowSessions = await clawSessions()
const mine = nowSessions.find((s) => !beforeIds.has(s.sessionId) && s.slug === 'hub')
ok('9. claw cockpit 出现本会话 session', mine !== undefined, mine ? `${mine.sessionId.slice(0, 12)} dispatches=${mine.dispatchCount}` : '未找到')

if (mine) {
  // 找本会话 claim 的 tab 的最新流，导出带时间线的回放
  const detail = await (await fetch(`${CLAW}/api/v1/sessions/${mine.sessionId}`)).json()
  const tabId = (detail.dispatches ?? []).find((d) => typeof d.tabId === 'number')?.tabId
  const streams = await (await fetch(`${CLAW}/api/v1/recordings/streams?tabId=${tabId}&limit=3`)).json()
  const doc = (streams.streams ?? [])[0]
  ok('10. 流发现（本会话 tab）', doc !== undefined, doc ? `doc=${doc.documentId.slice(0, 10)} ${doc.eventCount} events` : 'none')
  if (doc) {
    const ex = await call('replay.export', { documentId: doc.documentId, sessionId: mine.sessionId, out: '/tmp/normal-scenario-replay.html' })
    ok('11. replay.export（含本会话时间线）', !ex.isError, ex.text.slice(0, 90))
  }
}

// ── 收尾：关 space（真实 agent 的默认卫生纪律）──
const closed = await call('space.close', { spaceId })
ok('12. space.close（默认全关）', !closed.isError, closed.text.slice(0, 60))

await client.close().catch(() => {})
await delay(2000)

// ── 会话结束后：claw session 应结算 done ──
if (mine) {
  const after = await (await fetch(`${CLAW}/api/v1/sessions/${mine.sessionId}`)).json()
  ok('13. 断开后 claw session 结算', after.session?.status === 'done', `status=${after.session?.status}`)
}

console.log(process.exitCode ? '\n正常场景: 有失败项' : '\n正常场景: 全部通过')
process.exit(process.exitCode || 0)
