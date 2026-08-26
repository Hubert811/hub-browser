/**
 * P0-1 live CDP smoke for the run worker sandbox.
 * Requires real BrowserOS on BROWSEROS_CDP_PORT (default 9110).
 *
 * Run: BROWSEROS_CDP_PORT=9110 bun tests/run-sandbox-live-smoke.ts
 *
 * Verifies against the real browser:
 *   1. SDK bridge round-trips over CDP (pages.list returns live tabs)
 *   2. A synchronous `while (true) {}` is terminated at timeout without
 *      freezing this process (the daemon-freeze bug P0-1 fixes)
 *   3. The process is still healthy afterwards
 */
import { UnifiedBrowserFactory } from '../src/factory.ts'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { run } from '../src/browser-mcp/src/tools/run.ts'
import { makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')

async function main(): Promise<void> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 300)}`)
  }

  const factory = new UnifiedBrowserFactory()
  const page = await factory.connect({ cdpEndpoint: `http://127.0.0.1:${port}` })
  const ctx = makeContext(page)

  try {
    // 1. Bridge round-trip over real CDP
    const out1 = await executeTool(
      run,
      {
        code: `
          console.log('querying tabs')
          const tabs = await browser.pages.list()
          console.log('got ' + tabs.length + ' tabs')
          return { count: tabs.length, first: tabs[0] && tabs[0].title }
        `,
        timeout: 15_000,
      },
      ctx,
    )
    const structured1 = (out1 as { structuredContent?: any }).structuredContent
    record(
      'SDK bridge round-trip (pages.list over real CDP)',
      structured1?.ok === true && typeof structured1?.value?.count === 'number',
      `count=${structured1?.value?.count} first=${JSON.stringify(structured1?.value?.first)} logs=${JSON.stringify(structured1?.logs)}`,
    )

    // 2. Sync infinite loop terminated at timeout
    const t0 = Date.now()
    const out2 = await executeTool(
      run,
      {
        code: `console.log('entering dead loop'); while (true) { } return 'never'`,
        timeout: 2_000,
      },
      ctx,
    )
    const elapsed = Date.now() - t0
    const text2 = (out2.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
    record(
      'sync while(true) killed at timeout, process alive',
      out2.isError === true && text2.includes('exceeded 2000ms') && elapsed < 10_000,
      `elapsed=${elapsed}ms error="${text2.split('\n')[0]}"`,
    )

    // 3. Healthy afterwards
    const out3 = await executeTool(
      run,
      { code: `return 'alive after kill'`, timeout: 10_000 },
      ctx,
    )
    const structured3 = (out3 as { structuredContent?: any }).structuredContent
    record(
      'process healthy after termination',
      structured3?.value === 'alive after kill',
      `value=${JSON.stringify(structured3?.value)}`,
    )
  } finally {
    await factory.close().catch(() => {})
  }

  const failed = results.filter((r) => !r.pass)
  console.log(
    failed.length === 0
      ? `\nALL PASS (${results.length}/${results.length})`
      : `\nFAILED (${failed.length}/${results.length})`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})
