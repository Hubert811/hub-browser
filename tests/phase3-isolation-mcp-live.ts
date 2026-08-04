/**
 * Phase 3.3 — 真实 MCP 双会话隔离验证 (live, 需要 Chrome CDP 9110 在线).
 *
 * spawn 两个 `hub --mcp` 进程, 分别设 HUB_AGENT_ID=isolation-A / isolation-B,
 * 共享同一账本文件与同一 Chrome (CDP 9110)。用两个真实 MCP client 并行操作:
 *
 *   - A create space + open 2 tabs; B create space + open 1 tab
 *   - B 的 space.list 看不到 A 的 space; B 的 tabs 列表 (URL 级) 不包含 A 的标签
 *   - B 对 A 报告的 pageId 做 snapshot/navigate/read: 至少一个被拒
 *     ("is not in your space"), 且任何攻击都不触碰 A 的标签 (A 的 tabs 不变)
 *     — pageId 是每连接计数器, 同一数字在不同进程指向不同标签, 所以"撞号"时
 *     攻击落在 B 自己的标签上, 仍然是隔离成立
 *   - A 的视角对称; A 对自己 space 正常操作
 *   - handoff 后 A 被拒 ("user is controlling"), confirmed takeover 恢复
 *   - 跨进程账本: 两个进程写入互不覆盖 (merge-on-save), close 后清理干净
 *
 * Run: BROWSEROS_CDP_PORT=9110 bun tests/phase3-isolation-mcp-live.ts
 */
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, '..')
const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')
const ledger = path.join(mkdtempSync(path.join(os.tmpdir(), 'phase3-mcp-dual-')), 'hub-spaces.json')

