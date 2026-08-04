/**
 * Phase 3 B — `hub browser` commands are space-aware (via the shared
 * TaskSpaceManager ledger), exercised through the real commander program with
 * an injected fake browser bridge (no CDP needed).
 *
 * Coverage:
 *   space create → browser open <url> → tab list/state scoped to the space
 *   tab new attribution, tab close ledger sync, space close cleanup
 *   D3: without a current space open/select/close/new are rejected, tab list is empty
 */
import { describe, expect, it } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import { TaskSpaceManager } from '../src/space/task-space-manager.ts'
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

  async closeTab(target: number | string) {
    const idx = this.browser.tabs.findIndex(
      (t) =>
        t.pageId === target ||
        t.targetId === String(target) ||
        String(t.url ?? '').includes(String(target)),
    )
    if (idx >= 0) this.browser.tabs.splice(idx, 1)
  }

  async setActivePage(targetId?: string) {
    const idx = this.browser.tabs.findIndex((t) => t.targetId === targetId)
    if (idx >= 0) this.currentPageId = this.browser.tabs[idx].pageId
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
    // Sync in UnifiedPage (handler reads it without await).
    return this.browser.tabs.find((t) => t.pageId === this.currentPageId)?.targetId
  }
  async snapshot() {
    return 'fake snapshot'
  }
  async close() {}
}

function makeEnv() {
  const ledger = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'space-browser-cli-')),
    'hub-spaces.json',
  )
  const browser = new FakeBrowser()
  class FakeBridge {
    async connect() {
      return browser.connect()
    }
  }
  ;(globalThis as any).__HubBrowserBridgeOverride = FakeBridge
  // spaceGatewayFromBrowser() (used by `space close`) prefers the daemon
  // singleton — mimic it with the same fake browser.
  ;(globalThis as any).__HubBrowserFactory = {
    _cdp: {},
    _session: {},
    connect: async () => browser.connect(),
  }
  // In non-daemon mode browserAction() calls process.exit() after every
  // command; daemon mode keeps the process alive, which is what tests need.
  ;(globalThis as any).__HubDaemonMode = true
  return { ledger, browser }
}

