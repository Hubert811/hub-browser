/**
 * Claw harness reporter (P2-3) — feeds hub's tool dispatches into the
 * BrowserClaw server's audit trail so hub sessions appear in the cockpit
 * timeline with attributed rrweb recordings.
 *
 * Architecture: hub keeps its own CDP connection and space guards; this
 * reporter is a one-way, append-only observability feed to the claw-server
 * harness API (`POST /api/v1/harness/...`, see vendor-patches/
 * claw-server-harness-reporting.patch). It must NEVER gate or fail a tool
 * dispatch: every call is fire-and-forget with a bounded queue, and the first
 * connection refusal disables the reporter until a periodic re-probe.
 *
 * Session identity: claw requires Ulid-shaped session ids, and its task
 * projection anchors started_at/ended_at to the FIRST start/end event for a
 * session id (audit_log.rs query_start/query_end are order_by_asc). A
 * deterministic per-owner id therefore freezes the task row after its first
 * end while later dispatches keep attaching — F17's eternal 22h session was
 * the no-end variant of the same trap. Each process instance (daemon, MCP
 * server, direct CLI run) now derives a fresh per-working-period session id
 * per owner (`hub:<owner>#<instanceSuffix>`) and ends it with kind "closed"
 * (the only kind derive_status treats as terminal, matching the official
 * runtime) when that process exits or idles out. A small ledger file records
 * recent session ids per owner so cross-process readers (replay export) can
 * find the latest working period.
 */

import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { resolveClawServerPort } from '../../../cdp-port.js'

const REPROBE_INTERVAL_MS = 5 * 60_000
const QUEUE_LIMIT = 200
const END_WAIT_MS = 1_500
const DRAIN_WAIT_MS = 2_000
const SESSION_LEDGER_KEEP = 20
/** Stale threshold for the startup orphan sweep — matches the official
 * server's own idle default (DEFAULT_SESSION_IDLE_MS = 30min), so a hub
 * session left Live by a crashed process lives exactly as long as a native
 * MCP session would before the sweeper closes it. */
const SWEEP_STALE_MS = 30 * 60_000

/** Base URL of the BrowserClaw server; shared by the harness reporter (write
 * path) and the replay read face.
 *
 * Resolution: HUB_CLAW_SERVER_URL (whole-URL override) → config.json
 * `ports.server` (the server rebinds off 9210 when the port is taken, and the
 * config file is the only place that drift is recorded) → fallback
 * `http://127.0.0.1:9210`. Hard-coding 9210 broke the whole cockpit feed for
 * as long as the server sat on a drifted port — found 2026-08-26 when a
 * dogfooding run's tabs were invisible in the cockpit audit. */
export function clawServerBaseUrl(): string {
  const envUrl = process.env.HUB_CLAW_SERVER_URL?.trim()
  if (envUrl) return envUrl
  return `http://127.0.0.1:${resolveClawServerPort()}`
}

export interface ClawDispatchReport {
  /** Owner key (convoId ?? agentId) — derives the claw session id. */
  owner?: string
  /** Agent identity for the claw rows (session start / claim / dispatch);
   * falls back to 'hub' so unattributed callers keep the legacy label. */
  agentId?: string
  agentLabel?: string
  toolName: string
  pageId?: number
  tabId?: number
  targetId?: string
  url?: string
  title?: string
  args?: Record<string, unknown>
  isError: boolean
  errorHead?: string
  guard?: string
  structuredKeys?: string[]
  /** MCP content block count of the tool result — official rows summarize this
   * as `contentSummary: "N block(s)"` in resultMeta. */
  contentBlockCount?: number
  durationMs: number
  createdAt: number
}

interface QueuedCall {
  run: (baseUrl: string) => Promise<void>
  owner: string
}

/**
 * Deterministic Ulid-shaped claw session id for a hub owner key.
 *
 * Historical: this deterministic mapping predates the discovery that the
 * claw task projection anchors its started_at/ended_at to the FIRST start/end
 * events — with it, a working period after the first end attaches dispatches
 * to a frozen task row. Live sessions now use the per-process
 * `sessionIdFor()`; this export remains for readers that need the legacy
 * derivation (tests, historical lookups).
 */
export function clawSessionIdOf(owner: string): string {
  return createHash('sha256').update(`hub:${owner}`).digest('hex').slice(0, 26).toUpperCase()
}

/** Ledger file recording recent claw sessions per owner (newest first) so
 * cross-process readers can find the latest working period. Root matches
 * hubUserRoot's rule (BROWSEROS_DIR override, default ~/.hub) so the writer
 * and replay-tools' reader agree on one location. */
