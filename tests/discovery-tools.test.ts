/**
 * P2-6 (batch 3) — discovery tools (`find` / `analyze`): the structured
 * element query and site-recon pipelines, shared with the CLI commands
 * through observation-query.js. Tool-level tests run the real find pipeline
 * (buildFindJs/buildSemanticFindJs) and the real analyzeSite classification;
 * CLI-level tests verify the thin-wrapper output contracts survive
 * toolification (find {matches_n, entries[]} envelope / analyze report shape).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProgram } from '../src/opencli-engine/cli.js'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import { analyze, find } from '../src/browser-mcp/src/tools/discovery-tools.ts'
import { createFakePage, makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'
import { FakeBrowser, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

// ── Tool level ─────────────────────────────────────────────────────────────

const FIND_RESULT = {
  matches_n: 2,
  entries: [
    { ref: 'e1', tag: 'button', text: 'Save', attrs: { class: 'btn primary' } },
    { ref: 'e2', tag: 'button', text: 'Save all', attrs: { class: 'btn' } },
  ],
}

describe('find tool (P2-6 batch 3)', () => {
  it('css selector query returns matches_n + entries with refs', async () => {
    const page = createFakePage({ evaluate: async () => FIND_RESULT })
    const result = await executeTool(find, { page: 1, css: '.btn' }, makeContext(page))
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(FIND_RESULT)
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('[e1] Save')
  })

  it('semantic locator fields build the semantic find expression', async () => {
    const seen: string[] = []
    const page = createFakePage({
      evaluate: async (js: string) => {
        seen.push(js)
        return FIND_RESULT
      },
    })
    const result = await executeTool(
      find,
      { page: 1, role: 'button', name: 'Save' },
      makeContext(page),
    )
    expect(result.isError).toBeFalsy()
    // The semantic expression carries the CRITERIA marker; the CSS one does not.
    expect(seen[0]).toContain('CRITERIA')
    expect(seen[0]).toContain('"role":"button"')
  })

  it('neither css nor semantic fields is a usage error', async () => {
    const page = createFakePage({ evaluate: async () => FIND_RESULT })
    const result = await executeTool(find, { page: 1 }, makeContext(page))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'usage_error' })
  })

  it('find errors (invalid selector etc.) keep their pipeline codes', async () => {
    const page = createFakePage({
      evaluate: async () => ({ error: { code: 'invalid_selector', message: 'bad selector', hint: 'check syntax' } }),
    })
    const result = await executeTool(find, { page: 1, css: '>>' }, makeContext(page))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'invalid_selector' })
    expect(String((result.content as { text?: string }[])[0]?.text)).toContain('[invalid_selector]')
  })
})

describe('analyze tool (P2-6 batch 3)', () => {
  const PROBE = {
    cookieNames: ['session'],
    initialState: { __NEXT_DATA__: true },
    title: 'Fake Site',
    finalUrl: 'https://fake.example.com/page',
  }

  function probePage(extra: Partial<Record<'evaluate', unknown>> = {}) {
    return createFakePage({
      goto: async () => undefined,
      wait: async () => undefined,
      startNetworkCapture: async () => true,
      getCookies: async () => [],
      evaluate: async () => '[]',
      ...extra,
    })
  }

  it('navigates and returns a classified report', async () => {
    const gotoCalls: string[] = []
    const page = probePage({
      evaluate: async () => PROBE,
    })
    const pageWithGoto = Object.assign(page, {
      goto: async (url: string) => {
        gotoCalls.push(url)
      },
    })
    const result = await executeTool(
      analyze,
      { page: 1, url: 'https://fake.example.com/page' },
      makeContext(pageWithGoto),
    )
    expect(result.isError).toBeFalsy()
    expect(gotoCalls).toEqual(['https://fake.example.com/page'])
    const report = result.structuredContent as Record<string, unknown>
    expect(report.final_url).toBe('https://fake.example.com/page')
    // classifyPattern returns a structured object; the report carries it as-is.
    expect(report.pattern).toBeTypeOf('object')
    expect(report).toHaveProperty('recommended_next_step')
  })
})

// ── CLI thin-wrapper level ──────────────────────────────────────────────────

const BUILTIN_CLIS = join(process.cwd(), 'clis')
const USER_CLIS = join(tmpdir(), 'hub-clis-empty-disc')
const GATE_OWNER = 'disc-cli'

async function makeEnv() {
  const browser = new FakeBrowser()
  browser.tabs.push({ pageId: 100, targetId: 'target-100', url: 'https://example.com', isActive: true })
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  const root = mkdtempSync(join(tmpdir(), 'disc-spaces-'))
  const ledger = join(root, 'hub-spaces.json')
  process.env.HUB_SPACES_FILE = ledger
  process.env.HUB_AGENT_ID = GATE_OWNER
  process.env.OPENCLI_CACHE_DIR = mkdtempSync(join(tmpdir(), 'disc-cli-cache-'))
  const { TaskSpaceManager } = await import('../src/space/task-space-manager.ts')
  const manager = new TaskSpaceManager({ storagePath: ledger })
  await manager.create(GATE_OWNER, 'disc')
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

describe('browser find / analyze CLI wrappers (P2-6 batch 3)', () => {
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.HUB_SPACES_FILE
    delete process.env.HUB_AGENT_ID
    process.exitCode = 0
  })

  it('find --css prints the {matches_n, entries[]} envelope (pre-P2-6 contract)', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = FIND_RESULT
    const out = await env.run(['browser', '--session', 'work', 'find', '--css', '.btn'])
    const parsed = JSON.parse(out) as { matches_n: number; entries: Array<{ ref: string }> }
    expect(parsed.matches_n).toBe(2)
    expect(parsed.entries[0].ref).toBe('e1')
  })

  it('find --role semantic locator forwards to the semantic expression', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = FIND_RESULT
    const out = await env.run([
      'browser', '--session', 'work', 'find', '--role', 'button', '--name', 'Save',
    ])
    const parsed = JSON.parse(out) as { matches_n: number }
    expect(parsed.matches_n).toBe(2)
    // The semantic path carries the CRITERIA marker; the CSS path does not.
    expect(env.browser.evaluateCalls[0]).toContain('CRITERIA')
  })

  it('find usage errors keep the CLI codes after toolification', async () => {
    const env = await makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'find'])
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('usage_error')
    const both = await env.run([
      'browser', '--session', 'work', 'find', '--css', '.a', '--role', 'button',
    ])
    expect((JSON.parse(both) as { error: { code: string } }).error.code).toBe('usage_error')
  })

  it('analyze navigates and prints the classified report', async () => {
    const env = await makeEnv()
    env.browser.evaluateResult = {
      cookieNames: [],
      initialState: {},
      title: 'T',
      finalUrl: 'https://example.com/',
    }
    const out = await env.run([
      'browser', '--session', 'work', 'analyze', 'https://example.com/',
    ])
    const report = JSON.parse(out) as { final_url: string; pattern: unknown }
    expect(report.final_url).toBe('https://example.com/')
    expect(report.pattern).toBeTypeOf('object')
  })
})
