/**
 * 方案 C — best-effort migration of user adapters from the legacy
 * ~/.opencli/clis/<site>/ layout to the new ~/.hub/clis/<site>/ layout.
 * Exercises the discovery.js migrateLegacyUserClis() entrypoint with temp
 * dirs (never touches the real ~/.opencli / ~/.hub).
 */
import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyUserClis } from '../src/opencli-engine/discovery.js'

function tempSites() {
  const root = mkdtempSync(join(tmpdir(), 'migrate-clis-'))
  return {
    legacy: join(root, 'legacy-clis'),
    dest: join(root, 'dest-clis'),
  }
}

describe('migrateLegacyUserClis — user adapter migration (best-effort)', () => {
  it('copies legacy sites into the new clis dir and keeps the legacy files', async () => {
    const { legacy, dest } = tempSites()
    mkdirSync(join(legacy, 'hn'), { recursive: true })
    writeFileSync(join(legacy, 'hn', 'top.js'), 'export default 1', 'utf-8')
    writeFileSync(join(legacy, 'hn', 'notes.md'), 'legacy notes', 'utf-8')
    mkdirSync(join(legacy, 'news'), { recursive: true })
    writeFileSync(join(legacy, 'news', 'top.js'), 'export default 2', 'utf-8')

    await migrateLegacyUserClis(legacy, dest)

    expect(existsSync(join(dest, 'hn', 'top.js'))).toBe(true)
    expect(readFileSync(join(dest, 'hn', 'top.js'), 'utf-8')).toBe('export default 1')
    expect(readFileSync(join(dest, 'hn', 'notes.md'), 'utf-8')).toBe('legacy notes')
    expect(existsSync(join(dest, 'news', 'top.js'))).toBe(true)
    // Legacy files preserved — never deleted.
    expect(existsSync(join(legacy, 'hn', 'top.js'))).toBe(true)
    expect(existsSync(join(legacy, 'news', 'top.js'))).toBe(true)
  })

  it('does NOT overwrite a site that already exists at the destination', async () => {
    const { legacy, dest } = tempSites()
    mkdirSync(join(legacy, 'hn'), { recursive: true })
    writeFileSync(join(legacy, 'hn', 'top.js'), 'legacy version', 'utf-8')
    mkdirSync(join(dest, 'hn'), { recursive: true })
    writeFileSync(join(dest, 'hn', 'top.js'), 'new version — keep me', 'utf-8')

    await migrateLegacyUserClis(legacy, dest)

    // Existing destination wins.
    expect(readFileSync(join(dest, 'hn', 'top.js'), 'utf-8')).toBe('new version — keep me')
    // Legacy untouched as well.
    expect(readFileSync(join(legacy, 'hn', 'top.js'), 'utf-8')).toBe('legacy version')
  })

  it('is a silent no-op when no legacy clis dir exists', async () => {
    const { dest } = tempSites()
    await migrateLegacyUserClis(join(dest, 'no-legacy'), dest)
    expect(existsSync(dest)).toBe(false)
  })

  it('skips a broken site without blocking the rest (best-effort)', async () => {
    const { legacy, dest } = tempSites()
    mkdirSync(join(legacy, 'broken'), { recursive: true })
    writeFileSync(join(legacy, 'broken', 'top.js'), 'x', 'utf-8')
    // Unreadable source forces the copy to fail for this site only.
    chmodSync(join(legacy, 'broken'), 0o000)
    mkdirSync(join(legacy, 'ok'), { recursive: true })
    writeFileSync(join(legacy, 'ok', 'top.js'), 'fine', 'utf-8')

    await migrateLegacyUserClis(legacy, dest)

    // The healthy site still migrates; the broken one is skipped with a warning.
    expect(existsSync(join(dest, 'ok', 'top.js'))).toBe(true)
    expect(existsSync(join(dest, 'broken', 'top.js'))).toBe(false)
  })
})