function sessionLedgerPath(): string {
  const root =
    process.env.BROWSEROS_DIR?.trim() || path.join(os.homedir(), '.hub')
  return process.env.HUB_CLAW_SESSIONS_FILE ?? path.join(root, 'state', 'claw-sessions.json')
}

function recordSessionInLedger(owner: string, sessionId: string): void {
  try {
    const entries = readSessionLedger().filter((e) => e.sessionId !== sessionId)
    entries.unshift({ owner, sessionId, startedAt: Date.now() })
    writeSessionLedger(entries.slice(0, SESSION_LEDGER_KEEP))
  } catch {
    // Best-effort: the ledger only helps cross-process replay lookups.
  }
}

interface SessionLedgerEntry {
  owner: string
  sessionId: string
  startedAt: number
}

function readSessionLedger(): SessionLedgerEntry[] {
  try {
    const entries = JSON.parse(fs.readFileSync(sessionLedgerPath(), 'utf-8'))
    if (!Array.isArray(entries)) return []
    return entries.filter(
      (e): e is SessionLedgerEntry =>
        e && typeof e.sessionId === 'string' && typeof e.owner === 'string',
    )
  } catch {
    // Missing or corrupt ledger: read as empty.
    return []
  }
}

function writeSessionLedger(entries: SessionLedgerEntry[]): void {
  try {
    const file = sessionLedgerPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  } catch {
    // Best-effort.
  }
}

export class ClawHarnessReporter {
  private readonly baseUrl: string
  private readonly explicitlyDisabled: boolean
  /** Per-process salt: one working period per process instance per owner. */
  private readonly instanceSuffix = randomBytes(6).toString('hex')
  private connectionDown = false
  private lastProbeAt = 0
  private queue: QueuedCall[] = []
  private draining = false
  private readonly startedSessions = new Set<string>()
  private readonly claimedTabs = new Map<string, Set<number>>()
  /** owner per started session id (endAllSessions needs owners to rotate). */
  private readonly ownerBySession = new Map<string, string>()
  /** Monotonic per-owner period: bumped on end so a session id is never
   * reused after its end (the claw task projection anchors to first events). */
  private readonly periodOf = new Map<string, number>()

  constructor() {
    this.baseUrl = clawServerBaseUrl()
    // Off switch always wins; tests stay silent unless they explicitly opt in
    // with HUB_CLAW_REPORT=on (same opt-in philosophy as the audit sink).
    this.explicitlyDisabled =
      process.env.HUB_CLAW_REPORT === 'off' ||
      (process.env.NODE_ENV === 'test' && process.env.HUB_CLAW_REPORT !== 'on')
  }

  /** Visible for tests: force the connection state. */
  setConnectionDown(down: boolean): void {
    this.connectionDown = down
  }

  /** Fresh Ulid-shaped session id for one owner in THIS process instance;
   * the period suffix rotates after an end so ids are never reused. */
  sessionIdFor(owner: string): string {
    return createHash('sha256')
      .update(`hub:${owner}#${this.instanceSuffix}#${this.periodOf.get(owner) ?? 0}`)
      .digest('hex')
      .slice(0, 26)
      .toUpperCase()
  }

  /** This process's live session id for the owner, if it started one. */
  currentSessionIdOf(owner: string): string | undefined {
    const sessionId = this.sessionIdFor(owner)
    return this.startedSessions.has(sessionId) ? sessionId : undefined
  }

  isEnabled(now: number = Date.now()): boolean {
    if (this.explicitlyDisabled) return false
    if (!this.connectionDown) return true
    // Down: stay disabled until the re-probe interval elapses.
    return now - this.lastProbeAt >= REPROBE_INTERVAL_MS
  }

