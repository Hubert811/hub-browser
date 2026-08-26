/**
 * P2-7 — co-located verify fixtures: `clis/<site>/__fixtures__/verify/<cmd>.json`.
 *
 * The matrix: user fixture (~/.hub/config/sites/..., the historical path and
 * still the write target / local override) resolves first, then the builtin
 * co-located fixture ships with the adapter source. --require-fixture turns
 * "no fixture in effect" into the publish-gate failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  builtinFixturePath,
  fixturePath,
  loadFixture,
  resolveFixture,
  writeFixture,
} from '../src/opencli-engine/browser/verify-fixture.js'

const SAVED_BROWSEROS_DIR = process.env.BROWSEROS_DIR
let userRoot: string
let clisRoot: string

beforeAll(() => {
  userRoot = mkdtempSync(join(tmpdir(), 'hub-fx-user-'))
  clisRoot = mkdtempSync(join(tmpdir(), 'hub-fx-clis-'))
  process.env.BROWSEROS_DIR = userRoot
})

afterAll(() => {
  if (SAVED_BROWSEROS_DIR === undefined) delete process.env.BROWSEROS_DIR
  else process.env.BROWSEROS_DIR = SAVED_BROWSEROS_DIR
})

function seedUser(site: string, command: string, marker: string): void {
  const p = fixturePath(site, command)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify({ args: {}, expect: { rowCount: { min: 1 } }, marker }))
}

function seedBuiltin(site: string, command: string, marker: string): void {
  const p = builtinFixturePath(site, command, clisRoot)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify({ args: {}, expect: { rowCount: { min: 2 } }, marker }))
}

describe('resolveFixture matrix (P2-7)', () => {
  it('user fixture wins over the co-located builtin (local override)', () => {
    seedUser('s1', 'cmd', 'user-one')
    seedBuiltin('s1', 'cmd', 'builtin-one')
    const resolved = resolveFixture('s1', 'cmd', { clisRoot })
    expect(resolved?.source).toBe('user')
    expect(resolved?.fixture.marker).toBe('user-one')
    expect(resolved?.path).toBe(fixturePath('s1', 'cmd'))
  })

  it('falls back to the builtin co-located fixture when no user override exists', () => {
    seedBuiltin('s2', 'cmd', 'builtin-only')
    const resolved = resolveFixture('s2', 'cmd', { clisRoot })
    expect(resolved?.source).toBe('builtin')
    expect(resolved?.fixture.marker).toBe('builtin-only')
    expect(resolved?.path).toBe(builtinFixturePath('s2', 'cmd', clisRoot))
  })

  it('returns null when neither exists; loadFixture stays a thin wrapper', () => {
    expect(resolveFixture('nobody', 'nothing', { clisRoot })).toBeNull()
    expect(loadFixture('nobody', 'nothing', { clisRoot })).toBeNull()
  })

  it('writeFixture always targets the user path — the source tree is never written', () => {
    seedBuiltin('s3', 'cmd', 'builtin-original')
    const p = writeFixture('s3', 'cmd', { expect: { rowCount: { min: 1 } } })
    expect(p).toBe(fixturePath('s3', 'cmd'))
    // The builtin copy is untouched; the user copy now wins the matrix.
    expect(readFileSync(builtinFixturePath('s3', 'cmd', clisRoot), 'utf-8')).toContain(
      'builtin-original',
    )
    expect(resolveFixture('s3', 'cmd', { clisRoot })?.source).toBe('user')
  })

  it('builtinFixturePath resolves the installed clis tree by default', () => {
    const p = builtinFixturePath('github', 'issues')
    expect(p).toContain(join('github', '__fixtures__', 'verify', 'issues.json'))
    // Points at the real installed tree (this repo's clis/).
    expect(p).toContain(join('hub-browser', 'clis'))
  })
})
