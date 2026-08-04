/**
 * Phase 3 B — browser CLI tab guard (adapter-space e2e bugs #4 / #5):
 *   - `browser <session> tab select/close <targetId>` must reject tabs that
 *     belong to another space (or no space) when the caller has a current
 *     space; D3 — without any space select/close are rejected too and `tab
 *     list` is empty (no legacy open world).
 *   - `browser <session> tab list` must scope by tab identity (pageId), not
 *     URL — a same-URL tab owned by another space must not leak into the list.
 *
 * Exercised through the real commander program with an injected fake browser
 * bridge (no CDP needed), mirroring tests/space-browser-cli.test.ts.
 */
import { describe, expect, it } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

/** Shared fake browser registry (persists across per-command bridge instances). */
class FakeBrowser {
  tabs: Array<{
    pageId: number
    targetId: string
    url: string
    title?: string
    isActive?: boolean
  }> = []
  nextPageId = 100
  closed: string[] = []
  selected: string[] = []

  async connect() {
    return new FakePage(this)
  }

  newTab(url?: string, opts?: { background?: boolean }): { pageId: number; targetId: string } {
    const pageId = this.nextPageId++
    const targetId = `target-${pageId}`
    const tab = {
      pageId,
      targetId,
      url: url ?? 'about:blank',
      title: undefined,
      isActive: false,
    }
    this.tabs.push(tab)
    if (opts?.background === false) {
      tab.isActive = true
      for (const t of this.tabs) if (t !== tab) t.isActive = false
    }
    return { pageId, targetId }
  }
}

/** Fake UnifiedPage surface used by the browser commands under test. */
class FakePage {
  currentPageId: number | undefined
  constructor(private browser: FakeBrowser) {
    const active = this.browser.tabs.find((t) => t.isActive) ?? this.browser.tabs[0]
    this.currentPageId = active?.pageId
  }

  get session(): string {
    return `page-${this.currentPageId}`
  }

  async tabs() {
    return this.browser.tabs.map((t) => ({ ...t, page: t.targetId }))
  }

  async newTab(url?: string, opts?: { background?: boolean }) {
    const { targetId } = this.browser.newTab(url, opts)
    const created = this.browser.tabs.find((t) => t.targetId === targetId)!
    this.currentPageId = created.pageId
    return targetId
  }

  async selectTab(target: number | string) {
    const idx = this.browser.tabs.findIndex(
      (t) => t.pageId === target || t.targetId === String(target),
    )
    if (idx < 0) throw new Error(`Tab not found: ${target}`)
    this.browser.selected.push(String(target))
    this.currentPageId = this.browser.tabs[idx].pageId
  }

  async setActivePage(targetId?: string) {
    const idx = this.browser.tabs.findIndex((t) => t.targetId === targetId)
    if (idx >= 0) this.currentPageId = this.browser.tabs[idx].pageId
  }

  async closeTab(target: number | string) {
    const idx = this.browser.tabs.findIndex(
      (t) => t.pageId === target || t.targetId === String(target),
    )
    if (idx >= 0) {
      this.browser.closed.push(this.browser.tabs[idx].targetId)
      this.browser.tabs.splice(idx, 1)
    }
  }

  async goto(url: string) {
    const tab = this.browser.tabs.find((t) => t.pageId === this.currentPageId)
    if (tab) tab.url = url
  }

  async wait() {}
  async evaluate() {
    return undefined
  }
  async startNetworkCapture() {
    return false
  }
  async getCurrentUrl() {
    return this.browser.tabs.find((t) => t.pageId === this.currentPageId)?.url
  }
  getActivePage() {
    return this.browser.tabs.find((t) => t.pageId === this.currentPageId)?.targetId
  }
  async snapshot() {
    return 'fake snapshot'
  }
  async close() {}
}

/** Isolated env per test: own ledger, own browser-state dir, fake bridge. */
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'space-tab-guard-'))
  const ledger = path.join(root, 'hub-spaces.json')
  const browser = new FakeBrowser()
  class FakeBridge {
    async connect() {
      return browser.connect()
    }
  }
  ;(globalThis as any).__HubBrowserBridgeOverride = FakeBridge
  // In non-daemon mode browserAction() calls process.exit() after every
  // command; daemon mode keeps the process alive, which is what tests need.
  ;(globalThis as any).__HubDaemonMode = true
  // Isolate browser-state cache + user-cli discovery into the temp root.
  process.env.BROWSEROS_DIR = root
  process.env.HUB_SPACES_FILE = ledger
  return { root, ledger, browser }
}

async function runProgram(program: ReturnType<typeof createProgram>, args: string[]) {
  const lines: string[] = []
  const origLog = console.log
  const origErrLog = console.error
  const origErrWrite = process.stderr.write.bind(process.stderr)
  const origExitCode = process.exitCode
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    process.exitCode = 0
    await program.parseAsync(['node', 'hub', ...args])
  } finally {
    console.log = origLog
    console.error = origErrLog
    process.stderr.write = origErrWrite
    process.exitCode = origExitCode
  }
  return lines.join('\n')
}

