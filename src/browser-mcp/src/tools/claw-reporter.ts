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
 * Session identity: claw requires Ulid-shaped session ids. Hub convoIds
 * (`mcp:<client>:<suffix>`, `cli:local`, ...) contain colons, so each owner key
 * derives a deterministic 26-hex-char session id — the same conversation maps
 * to the same claw session across daemon restarts.
 */

import { createHash } from 'node:crypto'

const DEFAULT_BASE_URL = 'http://127.0.0.1:9210'
const REPROBE_INTERVAL_MS = 5 * 60_000
const QUEUE_LIMIT = 200
const END_WAIT_MS = 1_500

/** Base URL of the BrowserClaw server (HUB_CLAW_SERVER_URL override); shared
 * by the harness reporter (write path) and the replay read face. */
export function clawServerBaseUrl(): string {
  return process.env.HUB_CLAW_SERVER_URL ?? DEFAULT_BASE_URL
}

export interface ClawDispatchReport {
  /** Owner key (convoId ?? agentId) — derives the claw session id. */
  owner?: string
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

/** Deterministic Ulid-shaped claw session id for a hub owner key. */
export function clawSessionIdOf(owner: string): string {
  return createHash('sha256').update(`hub:${owner}`).digest('hex').slice(0, 26).toUpperCase()
}

export class ClawHarnessReporter {
  private readonly baseUrl: string
  private readonly explicitlyDisabled: boolean
  private connectionDown = false
  private lastProbeAt = 0
  private queue: QueuedCall[] = []
  private draining = false
  private readonly startedSessions = new Set<string>()
  private readonly claimedTabs = new Map<string, Set<number>>()

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
    const sessionId = clawSessionIdOf(owner)
    const tabId = report.tabId
    const needsStart = !this.startedSessions.has(sessionId)
    const needsClaim =
      tabId !== undefined && !this.claimedTabsFor(sessionId).has(tabId)
    // Mark synchronously: a burst of dispatches before the queue drains must
    // not duplicate session starts / tab claims. The closures below capture
    // needsStart/needsClaim by value, so a failed call that stays queued still
    // replays its start/claim on retry.
    if (needsStart) this.startedSessions.add(sessionId)
    if (needsClaim && tabId !== undefined) this.claimedTabsFor(sessionId).add(tabId)

    this.enqueue(owner, async (baseUrl) => {
      if (needsStart) {
        await this.postJson(baseUrl, '/api/v1/harness/sessions', {
          sessionId,
          agentId: 'hub',
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
          agentId: 'hub',
        })
      }
      await this.postJson(baseUrl, `/api/v1/harness/sessions/${sessionId}/dispatches`, {
        toolName: report.toolName,
        agentId: 'hub',
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

  /** End the owner's claw session and release its tab-ownership windows. */
  async endSession(owner: string, kind = 'normal'): Promise<void> {
    if (this.explicitlyDisabled) return
    const sessionId = clawSessionIdOf(owner)
    if (!this.startedSessions.has(sessionId)) return
    try {
      await Promise.race([
        this.postJson(this.baseUrl, `/api/v1/harness/sessions/${sessionId}/end`, { kind }),
        new Promise((resolve) => setTimeout(resolve, END_WAIT_MS)),
      ])
      this.startedSessions.delete(sessionId)
      this.claimedTabs.delete(sessionId)
    } catch {
      // Best-effort: claw's orphan cleanup closes claim windows eventually.
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
