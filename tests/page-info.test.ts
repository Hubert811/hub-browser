/**
 * P2-6 (batch 1) — page-info tools (`frames` / `extract`): capabilities the
 * CLI had as direct implementations, now single tool definitions shared by
 * both faces. Tool-level tests run the real extract pipeline (the shared
 * buildExtractHtmlJs + runExtractFromHtml chain); CLI-level tests verify the
 * thin-wrapper output contracts (bare JSON array / chunk envelope) survive
 * the toolification unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProgram } from '../src/opencli-engine/cli.js'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { extract, frames } from '../src/browser-mcp/src/tools/page-info.ts'
import { createFakePage, makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'
import { FakeBrowser, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

// ── Tool level ─────────────────────────────────────────────────────────────

describe('frames tool (P2-6)', () => {
  it('lists cross-origin frames with indices and a count', async () => {
    const page = createFakePage({
      frames: async () => [
        { url: 'https://ads.example/frame', targetId: 't-1' },
        { url: 'https://cdn.example/embed', targetId: 't-2' },
      ],
    })
    const result = await executeTool(frames, { page: 1 }, makeContext(page))
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      count: 2,
      frames: [{ url: 'https://ads.example/frame' }, { url: 'https://cdn.example/embed' }],
    })
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('[0] https://ads.example/frame')
  })

  it('empty frame list degrades to a friendly no-frames answer', async () => {
    const page = createFakePage({ frames: async () => [] })
    const result = await executeTool(frames, { page: 1 }, makeContext(page))
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ count: 0, frames: [] })
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('no cross-origin frames')
  })

  it('a failing frames() (unsupported backend) is a structured error, not a crash', async () => {
    // A real UnifiedPage always has frames(); the realistic degradation is a
    // backend that rejects the underlying CDP call — the tool must surface it
    // as a structured error through executeTool, never throw raw.
    const page = createFakePage({
      frames: async () => {
        throw new Error('FrameTree unavailable in this backend')
      },
    })
    const result = await executeTool(frames, { page: 1 }, makeContext(page))
    expect(result.isError).toBe(true)
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('FrameTree unavailable')
  })
})

describe('extract tool (P2-6)', () => {
  // Paragraph-aware chunking clamps chunkSize to MIN_CHUNK_SIZE=100, so the
  // continuation test needs a multi-paragraph body longer than that.
  const HTML = [
    '<h1>Alpha</h1>',
    ...Array.from({ length: 12 }, (_, i) => `<p>paragraph ${i} of the long page body with some words</p>`),
  ].join('')
  const evalRes = { html: HTML, url: 'https://example.com/long', title: 'Example Long' }

  it('returns the chunk envelope through the real extract pipeline', async () => {
    const page = createFakePage({ evaluate: async () => evalRes })
    const result = await executeTool(
      extract,
      { page: 1, chunkSize: 20000, start: 0 },
      makeContext(page),
    )
    expect(result.isError).toBeFalsy()
    const envelope = result.structuredContent as Record<string, unknown>
    expect(envelope.url).toBe('https://example.com/long')
    expect(envelope.title).toBe('Example Long')
    expect(envelope.start).toBe(0)
    expect(envelope.next_start_char).toBe(null) // fits in one chunk
    expect(String(envelope.content)).toContain('paragraph 0 of the long page body')
    expect(typeof envelope.total_chars).toBe('number')
  })

  it('continuation cursor: start=next_start_char reads the next chunk', async () => {
    const page = createFakePage({ evaluate: async () => evalRes })
    const first = await executeTool(
      extract,
      { page: 1, chunkSize: 100, start: 0 },
      makeContext(page),
    )
    const env1 = first.structuredContent as { next_start_char: number | null; end: number }
    expect(env1.next_start_char).not.toBe(null)
    const second = await executeTool(
      extract,
      { page: 1, chunkSize: 100, start: env1.next_start_char as number },
      makeContext(page),
    )
    const env2 = second.structuredContent as { start: number }
    expect(env2.start).toBe(env1.next_start_char)
  })

  it('page without a root element is a structured error', async () => {
    const page = createFakePage({ evaluate: async () => null })
    const result = await executeTool(extract, { page: 1 }, makeContext(page))
    expect(result.isError).toBe(true)
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('no root element')
  })

  it('selector matching nothing is a structured error', async () => {
    const page = createFakePage({ evaluate: async () => ({ notFound: true }) })
    const result = await executeTool(
      extract,
      { page: 1, selector: '.missing' },
      makeContext(page),
    )
    expect(result.isError).toBe(true)
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('.missing')
  })

  it('invalid chunkSize is rejected by the input schema', async () => {
    const page = createFakePage({ evaluate: async () => evalRes })
    const result = await executeTool(
      extract,
      { page: 1, chunkSize: 0 },
      makeContext(page),
    )
    expect(result.isError).toBe(true)
  })
})

// ── CLI thin-wrapper level ──────────────────────────────────────────────────

const BUILTIN_CLIS = join(process.cwd(), 'clis')
const USER_CLIS = join(tmpdir(), 'hub-clis-empty')
const GATE_OWNER = 'page-info-cli'

async function makeEnv() {
  const browser = new FakeBrowser()
  browser.tabs.push({ pageId: 100, targetId: 'target-100', url: 'https://example.com', isActive: true })
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  // Space-gate preset (P1-4): one space owning the fake page so the wrapper
  // passes the executeTool gate.
  const root = mkdtempSync(join(tmpdir(), 'page-info-spaces-'))
  const ledger = join(root, 'hub-spaces.json')
  process.env.HUB_SPACES_FILE = ledger
  process.env.HUB_AGENT_ID = GATE_OWNER
  const { TaskSpaceManager } = await import('../src/space/task-space-manager.ts')
  const manager = new TaskSpaceManager({ storagePath: ledger })
  await manager.create(GATE_OWNER, 'page-info')
  await manager.recordTabForCurrentSpace(GATE_OWNER, 100, 'https://example.com')
  return {
    browser,
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    },
  }
}

describe('browser frames / extract CLI wrappers (P2-6)', () => {
  beforeEach(() => {
    process.env.OPENCLI_CACHE_DIR = mkdtempSync(join(tmpdir(), 'page-info-cache-'))
  })
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.HUB_SPACES_FILE
    delete process.env.HUB_AGENT_ID
    process.exitCode = 0
  })

  it('frames prints the bare JSON array (pre-P2-6 contract)', async () => {
    const env = await makeEnv()
    env.browser.framesResult = [{ url: 'https://embed.example', targetId: 't-9' }]
    const out = await env.run(['browser', '--session', 'work', 'frames'])
    const parsed = JSON.parse(out) as Array<{ url: string }>
    expect(parsed).toEqual([{ url: 'https://embed.example', targetId: 't-9' }])
  })

  it('extract prints the chunk envelope (pre-P2-6 contract) with selector forwarded', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = {
      html: '<p>scoped body</p>',
      url: 'https://example.com/a',
      title: 'A',
    }
    const out = await env.run([
      'browser', '--session', 'work', 'extract',
      '--selector', 'div.main',
    ])
    const envelope = JSON.parse(out) as { content: string; url: string }
    expect(envelope.url).toBe('https://example.com/a')
    expect(String(envelope.content)).toContain('scoped body')
    // The selector must reach the shared extraction expression.
    expect(env.browser.evaluateCalls.some((js) => js.includes('div.main'))).toBe(true)
  })

  it('local usage errors keep their CLI error codes after toolification', async () => {
    const env = await makeEnv()
    const out = await env.run([
      'browser', '--session', 'work', 'extract', '--chunk-size', '0',
    ])
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('invalid_chunk_size')
  })
})
