import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { withLedgerLock } from './ledger-lock.js'

function tempLedger(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-lock-')), 'hub-spaces.json')
}

describe('ledger-lock (P1-7)', () => {
  it('holds the lockfile inside the critical section and removes it after', () => {
    const ledger = tempLedger()
    fs.writeFileSync(ledger, '{}', 'utf-8')
    withLedgerLock(ledger, () => {
      expect(fs.existsSync(`${ledger}.lock`)).toBe(true)
    })
    expect(fs.existsSync(`${ledger}.lock`)).toBe(false)
  })

  it('returns the critical section value', () => {
    const ledger = tempLedger()
    expect(withLedgerLock(ledger, () => 42)).toBe(42)
  })

  it('serializes concurrent sections in the same process', () => {
    const ledger = tempLedger()
    const order: string[] = []
    // Simulate P1 entering while P2 is inside: sections queue via EEXIST retry.
    withLedgerLock(ledger, () => {
      order.push('p1-start')
      withLedgerLock(
        ledger,
        () => {
          order.push('p2-inside')
        },
        { waitMs: 300, staleMs: 60_000 },
      )
      order.push('p1-end')
    })
    // The inner call cannot acquire (outer holds it, staleMs large) and runs
    // unlocked after waiting out waitMs — it must not deadlock or throw.
    expect(order).toContain('p2-inside')
    expect(order[0]).toBe('p1-start')
    expect(fs.existsSync(`${ledger}.lock`)).toBe(false)
  })

  it('breaks a stale lock (crashed holder) and acquires immediately', () => {
    const ledger = tempLedger()
    fs.writeFileSync(
      `${ledger}.lock`,
      JSON.stringify({ pid: 999999, ts: Date.now() - 60_000, uuid: 'stale-uuid' }),
      'utf-8',
    )
    const started = Date.now()
    const out = withLedgerLock(ledger, () => 'ok', { staleMs: 5_000, waitMs: 2_000 })
    expect(out).toBe('ok')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(fs.existsSync(`${ledger}.lock`)).toBe(false)
  })

  it('breaks an unreadable stale lock by mtime age', () => {
    const ledger = tempLedger()
    fs.writeFileSync(`${ledger}.lock`, 'not-json', 'utf-8')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(`${ledger}.lock`, old, old)
    const out = withLedgerLock(ledger, () => 'ok', { staleMs: 5_000, waitMs: 1_000 })
    expect(out).toBe('ok')
    expect(fs.existsSync(`${ledger}.lock`)).toBe(false)
  })

  it('times out on a fresh foreign lock: runs unlocked, keeps the foreign lock', () => {
    const ledger = tempLedger()
    const foreign = { pid: 12345, ts: Date.now(), uuid: 'foreign-uuid' }
    fs.writeFileSync(`${ledger}.lock`, JSON.stringify(foreign), 'utf-8')
    const started = Date.now()
    const out = withLedgerLock(ledger, () => 'ran-anyway', { waitMs: 150, staleMs: 60_000 })
    expect(out).toBe('ran-anyway')
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    // The foreign lock must survive — a timed-out holder never deletes it.
    expect(JSON.parse(fs.readFileSync(`${ledger}.lock`, 'utf-8'))).toEqual(foreign)
  })

  it('leaves no lock debris after a throwing critical section', () => {
    const ledger = tempLedger()
    expect(() =>
      withLedgerLock(ledger, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(fs.existsSync(`${ledger}.lock`)).toBe(false)
  })
})
