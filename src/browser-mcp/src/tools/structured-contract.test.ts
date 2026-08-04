import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTool } from './framework'
import { BROWSER_TOOLS } from './registry'
import { createFakePage, makeContext } from './test-helpers'

const page = {
  pageId: 1,
  targetId: 'target-1',
  tabId: 11,
  url: 'https://example.com',
  title: 'Example',
  isActive: true,
  isLoading: false,
  loadProgress: 1,
  isPinned: false,
}

const windowInfo = {
  windowId: 7,
  type: 'normal',
  bounds: {},
  state: 'normal',
  tabCount: 1,
  tabs: [],
}

const group = {
  groupId: 'group-1',
  windowId: 7,
  title: 'Work',
  color: 'blue',
  collapsed: false,
  tabIds: [11],
}

const historyEntry = {
  id: 'history-1',
  url: 'https://example.com/history',
  title: 'History',
  lastVisitTime: 1_785_456_000_000,
  visitCount: 2,
  typedCount: 1,
}

/** Fully stubbed UnifiedPage implementing the fork's tool surface. */
function createContractPage() {
  let downloadDir = ''
  const downloadHandlers: Record<string, ((p: unknown) => void) | undefined> = {}
  const up = createFakePage({
    evaluate: (async (expression: string) => {
      if (
        expression.includes('.includes(') ||
        expression.includes('querySelector(')
      ) {
        return true
      }
      return 'page value'
    }) as never,
    snapshot: (async () => 'button "Save" [ref=e1]') as never,
    diff: (async () => ({
      changed: true,
      text: '+ button "Saved" [ref=e1]',
      added: 1,
      removed: 0,
      afterUrl: page.url,
    })) as never,
    tabs: (async () => [page]) as never,
    newTab: (async () => 'target-2') as never,
    closeTab: (async () => {}) as never,
    goto: (async () => {}) as never,
    refCenter: (async () => null) as never,
    pageSession: (async () => ({
      Page: {
        setDownloadBehavior: async (params?: { downloadPath?: string }) => {
          downloadDir = String(params?.downloadPath ?? '')
        },
        on: (event: string, cb: (p: unknown) => void) => {
          downloadHandlers[event] = cb
          return () => {
            downloadHandlers[event] = undefined
          }
        },
      },
    })) as never,
    click: (async () => {
      if (downloadDir) {
        writeFileSync(join(downloadDir, 'report.txt'), 'data')
        downloadHandlers.downloadWillBegin?.({
          guid: 'g-1',
          suggestedFilename: 'report.txt',
        })
        downloadHandlers.downloadProgress?.({ guid: 'g-1', state: 'completed' })
      }
    }) as never,
    fillText: (async () => ({ filled: true })) as never,
    nativeType: (async () => {}) as never,
    nativeClick: (async () => {}) as never,
    pressKey: (async () => {}) as never,
    hover: (async () => {}) as never,
    focus: (async () => ({ focused: true })) as never,
    setChecked: (async () => ({ checked: true, changed: true })) as never,
    selectOption: (async () => 'Work') as never,
    scroll: (async () => {}) as never,
    scrollTo: (async () => {}) as never,
    drag: (async () => ({ dragged: true })) as never,
    uploadFiles: (async () => ({ uploaded: true, files: 1 })) as never,
    screenshot: (async () => Buffer.from('image').toString('base64')) as never,
    annotatedScreenshot: (async () =>
      Buffer.from('image').toString('base64')) as never,
    windowList: (async () => [windowInfo]) as never,
    windowCreate: (async () => windowInfo) as never,
    windowClose: (async () => {}) as never,
    windowActivate: (async () => {}) as never,
    tabGroupList: (async () => [group]) as never,
    tabGroupCreate: (async () => group) as never,
    tabGroupUpdate: (async () => group) as never,
    cdp: (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.setDownloadBehavior') {
        downloadDir = String(params?.downloadPath ?? '')
        return {}
      }
      if (method === 'Page.printToPDF') {
        return { data: Buffer.from('pdf').toString('base64') }
      }
      if (method === 'Browser.getTabGroups') {
        return { groups: [group] }
      }
      if (method === 'History.getRecent') {
        return { entries: [historyEntry] }
      }
      if (
        method === 'Browser.addTabsToGroup' ||
        method === 'Browser.createTabGroup' ||
        method === 'Browser.updateTabGroup'
      ) {
        return { group }
      }
      return {}
    }) as never,
  })
  return up
}

function structuredKeys(structuredContent: unknown): string[] {
  if (
    typeof structuredContent !== 'object' ||
    structuredContent === null ||
    Array.isArray(structuredContent)
  ) {
    throw new Error('expected a structured object')
  }
  return Object.keys(structuredContent).sort()
}