  /** Report one completed dispatch; lazily starts the session and claims the tab. */
  reportDispatch(report: ClawDispatchReport): void {
    if (!this.isEnabled()) return
    const owner = report.owner
    if (owner === undefined || owner === '') return
    const sessionId = this.sessionIdFor(owner)
    const agentId = report.agentId ?? 'hub'
    const tabId = report.tabId
    const needsStart = !this.startedSessions.has(sessionId)
    const needsClaim =
      tabId !== undefined && !this.claimedTabsFor(sessionId).has(tabId)
    // Mark synchronously: a burst of dispatches before the queue drains must
    // not duplicate session starts / tab claims. The closures below capture
    // needsStart/needsClaim by value, so a failed call that stays queued still
    // replays its start/claim on retry.
    if (needsStart) {
      this.startedSessions.add(sessionId)
      this.ownerBySession.set(sessionId, owner)
      recordSessionInLedger(owner, sessionId)
    }
    if (needsClaim && tabId !== undefined) this.claimedTabsFor(sessionId).add(tabId)

    this.enqueue(owner, async (baseUrl) => {
      if (needsStart) {
        await this.postJson(baseUrl, '/api/v1/harness/sessions', {
          sessionId,
          agentId,
          slug: 'hub',
          agentLabel: report.agentLabel ?? 'hub-browser',
          clientName: 'hub-browser',
        })
      }
      if (needsClaim && tabId !== undefined) {
        await this.postJson(baseUrl, `/api/v1/harness/sessions/${sessionId}/tabs`, {
          tabId,
          ...(report.targetId !== undefined && { targetId: report.targetId }),
          claimedAt: report.createdAt,
          agentId,
        })
      }
      await this.postJson(baseUrl, `/api/v1/harness/sessions/${sessionId}/dispatches`, {
        toolName: report.toolName,
        agentId,
        slug: 'hub',
        agentLabel: report.agentLabel ?? 'hub-browser',
        ...(report.pageId !== undefined && { pageId: report.pageId }),
        ...(tabId !== undefined && { tabId }),
        ...(report.targetId !== undefined && { targetId: report.targetId }),
        ...(report.url !== undefined && { url: report.url }),
        ...(report.title !== undefined && { title: report.title }),
        ...(report.args !== undefined && { args: report.args }),
        // Official-shape result meta (JSON like the MCP path's tool_result_meta:
        // isError/cancelled/contentSummary/structuredKeys): the cockpit timeline
        // parses this field, so hub rows render the way native sessions do.
        // `cancelled` is always false by construction — a cancelled dispatch
        // never reaches this reporter (it fires on completion), unlike the
        // official observer which sees in-flight cancellations.
        resultMeta: JSON.stringify({
          isError: report.isError,
          cancelled: false,
          ...(report.contentBlockCount !== undefined && {
            contentSummary: `${report.contentBlockCount} block(s)`,
          }),
          ...(report.guard !== undefined && { guard: report.guard }),
          ...(report.errorHead !== undefined && { error: report.errorHead }),
          ...(report.structuredKeys !== undefined && {
            structuredKeys: report.structuredKeys,
          }),
        }),
        durationMs: report.durationMs,
        createdAt: report.createdAt,
      })
    })
  }

  /** End the owner's claw session and release its tab-ownership windows.
   *
   * Default kind "closed" is deliberate: claw's derive_status only treats
   * closed/errored/cancelled as terminal — anything else (including the old
   * "normal" default) leaves the task Live forever. */
  async endSession(owner: string, kind = 'closed'): Promise<void> {
    if (this.explicitlyDisabled) return
    const sessionId = this.sessionIdFor(owner)
    if (!this.startedSessions.has(sessionId)) return
    await this.endSessionIds([sessionId], kind)
  }

  /** End every session this process started (daemon/MCP exit, direct-CLI
   * command completion). A multi-owner daemon sweeps all owners at once. */
  async endAllSessions(kind = 'closed'): Promise<void> {
    if (this.explicitlyDisabled) return
    if (this.startedSessions.size === 0) return
    await this.endSessionIds([...this.startedSessions], kind)
  }