describe('hub browser tab guard (Phase 3 B — bugs #4/#5 + D3)', () => {
  it('tab select rejects a tab owned by another space', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    // agent-a creates its space and opens a tab
    process.env.HUB_AGENT_ID = 'agent-a'
    const createdA = JSON.parse(await run(['space', 'create', 'alice', '--json']))
    const spaceA = (createdA as { space: { id: string } }).space.id
    const openedA = JSON.parse(
      await run(['browser', '--session', 'alice-work', 'open', 'https://example.com']),
    )
    expect((openedA as { spaceId: string }).spaceId).toBe(spaceA)
    expect((openedA as { pageId: number }).pageId).toBe(100)

    // agent-b creates its space and opens a tab (same URL on purpose)
    process.env.HUB_AGENT_ID = 'agent-b'
    const createdB = JSON.parse(await run(['space', 'create', 'bob', '--json']))
    const spaceB = (createdB as { space: { id: string } }).space.id
    const openedB = JSON.parse(
      await run(['browser', '--session', 'bob-work', 'open', 'https://example.com']),
    )
    expect((openedB as { pageId: number }).pageId).toBe(101)
    expect(spaceB).not.toBe(spaceA)

    // agent-a must NOT be able to select agent-b's tab
    process.env.HUB_AGENT_ID = 'agent-a'
    const out = await run(['browser', '--session', 'alice-work', 'tab', 'select', 'target-101'])
    expect(out).toContain('tab target-101 is not in your space')
    expect(browser.selected).toEqual([])

    // agent-a selecting its own tab still works
    const ownOut = await run(['browser', '--session', 'alice-work', 'tab', 'select', 'target-100'])
    expect(ownOut).toContain('"selected": "target-100"')
    expect(browser.selected).toEqual(['target-100'])
  })

  it('tab close rejects a tab owned by another space (bug #4: fallback bypass)', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    process.env.HUB_AGENT_ID = 'agent-a'
    const createdA = JSON.parse(await run(['space', 'create', 'alice', '--json']))
    const spaceA = (createdA as { space: { id: string } }).space.id
    await run(['browser', '--session', 'alice-work', 'open', 'https://a.example'])

    process.env.HUB_AGENT_ID = 'agent-b'
    const createdB = JSON.parse(await run(['space', 'create', 'bob', '--json']))
    const spaceB = (createdB as { space: { id: string } }).space.id
    await run(['browser', '--session', 'bob-work', 'open', 'https://b.example'])
    expect(spaceB).not.toBe(spaceA)
    expect(browser.tabs.map((t) => t.targetId)).toContain('target-101')

    // agent-a must NOT be able to close agent-b's tab
    process.env.HUB_AGENT_ID = 'agent-a'
    const out = await run(['browser', '--session', 'alice-work', 'tab', 'close', 'target-101'])
    expect(out).toContain('tab target-101 is not in your space')
    expect(browser.closed).toEqual([])
    expect(browser.tabs.map((t) => t.targetId)).toContain('target-101')

    // agent-a closing its own tab still works
    const ownOut = await run(['browser', '--session', 'alice-work', 'tab', 'close', 'target-100'])
    expect(ownOut).toContain('"closed": "target-100"')
    expect(browser.tabs.map((t) => t.targetId)).toEqual(['target-101'])
  })

  it('tab list scopes by tab identity, not URL (bug #5: same-URL leak)', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    process.env.HUB_AGENT_ID = 'agent-a'
    const createdA = JSON.parse(await run(['space', 'create', 'alice', '--json']))
    const spaceA = (createdA as { space: { id: string } }).space.id
    await run(['browser', '--session', 'alice-work', 'open', 'https://example.com'])

    process.env.HUB_AGENT_ID = 'agent-b'
    const createdB = JSON.parse(await run(['space', 'create', 'bob', '--json']))
    const spaceB = (createdB as { space: { id: string } }).space.id
    await run(['browser', '--session', 'bob-work', 'open', 'https://example.com'])
    expect(spaceB).not.toBe(spaceA)

    // Same URL in both spaces; agent-a's scoped list must show only its tab.
    process.env.HUB_AGENT_ID = 'agent-a'
    const listed = JSON.parse(
      await run(['browser', '--session', 'alice-work', 'tab', 'list']),
    ) as Array<{ pageId: number; url: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0].pageId).toBe(100)
    expect(listed[0].url).toBe('https://example.com')

    process.env.HUB_AGENT_ID = 'agent-b'
    const listedB = JSON.parse(
      await run(['browser', '--session', 'bob-work', 'tab', 'list']),
    ) as Array<{ pageId: number; url: string }>
    expect(listedB).toHaveLength(1)
    expect(listedB[0].pageId).toBe(101)
  })

  it('D3: without a current space select/close are rejected and tab list is empty', async () => {
    const { browser } = makeEnv()
    browser.newTab('https://start.example')
    browser.newTab('https://other.example')
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)
    delete process.env.HUB_AGENT_ID

    // No current space → tab list is empty (no legacy unfiltered listing)
    const listed = JSON.parse(await run(['browser', '--session', 'legacy', 'tab', 'list'])) as unknown[]
    expect(listed).toHaveLength(0)

    // No current space → select is rejected
    const selected = await run(['browser', '--session', 'legacy', 'tab', 'select', 'target-100'])
    expect(selected).toContain('no space')
    expect(browser.selected).toEqual([])

    // No current space → close is rejected (tab stays open)
    const closed = await run(['browser', '--session', 'legacy', 'tab', 'close', 'target-101'])
    expect(closed).toContain('no space')
    expect(browser.tabs.map((t) => t.targetId)).toEqual(['target-100', 'target-101'])
  })
})