const results: Array<{ name: string; pass: boolean; detail: string }> = []
function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 300)}`)
}

function textOf(result: { content?: unknown } | undefined): string {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        typeof c === 'object' && c !== null && c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

interface MpcPeer {
  agentId: string
  pid: number | null
  transport: StdioClientTransport
  client: Client
  stderr: string
}

async function spawnPeer(agentId: string): Promise<MpcPeer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/hub.mjs', '--mcp'],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BROWSEROS_CDP_PORT: String(port),
      HUB_AGENT_ID: agentId,
      HUB_SPACES_FILE: ledger,
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: `phase3-isolation-${agentId}`, version: '0.0.1' })
  await client.connect(transport)
  const peer: MpcPeer = { agentId, pid: transport.pid, transport, client, stderr: '' }
  transport.stderr?.on?.('data', (d: Buffer) => {
    peer.stderr += d.toString()
    process.stderr.write(`[mcp:${agentId}] ${d}`)
  })
  return peer
}

function pageIdsOf(result: { content?: unknown } | undefined): number[] {
  const pages = (result?.structuredContent as { pages: Array<{ page: number }> } | undefined)?.pages
  return (pages ?? []).map((p) => p.page)
}

function spacesOf(result: { content?: unknown } | undefined): Array<{ id: string; name: string }> {
  return (result?.structuredContent as { spaces: Array<{ id: string; name: string }> } | undefined)?.spaces ?? []
}

/** Tab list entries with URL — URLs are the stable cross-process identity. */
function tabEntriesOf(result: { content?: unknown } | undefined): Array<{ page: number; url: string }> {
  return (result?.structuredContent as { pages: Array<{ page: number; url: string }> } | undefined)?.pages ?? []
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main(): Promise<void> {
  // CDP must be online for a real dual-session run.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (!res.ok) throw new Error(`http ${res.status}`)
  } catch {
    console.log(`[skip] Chrome CDP not reachable on 127.0.0.1:${port} — real MCP dual-session verification skipped (unit isolation tests still cover the logic)`)
    process.exit(0)
  }

  const a = await spawnPeer('isolation-A')
  const b = await spawnPeer('isolation-B')

  try {
    // ── 并行建 space ──
    const aSpace = await a.client.callTool({
      name: 'space.create',
      arguments: { name: `isolation-A-${Date.now()}` },
    })
    const bSpace = await b.client.callTool({
      name: 'space.create',
      arguments: { name: `isolation-B-${Date.now()}` },
    })
    const aSpaceId = (aSpace.structuredContent as { space?: { id: string } }).space?.id ?? ''
    const bSpaceId = (bSpace.structuredContent as { space?: { id: string } }).space?.id ?? ''
    record('A/B 各自创建 space (并行)', !!aSpaceId && !!bSpaceId, `A=${aSpaceId} B=${bSpaceId}`)

    // ── 各开真实浏览器 tab: A 开 2 个 (example.com / example.net), B 开 1 个 (example.org) ──
    // A 有 2 个 pageId, B 有 1 个; 由于 pageId 是每连接计数器, 同一数字在不同进程
    // 指向不同标签。B 攻击 A 报告的 2 个 pageId 时, 至少一个与 B 自己的 pageId
    // 不同 → 必被 guard 拒绝; 撞号的那个在 B 进程里是 B 自己的标签 (不会碰到 A)。
    const aUrl1 = `https://example.com/?a=${Date.now()}`
    const aUrl2 = `https://example.net/?a=${Date.now()}`
    const bUrl1 = `https://example.org/?b=${Date.now()}`
    const aTab1 = await a.client.callTool({ name: 'space.open_tab', arguments: { url: aUrl1 } })
    const aTab2 = await a.client.callTool({ name: 'space.open_tab', arguments: { url: aUrl2 } })
    const bTab1 = await b.client.callTool({ name: 'space.open_tab', arguments: { url: bUrl1 } })
    const aPagesOpen = [(aTab1.structuredContent as { pageId?: number }).pageId, (aTab2.structuredContent as { pageId?: number }).pageId]
    const bPageId = (bTab1.structuredContent as { pageId?: number }).pageId
    record(
      'A/B 各自在真实浏览器开 tab',
      aPagesOpen.every((p) => typeof p === 'number') && typeof bPageId === 'number',
      `A pageIds=${JSON.stringify(aPagesOpen)} B pageId=${bPageId}`,
    )
    if (aPagesOpen.some((p) => typeof p !== 'number') || typeof bPageId !== 'number') {
      throw new Error('open_tab failed')
    }

    // ── B 看不到 A 的 space ──
    const bList = await b.client.callTool({ name: 'space.list', arguments: {} })
    const bSpaces = spacesOf(bList)
    record(
      'B 的 space.list 看不到 A 的 space',
      bList.isError !== true && bSpaces.length === 1 && bSpaces[0].id === bSpaceId && bSpaces[0].id !== aSpaceId,
      JSON.stringify(bSpaces.map((s) => s.id)),
    )

    // ── B 的 tabs 列表 (URL 级) 不包含 A 的标签 ──
    const bTabs = await b.client.callTool({ name: 'tabs', arguments: { action: 'list' } })
    const bEntries = tabEntriesOf(bTabs)
    const bUrlsOk =
      bTabs.isError !== true &&
      bEntries.length === 1 &&
      bEntries[0].url.startsWith('https://example.org/') &&
      !bEntries.some((t) => String(t.url).includes('example.com') || String(t.url).includes('example.net'))
    record('B 的 tabs 列表只含自己的标签 (URL 级)', bUrlsOk, JSON.stringify(bEntries))

    // ── B 对 A 报告的 pageId 做控制操作: 至少一个被拒, 且 A 的标签不被触碰 ──
    const crossChecks: Array<[string, Record<string, unknown>]> = []
    for (const pageId of aPagesOpen) {
      crossChecks.push(
        ['snapshot', { page: pageId }],
        ['read', { page: pageId, format: 'text' }],
        ['navigate', { page: pageId, action: 'url', url: 'https://evil.example/' }],
      )
    }
    const crossDetails: string[] = []
    let rejectedCount = 0
    for (const [name, args] of crossChecks) {
      const res = await b.client.callTool({ name, arguments: args })
      const rejected = res.isError === true && textOf(res).includes('is not in your space')
      if (rejected) rejectedCount++
      crossDetails.push(`${name}(page ${String(args.page)}):${rejected ? 'rejected' : 'passed'}`)
    }
    // A 的标签必须原封不动 (URL 仍是 A 的, 没有被导航/关闭).
    const aTabsAfter = await a.client.callTool({ name: 'tabs', arguments: { action: 'list' } })
    const aAfterUrls = tabEntriesOf(aTabsAfter).map((t) => t.url)
    const aUntouched =
      aTabsAfter.isError !== true &&
      aAfterUrls.length === 2 &&
      aAfterUrls.some((u) => u.startsWith('https://example.com/')) &&
      aAfterUrls.some((u) => u.startsWith('https://example.net/')) &&
      !aAfterUrls.some((u) => u.includes('evil.example'))
    // 2 个 A pageId 中至少一个与 B 的 pageId 不同 → 必被拒 (guard 兜底层).
    record(
      'B 控制操作: ≥1 被拒 + A 的标签不被触碰',
      rejectedCount >= 1 && aUntouched,
      `rejected=${rejectedCount}/${crossChecks.length} | A-tabs=${JSON.stringify(aAfterUrls)} | ${crossDetails.join(' ')}`,
    )

    // ── A 的视角对称: A 的 tabs 只含自己的标签 (URL 级) ──
    const aTabs = await a.client.callTool({ name: 'tabs', arguments: { action: 'list' } })
    const aEntries = tabEntriesOf(aTabs)
    const aUrlsOk =
      aTabs.isError !== true &&
      aEntries.length === 2 &&
      aEntries.every((t) => t.url.startsWith('https://example.com/') || t.url.startsWith('https://example.net/')) &&
      !aEntries.some((t) => String(t.url).includes('example.org'))
    record('A 的 tabs 列表只含自己的标签 (URL 级)', aUrlsOk, JSON.stringify(aEntries))

    // A 攻击 B 的 pageId: 要么被拒 ("is not in your space"), 要么 (撞号) 落在
    // A 自己的标签上 (snapshot 结果 origin 是 A 的 URL) — B 的标签绝不被 A 操作.
    // (B 的标签在上一步撞号攻击里可能已被 B 自己导航到 evil.example, 因此这里只
    //  校验 B 的标签数不变、且 A 的 snapshot 没有命中 B 的标签.)
    const aOnB = await a.client.callTool({ name: 'snapshot', arguments: { page: bPageId } })
    const bTabsAfter = await b.client.callTool({ name: 'tabs', arguments: { action: 'list' } })
    const bAfterUrls = tabEntriesOf(bTabsAfter).map((t) => t.url)
    const aOnBRejected = aOnB.isError === true && textOf(aOnB).includes('is not in your space')
    const aOnBOwn =
      aOnB.isError !== true &&
      (textOf(aOnB).includes('example.com') || textOf(aOnB).includes('example.net'))
    const bTabCountOk = bTabsAfter.isError !== true && bAfterUrls.length === 1
    record(
      'A 对 B 的 pageId snapshot: 被拒或落在自己标签上 (B 标签不被 A 操作)',
      (aOnBRejected || aOnBOwn) && bTabCountOk,
      `rejected=${aOnBRejected} onOwn=${aOnBOwn} B-tabCount=${bAfterUrls.length}`,
    )

    // ── A 对自己 space 正常操作 ──
    const aOwn = await a.client.callTool({ name: 'snapshot', arguments: { page: aPagesOpen[0] } })
    record('A 对自己 tab 正常 snapshot', aOwn.isError !== true, textOf(aOwn).slice(0, 80))

    // ── handoff → "user is controlling" → takeover 恢复 ──
    await a.client.callTool({ name: 'space.handoff', arguments: { spaceId: aSpaceId } })
    const blocked = await a.client.callTool({ name: 'read', arguments: { page: aPagesOpen[0], format: 'text' } })
    const handoffBlocked = blocked.isError === true && textOf(blocked).includes('user is controlling')
    const noConfirm = await a.client.callTool({ name: 'space.takeover', arguments: { spaceId: aSpaceId } })
    const needsConfirm = noConfirm.isError === true && textOf(noConfirm).includes('requires user confirmation')
    const taken = await a.client.callTool({
      name: 'space.takeover',
      arguments: { spaceId: aSpaceId, confirmed: true },
    })
    const resumed = await a.client.callTool({ name: 'read', arguments: { page: aPagesOpen[0], format: 'text' } })
    record(
      'handoff 被拒 → takeover(需确认) → 恢复',
      handoffBlocked && needsConfirm && taken.isError !== true && resumed.isError !== true,
      `blocked=${handoffBlocked} needsConfirm=${needsConfirm} resumed=${resumed.isError !== true}`,
    )

    // ── 跨进程账本: 两个进程写入互不覆盖 ──
    const raw = JSON.parse(readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, { owner: string }>
      currentSpaceByOwner: Record<string, string>
    }
    const ledgerKeepsBoth =
      !!raw.spaces[aSpaceId] && !!raw.spaces[bSpaceId] &&
      raw.spaces[aSpaceId].owner === 'isolation-A' &&
      raw.spaces[bSpaceId].owner === 'isolation-B' &&
      raw.currentSpaceByOwner['isolation-A'] === aSpaceId &&
      raw.currentSpaceByOwner['isolation-B'] === bSpaceId
    record('跨进程账本不被对方覆盖 (merge-on-save)', ledgerKeepsBoth, `spaces=${Object.keys(raw.spaces).length}`)

    // ── 清理: 两个 space 都关闭, 账本清空 ──
    const closeA = await a.client.callTool({ name: 'space.close', arguments: { spaceId: aSpaceId } })
    const closeB = await b.client.callTool({ name: 'space.close', arguments: { spaceId: bSpaceId } })
    const ledgerClean = await waitFor(async () => {
      try {
        const raw2 = JSON.parse(readFileSync(ledger, 'utf-8')) as { spaces: Record<string, unknown> }
        return !raw2.spaces[aSpaceId] && !raw2.spaces[bSpaceId]
      } catch {
        return false
      }
    }, 10_000)
    record('双 space close 后账本清理干净', closeA.isError !== true && closeB.isError !== true && ledgerClean, `A=${closeA.isError !== true} B=${closeB.isError !== true} clean=${ledgerClean}`)
  } catch (err) {
    record('live dual-identity run', false, err instanceof Error ? err.message : String(err))
  } finally {
    await a.client.close().catch(() => {})
    await b.client.close().catch(() => {})
    await a.transport.close().catch(() => {})
    await b.transport.close().catch(() => {})
    // The MCP subprocess keeps running (its CDP websocket stays open), so
    // terminate it explicitly by pid.
    const killPeer = (peer: MpcPeer) => {
      if (peer.pid) {
        try {
          process.kill(peer.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    killPeer(a)
    killPeer(b)
    await new Promise((r) => setTimeout(r, 500))
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n[phase-3 isolation mcp live] ${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main()
