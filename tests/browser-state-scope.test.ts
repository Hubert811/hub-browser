/**
 * Regression — browser-target-state persistence scope (audit finding):
 *
 * `hub browser <session> tab select <targetId>` must persist the default tab
 * under the USER SESSION NAME (`browser-state/<session>.json`), because
 * `getBrowserPage(session)` reads that same key via `resolveStoredBrowserTarget`.
 * It must NOT write under `page-<pageId>.json` — that key is never read.
 *
 * Scenario (proves the read path, not just the file name):
 *   space → open a.example (tab 100) → open b.example (tab 101, now ACTIVE)
 *   → tab select target-100 (the NON-active tab)
 *   → `browser <session> state` must operate on target-100 (the saved default),
 *     NOT fall back to the active tab (101). Without the fix the default-tab
 *     state is written to page-100.json and `<session>.json` is missing, so
 *     state falls back to the active tab (b.example).
 */
import { describe, expect, it } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

class FakeBrowser {
  tabs: Array<{
    pageId: number
    targetId: string
    url: string
    title?: string
    isActive?: boolean
  }> = []
  nextPageId = 100
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

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-state-scope-'))
  const ledger = path.join(root, 'hub-spaces.json')
  const browser = new FakeBrowser()
  class FakeBridge {
    async connect() {
      return browser.connect()
    }
  }
  ;(globalThis as any).__HubBrowserBridgeOverride = FakeBridge
  ;(globalThis as any).__HubDaemonMode = true
  process.env.BROWSEROS_DIR = root
  process.env.HUB_SPACES_FILE = ledger
  process.env.HUB_AGENT_ID = 'agent-a'
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

function stateDir(root: string) {
  return path.join(root, 'cache', 'browser-state')
}

describe('browser-target-state scope: user session name (not page-<id>)', () => {
  it('tab select persists under <session>.json and getBrowserPage reads the same key', async () => {
    const { root, browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    const created = JSON.parse(await run(['space', 'create', 'state-work', '--json']))
    const spaceId = (created as { space: { id: string } }).space.id
    expect(spaceId).toBeTruthy()

    // Two tabs: 100 (a.example) then 101 (b.example, ACTIVE).
    const openedA = JSON.parse(await run(['browser', '--session', 'work', 'open', 'https://a.example']))
    expect((openedA as { pageId: number }).pageId).toBe(100)
    const openedB = JSON.parse(await run(['browser', '--session', 'work', 'open', 'https://b.example']))
    expect((openedB as { pageId: number }).pageId).toBe(101)
    expect(browser.tabs.find((t) => t.pageId === 101)?.isActive).toBe(true)

    // Select the NON-active tab 100 as the session default.
    const selected = await run(['browser', '--session', 'work', 'tab', 'select', 'target-100'])
    expect(JSON.parse(selected) as { selected: string }).toMatchObject({ selected: 'target-100' })

    // The default-tab state must live under the USER SESSION name.
    const sessionFile = path.join(stateDir(root), 'work.json')
    const pageFile = path.join(stateDir(root), 'page-100.json')
    expect(fs.existsSync(sessionFile)).toBe(true)
    expect(fs.existsSync(pageFile)).toBe(false)
    const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as { defaultPage: string }
    expect(stored.defaultPage).toBe('target-100')

    // Next command must read the same key and operate on the saved default tab
    // (100), NOT fall back to the active tab (101).
    const stateOut = await run(['browser', '--session', 'work', 'state'])
    expect(stateOut).toContain('https://a.example')
    expect(stateOut).not.toContain('https://b.example')
  })

  it('tab close clears the session-scoped default when closing the selected tab', async () => {
    const { root, browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    await run(['space', 'create', 'close-work', '--json'])
    await run(['browser', '--session', 'work', 'open', 'https://a.example'])
    await run(['browser', '--session', 'work', 'tab', 'select', 'target-100'])

    const sessionFile = path.join(stateDir(root), 'work.json')
    expect(fs.existsSync(sessionFile)).toBe(true)

    await run(['browser', '--session', 'work', 'tab', 'close', 'target-100'])
    expect(fs.existsSync(sessionFile)).toBe(false)
    expect(browser.tabs).toHaveLength(0)
  })
})
