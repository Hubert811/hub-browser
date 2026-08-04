/**
 * Shared fake browser bridge for Phase 4 CLI tests (bookmarks / history /
 * diff / read / grep / pdf / download / upload). Mirrors the fake pattern in
 * tests/space-browser-cli.test.ts but also fakes the UnifiedPage surface the
 * fork browser tools call (cdp / evaluate / snapshot / diff / pageSession /
 * click / uploadFiles / tabs).
 */
export interface FakeTab {
  pageId: number
  targetId: string
  url: string
  title?: string
  isActive?: boolean
}

export class FakeDownloadSession {
  handlers: Record<string, Array<(params: any) => void>> = {}
  setDownloadBehaviorCalls: Array<{ behavior: string; downloadPath?: string }> = []
  Page = {
    setDownloadBehavior: async (params: { behavior: string; downloadPath?: string }) => {
      this.setDownloadBehaviorCalls.push(params)
    },
    on: (event: string, cb: (params: any) => void) => {
      ;(this.handlers[event] ??= []).push(cb)
      return () => {
        this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== cb)
      }
    },
  }
  emit(event: string, params: any) {
    for (const h of this.handlers[event] ?? []) h(params)
  }
}

export class FakeBrowser {
  tabs: FakeTab[] = []
  nextPageId = 100
  cdpCalls: Array<{ method: string; params: unknown }> = []
  evaluateCalls: string[] = []
  cdpHandler?: (method: string, params: any) => unknown
  evaluateResult: unknown = 'fake page content'
  snapshotText = 'line1 [ref=e1]\nline2 error here [ref=e2]\nline3'
  diffResult: unknown = { changed: false }
  uploadResult: unknown = {
    uploaded: 1,
    files: ['/tmp/a.pdf'],
    file_names: ['a.pdf'],
    target: '5',
    matches_n: 1,
  }
  downloadSession = new FakeDownloadSession()
  lastUpload?: { ref: string; files: string[] }
  lastClickRef?: string

  newTab(url?: string, opts?: { background?: boolean }): { pageId: number; targetId: string } {
    const pageId = this.nextPageId++
    const targetId = `target-${pageId}`
    const tab: FakeTab = { pageId, targetId, url: url ?? 'about:blank', isActive: false }
    this.tabs.push(tab)
    if (opts?.background === false) {
      tab.isActive = true
      for (const t of this.tabs) if (t !== tab) t.isActive = false
    }
    return { pageId, targetId }
  }

  async connect() {
    return new FakePage(this)
  }
}

export class FakePage {
  pageId = 100
  constructor(private browser: FakeBrowser) {}

  get session(): string {
    return `page-${this.pageId}`
  }

  async tabs() {
    return this.browser.tabs.map((t) => ({ ...t, page: t.targetId }))
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.browser.cdpCalls.push({ method, params })
    if (this.browser.cdpHandler) return this.browser.cdpHandler(method, params)
    if (method === 'Bookmarks.getBookmarks') return { nodes: [] }
    if (method === 'Bookmarks.searchBookmarks') return { results: [] }
    if (method === 'History.getRecent') return { entries: [] }
    if (method === 'History.search') return { entries: [] }
    if (method === 'Page.printToPDF') {
      return { data: Buffer.from('%PDF-1.4 fake pdf').toString('base64') }
    }
    return {}
  }

  async evaluate(js: string): Promise<unknown> {
    this.browser.evaluateCalls.push(js)
    return this.browser.evaluateResult
  }

  async snapshot() {
    return this.browser.snapshotText
  }

  async diff() {
    return this.browser.diffResult
  }

  async pageSession() {
    return this.browser.downloadSession as unknown
  }

  async click(ref: string) {
    this.browser.lastClickRef = ref
    this.browser.downloadSession.emit('downloadWillBegin', {
      guid: 'guid-1',
      suggestedFilename: 'report.csv',
    })
    this.browser.downloadSession.emit('downloadProgress', {
      guid: 'guid-1',
      state: 'completed',
    })
    return { ok: true, matches_n: 1, match_level: 'ref' }
  }

  async uploadFiles(ref: string, files: string[]) {
    this.browser.lastUpload = { ref, files }
    return this.browser.uploadResult
  }

  async close() {}

  getActivePage() {
    return this.browser.tabs[0]?.targetId
  }

  async getCurrentUrl() {
    return this.browser.tabs[0]?.url ?? 'https://example.com'
  }
}

/** Wires the fake bridge into the CLI's browserAction path for the process. */
export function installFakeBridge(browser: FakeBrowser) {
  class FakeBridge {
    async connect() {
      return browser.connect()
    }
  }
  ;(globalThis as any).__HubBrowserBridgeOverride = FakeBridge
  // browserAction() calls process.exit() after every command unless daemon
  // mode is set; tests need the process to survive.
  ;(globalThis as any).__HubDaemonMode = true
}

export function uninstallFakeBridge() {
  delete (globalThis as any).__HubBrowserBridgeOverride
  delete (globalThis as any).__HubDaemonMode
}
