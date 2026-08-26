/**
 * Cross-process advisory lock for the space ledger file (P1-7).
 *
 * The ledger is shared by several processes (MCP server, hub daemon, per-command
 * CLI runs). Each writer does read-merge-write: read the disk state, merge its
 * in-memory view on top, atomically rename the result into place. Without a
 * lock, two writers interleave (P2 reads before P1 renames) and whichever
 * renames last silently discards state the other had just written — merge-on-save
 * only softens the blast radius, it cannot close the window.
 *
 * This module serializes the critical section with an O_EXCL lockfile:
 *  - acquire: exclusive `open(path, 'wx')` + `{pid, ts, uuid}` payload
 *  - staleness: a holder that crashed mid-write is detected by `ts` age (or
 *    file mtime when the payload is unreadable) and its lock is broken — the
 *    uuid is re-checked right before removal so a freshly re-acquired lock
 *    from another process is never collateral damage
 *  - waiting: tiny synchronous sleeps (Atomics.wait; busy loop fallback for
 *    runtimes that refuse it on the main thread)
 *  - timeout: after `waitMs` the critical section runs unlocked — persistence
 *    stays best-effort, a hung agent session is worse than a rare lost merge
 *  - release: the lock is removed only when it still carries this holder's
 *    uuid, so a timed-out holder never deletes a successor's lock
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_STALE_MS = 5_000
const DEFAULT_WAIT_MS = 2_000
const RETRY_SLEEP_MS = 2

export interface LedgerLockOptions {
  /** A held lock older than this is treated as abandoned (holder crashed). */
  staleMs?: number
  /** Total wait before running the critical section without the lock. */
  waitMs?: number
}

interface LockPayload {
  pid: number
  ts: number
  uuid: string
}

function lockPathFor(storagePath: string): string {
  return `${storagePath}.lock`
}

function tryAcquire(lockPath: string): LockPayload | undefined {
  const payload: LockPayload = { pid: process.pid, ts: Date.now(), uuid: randomUUID() }
  try {
    const fd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeSync(fd, JSON.stringify(payload))
    } finally {
      fs.closeSync(fd)
    }
    return payload
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return undefined
    throw e
  }
}

function readLock(lockPath: string): LockPayload | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockPayload>
    if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'number' && typeof parsed.uuid === 'string') {
      return parsed as LockPayload
    }
    return undefined
  } catch {
    return undefined
  }
}

function breakStaleLock(lockPath: string, staleMs: number): void {
  try {
    const held = readLock(lockPath)
    if (held) {
      if (Date.now() - held.ts < staleMs) return
      // Re-read and match identity before removing: another process may have
      // broken the same stale lock and re-acquired a fresh one in between.
      if (readLock(lockPath)?.uuid === held.uuid) fs.rmSync(lockPath, { force: true })
      return
    }
    // Unreadable/corrupt payload — fall back to mtime age.
    const st = fs.statSync(lockPath)
    if (Date.now() - st.mtimeMs >= staleMs) fs.rmSync(lockPath, { force: true })
  } catch {
    // best-effort: a vanished lock simply means someone else already broke it
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* busy fallback for runtimes that reject Atomics.wait on the main thread */
    }
  }
}

function release(lockPath: string, held: LockPayload): void {
  try {
    if (readLock(lockPath)?.uuid === held.uuid) fs.rmSync(lockPath, { force: true })
  } catch {
    // best-effort: a stale lock file is reclaimed by staleness later
  }
}

/**
 * Run `fn` (the read-merge-write critical section) holding the ledger lock.
 * Returns fn's return value; never throws for lock-related reasons — on
 * timeout the section simply runs unlocked (best-effort persistence).
 */
export function withLedgerLock<T>(
  storagePath: string,
  fn: () => T,
  opts: LedgerLockOptions = {},
): T {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS
  const lockPath = lockPathFor(storagePath)
  // The ledger's directory may not exist yet (first write / migration) — the
  // lockfile lives beside it, so make the module self-sufficient here.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  let held: LockPayload | undefined
  const deadline = Date.now() + waitMs
  while (!held && Date.now() < deadline) {
    held = tryAcquire(lockPath)
    if (!held) {
      breakStaleLock(lockPath, staleMs)
      sleepSync(RETRY_SLEEP_MS)
    }
  }
  try {
    return fn()
  } finally {
    if (held) release(lockPath, held)
  }
}
