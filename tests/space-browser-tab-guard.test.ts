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
import { describe, expect, it, afterAll } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

// Env hygiene: HUB_AGENT_ID/HUB_SPACES_FILE leaking past this file breaks
// sibling spawn-based tests (e.g. space-close-direct-exit) that inherit env.
afterAll(() => {
  delete process.env.HUB_AGENT_ID
  delete process.env.HUB_SPACES_FILE
})

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
  groups: Array<{ pages: number[]; title?: string }> = []
  ungrouped: number[][] = []
  groupUpdates: string[] = []
  groupCloses: string[] = []

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

  tabGroupCreate(pages: number[], title?: string) {
    const group = { pages: [...pages], ...(title !== undefined ? { title } : {}) }
    this.groups.push(group)
    return { groupId: `group-${this.groups.length}`, ...group }
  }

  tabGroupUngroup(pages: number[]) {
    this.ungrouped.push([...pages])
  }

  /** CDP-shaped group view: groupId + tabIds (tabId === pageId in the fake). */
  tabGroupList() {
    return this.groups.map((g, i) => ({
      groupId: `group-${i + 1}`,
      title: g.title,
      tabIds: [...g.pages],
    }))
  }

  tabGroupUpdate(groupId: string, opts: { title?: string }) {
    this.groupUpdates.push(groupId)
    const idx = Number(groupId.replace(/^group-/, '')) - 1
    const g = this.groups[idx]
    if (!g) throw new Error(`Unknown tab group ${groupId}`)
    if (opts.title !== undefined) g.title = opts.title
    return { groupId, ...g }
  }

  tabGroupClose(groupId: string) {
    this.groupCloses.push(groupId)
    const idx = Number(groupId.replace(/^group-/, '')) - 1
    const g = this.groups[idx]
    if (!g) throw new Error(`Unknown tab group ${groupId}`)
    for (const pageId of g.pages) {
      const t = this.tabs.find((tab) => tab.pageId === pageId)
      if (t) {
        this.closed.push(t.targetId)
        this.tabs.splice(this.tabs.indexOf(t), 1)
      }
    }
    this.groups.splice(idx, 1)
  }
}

/** Fake UnifiedPage surface used by the browser commands under test. */
class FakePage {
  currentPageId: number | undefined
  constructor(private browser: FakeBrowser) {
    const active = this.browser.tabs.find((t) => t.isActive) ?? this.browser.tabs[0]
    this.currentPageId = active?.pageId
  }

  /** forkToolArgsFor(page) binds the connected/active page id. */
  get pageId(): number | undefined {
    return this.currentPageId
  }

  get session(): string {
    return `page-${this.currentPageId}`
  }

  async tabs() {
    // tabId mirrors pageId in the fake (real CDP tabs carry both ids).
    return this.browser.tabs.map((t) => ({ ...t, tabId: t.pageId, page: t.targetId }))
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
  async tabGroupCreate(pages: number[], title?: string) {
    return this.browser.tabGroupCreate(pages, title)
  }
  async tabGroupUngroup(pages: number[]) {
    this.browser.tabGroupUngroup(pages)
  }
  async tabGroupList() {
    return this.browser.tabGroupList()
  }
  async tabGroupUpdate(groupId: string, opts: { title?: string }) {
    return this.browser.tabGroupUpdate(groupId, opts)
  }
  async tabGroupClose(groupId: string) {
    return this.browser.tabGroupClose(groupId)
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
      await run(['browser', '--session', 'alice-work', 'tab', 'list', '-f', 'json']),
    ) as Array<{ pageId: number; url: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0].pageId).toBe(100)
    expect(listed[0].url).toBe('https://example.com')

