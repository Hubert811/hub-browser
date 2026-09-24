/**
 * M5 — ledger authority: ONE process owns the ledger, and it says so.
 *
 * Why this exists. Before M5 the storage layer carried three pieces of
 * machinery — a cross-process lock, merge-on-save, and close tombstones — whose
 * only job was to survive MULTIPLE writers. They made concurrent writes
 * non-corrupting, but never lossless: whichever process renamed last still
 * dropped spaces the other had just written (merge only narrowed the window).
 *
 * M5 removes them by making one writer true instead of merely usual:
 *   - `hub --mcp` is now a client of the daemon (src/daemon-bridge.ts), so the
 *     daemon is the writer for every agent;
 *   - the daemon CLAIMS the ledger for its lifetime (this module), and a second
 *     authority refuses to start rather than silently merging;
 *   - the short-lived entry points that could still be a second writer (the
 *     CLI's direct-execution fallback, the embedded stdio mode) claim too, so
 *     two of them serialize instead of clobbering.
 *
 * Liveness is `pid alive AND heartbeat fresh`: a process killed with -9 stops
 * being an authority immediately (its pid is gone) instead of blocking the next
 * one for the whole stale window.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** How long a heartbeat stays valid. Holders refresh well inside this. */
export const AUTHORITY_STALE_MS = 30_000

export interface LedgerAuthority {
  pid: number
  startedAt: number
  heartbeatAt: number
  /** The daemon's HTTP port, when the holder is a daemon. */
  port?: number
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; holder: LedgerAuthority }

/**
 * Paths this process holds, with a REFCOUNT.
 *
 * The count matters: several managers (or a manager plus an entry-point claim)
 * share one process-level authority, and the authority must survive until the
 * LAST of them is done. Releasing on the first dispose would hand the ledger to
 * another process while a live manager here could still write it.
 */
const held = new Map<string, number>()

export function authorityPathFor(storagePath: string): string {
  return `${storagePath}.authority.json`
}

export function readLedgerAuthority(
  storagePath: string,
): LedgerAuthority | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(authorityPathFor(storagePath), 'utf-8'),
    ) as Partial<LedgerAuthority>
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.heartbeatAt === 'number'
    ) {
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        heartbeatAt: parsed.heartbeatAt,
        ...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
      }
    }
  } catch {
    // Missing or unreadable: nobody provably holds it.
  }
  return undefined
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** A holder counts as live only while its pid exists AND its heartbeat is fresh. */
export function isAuthorityLive(
  holder: LedgerAuthority | undefined,
  now = Date.now(),
): boolean {
  if (!holder) return false
  if (!pidAlive(holder.pid)) return false
  return now - holder.heartbeatAt < AUTHORITY_STALE_MS
}

/**
 * The live holder of this ledger, if any (this process excluded). Read-only:
 * callers use it to refuse loudly instead of writing behind someone's back.
 */
export function ledgerAuthorityHolder(
  storagePath: string,
): LedgerAuthority | undefined {
  if (held.has(storagePath)) return undefined
  const holder = readLedgerAuthority(storagePath)
  if (!isAuthorityLive(holder)) return undefined
  return holder?.pid === process.pid ? undefined : holder
}

/**
 * Take the ledger for this process. Idempotent per path: several managers in one
 * process are one authority (which is what they are).
 */
export function claimLedgerAuthority(
  storagePath: string,
  opts?: { port?: number; now?: number },
): ClaimResult {
  const existingCount = held.get(storagePath)
  if (existingCount !== undefined) {
    held.set(storagePath, existingCount + 1)
    return { ok: true }
  }
  const now = opts?.now ?? Date.now()
  const record: LedgerAuthority = {
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    ...(opts?.port !== undefined ? { port: opts.port } : {}),
  }
  const authorityPath = authorityPathFor(storagePath)
  try {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  } catch {
    // An unwritable directory must not be fatal: the ledger write itself will
    // fail loudly enough, and refusing to start on a read-only directory would
    // be worse than proceeding.
    held.set(storagePath, 1)
    return { ok: true }
  }
  // Atomic claim. An O_EXCL create is the only thing that makes "exactly one
  // writer" true when two processes start at the same instant: a
  // read-then-write check is a TOCTOU race in which BOTH sides read nothing
  // and both conclude they are the authority.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(authorityPath, 'wx')
      try {
        fs.writeSync(fd, JSON.stringify(record, null, 2))
      } finally {
        fs.closeSync(fd)
      }
      held.set(storagePath, 1)
      return { ok: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // Any other failure is treated like an unwritable authority file.
        held.set(storagePath, 1)
        return { ok: true }
      }
      const existing = readLedgerAuthority(storagePath)
      if (
        existing &&
        isAuthorityLive(existing, now) &&
        existing.pid !== process.pid
      ) {
        return { ok: false, holder: existing }
      }
      // Stale holder (dead pid / old heartbeat): clear it and retry the create.
      try {
        fs.rmSync(authorityPath, { force: true })
      } catch {
        // best-effort — the next attempt re-checks EEXIST
      }
    }
  }
  const holder = readLedgerAuthority(storagePath)
  return holder ? { ok: false, holder } : { ok: true }
}

/** Refresh our claim. A no-op when this process does not hold the ledger. */
export function heartbeatLedgerAuthority(
  storagePath: string,
  opts?: { now?: number },
): void {
  if (!held.has(storagePath)) return
  const existing = readLedgerAuthority(storagePath)
  if (existing && existing.pid !== process.pid) return // someone took over
  try {
    fs.writeFileSync(
      authorityPathFor(storagePath),
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: existing?.startedAt ?? (opts?.now ?? Date.now()),
          heartbeatAt: opts?.now ?? Date.now(),
          ...(existing?.port !== undefined ? { port: existing.port } : {}),
        },
        null,
        2,
      ),
      'utf-8',
    )
  } catch {
    // best-effort
  }
}

/**
 * Drop ONE claim. The ledger is released only when the last holder in this
 * process lets go (see the refcount note above).
 */
export function releaseLedgerAuthority(storagePath: string): void {
  const count = held.get(storagePath)
  if (count === undefined) return
  if (count > 1) {
    held.set(storagePath, count - 1)
    return
  }
  held.delete(storagePath)
  try {
    const existing = readLedgerAuthority(storagePath)
    if (existing && existing.pid !== process.pid) return
    fs.rmSync(authorityPathFor(storagePath), { force: true })
  } catch {
    // best-effort
  }
}

/** Drop every claim this process holds, whatever the refcounts (exit hook). */
export function releaseAllLedgerAuthorities(): void {
  for (const storagePath of [...held.keys()]) {
    held.set(storagePath, 1)
    releaseLedgerAuthority(storagePath)
  }
}

/** A short, operator-facing description of a holder. */
export function describeAuthority(holder: LedgerAuthority): string {
  return `pid ${holder.pid}${holder.port !== undefined ? ` on port ${holder.port}` : ''}`
}