  /** Startup orphan sweep: sessions left Live by processes that died before
   * their exit hook ran (kill -9, crash). The official server's own idle
   * sweeper only covers sessions in its in-memory map — harness sessions are
   * not in it, so hub cleans its own via the ledger. A session is ended only
   * when its last dispatch is older than SWEEP_STALE_MS (a live concurrent
   * process with recent activity is never touched); unknown or already-ended
   * sessions are dropped from the ledger. */
  async sweepStaleSessions(now: number = Date.now()): Promise<number> {
    if (this.explicitlyDisabled) return 0
    if (!this.isEnabled(now)) return 0
    const entries = readSessionLedger()
    if (entries.length === 0) return 0
    const kept: SessionLedgerEntry[] = []
    let ended = 0
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (this.startedSessions.has(entry.sessionId)) {
        kept.push(entry)
        continue
      }
      const detail = await this.fetchSessionDetail(entry.sessionId)
      if (detail === null) {
        // Claw unreachable mid-sweep: keep everything left and stop.
        kept.push(...entries.slice(i))
        break
      }
      if (detail === undefined) {
        // GET 404 — the detail route filters dispatch_count > 0, so this is
        // either a session that never existed (stale ledger noise) or a
        // zero-dispatch orphan that is still Live in the DB. POST /end is
        // idempotent and harmless for the former, and it clears the latter.
        const endedOk = await this.postJson(
          this.baseUrl,
          `/api/v1/harness/sessions/${entry.sessionId}/end`,
          { kind: 'closed', reason: 'idle timeout sweep' },
        )
          .then(() => true)
          .catch(() => false)
        if (endedOk) ended += 1
        continue
      }
      if (detail.status !== 'live') continue // already terminal: drop
      const lastActivity = Math.max(entry.startedAt, ...detail.lastDispatchAt)
      if (now - lastActivity < SWEEP_STALE_MS) {
        kept.push(entry) // recently active: maybe a live process, leave it
        continue
      }
      const endedOk = await this.postJson(
        this.baseUrl,
        `/api/v1/harness/sessions/${entry.sessionId}/end`,
        { kind: 'closed', reason: 'idle timeout sweep' },
      )
        .then(() => true)
        .catch(() => false)
      if (endedOk) ended += 1
    }
    writeSessionLedger(kept)
    return ended
  }

  /** Session detail for the sweep: undefined = unknown session (404), null =
   * lookup failed (server down). `lastDispatchAt` is empty when the session
   * recorded no dispatches. */
  private async fetchSessionDetail(
    sessionId: string,
  ): Promise<{ status: string; lastDispatchAt: number[] } | null | undefined> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(4_000) },
      )
      if (response.status === 404) return undefined
      if (!response.ok) return null
      const body = (await response.json()) as {
        session?: { status?: unknown }
        dispatches?: Array<{ createdAt?: unknown }>
      }
      const dispatches = Array.isArray(body.dispatches) ? body.dispatches : []
      return {
        status: typeof body.session?.status === 'string' ? body.session.status : 'live',
        lastDispatchAt: dispatches
          .map((d) => (typeof d.createdAt === 'number' ? d.createdAt : 0))
          .filter((t) => t > 0),
      }
    } catch {
      return null
    }
  }

  /** Wait (bounded) for the queue to drain, then POST /end for each session
   * id. Ending past the queue matters: the old direct postJson could land the
   * end BEFORE still-queued dispatches, attaching them to an ended session. */
  private async endSessionIds(sessionIds: string[], kind: string): Promise<void> {
    try {
      await Promise.race([
        this.waitForDrain(),
        new Promise((resolve) => setTimeout(resolve, DRAIN_WAIT_MS)),
      ])
      await Promise.race([
        (async () => {
          for (const sessionId of sessionIds) {
            await this.postJson(
              this.baseUrl,
              `/api/v1/harness/sessions/${sessionId}/end`,
              { kind },
            )
          }
        })(),
        new Promise((resolve) => setTimeout(resolve, END_WAIT_MS * sessionIds.length)),
      ])
    } catch {
      // Best-effort: claw's orphan cleanup closes claim windows eventually.
    }
    for (const sessionId of sessionIds) {
      this.startedSessions.delete(sessionId)
      this.claimedTabs.delete(sessionId)
      const owner = this.ownerBySession.get(sessionId)
      this.ownerBySession.delete(sessionId)
      if (owner !== undefined) this.periodOf.set(owner, (this.periodOf.get(owner) ?? 0) + 1)
    }
  }

  private async waitForDrain(): Promise<void> {
    while (this.queue.length > 0 || this.draining) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  private claimedTabsFor(sessionId: string): Set<number> {
    let tabs = this.claimedTabs.get(sessionId)
    if (tabs === undefined) {
      tabs = new Set<number>()
      this.claimedTabs.set(sessionId, tabs)
    }
    return tabs
  }

  private enqueue(owner: string, run: (baseUrl: string) => Promise<void>): void {
    this.queue.push({ run, owner })
    if (this.queue.length > QUEUE_LIMIT) {
      // Drop the OLDEST queued work under pressure — newest activity is the
      // most valuable for live replay.
      this.queue.shift()
    }
    if (!this.draining) {
      void this.drain()
    }
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0]
        this.lastProbeAt = Date.now()
        try {
          await next.run(this.baseUrl)
          this.connectionDown = false
        } catch {
          // Connection refused / server error: stop draining and cool down.
          // The queue keeps its entries; the next reportDispatch (after the
          // re-probe interval) resumes from where it stopped.
          this.connectionDown = true
          return
        }
        this.queue.shift()
      }
    } finally {
      this.draining = false
    }
  }

  private async postJson(baseUrl: string, path: string, body: unknown): Promise<void> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) {
      throw new Error(`claw harness API ${path} -> HTTP ${response.status}`)
    }
  }
}

export const clawHarnessReporter = new ClawHarnessReporter()