describe('hub browser ↔ space integration (Phase 3 B)', () => {
  it('space create → browser open → tab list/state scoped → space close cleans up', async () => {
    const { ledger, browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        process.env.HUB_SPACES_FILE = ledger
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    }

    const created = await run(['space', 'create', 'cli-work', '--json'])
    const spaceId = (JSON.parse(created) as { space: { id: string } }).space.id
    expect(spaceId).toBeTruthy()

    // browser open <url> with a current space → routed through manager.openTab
    const opened = await run(['browser', '--session', 'work', 'open', 'https://example.com'])
    const openJson = JSON.parse(opened) as {
      url: string
      pageId: number
      spaceId: string
      page?: string
    }
    expect(openJson.url).toBe('https://example.com')
    expect(openJson.spaceId).toBe(spaceId)
    expect(openJson.pageId).toBe(100)
    expect(openJson.page).toBe('target-100')

    // browser tab list → scoped to the current space
    const listed = await run(['browser', '--session', 'work', 'tab', 'list'])
    const listJson = JSON.parse(listed) as Array<{ pageId: number; url: string }>
    expect(listJson).toHaveLength(1)
    expect(listJson[0].pageId).toBe(100)
    expect(listJson[0].url).toBe('https://example.com')

    // browser state → operates on the space tab (it became the active tab)
    const stateOut = await run(['browser', '--session', 'work', 'state'])
    expect(stateOut).toContain('https://example.com')

    // space close → closes the space's browser tab + removes the ledger entry
    const closed = await run(['space', 'close', spaceId, '--json'])
    expect((JSON.parse(closed) as { closed: string }).closed).toBe(spaceId)
    expect(browser.tabs.filter((t) => t.pageId === 100)).toHaveLength(0)
    expect(browser.tabs).toHaveLength(0)

    const after = await run(['space', 'list'])
    expect(after).not.toContain(spaceId)
  })

  it('browser tab new attributes the fresh tab to the current space', async () => {
    const { ledger } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      try {
        process.env.HUB_SPACES_FILE = ledger
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
      }
      return lines.join('\n')
    }

    const created = await run(['space', 'create', 'tab-work', '--json'])
    const spaceId = (JSON.parse(created) as { space: { id: string } }).space.id

    const out = await run(['browser', '--session', 'work', 'tab', 'new', 'https://example.org'])
    const json = JSON.parse(out) as { page: string; space?: string; pageId?: number }
    expect(json.page).toBe('target-100')
    expect(json.space).toBe(spaceId)
    expect(json.pageId).toBe(100)

    const listed = await run(['browser', '--session', 'work', 'tab', 'list'])
    expect(listed).toContain('https://example.org')

    const manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
    expect((await manager.getSpace(spaceId)).tabIds).toEqual([100])
  })

  it('browser tab close removes the tab from the space ledger too', async () => {
    const { ledger, browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      try {
        process.env.HUB_SPACES_FILE = ledger
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
      }
      return lines.join('\n')
    }

    const created = await run(['space', 'create', 'close-work', '--json'])
    const spaceId = (JSON.parse(created) as { space: { id: string } }).space.id
    await run(['browser', '--session', 'work', 'open', 'https://example.com'])

    const closed = await run(['browser', '--session', 'work', 'tab', 'close', 'target-100'])
    expect(JSON.parse(closed) as { closed: string }).toMatchObject({ closed: 'target-100' })
    expect(browser.tabs).toHaveLength(0)

    const manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
    expect((await manager.getSpace(spaceId)).tabIds).toEqual([])
  })

  it('D3: without a current space browser open/select/close/new are rejected and tab list is empty', async () => {
    const { ledger, browser } = makeEnv()
    browser.tabs.push({
      pageId: 100,
      targetId: 'target-100',
      url: 'https://start.example',
      title: undefined,
      isActive: true,
    })
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      const origErrWrite = process.stderr.write.bind(process.stderr)
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      process.stderr.write = ((chunk: unknown) => {
        lines.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        process.env.HUB_SPACES_FILE = ledger
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
        process.stderr.write = origErrWrite
      }
      return lines.join('\n')
    }

    // browser open → rejected with no-space (no legacy navigate of the connected tab)
    const opened = await run(['browser', '--session', 'work', 'open', 'https://example.com'])
    expect(opened).toContain('no space')
    expect(opened).toContain("hub space create")
    expect(browser.tabs).toHaveLength(1)
    expect(browser.tabs[0].url).toBe('https://start.example')

    // browser open --tab <target> → rejected too (no legacy raw navigate)
    const tabbed = await run(['browser', '--session', 'work', 'open', 'https://example.com', '--tab', 'target-100'])
    expect(tabbed).toContain('no space')
    expect(browser.tabs[0].url).toBe('https://start.example')

    // browser tab list → empty (no legacy unfiltered listing)
    const listed = JSON.parse(await run(['browser', '--session', 'work', 'tab', 'list'])) as unknown[]
    expect(listed).toHaveLength(0)

    // browser tab select → rejected
    const selected = await run(['browser', '--session', 'work', 'tab', 'select', 'target-100'])
    expect(selected).toContain('no space')

    // browser tab close → rejected (tab stays open)
    const closed = await run(['browser', '--session', 'work', 'tab', 'close', 'target-100'])
    expect(closed).toContain('no space')
    expect(browser.tabs).toHaveLength(1)

    // browser tab new → rejected before a tab is created
    const created = await run(['browser', '--session', 'work', 'tab', 'new', 'https://new.example'])
    expect(created).toContain('no space')
    expect(browser.tabs).toHaveLength(1)

    const manager = new TaskSpaceManager({ storagePath: ledger, persist: false })
    expect(await manager.listSpaces('cli:local')).toHaveLength(0)
  })
})