describe('browser tool structured contract', () => {
  it('pins the exact structured keys emitted by every browser tool', async () => {
    const previous = process.env.BROWSEROS_DIR
    const browserosDir = mkdtempSync(join(tmpdir(), 'structured-contract-'))
    process.env.BROWSEROS_DIR = browserosDir
    try {
      const up = createContractPage()
      const ctx = makeContext(up)
      const byName = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool]))
      const call = async (name: string, args: Record<string, unknown>) => {
        const tool = byName.get(name)
        if (!tool) throw new Error(`missing browser tool: ${name}`)
        const result = await executeTool(tool, args, ctx)
        expect(result.isError, `${name} should succeed`).toBeFalsy()
        return structuredKeys(result.structuredContent)
      }

      const actual = {
        'tabs.list': await call('tabs', { action: 'list' }),
        'tabs.active': await call('tabs', { action: 'active' }),
        'tabs.new': await call('tabs', { action: 'new' }),
        'tabs.close': await call('tabs', { action: 'close', page: 1 }),
        'tab_groups.list': await call('tab_groups', { action: 'list' }),
        'tab_groups.create': await call('tab_groups', {
          action: 'create',
          pages: [1],
        }),
        'tab_groups.update': await call('tab_groups', {
          action: 'update',
          groupId: 'group-1',
          title: 'Updated',
        }),
        'tab_groups.ungroup': await call('tab_groups', {
          action: 'ungroup',
          pages: [1],
        }),
        'tab_groups.close': await call('tab_groups', {
          action: 'close',
          groupId: 'group-1',
        }),
        history: await call('history', { maxResults: 1 }),
        navigate: await call('navigate', {
          page: 1,
          action: 'url',
          url: page.url,
        }),
        snapshot: await call('snapshot', { page: 1 }),
        diff: await call('diff', { page: 1 }),
        act: await call('act', { page: 1, kind: 'click', ref: 'e1' }),
        download: await call('download', { page: 1, ref: 'e1' }),
        upload: await call('upload', {
          page: 1,
          ref: 'e2',
          file: '/tmp/upload.txt',
        }),
        read: await call('read', { page: 1, format: 'text' }),
        grep: await call('grep', {
          page: 1,
          pattern: 'save',
          over: 'ax',
        }),
        screenshot: await call('screenshot', { page: 1 }),
        pdf: await call('pdf', { page: 1 }),
        'wait.time': await call('wait', {
          page: 1,
          for: 'time',
          value: 0,
        }),
        'wait.selector': await call('wait', {
          page: 1,
          for: 'selector',
          value: '#ready',
        }),
        'windows.list': await call('windows', { action: 'list' }),
        'windows.create': await call('windows', { action: 'create' }),
        'windows.close': await call('windows', {
          action: 'close',
          windowId: 7,
        }),
        'windows.activate': await call('windows', {
          action: 'activate',
          windowId: 7,
        }),
        evaluate: await call('evaluate', {
          page: 1,
          code: 'return document.title',
        }),
        run: await call('run', { code: 'return { answer: 42 }' }),
      }

      expect(actual).toEqual({
        'tabs.list': ['pages'],
        'tabs.active': ['action', 'page'],
        'tabs.new': ['page'],
        'tabs.close': ['page'],
        'tab_groups.list': ['count', 'groups'],
        'tab_groups.create': ['group'],
        'tab_groups.update': ['group'],
        'tab_groups.ungroup': ['count', 'pageIds'],
        'tab_groups.close': ['groupId'],
        history: ['count', 'entries'],
        navigate: ['page', 'url'],
        snapshot: ['contentLength', 'page', 'tokenEstimate', 'writtenToFile'],
        diff: ['added', 'changed', 'removed'],
        act: ['changed', 'kind'],
        download: ['filename', 'page', 'path', 'ref'],
        upload: ['files', 'page', 'ref', 'uploaded'],
        read: ['contentLength', 'format', 'page', 'writtenToFile'],
        grep: ['count', 'matches', 'over', 'page'],
        screenshot: ['bytes', 'format', 'page'],
        pdf: ['bytes', 'page', 'path'],
        'wait.time': ['matched', 'waitedMs'],
        'wait.selector': ['matched'],
        'windows.list': ['action', 'count', 'windows'],
        'windows.create': ['action', 'window'],
        'windows.close': ['action', 'windowId'],
        'windows.activate': ['action', 'windowId'],
        evaluate: ['page', 'value'],
        run: ['logs', 'ok', 'value'],
      })
    } finally {
      if (previous === undefined) {
        delete process.env.BROWSEROS_DIR
      } else {
        process.env.BROWSEROS_DIR = previous
      }
      rmSync(browserosDir, { recursive: true, force: true })
    }
  })
})
