/**
 * Phase 4.7 — `opencli browser pdf`, `browser download`, `browser upload`
 * (thin wrappers over the fork pdf/download/upload tools). Fake bridge, no CDP.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createProgram } from '../src/opencli-engine/cli.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { FakeBrowser, installFakeBridge, uninstallFakeBridge } from './helpers/fake-browser'

const BUILTIN_CLIS = path.join(process.cwd(), 'clis')
const USER_CLIS = path.join(os.homedir(), '.hub', 'clis')

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-dl-ul-'))
  const cacheDir = path.join(tmp, 'cache')
  const browserosDir = path.join(tmp, 'browseros')
  const browser = new FakeBrowser()
  browser.tabs.push({ pageId: 100, targetId: 'target-100', url: 'https://example.com', isActive: true })
  installFakeBridge(browser)
  const program = createProgram(BUILTIN_CLIS, USER_CLIS)
  return {
    tmp,
    cacheDir,
    browserosDir,
    browser,
    run: async (args: string[]) => {
      const lines: string[] = []
      const origLog = console.log
      const origErr = console.error
      console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => lines.push('ERR ' + a.map(String).join(' '))
      try {
        process.env.OPENCLI_CACHE_DIR = cacheDir
        process.env.BROWSEROS_DIR = browserosDir
        await program.parseAsync(['node', 'hub', ...args])
      } finally {
        console.log = origLog
        console.error = origErr
      }
      return lines.join('\n')
    },
  }
}

describe('opencli browser pdf (Phase 4.7)', () => {
  beforeEach(() => installFakeBridge(new FakeBrowser()))
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.BROWSEROS_DIR
    process.exitCode = 0
  })

  it('prints the tool output path when no --path is given', async () => {
    const env = makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'pdf'])
    expect(out).toContain('Saved page 100 as PDF')
    expect(out).toMatch(/\.pdf$/)
    const call = env.browser.cdpCalls.find((c) => c.method === 'Page.printToPDF')
    expect(call?.params).toMatchObject({ printBackground: true })
  })

  it('--path copies the generated PDF and reports the requested path', async () => {
    const env = makeEnv()
    const target = path.join(env.tmp, 'out', 'page.pdf')
    const out = await env.run(['browser', '--session', 'work', 'pdf', '--path', target])
    expect(out).toContain(target)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toContain('%PDF-1.4 fake pdf')
  })

  it('--json prints the structured envelope with the path', async () => {
    const env = makeEnv()
    const target = path.join(env.tmp, 'page2.pdf')
    const out = await env.run(['browser', '--session', 'work', 'pdf', '--path', target, '--json'])
    const parsed = JSON.parse(out) as { path: string; bytes: number }
    expect(parsed.path).toBe(target)
    expect(parsed.bytes).toBeGreaterThan(0)
  })
})

describe('opencli browser download (Phase 4.7)', () => {
  beforeEach(() => installFakeBridge(new FakeBrowser()))
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.BROWSEROS_DIR
    process.exitCode = 0
  })

  it('clicks the ref and reports the saved download path', async () => {
    const env = makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'download', '5'])
    expect(env.browser.lastClickRef).toBe('5')
    expect(out).toContain('Downloaded "report.csv" to:')
    expect(out).toContain('report.csv')
  })

  it('strips a leading @ from the ref', async () => {
    const env = makeEnv()
    await env.run(['browser', '--session', 'work', 'download', '@5'])
    expect(env.browser.lastClickRef).toBe('5')
  })

  it('--json prints the structured download envelope', async () => {
    const env = makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'download', '5', '--json'])
    const parsed = JSON.parse(out) as { ref: string; filename: string }
    expect(parsed.ref).toBe('5')
    expect(parsed.filename).toBe('report.csv')
  })
})

describe('opencli browser upload (Phase 4.7)', () => {
  beforeEach(() => installFakeBridge(new FakeBrowser()))
  afterEach(() => {
    uninstallFakeBridge()
    delete process.env.OPENCLI_CACHE_DIR
    delete process.env.BROWSEROS_DIR
    process.exitCode = 0
  })

  it('--file uploads a single file through the fork upload tool', async () => {
    const env = makeEnv()
    const filePath = path.join(env.tmp, 'a.pdf')
    fs.writeFileSync(filePath, 'pdf')
    const out = await env.run(['browser', '--session', 'work', 'upload', '@5', '--file', filePath])
    expect(env.browser.lastUpload).toEqual({ ref: '5', files: [filePath] })
    expect(out).toContain('Uploaded 1 file(s) to 5')
  })

  it('--files accepts a comma-separated list plus positional files', async () => {
    const env = makeEnv()
    const a = path.join(env.tmp, 'a.pdf')
    const b = path.join(env.tmp, 'b.pdf')
    fs.writeFileSync(a, 'a')
    fs.writeFileSync(b, 'b')
    const out = await env.run(['browser', '--session', 'work', 'upload', '7', '--files', a])
    expect(env.browser.lastUpload).toEqual({ ref: '7', files: [a] })
    expect(out).toContain('Uploaded 1 file(s) to 7')
  })

  it('--json prints the fork tool structured envelope', async () => {
    const env = makeEnv()
    const filePath = path.join(env.tmp, 'c.pdf')
    fs.writeFileSync(filePath, 'c')
    const out = await env.run(['browser', '--session', 'work', 'upload', '5', '--file', filePath, '--json'])
    const parsed = JSON.parse(out) as { ref: string; uploaded: number }
    expect(parsed.ref).toBe('5')
    expect(parsed.uploaded).toBe(1)
  })

  it('missing files produce a friendly error', async () => {
    const env = makeEnv()
    const out = await env.run(['browser', '--session', 'work', 'upload', '5', '--file', '/nope/does-not-exist.pdf'])
    expect(JSON.parse(out) as { error: { code: string } }).toMatchObject({ error: { code: 'file_not_found' } })
  })
})
