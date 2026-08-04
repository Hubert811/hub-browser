/**
 * Phase 3 live CDP smoke (spec 验证标准). Requires real Chrome on
 * BROWSEROS_CDP_PORT (default 9110).
 *
 * Coverage:
 *  - MCP-path: 建 space → 开 tab → snapshot → tabs 过滤 → handoff 拒绝 → takeover → 恢复
 *  - A: restore() 幂等 — 模拟 daemon 重启 (新 manager 实例) 不重复开 tab，
 *      持久化 restoredAt/restored 标记，Chrome 中不出现重复标签
 *  - B: opencli browser 空间内操作 — 通过真实 daemon 跑
 *      space create → browser open → tab list/state → space close，标签归属与清理
 *
 * Run:
 *   BROWSEROS_CDP_PORT=9110 bun tests/phase3-space-live-smoke.ts
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UnifiedBrowserFactory } from '../src/factory.ts'
import { TaskSpaceManager, gatewayFromProvider } from '../src/space/task-space-manager.ts'
import { BROWSER_TOOLS } from '../src/browser-mcp/src/tools/registry.ts'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import type { ToolContext } from '../src/browser-mcp/src/tools/framework.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, '..')

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')
const ledger =
  process.env.HUB_SPACES_FILE ??
  path.join(os.tmpdir(), `hub-spaces-live-${Date.now()}.json`)
const daemonPort = Number(process.env.HUB_SMOKE_DAEMON_PORT ?? 9401)

function textOf(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return ''
  return result.content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        typeof c === 'object' && c !== null && c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

function tool(name: string) {
  const def = BROWSER_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function countLiveTabs(page: Awaited<ReturnType<typeof factory.connect>>, fragment: string): Promise<number> {
  try {
    const tabs = (await page.tabs()) as Array<{ url: string }>
    return tabs.filter((t) => String(t.url).includes(fragment)).length
  } catch {
    return -1
  }
}

async function waitForHealth(): Promise<boolean> {
  return waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`)
      return res.ok
    } catch {
      return false
    }
  }, 10_000)
}

function hubCli(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/hub.mjs', ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HUB_DAEMON_PORT: String(daemonPort), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

async function main(): Promise<void> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 260)}`)
  }

  const cliEnv = {
    BROWSEROS_CDP_PORT: String(port),
    HUB_SPACES_FILE: ledger,
    HUB_AGENT_ID: 'smoke-agent',
  }

  const factory = new UnifiedBrowserFactory()
  const manager = new TaskSpaceManager({
    storagePath: ledger,
    gateway: gatewayFromProvider(factory),
  })
  const identity = { agentId: 'smoke-agent', displayName: 'phase-3 smoke' }
  let page: Awaited<ReturnType<typeof factory.connect>>
  let daemon: ReturnType<typeof spawn> | undefined
  try {
    page = await factory.connect({ cdpEndpoint: `http://127.0.0.1:${port}` })
    const ctx = (): ToolContext => ({ page, pageFor: async (id) => factory.connect({ pageId: id }), identity, spaces: manager })

    // ── Phase 1: MCP-path space flow ──
    const name = `smoke-${Date.now()}`
    const space = await manager.create(identity.agentId, name)
    record('创建空间', !!space.id, `space ${space.id} ("${name}")`)

    const tabUrl = 'https://example.com'
    const preComCount = await countLiveTabs(page, 'example.com')
    const pageId = await manager.openTab(identity.agentId, space.id, tabUrl, { background: true })
    record('空间内开 tab', typeof pageId === 'number', `pageId=${pageId} url=${tabUrl}`)

    const snap = await executeTool(tool('snapshot'), { page: pageId }, ctx())
    record('空间内 snapshot', !snap.isError, textOf(snap).slice(0, 120))

    const list = await executeTool(tool('tabs'), { action: 'list' }, ctx())
    const pages = (list.structuredContent as { pages: Array<{ page: number }> }).pages
    record('tabs list 只含自己 space', pages.every((p) => p.page === pageId), `pages=${JSON.stringify(pages.map((p) => p.page))}`)

    // ── Phase 2: A — restore idempotency (simulated daemon restart) ──
    const restoredBefore = readFileSync(ledger, 'utf-8')
    const manager2 = new TaskSpaceManager({
      storagePath: ledger,
      gateway: gatewayFromProvider(factory),
    })
    const n1 = await manager2.restore()
    const n2 = await manager2.restore()
    const ledgerAfter = JSON.parse(readFileSync(ledger, 'utf-8'))
    const restoredSpace = ledgerAfter.spaces[space.id]
    const restoredMarkers =
      typeof restoredSpace?.restoredAt === 'number' &&
      restoredSpace.restoredAt > 0 &&
      Array.isArray(restoredSpace.tabs) &&
      restoredSpace.tabs.every((t: { restored?: boolean }) => t.restored === true)
    const comAfterRestore = await countLiveTabs(page, 'example.com')
    record(
      'A: restore 幂等 (二次 restore 不重复开 tab)',
      n1 >= 1 && n2 === 0 && comAfterRestore === preComCount + 1,
      `n1=${n1} n2=${n2} example.com 标签数=${comAfterRestore} (本 run 期望 ${preComCount + 1})`,
    )
    record('A: restore 持久化 restoredAt/restored 标记', restoredMarkers, `restoredAt=${restoredSpace?.restoredAt}`)
    manager.reload()

    // ── handoff → blocked → takeover (phase 1 tail) ──
    await manager.handOff(identity.agentId, space.id)
    const blocked = await executeTool(tool('read'), { page: pageId, format: 'text' }, ctx())
    record('handoff 后 agent 被拒', blocked.isError && textOf(blocked).includes('user is controlling'), textOf(blocked).slice(0, 140))

    await manager.takeOver(identity.agentId, space.id, { confirmed: true })
    const resumed = await executeTool(tool('read'), { page: pageId, format: 'text' }, ctx())
    record('takeover 后恢复', !resumed.isError, textOf(resumed).slice(0, 100))

    // ── Phase 3: B — opencli browser 空间内操作 (real daemon) ──
    daemon = spawn(process.execPath, ['bin/hub.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HUB_DAEMON: 'true',
        HUB_DAEMON_PORT: String(daemonPort),
        ...cliEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    daemon.stderr?.on('data', (d: Buffer) => process.stderr.write(`[daemon] ${d}`))

    const healthy = await waitForHealth()
    record('daemon 启动 + health', healthy, `http://127.0.0.1:${daemonPort}/health`)

    // Daemon boot restore re-stamps restoredAt once it has reconciled the live
    // tabs (pageIds differ across connections) — wait for it so the CLI space
    // close below uses the daemon's pageIds.
    const restoredAtPhase2 = restoredSpace.restoredAt
    const bootReconciled = await waitFor(() => {
      try {
        const raw = JSON.parse(readFileSync(ledger, 'utf-8'))
        return (
          typeof raw.spaces[space.id]?.restoredAt === 'number' &&
          raw.spaces[space.id].restoredAt > restoredAtPhase2
        )
      } catch {
        return false
      }
    }, 10_000)
    record('A: daemon 启动自动 restore 已执行', bootReconciled, `restoredAt ${restoredAtPhase2} → ${bootReconciled ? '更新' : '未更新'}`)

    // Still no duplicate example.com tab after the daemon boot restore.
    const comAfterBoot = await countLiveTabs(page, 'example.com')
    record(
      'A: daemon 重启不重复恢复 (Chrome 标签数不变)',
      comAfterBoot === preComCount + 1,
      `example.com 标签数=${comAfterBoot} (期望 ${preComCount + 1})`,
    )

    const created = await hubCli(cliEnv, ['space', 'create', `cli-${Date.now()}`, '--json'])
    let cliSpaceId = ''
    try {
      cliSpaceId = (JSON.parse(created.out) as { space: { id: string } }).space.id
    } catch {}
    record('B: CLI space create', created.code === 0 && !!cliSpaceId, created.out.split('\n')[0])

    const preOrgCount = await countLiveTabs(page, 'example.org')
    const opened = await hubCli(cliEnv, ['browser', 'smoke', 'open', 'https://example.org'])
    let openJson: { spaceId?: string; pageId?: number; url?: string } = {}
    try {
      openJson = JSON.parse(opened.out) as typeof openJson
    } catch {}
    record(
      'B: browser open 归入当前 space',
      opened.code === 0 && openJson.spaceId === cliSpaceId && typeof openJson.pageId === 'number' && String(openJson.url).includes('example.org'),
      `spaceId=${openJson.spaceId} pageId=${openJson.pageId} url=${openJson.url}`,
    )

    const listed = await hubCli(cliEnv, ['browser', 'smoke', 'tab', 'list'])
    let listJson: Array<{ url?: string }> = []
    try {
      listJson = JSON.parse(listed.out) as typeof listJson
    } catch {}
    record(
      'B: tab list 作用在当前 space 标签',
      listed.code === 0 &&
        Array.isArray(listJson) &&
        listJson.some((t) => String(t.url).includes('example.org')) &&
        !listJson.some((t) => String(t.url).includes('example.com')),
      `tabs=${JSON.stringify(listJson.map((t) => t.url))}`,
    )

    const stateOut = await hubCli(cliEnv, ['browser', 'smoke', 'state'])
    record('B: state 看到 space 标签', stateOut.code === 0 && stateOut.out.includes('example.org'), stateOut.out.split('\n')[0] ?? '')

    const closed = await hubCli(cliEnv, ['space', 'close', cliSpaceId])
    record('B: space close 后标签清理', closed.code === 0, closed.out.trim())

    const orgAfterClose = await countLiveTabs(page, 'example.org')
    record(
      'B: space close 关闭浏览器标签',
      orgAfterClose === preOrgCount,
      `example.org 标签数=${orgAfterClose} (期望 ${preOrgCount})`,
    )

    // ── Phase 4: cleanup phase-1 space via the daemon (ledger pageIds now daemon-side) ──
    const closed1 = await hubCli(cliEnv, ['space', 'close', space.id])
    const comAfterCleanup = await countLiveTabs(page, 'example.com')
    record(
      'cleanup: phase-1 space 关闭并清理',
      closed1.code === 0 && comAfterCleanup === preComCount,
      `example.com 标签数=${comAfterCleanup} (期望 ${preComCount})`,
    )
    const rawEnd = JSON.parse(readFileSync(ledger, 'utf-8'))
    record('ledger 清理完成', !rawEnd.spaces[space.id] && !rawEnd.spaces[cliSpaceId], 'spaces 已移除')
  } catch (err) {
    record('live smoke', false, err instanceof Error ? err.message : String(err))
  } finally {
    daemon?.kill('SIGTERM')
    await factory.close?.().catch(() => {})
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n[phase-3 live smoke] ${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main()
