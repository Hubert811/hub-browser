/**
 * Live CDP smoke for openTab URL reuse (ego openOrReuseTab).
 * Requires real Chrome on BROWSEROS_CDP_PORT (default 9110).
 *
 * Run: BROWSEROS_CDP_PORT=9110 bun tests/reuse-live-smoke.ts
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { UnifiedBrowserFactory } from '../src/factory.ts'
import {
  TaskSpaceManager,
  gatewayFromProvider,
} from '../src/space/task-space-manager.ts'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')
const ledger = path.join(os.tmpdir(), `hub-reuse-smoke-${Date.now()}.json`)

async function main(): Promise<void> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 300)}`)
  }

  const factory = new UnifiedBrowserFactory()
  const manager = new TaskSpaceManager({
    storagePath: ledger,
    gateway: gatewayFromProvider(factory),
  })
  const identity = { agentId: 'reuse-smoke-agent', displayName: 'reuse smoke' }
  try {
    const page = await factory.connect({ cdpEndpoint: `http://127.0.0.1:${port}` })
    const space = await manager.create(identity.agentId, `reuse-smoke-${Date.now()}`)

    const urlA = 'https://example.com/'
    const urlB = 'https://example.org/'

    const before = (await page.tabs()).length
    const first = await manager.openTabWithReuse(identity.agentId, space.id, urlA, {
      background: true,
    })
    record(
      '第一次 open → 新建 (reused:false)',
      first.reused === false && typeof first.pageId === 'number',
      `pageId=${first.pageId}`,
    )

    const afterFirst = (await page.tabs()).length
    const second = await manager.openTabWithReuse(identity.agentId, space.id, urlA, {
      background: true,
    })
    const afterSecond = (await page.tabs()).length
    record(
      '同 URL 二次 open → 复用同 pageId, Chrome 不重复开',
      second.reused === true &&
        second.pageId === first.pageId &&
        afterSecond === afterFirst,
      `pageId=${second.pageId} reused=${second.reused} 标签数 ${afterFirst}→${afterSecond}`,
    )

    const diff = await manager.openTabWithReuse(identity.agentId, space.id, urlB, {
      background: true,
    })
    record(
      '不同 URL → 新建',
      diff.reused === false && diff.pageId !== first.pageId,
      `pageId=${diff.pageId}`,
    )

    const forced = await manager.openTabWithReuse(identity.agentId, space.id, urlA, {
      background: true,
      reuse: false,
    })
    record(
      'reuse:false → 强制新建 (同 URL)',
      forced.reused === false && forced.pageId !== first.pageId,
      `pageId=${forced.pageId}`,
    )

    const after = (await page.tabs()).length
    record(
      '总标签数 = 本 run 新建 3 个',
      after === before + 3,
      `before=${before} after=${after}`,
    )

    // Cleanup: close every tab we opened.
    for (const id of [first.pageId, diff.pageId, forced.pageId]) {
      try {
        await manager.closeTab(identity.agentId, space.id, id)
      } catch {
        /* best-effort */
      }
    }
    const cleaned = (await page.tabs()).length
    record('清理后恢复原标签数', cleaned === before, `before=${before} after=${cleaned}`)
    await manager.closeSpace(identity.agentId, space.id, { keep: true })
  } finally {
    try {
      await manager.dispose()
    } catch {
      /* best-effort */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`)
  if (failed.length > 0) process.exit(1)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('smoke failed:', err)
    process.exit(1)
  })