    process.env.HUB_AGENT_ID = 'agent-b'
    const listedB = JSON.parse(
      await run(['browser', '--session', 'bob-work', 'tab', 'list', '-f', 'json']),
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
    const listed = JSON.parse(await run(['browser', '--session', 'legacy', 'tab', 'list', '-f', 'json'])) as unknown[]
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

describe('hub CLI P1-4 gate: group commands + fork tool wrappers', () => {
  it('group create rejects pages owned by another space (P1-1 矩阵补洞)', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    process.env.HUB_AGENT_ID = 'agent-a'
    await run(['space', 'create', 'alice', '--json'])
    await run(['browser', '--session', 'alice-work', 'open', 'https://a.example'])

    process.env.HUB_AGENT_ID = 'agent-b'
    await run(['space', 'create', 'bob', '--json'])
    await run(['browser', '--session', 'bob-work', 'open', 'https://b.example'])

    // agent-b must NOT be able to drag agent-a's tab (page 100) into its own
    // group — D5 treats a drag INTO the group as an ownership transfer.
    // (The two existing groups are the D5 space projections: each space
    // create/open auto-groups its tabs under the space name.)
    const groupsBefore = browser.groups.length
    const out = await run(['browser', '--session', 'bob-work', 'group', 'create', '--pages', '100'])
    expect(out).toContain('not in your space')
    expect(out).toContain('page-not-in-space')
    expect(browser.groups).toHaveLength(groupsBefore)
    expect(browser.groups.find((g) => g.pages.includes(100))?.title).toBe('alice')

    // Grouping its OWN page works (a genuinely new group beyond the projections)
    const own = await run(['browser', '--session', 'bob-work', 'group', 'create', '--pages', '101', '--title', 'bob-extra'])
    expect(browser.groups).toHaveLength(groupsBefore + 1)
    expect(browser.groups.at(-1)?.pages).toEqual([101])
    expect(browser.groups.at(-1)?.title).toBe('bob-extra')
  })

  it('group create/ungroup without a current space are rejected (D3)', async () => {
    const { browser } = makeEnv()
    browser.newTab('https://start.example')
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)
    delete process.env.HUB_AGENT_ID

    const created = await run(['browser', '--session', 'legacy', 'group', 'create', '--pages', '100'])
    expect(created).toContain('no space')
    expect(browser.groups).toEqual([])

    const ungrouped = await run(['browser', '--session', 'legacy', 'group', 'ungroup', '--pages', '100'])
    expect(ungrouped).toContain('no space')
    expect(browser.ungrouped).toEqual([])
  })

  it('group ungroup rejects pages owned by another space', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    process.env.HUB_AGENT_ID = 'agent-a'
    await run(['space', 'create', 'alice', '--json'])
    await run(['browser', '--session', 'alice-work', 'open', 'https://a.example'])

    process.env.HUB_AGENT_ID = 'agent-b'
    await run(['space', 'create', 'bob', '--json'])
    await run(['browser', '--session', 'bob-work', 'open', 'https://b.example'])

    const out = await run(['browser', '--session', 'bob-work', 'group', 'ungroup', '--pages', '100'])
    expect(out).toContain('not in your space')
    expect(browser.ungrouped).toEqual([])
  })

