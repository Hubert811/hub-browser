/**
 * Phase 4.2 — `opencli bookmarks` command group (BrowserOS neo Bookmarks CDP
 * domain): list / search / add / update / move / remove. Exercised through the
 * real commander program with an injected fake bridge (no CDP needed).
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { FakeBrowser, FakePage, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

const FOLDER = { id: 'f1', type: 'folder', title: '工作', dateAdded: 1000 }
const BOOKMARK = {
  id: 'b1',
  parentId: 'f1',
  index: 0,
  type: 'url',
  title: 'GitHub',
  url: 'https://github.com',
  dateAdded: 2000,
  dateLastUsed: 3000,
}

function makeEnv() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-cli-cache-'))
  const browser = new FakeBrowser()
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  return {
    cacheDir,
    browser,
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        process.env.OPENCLI_CACHE_DIR = cacheDir
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    },
  }
}

describe('opencli bookmarks command group (Phase 4.2)', () => {
  beforeEach(() => {
    installFakeBridge(new FakeBrowser())
  })
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    process.exitCode = 0
  })

  it('list prints bookmark nodes as text and JSON', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'Bookmarks.getBookmarks') return { nodes: [FOLDER, BOOKMARK] }
      return {}
    }
    const out = await env.run(['bookmarks', 'list'])
    expect(out).toContain('[folder] 工作')
    expect(out).toContain('(id: f1)')
    expect(out).toContain('GitHub')
    expect(out).toContain('https://github.com')

    const jsonOut = await env.run(['bookmarks', 'list', '--json'])
    const parsed = JSON.parse(jsonOut) as { nodes: unknown[]; count: number }
    expect(parsed.count).toBe(2)
    expect(parsed.nodes[1]).toMatchObject({ id: 'b1', url: 'https://github.com' })
  })

  it('list --folder forwards folderId to Bookmarks.getBookmarks', async () => {
    const env = makeEnv()
    const out = await env.run(['bookmarks', 'list', '--folder', 'f1'])
    expect(out).toBe('(no bookmarks)')
    const call = env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.getBookmarks')
    expect(call?.params).toEqual({ folderId: 'f1' })
  })

  it('search returns matching bookmark results', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'Bookmarks.searchBookmarks') return { results: [BOOKMARK] }
      return {}
    }
    const out = await env.run(['bookmarks', 'search', 'github'])
    expect(out).toContain('GitHub')
    const call = env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.searchBookmarks')
    expect(call?.params).toMatchObject({ query: 'github', maxResults: 100 })

    const jsonOut = await env.run(['bookmarks', 'search', 'github', '--limit', '5', '--json'])
    const parsed = JSON.parse(jsonOut) as { results: unknown[]; count: number }
    expect(parsed.count).toBe(1)
    const limitCall = env.browser.cdpCalls.filter((c) => c.method === 'Bookmarks.searchBookmarks').pop()
    expect(limitCall?.params).toMatchObject({ query: 'github', maxResults: 5 })
  })

  it('add creates a URL bookmark and prints the node', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'Bookmarks.createBookmark') return { node: BOOKMARK }
      return {}
    }
    const out = await env.run(['bookmarks', 'add', '--title', 'GitHub', '--url', 'https://github.com', '--parent', 'f1', '--index', '0'])
    expect(out).toContain('Created bookmark b1 (GitHub)')
    const call = env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.createBookmark')
    expect(call?.params).toEqual({ title: 'GitHub', url: 'https://github.com', parentId: 'f1', index: 0 })

    const jsonOut = await env.run(['bookmarks', 'add', '--title', 'GitHub', '--url', 'https://github.com', '--json'])
    expect((JSON.parse(jsonOut) as { node: unknown }).node).toMatchObject({ id: 'b1' })
  })

  it('add --folder creates a folder without a URL', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'Bookmarks.createBookmark') return { node: FOLDER }
      return {}
    }
    const out = await env.run(['bookmarks', 'add', '--title', '工作', '--folder'])
    expect(out).toContain('Created folder f1')
    const call = env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.createBookmark')
    expect(call?.params).toEqual({ title: '工作' })
  })

  it('add without --url or --folder is a friendly usage error', async () => {
    const env = makeEnv()
    const out = await env.run(['bookmarks', 'add', '--title', 'x'])
    const parsed = JSON.parse(out) as { error: { code: string } }
    expect(parsed.error.code).toBe('usage_error')
    expect(env.browser.cdpCalls).toHaveLength(0)
  })

  it('update forwards title/url to Bookmarks.updateBookmark', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'Bookmarks.updateBookmark') return { node: { ...BOOKMARK, title: 'New' } }
      return {}
    }
    const out = await env.run(['bookmarks', 'update', 'b1', '--title', 'New'])
    expect(out).toContain('Updated bookmark b1 (New)')
    expect(env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.updateBookmark')?.params)
      .toEqual({ id: 'b1', title: 'New' })

    const bad = await env.run(['bookmarks', 'update', 'b1'])
    expect((JSON.parse(bad) as { error: { code: string } }).error.code).toBe('usage_error')
  })

  it('move forwards parent/index to Bookmarks.moveBookmark', async () => {
    const env = makeEnv()
    env.browser.cdpHandler = (method) => {
      if (method === 'Bookmarks.moveBookmark') return { node: { ...BOOKMARK, parentId: 'f2' } }
      return {}
    }
    const out = await env.run(['bookmarks', 'move', 'b1', '--parent', 'f2', '--index', '3'])
    expect(out).toContain('Moved bookmark b1 to folder f2')
    expect(env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.moveBookmark')?.params)
      .toEqual({ id: 'b1', parentId: 'f2', index: 3 })
  })

  it('remove calls Bookmarks.removeBookmark', async () => {
    const env = makeEnv()
    const out = await env.run(['bookmarks', 'remove', 'b1'])
    expect(out).toContain('Removed bookmark b1')
    expect(env.browser.cdpCalls.find((c) => c.method === 'Bookmarks.removeBookmark')?.params)
      .toEqual({ id: 'b1' })
  })

  it('add uses a default browser session (no <session> positional needed)', async () => {
    const env = makeEnv()
    const pageSpy = { connected: false }
    const orig = FakePage.prototype.cdp
    FakePage.prototype.cdp = async function (this: FakePage, method: string) {
      pageSpy.connected = true
      return orig.call(this, method)
    }
    try {
      await env.run(['bookmarks', 'list'])
      expect(pageSpy.connected).toBe(true)
    } finally {
      FakePage.prototype.cdp = orig
    }
  })
})
