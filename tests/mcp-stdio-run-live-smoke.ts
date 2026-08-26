/**
 * P0-1/#13 — full MCP stdio integration smoke.
 *
 * Spawns the real `hub --mcp` server as a child process and drives it with
 * the official MCP client over stdio, covering the gap between tool-layer
 * unit tests and the shipped entrypoint:
 *
 *   1. tools/list advertises `run`
 *   2. a normal run script round-trips (client → server → worker → CDP → back)
 *   3. a synchronous while(true) is terminated at timeout AND the MCP server
 *      process stays alive (subsequent tool calls succeed) — the daemon-freeze
 *      bug at process level
 *
 * Requires a real BrowserOS on BROWSEROS_CDP_PORT (default 9110).
 *
 * Run: BROWSEROS_CDP_PORT=9110 bun tests/mcp-stdio-run-live-smoke.ts
 *
 * Isolation: HUB_SPACES_FILE points at a throwaway ledger so the server's
 * startup restore() never touches the user's real space tabs; the reaper is
 * disabled for the same reason.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')

function textOf(result: { content?: unknown } | undefined): string {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        (item as { type?: unknown }).type === 'text' &&
        'text' in item &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
}

async function main(): Promise<void> {
  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 300)}`)
  }

  const ledger = join(mkdtempSync(join(tmpdir(), 'hub-mcp-smoke-')), 'spaces.json')
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['bin/hub.mjs', '--mcp'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      BROWSEROS_CDP_PORT: String(port),
      HUB_SPACES_FILE: ledger,
      HUB_SPACE_REAP: 'off',
    },
  })
  const client = new Client({ name: 'hub-stdio-smoke', version: '1.0.0' })

  try {
    await client.connect(transport)

    // 1. Tool advertisement
    const tools = await client.listTools()
    const runTool = tools.tools.find((t) => t.name === 'run')
    record(
      'listTools advertises run',
      runTool !== undefined,
      `${tools.tools.length} tools, run ${runTool ? 'present' : 'MISSING'}`,
    )

    // 1b. Real agent workflow precondition (D3): browser tools require an
    // owned space — the server registers an identity per MCP client, and
    // run without a space is rejected by the guard.
    const created = await client.callTool({
      name: 'space.create',
      arguments: { name: 'stdio-run-smoke' },
    })
    const createdText = textOf(created as { content?: unknown })
    record(
      'space.create (agent workflow precondition)',
      (created as { isError?: boolean }).isError !== true,
      createdText.slice(0, 160),
    )

    // 1c. Open a foreground tab owned by the space: run guards the active
    // page's ownership (D3), so the agent must own the tab it runs on.
    const opened = await client.callTool({
      name: 'space.open_tab',
      arguments: { url: 'about:blank', background: false },
    })
    const openedText = textOf(opened as { content?: unknown })
    record(
      'space.open_tab (owned active page for run)',
      (opened as { isError?: boolean }).isError !== true && /page \d+/i.test(openedText),
      openedText.slice(0, 160),
    )

    // 2. Normal round-trip through the full stdio chain
    const ok1 = await client.callTool({
      name: 'run',
      arguments: {
        code: `console.log('via stdio'); const tabs = await browser.pages.list(); return { ok: true, tabs: tabs.length }`,
        timeout: 20_000,
      },
    })
    const s1 = (ok1 as { structuredContent?: any }).structuredContent
    record(
      'normal run round-trips over stdio',
      s1?.ok === true && typeof s1?.value?.tabs === 'number' && Array.isArray(s1?.logs),
      `value=${JSON.stringify(s1?.value)} logs=${JSON.stringify(s1?.logs)}`,
    )

    // 3. Sync dead loop: terminated at timeout, server survives
    const t0 = Date.now()
    const dead = await client.callTool({
      name: 'run',
      arguments: {
        code: `console.log('entering loop'); while (true) { } return 'never'`,
        timeout: 1_500,
      },
    })
    const deadText = textOf(dead as { content?: unknown })
    const deadElapsed = Date.now() - t0
    record(
      'while(true) terminated at timeout over stdio',
      (dead as { isError?: boolean }).isError === true &&
        deadText.includes('exceeded 1500ms') &&
        deadElapsed < 10_000,
      `elapsed=${deadElapsed}ms error="${deadText.split('\n')[0]}"`,
    )

    // 4. The MCP server process is still alive and serving
    const after = await client.callTool({
      name: 'run',
      arguments: { code: `return 'server-alive'`, timeout: 10_000 },
    })
    const s4 = (after as { structuredContent?: any }).structuredContent
    record(
      'MCP server survives the terminated worker',
      s4?.value === 'server-alive',
      `value=${JSON.stringify(s4?.value)}`,
    )
  } finally {
    // Close the throwaway space (also closes its tabs in the browser).
    await client
      .callTool({ name: 'space.close', arguments: {} })
      .catch(() => {})
    await client.close().catch(() => {})
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