  it('group update/close reject a group owned by another space (real-run P1-1 hole, 2026-08-22)', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    process.env.HUB_AGENT_ID = 'agent-a'
    await run(['space', 'create', 'alice', '--json'])
    await run(['browser', '--session', 'alice-work', 'open', 'https://a.example'])

    process.env.HUB_AGENT_ID = 'agent-b'
    await run(['space', 'create', 'bob', '--json'])
    await run(['browser', '--session', 'bob-work', 'open', 'https://b.example'])

    // D5 projection groups: alice's tabs grouped under 'alice', bob's under
    // 'bob'. Grab live group ids from the list (never hardcode fake ids).
    const groups = JSON.parse(
      await run(['browser', '--session', 'bob-work', 'group', 'list']),
    ) as Array<{ groupId: string; title?: string; tabIds: number[] }>
    const foreign = groups.find((g) => g.title === 'alice')
    const own = groups.find((g) => g.title === 'bob')
    expect(foreign).toBeDefined()
    expect(own).toBeDefined()
    // The D5 projection sync itself may call tabGroupUpdate; only calls past
    // this point are the command under test.
    const updatesBefore = browser.groupUpdates.length
    const closesBefore = browser.groupCloses.length

    // agent-b must NOT be able to rename agent-a's group — pre-fix this
    // sailed through (groupId-addressed, pages gate never fired).
    const upd = await run(['browser', '--session', 'bob-work', 'group', 'update', foreign!.groupId, '--title', 'hack'])
    expect(upd).toContain('not in your space')
    expect(upd).toContain('page-not-in-space')
    expect(browser.groupUpdates.slice(updatesBefore)).toEqual([])

    // Nor close it — that would take agent-a's tabs down with the group.
    const cls = await run(['browser', '--session', 'bob-work', 'group', 'close', foreign!.groupId])
    expect(cls).toContain('not in your space')
    expect(browser.groupCloses.slice(closesBefore)).toEqual([])
    expect(browser.tabs.map((t) => t.targetId)).toContain('target-100')
    expect(browser.groups.find((g) => g.pages.includes(100))?.title).toBe('alice')

    // agent-b renaming its OWN group still works.
    const ok = await run(['browser', '--session', 'bob-work', 'group', 'update', own!.groupId, '--title', 'bob-renamed'])
    expect(browser.groupUpdates.slice(updatesBefore)).toEqual([own!.groupId])
    expect(browser.groups.find((g) => g.pages.includes(101))?.title).toBe('bob-renamed')
  })

  it('group update/close reject the SAME agent\u2019s other space (real-run repro: one agent, two spaces)', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    // One local agent (no HUB_AGENT_ID switching), two spaces — mirrors the
    // live repro where an agent-level check (assertPagesControllable) waved
    // the rename through because BOTH spaces belong to the same owner.
    process.env.HUB_AGENT_ID = 'solo'
    await run(['space', 'create', 'work-one', '--json'])
    await run(['browser', '--session', 's1', 'open', 'https://one.example'])
    await run(['space', 'create', 'work-two', '--json'])
    await run(['browser', '--session', 's2', 'open', 'https://two.example'])

    const groups = JSON.parse(
      await run(['browser', '--session', 's2', 'group', 'list']),
    ) as Array<{ groupId: string; title?: string; tabIds: number[] }>
    const foreign = groups.find((g) => g.title === 'work-one')
    const own = groups.find((g) => g.title === 'work-two')
    expect(foreign).toBeDefined()
    expect(own).toBeDefined()
    const updatesBefore = browser.groupUpdates.length
    const closesBefore = browser.groupCloses.length

    // Current space is work-two; renaming/closing work-one's projection
    // group must be rejected at the SPACE level even though both spaces
    // belong to the same agent.
    const upd = await run(['browser', '--session', 's2', 'group', 'update', foreign!.groupId, '--title', 'hijacked'])
    expect(upd).toContain('is not in your space')
    expect(upd).toContain('page-not-in-space')
    expect(browser.groupUpdates.slice(updatesBefore)).toEqual([])

    const cls = await run(['browser', '--session', 's2', 'group', 'close', foreign!.groupId])
    expect(cls).toContain('is not in your space')
    expect(browser.groupCloses.slice(closesBefore)).toEqual([])
    // work-one's tab survives the close attempt.
    expect(browser.tabs.map((t) => t.url)).toContain('https://one.example')

    // The current space's own group is still operable.
    const ok = await run(['browser', '--session', 's2', 'group', 'update', own!.groupId, '--title', 'work-two-renamed'])
    expect(browser.groupUpdates.slice(updatesBefore)).toEqual([own!.groupId])
    expect(browser.groups.find((g) => g.pages.includes(101))?.title).toBe('work-two-renamed')
  })

  it('fork tool wrappers pass the executeTool gate (P1-4 CLI face)', async () => {
    const { browser } = makeEnv()
    const program = createProgram(BUILTIN_CLIS, USER_CLIS)
    const run = (args: string[]) => runProgram(program, args)

    // agent-a's tab (100) is the active tab; agent-b owns a space with no tabs.
    process.env.HUB_AGENT_ID = 'agent-a'
    await run(['space', 'create', 'alice', '--json'])
    await run(['browser', '--session', 'alice-work', 'open', 'https://a.example'])

    process.env.HUB_AGENT_ID = 'agent-b'
    await run(['space', 'create', 'bob', '--json'])

    // The connected/active page (100) belongs to agent-a → guardToolAccess
    // inside executeTool rejects the fork wrapper (open-world before the
    // identity+spaces injection).
    const foreign = await run(['browser', '--session', 'bob-work', 'read'])
    expect(foreign).toContain('not in your space')
    // P1-4 (phase C): the fork bridge surfaces the REAL platform code from
    // the structured contract — not the legacy 'tool_error' blanket.
    const jsonStart = foreign.indexOf('{')
    const jsonEnd = foreign.lastIndexOf('}')
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    const foreignParsed = JSON.parse(foreign.slice(jsonStart, jsonEnd + 1)) as {
      error: { code: string; message: string }
    }
    expect(foreignParsed.error.code).toBe('page-not-in-space')
    expect(foreignParsed.error.message).toContain('not in your space')

    // Without a space the fork wrappers are rejected (D3 parity with tab select)
    delete process.env.HUB_AGENT_ID
    const noSpace = await run(['browser', '--session', 'legacy', 'read'])
    expect(noSpace).toContain('no space')

    // Own page still reads fine (evaluate returns undefined → '(empty)' body)
    process.env.HUB_AGENT_ID = 'agent-a'
    const own = await run(['browser', '--session', 'alice-work', 'read'])
    expect(own).toContain('UNTRUSTED_PAGE_CONTENT')
  })
})
