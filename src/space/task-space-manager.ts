/**
 * Phase 3 — TaskSpaceManager (统一 Core, hub-browser).
 *
 * Space = 标签页集合 (tabIds) + 生命周期 + 归属控制 + 任务名, running inside the
 * default BrowserContext (cookie/localStorage 与用户共享 — Layer 1 设计, 不做物理隔离).
 *
 * This module is the single source of truth for the space ledger:
 *   - spaces 存储 (JSON file, atomic writes)
 *   - tab→space 账本
 *   - 每会话 (owner/conversation) current_space_id
 *   - SpaceOwnership 状态机 (agent → agentDelegatedToUser → user; takeOver 需确认)
 *   - Agent 级 Tab 隔离 guard (tabs 过滤 + 控制工具校验)
 *   - space.* 事件流 (进程内事件总线; Phase 7 UI 的数据源)
 *
 * D1 (2026-08-02): 放在统一 Core (hub-browser, TS), 不放 claw-server-rust。
 * D2: space 与 conversation 1:N — owner 为某个 conversation; 每 space 一个时刻一个 owner。
 *
 * 存储选型: JSON 文件 (简单优先)。路径 (方案 C): $BROWSEROS_DIR/state/hub-spaces.json 或
 * ~/.hub/state/hub-spaces.json (默认根 ~/.hub, BROWSEROS_DIR 可覆盖)。理由: 低频账本、
 * 人可读、原子写、零依赖; MCP server 实例与 CLI daemon 各自持有 manager 时通过同一文件共享。
 * 旧版 ~/.opencli/hub-spaces.json 由 migrateLegacyLedger() 一次性迁移 (保留旧文件)。
 * 跨进程: save() 是 merge-on-save (保留磁盘上本进程没见过的 space + 双方 close
 * tombstone), 因此两个 identity 的 MCP 进程并行写同一账本不会互相覆盖对方的空间;
 * 实时跨进程状态推送 (事件/变更通知) 仍不在本阶段范围 — 已知限制。
 *
 * 注意: 本文件刻意零相对 import (只依赖 node 内置模块), 以便同时被 bun (daemon/MCP)
 * 与 Node 22.18+ (type stripping) 直接加载。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  claimLedgerAuthority,
  describeAuthority,
  releaseLedgerAuthority,
} from './ledger-authority.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SpaceOwnership = 'agent' | 'agentDelegatedToUser' | 'user'

export interface SpaceIdentity {
  /** Stable per-conversation / per-agent identifier. */
  agentId: string
  /** Human-readable name (e.g. MCP client name). */
  displayName?: string
  /**
   * P1-3 — ownership key: the stable conversation id (convoId). Two
   * different conversations from the same agent tool (e.g. two Claude Code
   * processes, both "mcp:claude-code") get distinct convoIds and therefore
   * distinct space ownership. Falls back to agentId when unset (legacy
   * callers / existing ledger entries keep their owner keys unchanged).
   */
  convoId?: string
}

/**
 * P1-3 — the ownership key one identity acts under. All space ledger
 * operations and guards must extract the owner through this helper (never
 * `identity.agentId` directly) so the convoId layer stays swappable.
 */
export function ownerOf(identity: SpaceIdentity): string {
  return identity.convoId ?? identity.agentId
}

/** P1-5 — tri-bucket tab ownership from one agent's point of view. */
export type TabOwnership = 'mine' | 'user' | 'other-agent'

/** Live browser tab shape (superset of what browser-core pages.list returns). */
export interface TabLike {
  pageId: number
  targetId?: string
  tabId?: number
  url?: string
  title?: string
  isActive?: boolean
  /** Owning browser window. Already present at runtime (`PageInfo.windowId`);
   *  the window guard (P7-H H5) derives a window's ownership from the ledger
   *  membership of the tabs inside it, so it must be typed here. */
  windowId?: number
  /** True while the tab is still loading — busy-but-healthy, must not fail
   * the F16 restore health probe. */
  isLoading?: boolean
  /**
   * M3 — the PERSISTED tab id this live tab was restored from, when the
   * browser can say so.
   *
   * This is the one thing no client outside the browser can reconstruct:
   * `tabId` and `targetId` both die with the browser run, and Chromium's
   * session restore gives the restored WebContents a NEW SessionID while the
   * persisted session data still carries the OLD one. A browser that surfaces
   * that mapping turns cross-restart rebinding from a URL GUESS into evidence.
   *
   * Absent on a browser that does not report it — every reader must degrade to
   * the URL heuristics, never assume it exists. See `restore()` strategy 0b.
   */
  restoredFromTabId?: number
}

/** One tab attributed to a space (ledger). */
export interface TabRef {
  pageId: number
  /**
   * M2 — the browser's OWN tab identity (Chromium `SessionID`), and therefore
   * the ledger's primary anchor. `pageId` is a per-connection counter that
   * means nothing outside the connection that minted it; `tabId` is what the
   * browser itself uses (`Browser.getTabInfo` / `closeTab` / `activeTabId`),
   * is immutable for the life of the tab, and exists for every live tab. It is
   * unique only within one browser run — see `targetId` and `restore()`.
   */
  tabId?: number
  /**
   * Stable tab identity (CDP targetId). pageId is a per-connection sequence
   * number — it drifts across process restarts, so a ledger reconciled by
   * pageId alone binds whatever tab happens to hold that number in the new
   * connection and can even overwrite the ledger's url with the wrong tab's
   * url (observed: the QuickBI ledger got rewritten to chrome://newtab).
   * targetId is the cross-process anchor; pageId stays for same-connection
   * idempotency, always double-checked against the url.
   */
  targetId?: string
  url: string
  title?: string
  /**
   * True once a restore() pass has reconciled this tab with the live browser.
   * Freshly opened tabs are pending (restored === undefined/false) so the next
   * daemon/MCP start re-attaches or re-opens them exactly once (Phase 3 A).
   */
  restored?: boolean
  /**
   * P7-H1 — the window this tab was observed in. Advisory, exactly like pageId:
   * window ids drift across browser restarts, so this is re-bound by restore()
   * and never used as a matching key.
   */
  windowId?: number
  /**
   * P7-A — durable page label (ego semantics: `p1`, `p2`, … per space). The
   * cross-process handle an agent uses instead of a pageId, which drifts.
   * Assigned when the tab enters the space and kept across restores.
   */
  label?: string
  /**
   * P7-A — origin attribution, stamped when the tab is first recorded and never
   * rewritten (ego: conservative and immutable). `unknown` means "not provably
   * ours" and is treated as user-owned when deciding what may be closed.
   */
  openedBy?: TabOrigin
}

/** Where a tab came from — see TabRef.openedBy. */
export type TabOrigin = 'agent' | 'unknown'

/** Persisted per-space record. */
export interface SpaceRecord {
  id: string
  name: string
  taskId?: string
  owner: string
  ownership: SpaceOwnership
  createdAt: number
  lastActiveAt: number
  /** When restore() last reconciled this space's tabs with the live browser. */
  restoredAt?: number
  /**
   * P7-H1 — the space's own window, created lazily by the first open_tab
   * (`Browser.createWindow` always brings one tab, so the window is created
   * with the tab the caller wanted). Advisory: verified against windowList()
   * before reuse and re-created when it is gone.
   */
  windowId?: number
  /**
   * P7-A — the tab the user was on at the last handoff boundary (ego
   * `userPage()`). Captured when the agent hands the space over / the user
   * confirms control, and it is the ONE place where a tab outside the agent's
   * control may expose url/title: handing the space over IS the consent.
   */
  handoffPage?: {
    pageId: number
    label?: string
    url?: string
    title?: string
  }
  tabs: TabRef[]
}

/** Public (JSON-safe) space shape returned by the API. */
export interface SpaceInfo {
  id: string
  name: string
  taskId?: string
  owner: string
  ownership: SpaceOwnership
  createdAt: string
  lastActiveAt: string
  tabIds: number[]
  /** P7-H1 — the space's own window, when it has one. */
  windowId?: number
}

export interface SpaceTabInfo {
  pageId: number
  /** P7-A — durable page label (`p1`, `p2`, …) — see TabRef.label. */
  label?: string
  /** P7-A — origin attribution — see TabRef.openedBy. */
  openedBy?: TabOrigin
  /** M2 — the browser's own tab identity — see TabRef.tabId. */
  tabId?: number
  /** Stable tab identity (present when known) — see TabRef.targetId. */
  targetId?: string
  url: string
  title?: string
  isActive?: boolean
  /**
   * TabFreshness health telemetry (in-memory only, never persisted, no auto
   * decisions): number of open/reuse hits recorded for this tab and its age.
   * Present only when the tab was opened through the manager this process
   * instance (openTabWithReuse) — restore()-reopened tabs have no stats until
   * the next reuse. Additive; consumers must tolerate absence.
   */
  ops?: number
  ageMs?: number
}

/**
 * P7-A follow-up — a live tab inside the space's own window that the ledger
 * does NOT know about (the user dragged it in, or it is another agent's).
 *
 * Identity only, deliberately: hub's P1-5 posture is that a tab which is not
 * ours exposes WHO holds it, never WHAT is in it (`tabs view=all` strips
 * url/title for the same reason). `adopt` is the consent boundary — once the
 * tab is in the ledger its url/title become readable, and the ledger records
 * that the agent took responsibility for it (`openedBy: 'unknown'`).
 */
export interface UnmanagedTabInfo {
  unmanaged: true
  pageId: number
  targetId?: string
  isActive?: boolean
}

/** One row of the window-scoped listing: ours (ledger) or merely present. */
export type SpaceWindowTabInfo = SpaceTabInfo | UnmanagedTabInfo

/** True for the P1-5 identity-only rows. */
export function isUnmanagedTab(
  tab: SpaceWindowTabInfo,
): tab is UnmanagedTabInfo {
  return (tab as UnmanagedTabInfo).unmanaged === true
}

/**
 * Result of the window-scoped listing.
 *
 * `scope: 'window'` — the space's window was resolved, so `tabs` is every live
 * tab in it (ledger rows + `unmanaged` rows). `scope: 'ledger-only'` — the
 * window could not be resolved (no ledger windowId AND no live managed tab
 * carrying one), so the listing degrades to exactly `listTabs()`: we must
 * never guess a boundary, because guessing wrong is how a stranger's tab gets
 * reported as ours.
 */
export interface SpaceWindowTabs {
  tabs: SpaceWindowTabInfo[]
  windowId?: number
  scope: 'window' | 'ledger-only'
}

/** URL-reuse matching modes (ego openOrReuseTab semantics). */export type TabUrlReuseMode =
  | 'exact'
  | 'origin'
  | 'origin+path'
  | 'includes'
  | false

/** Result of an open-with-reuse call. */
export interface OpenTabResult {
  pageId: number
  /** true when an existing tab in the space matched and was switched to. */
  reused: boolean
  /** P7-A — the durable page label (`p1`, `p2`, …) of the tab. */
  label?: string
  /**
   * The tab's CDP target id, when known. Callers that hold a long-lived page
   * handle (the CLI's `browser open` → `browser <session> state`) need it to
   * REBIND to the tab they just opened: the tab lives in the space's window,
   * which is usually not the window their handle was connected to.
   */
  targetId?: string
}

/**
 * P7-A — `finish` receipt (ego shape): what was kept, what was closed, and how
 * many tabs in the window were left alone because they are not ours.
 */
export interface FinishReceipt {
  spaceId: string
  /** True when the space left the ledger (nothing remained to keep). */
  closedSpace: boolean
  keptLabels: string[]
  closedLabels: string[]
  /** Live tabs in the space's window that are not in the ledger (the user's). */
  preservedUnmanagedCount: number
}

/** One tab before/after a space recycle (old pageId → reopened pageId, same URL). */
export interface RecycleTabResult {
  oldPageId: number
  /** Page id after recycle. Same as oldPageId when the old tab was reused (its close failed). */
  newPageId: number
  url: string
  /** true when the "fresh" tab is actually the old tab reused (close failed). */
  reused: boolean
}

/** Result of recycleSpaceTabs. */
export interface RecycleSpaceTabsResult {
  /** Number of tabs reopened (count of `tabs`). */
  recycled: number
  /** Per-tab old→new pageId mapping, in ledger order. */
  tabs: RecycleTabResult[]
  /** Number of URLs that failed to reopen (their old tab was closed; the ledger ref was dropped). */
  failed?: number
}

/**
 * D8 — one ledger eviction performed by reapExpiredSpaces.
 *
 * tier 1 = empty space (tabs.length === 0) idle past emptyTtl (default 24h);
 * tier 2 = agent-owned space idle past spaceTtl (default 7d), any tab count.
 */
export interface ReapEviction {
  spaceId: string
  name: string
  owner: string
  tier: 1 | 2
  ageMs: number
  tabs: number
}

/** Minimal browser surface TaskSpaceManager needs to open/close/list tabs. */
export interface SpaceTabGateway {
  newTab(
    url: string,
    opts?: { background?: boolean; windowId?: number },
  ): Promise<string | number | undefined>
  closeTab(target: number | string): Promise<void>
  listTabs(): Promise<TabLike[]>
  /**
   * F16 — bounded health probe for one live tab. A tab whose renderer hung
   * (zombie) still lists in the browser but never answers JS; restore()
   * refuses to adopt such targets so later commands fall back to the
   * reopen-by-URL path instead of hanging to their own timeouts. Optional —
   * callers must tolerate absence (legacy behavior: adopt without probing).
   */
  probeTab?(target: number | string): Promise<boolean>
  /**
   * Best-effort activation: make the given tab the agent's active tab
   * (e.g. UnifiedPage.selectTab). Optional — callers must tolerate absence.
   */
  activate?(target: number | string): Promise<void>
  /**
   * P7-H1 — window family. All optional: a gateway without it degrades to the
   * legacy shared-window behaviour (every space's tabs in one window), which is
   * exactly what a browser without the CDP window commands gives us.
   */
  windowList?(): Promise<WindowLike[]>
  /** Creates a window WITH one tab at `url` (Chromium always adds one tab). */
  windowCreate?(opts?: { url?: string }): Promise<WindowLike | undefined>
  windowClose?(windowId: number): Promise<void>
  windowActivate?(windowId: number): Promise<void>
  /** P7-H2 — physically move a tab into another window (cross-window move). */
  moveTab?(target: number | string, windowId: number): Promise<void>
}

/** Live browser window shape (subset of the CDP WindowInfo hub uses). */
export interface WindowLike {
  windowId: number
  tabCount?: number
  isActive?: boolean
  isVisible?: boolean
}

export type SpaceGuardErrorCode =
  | 'no-space'
  | 'page-not-in-space'
  | 'user-controlling'
  | 'space-not-found'
  | 'not-space-owner'
  | 'needs-confirmation'
  | 'no-gateway'
  | 'not-configured'
  | 'tab-resolve-failed'
  | 'not-handed-off'
  | 'tab-agent-owned'
  | 'label-taken'
  /**
   * P7-H H5 — a window-addressed mutation (windows close/activate) whose tabs
   * are not all in the agent's current space.
   */
  | 'window-not-in-space'
  /**
   * P7-F / D-P9 — a group-addressed mutation (`tab_groups update`/`close`,
   * `hub browser group update/close`) whose member tabs are not all in the
   * agent's current space. Replaces the deleted projection-based guard: a tab
   * group is no longer "the space's group", so control is proven from ledger
   * ownership of every member tab instead.
   */
  | 'group-not-in-space'

export class SpaceGuardError extends Error {
  readonly code: SpaceGuardErrorCode
  readonly spaceId?: string
  readonly pageId?: number
  readonly hint?: string

  constructor(
    code: SpaceGuardErrorCode,
    message: string,
    meta?: { spaceId?: string; pageId?: number; hint?: string },
  ) {
    super(message)
    this.name = 'SpaceGuardError'
    this.code = code
    if (meta?.spaceId !== undefined) this.spaceId = meta.spaceId
    if (meta?.pageId !== undefined) this.pageId = meta.pageId
    if (meta?.hint !== undefined) this.hint = meta.hint
  }
}

export type SpaceEventType =
  | 'space.created'
  | 'space.agent_active'
  | 'space.handoff_requested'
  | 'space.interrupted'
  | 'space.switched'
  | 'space.closed'
  | 'space.tabs_recycled'
  /**
   * M1 follow-up — the space's TAB SET changed (opened / closed / adopted /
   * released / transferred / reconciled). Without this the push feed was deaf
   * to the single most common change there is: `space.open_tab` emitted
   * nothing, so a Space UI subscribed to /spaces/stream would keep showing a
   * stale tab count until some unrelated event happened to fire.
   *
   * `urls` carries the new tab COUNT (see SpaceEvent.urls).
   */
  | 'space.tabs_changed'

export interface SpaceEvent {
  type: SpaceEventType
  spaceId: string
  /** Space display name (additive — included so MCP notifications can carry it). */
  name?: string
  owner?: string
  ownership?: SpaceOwnership
  /** Number of tabs involved (e.g. space.tabs_recycled carries the recycled count). */
  urls?: number
  timestamp: number
}

export type SpaceEventListener = (event: SpaceEvent) => void

/** 简单进程内事件总线 (骨架; 跨进程推送不在本阶段范围). */
export class SpaceEventBus {
  private readonly listeners = new Map<SpaceEventType, Set<SpaceEventListener>>()
  /**
   * P7-C — wildcard subscribers. The daemon's SSE feed needs EVERY change, not
   * one type at a time: enumerating the seven types at the call site would
   * silently stop covering a type the day an eighth is added.
   */
  private readonly anyListeners = new Set<SpaceEventListener>()

  on(type: SpaceEventType, listener: SpaceEventListener): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => this.off(type, listener)
  }

  /** Subscribe to every event type; returns the unsubscribe function. */
  onAny(listener: SpaceEventListener): () => void {
    this.anyListeners.add(listener)
    return () => {
      this.anyListeners.delete(listener)
    }
  }

  off(type: SpaceEventType, listener: SpaceEventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(event: SpaceEvent): void {
    for (const listener of [
      ...(this.listeners.get(event.type) ?? []),
      ...this.anyListeners,
    ]) {
      try {
        listener(event)
      } catch {
        // A subscriber must never break the ledger.
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

interface PersistedState {
  version: 4
  spaces: Record<string, SpaceRecord>
  currentSpaceByOwner: Record<string, string>
}

/**
 * Ledger schema version.
 *
 * v1 (D5, 2026-08-03) projected every space onto a Chrome tab group and
 * persisted the projection as `SpaceRecord.tabGroupId`.
 * v2 (P7-F, decision D-P9) removes that projection: the ledger is the single
 * source of truth and Chrome tab groups are an ordinary browser feature hub
 * does not tie to spaces.
 * v3 (M2, space-ledger-architecture.md L2) anchors tab identity on the
 * browser's own `tabId` (Chromium SessionID) instead of hub's connection-local
 * `pageId`. No field is dropped or rewritten: `tabId` is additive and a v2 ref
 * simply lacks it, which `restore()` fills in on its next pass. The version is
 * stamped anyway because the SEMANTICS of the stored fields changed — a v2-era
 * reader would ignore `tabId` and reconcile by `pageId`, which is exactly the
 * misbinding this version exists to stop.
 * v4 (M5) drops `deletedSpaces`. Those tombstones existed so a merge-on-save in
 * another process could not resurrect a space this one closed — and M5 removed
 * the second writer (the daemon owns the ledger; `hub --mcp` is its client), so
 * there is nothing left to merge with. The field is dropped on read.
 */
export const SPACE_STORAGE_VERSION = 4

/** P7-C bridge — how long the UI snapshot waits for a live tab probe. */
const UI_SNAPSHOT_PROBE_TIMEOUT_MS = 2_000

/** True when a raw ledger space object still carries the dropped v1 field. */
function carriesTabGroupId(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'tabGroupId' in (value as Record<string, unknown>)
  )
}

/**
 * v1 → v2 ledger migration (P7-F / decision D-P9).
 *
 * Trigger — EITHER is enough:
 *   - the file says `version: 1` (the projection era), or its `version` is
 *     missing / not a number (the pre-versioning shape);
 *   - any space still carries `tabGroupId`, whatever the version claims.
 * A v2 file with no such field is a no-op.
 *
 * What it does: drops `SpaceRecord.tabGroupId` from every space and returns the
 * state stamped as version 2. Everything else rides through untouched — this
 * pass migrates ONE field, it does not validate the rest of the ledger, so
 * unknown/older shapes are tolerated instead of throwing. Idempotent: running
 * it again on its own output changes nothing, which is what lets a migrated
 * file round-trip through merge-on-save without the field creeping back.
 *
 * Every disk read goes through here (`readRaw()`), so the migration applies to
 * `load()` and the legacy-ledger import alike — both
 * paths that previously ignored `raw.version` entirely.
 */
function migratePersistedState(raw: unknown): Partial<PersistedState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const state = raw as {
    version?: unknown
    spaces?: unknown
    currentSpaceByOwner?: unknown
    deletedSpaces?: unknown
  }
  const rawSpaces = state.spaces
  if (!rawSpaces || typeof rawSpaces !== 'object' || Array.isArray(rawSpaces)) {
    return {}
  }
  const entries = Object.entries(rawSpaces as Record<string, unknown>)
  const version = typeof state.version === 'number' ? state.version : undefined
  const legacy =
    version !== SPACE_STORAGE_VERSION || entries.some(([, v]) => carriesTabGroupId(v))
  // v4 drops `deletedSpaces` — but the ids it named were CLOSED, so they must
  // be applied one last time on the way in. Dropping the list without applying
  // it would resurrect every space any past version had tombstoned.
  const tombstoned = new Set(
    Array.isArray(state.deletedSpaces)
      ? state.deletedSpaces.filter((v): v is string => typeof v === 'string')
      : [],
  )
  const spaces: Record<string, SpaceRecord> = {}
  for (const [id, value] of entries) {
    if (tombstoned.has(id)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (legacy) {
      const { tabGroupId: _dropped, ...rest } = value as Record<string, unknown>
      spaces[id] = rest as unknown as SpaceRecord
    } else {
      spaces[id] = value as unknown as SpaceRecord
    }
  }
  return {
    version: SPACE_STORAGE_VERSION,
    spaces,
    currentSpaceByOwner:
      state.currentSpaceByOwner &&
      typeof state.currentSpaceByOwner === 'object' &&
      !Array.isArray(state.currentSpaceByOwner)
        ? (state.currentSpaceByOwner as Record<string, string>)
        : {},
  }
}

/**
 * Single user-data root (方案 C): `~/.hub` by default, overridable via
 * `BROWSEROS_DIR` (trimmed; empty/whitespace falls back to the default).
 * Deliberately duplicated inline — this file keeps the zero-relative-import
 * constraint (node builtins only), so it cannot import the JS engine's
 * discovery.js copy of the same rule.
 */
export function hubUserRoot(): string {
  const override = process.env.BROWSEROS_DIR?.trim()
  if (override) return override
  return path.join(os.homedir(), '.hub')
}

/** Legacy ledger location (pre-方案 C); kept as migration source only. */
export function legacyLedgerPath(): string {
  return path.join(os.homedir(), '.opencli', 'hub-spaces.json')
}

/** Default ledger file location: <root>/state/hub-spaces.json. */
export function defaultStoragePath(): string {
  return path.join(hubUserRoot(), 'state', 'hub-spaces.json')
}

/**
 * M1 — the process-wide space authority seam (decision L1).
 *
 * A host that owns the ledger for a whole process installs its manager here so
 * that EVERY in-process consumer — MCP sessions, `/command` CLI runs, the HTTP
 * feeds — reads one in-memory truth instead of each building a private view
 * over the same file. That private-view-per-consumer shape is precisely what
 * forced locks, merge-on-save and close tombstones into the storage layer.
 *
 * Processes that own no ledger (a standalone CLI invocation, a `hub --mcp`
 * stdio server) leave this unset and keep the per-caller manager: they are
 * clients of the file, not authorities over it.
 */
let processAuthority: TaskSpaceManager | undefined

/** Install (or clear) this process's space authority. */
export function setProcessSpaceManager(
  manager: TaskSpaceManager | undefined,
): void {
  processAuthority = manager
}

/** The authority installed by this process's host, when there is one. */
export function processSpaceManager(): TaskSpaceManager | undefined {
  return processAuthority
}

/**
 * One-time migration: when the new ledger (`targetPath`) does not exist yet and
 * the legacy `~/.opencli/hub-spaces.json` ledger does, fold the legacy content
 * into the new ledger using the same merge-on-save shape and the same atomic
 * write (tmp + rename) the manager uses. The legacy file is preserved — never
 * deleted. Best-effort: returns true when migration wrote a new ledger, false
 * when there was nothing to migrate or a failure occurred (callers must not
 * treat it as fatal). `legacyPath` is injectable for tests.
 */
export function migrateLegacyLedger(
  targetPath: string,
  legacyPath: string = legacyLedgerPath(),
): boolean {
  // P1-7: the existsSync check and the write are a TOCTOU pair — two
  // processes can both see "no ledger yet" and the slower rename then
  // clobbers state the faster one already merged in. Serialize under the
  // ledger lock and re-check inside the critical section.
  try {
    // Defence in depth for the constructor's empty-path guard: an empty
    // target would put the staging file in the process CWD.
    if (!targetPath) return false
    if (fs.existsSync(targetPath)) return false
    if (!fs.existsSync(legacyPath)) return false
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as unknown
    // The legacy file is a v1-era ledger by definition — run it through the
    // same migration as any other disk read so the imported spaces land in the
    // current schema (no `tabGroupId`, no tombstones).
    const migrated = migratePersistedState(raw)
    if (!migrated.spaces) return false
    const imported: PersistedState = {
      version: SPACE_STORAGE_VERSION,
      spaces: migrated.spaces,
      currentSpaceByOwner: migrated.currentSpaceByOwner ?? {},
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const tmp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(imported, null, 2), 'utf-8')
    fs.renameSync(tmp, targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * D8 — legacy-space auto-reap (unified TTL scheme). Every field is optional;
 * resolution order is options.reap → env (HUB_SPACE_EMPTY_TTL_MS /
 * HUB_SPACE_TTL_MS, positive integers, invalid falls back to the default) →
 * defaults (24h empty TTL / 7d space TTL). `enabled: false` (or
 * HUB_SPACE_REAP=off) turns the whole reaper off — no load-time sweep, and
 * the MCP timer is not started by bin/hub.mjs.
 */
export interface TaskSpaceReapOptions {
  enabled?: boolean
  emptyTtlMs?: number
  spaceTtlMs?: number
}

export interface TaskSpaceManagerOptions {
  /** JSON ledger path; defaults to defaultStoragePath(). Tests pass a temp file. */
  storagePath?: string
  /** Browser gateway used when a call does not pass one explicitly. */
  gateway?: SpaceTabGateway
  /** Event bus; defaults to a new in-process bus. Pass null to disable. */
  events?: SpaceEventBus | null
  /** Persist mutations to disk. Default true. */
  persist?: boolean
  /** D8 — TTL reaper configuration. See TaskSpaceReapOptions. */
  reap?: TaskSpaceReapOptions
}

/** D8 — default TTLs for legacy-space auto-reap (overridable via options/env). */
export const REAP_EMPTY_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000 // 24h
export const REAP_SPACE_TTL_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000 // 7d

/**
 * D8 — positive-integer TTL parse with fallback. Resolution: options.reap
 * value → env value → default; anything that is not a positive integer falls
 * through to the next source and finally to the default.
 */
function resolveReapTtl(
  option: number | undefined,
  envValue: string | undefined,
  fallback: number,
): number {
  if (option !== undefined) {
    const n = Number(option)
    if (Number.isInteger(n) && n > 0) return n
  }
  if (envValue !== undefined && envValue.trim() !== '') {
    const n = Number(envValue)
    if (Number.isInteger(n) && n > 0) return n
  }
  return fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateways (UnifiedPage / provider adapters)
// ─────────────────────────────────────────────────────────────────────────────

type PageLike = {
  newTab?(
    url?: string,
    opts?: { background?: boolean; windowId?: number },
  ): Promise<string | number | undefined>
  closeTab?(target: number | string): Promise<void>
  tabs?(): Promise<unknown[]>
  selectTab?(target: number | string): Promise<void>
  /** F16 — bounded health probe (zombie-renderer detection) for one tab. */
  probeTab?(target: number | string): Promise<boolean>
  /** P7-H1 — optional window family; absent → shared-window behaviour.
   *  Typed loosely like `tabs?()` — the gateway narrows to WindowLike. */
  windowList?(): Promise<unknown[]>
  windowCreate?(opts?: { url?: string }): Promise<unknown>
  windowClose?(windowId: number): Promise<void>
  windowActivate?(windowId: number): Promise<void>
  moveTab?(target: number | string, windowId: number): Promise<void>
}

type ProviderLike = {
  connect(opts?: { pageId?: number; timeout?: number }): Promise<PageLike>
}

export function gatewayFromPage(page: PageLike): SpaceTabGateway {
  return {
    newTab: async (url, opts) => {
      if (!page.newTab) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser page does not support opening tabs',
        )
      }
      return (await page.newTab(url ?? 'about:blank', opts)) as
        | string
        | number
        | undefined
    },
    closeTab: async (target) => {
      if (!page.closeTab) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser page does not support closing tabs',
        )
      }
      await page.closeTab(target)
    },
    listTabs: async () => ((await page.tabs?.()) ?? []) as TabLike[],
    ...(page.probeTab
      ? {
          probeTab: async (target: number | string) => page.probeTab!(target),
        }
      : {}),
    ...(page.selectTab
      ? {
          activate: async (target: number | string) => {
            await page.selectTab!(target)
          },
        }
      : {}),
    ...(page.windowList
      ? { windowList: async () => (await page.windowList!()) as WindowLike[] }
      : {}),
    ...(page.windowCreate
      ? {
          windowCreate: async (opts?: { url?: string }) =>
            (await page.windowCreate!(opts)) as WindowLike | undefined,
        }
      : {}),
    ...(page.windowClose
      ? { windowClose: async (windowId: number) => page.windowClose!(windowId) }
      : {}),
    ...(page.windowActivate
      ? {
          windowActivate: async (windowId: number) =>
            page.windowActivate!(windowId),
        }
      : {}),
    ...(page.moveTab
      ? {
          moveTab: async (target: number | string, windowId: number) =>
            page.moveTab!(target, windowId),
        }
      : {}),
  }
}

export function gatewayFromProvider(provider: ProviderLike): SpaceTabGateway {
  return {
    newTab: async (url, opts) => {
      const page = await provider.connect()
      if (!page.newTab) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser provider does not support opening tabs',
        )
      }
      return (await page.newTab(url ?? 'about:blank', opts)) as
        | string
        | number
        | undefined
    },
    closeTab: async (target) => {
      const page = await provider.connect()
      if (!page.closeTab) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser provider does not support closing tabs',
        )
      }
      await page.closeTab(target)
    },
    listTabs: async () => {
      const page = await provider.connect()
      return ((await page.tabs?.()) ?? []) as TabLike[]
    },
    probeTab: async (target: number | string) => {
      const page = await provider.connect()
      if (!page.probeTab) return true
      return page.probeTab(target)
    },
    activate: async (target) => {
      const page = await provider.connect()
      if (page.selectTab) await page.selectTab(target)
    },
    // P7-H1 window family — MIRRORS gatewayFromPage. It was missing here, and
    // every MCP path (stdio `hub --mcp` AND the daemon's HTTP sessions) builds
    // its gateway with gatewayFromProvider: so per-space windows silently
    // degraded to the legacy shared window for all agent traffic, while the
    // live smoke (which uses gatewayFromPage) passed. The window model only
    // ever worked on the CLI/restore path.
    //
    // Each accessor re-resolves the page: the provider owns the connection
    // lifecycle and may reconnect between calls.
    windowList: async () => {
      const page = await provider.connect()
      if (!page.windowList) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser provider does not support listing windows',
        )
      }
      return (await page.windowList()) as WindowLike[]
    },
    windowCreate: async (opts) => {
      const page = await provider.connect()
      if (!page.windowCreate) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser provider does not support creating windows',
        )
      }
      return (await page.windowCreate(opts)) as WindowLike | undefined
    },
    windowClose: async (windowId) => {
      const page = await provider.connect()
      if (!page.windowClose) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser provider does not support closing windows',
        )
      }
      await page.windowClose(windowId)
    },
    windowActivate: async (windowId) => {
      const page = await provider.connect()
      if (!page.windowActivate) return
      await page.windowActivate(windowId)
    },
    moveTab: async (target, windowId) => {
      const page = await provider.connect()
      if (!page.moveTab) {
        throw new SpaceGuardError(
          'no-gateway',
          'browser provider does not support moving tabs between windows',
        )
      }
      await page.moveTab(target, windowId)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskSpaceManager
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_STATE = (): PersistedState => ({
  version: SPACE_STORAGE_VERSION,
  spaces: {},
  currentSpaceByOwner: {},
})

export class TaskSpaceManager {
  readonly events: SpaceEventBus | null
  private state: PersistedState
  private readonly storagePath: string | undefined
  private readonly gateway: SpaceTabGateway | undefined
  private readonly persist: boolean
  /**
   * M5 — this manager may write the ledger only when its PROCESS holds the
   * authority for it (src/space/ledger-authority.ts). A manager that cannot
   * claim (another live hub process owns the file) still serves reads — which
   * is what an inspecting caller wants — but never writes, so two authorities
   * cannot silently drop each other's spaces.
   */
  private readonly readOnly: boolean
  /** D8 — TTL reaper on/off (options.reap.enabled === false or HUB_SPACE_REAP=off → off). */
  private readonly reapEnabled: boolean
  /** D8 — Tier 1 empty-space idle TTL (ms). */
  private readonly reapEmptyTtlMs: number
  /** D8 — Tier 2 idle agent-space TTL (ms). */
  private readonly reapSpaceTtlMs: number
  /**
   * TabFreshness health telemetry — in-memory ONLY (ledger structure untouched,
   * never persisted, no automatic decisions; thresholds stay future work).
   * Keyed by pageId: ops = open/reuse hits through openTabWithReuse (+1 per
   * hit/new), cleared by closeTab / recycle. ageMs derives from openedAt.
   */
  private readonly tabHealth = new Map<
    number,
    { ops: number; openedAt: number }
  >()
  /**
   * P7-C — external-writer convergence for the daemon's `/spaces/stream` feed.
   *
   * The daemon owns the ledger, but not every writer goes through it yet (a
   * `hub --mcp` stdio server, a direct CLI invocation). Those changes are not
   * on this process's event bus, so the file itself has to be watched. The
   * callback is invoked AFTER the state has been re-read, so a subscriber can
   * immediately render the new truth.
   */
  private storageWatcher: fs.FSWatcher | undefined
  private storageWatchCallback: (() => void) | undefined
  /**
   * The exact JSON this manager last wrote. An fs event whose content matches
   * is our OWN save, not an external change — without this every local write
   * would re-enter as a spurious "reloaded" notification.
   */
  private lastPersistedJson: string | undefined

  constructor(options: TaskSpaceManagerOptions = {}) {
    const configuredPath = options.storagePath
    this.storagePath = configuredPath ?? defaultStoragePath()
    // One-time legacy migration: only when this manager is using the default
    // ledger location (no HUB_SPACES_FILE / explicit temp override), so tests
    // with temp ledgers and opt-out deployments are never touched. Idempotent —
    // migrateLegacyLedger no-ops once the new path exists.
    //
    // An EMPTY path means "no ledger file at all" and must be skipped: passing
    // it through would write the migration's staging file into the process's
    // CWD (observed as stray `.pid.uuid.tmp` dotfiles in the repo root, because
    // `${''}.${pid}.${uuid}.tmp` has no directory component).
    if (
      this.storagePath &&
      (configuredPath === undefined || configuredPath === defaultStoragePath())
    ) {
      migrateLegacyLedger(this.storagePath)
    }
    this.gateway = options.gateway
    this.persist = options.persist ?? true
    // Claim the ledger for this process. Failure is not fatal — reads stay
    // useful — but writes are refused, loudly, once.
    let readOnly = false
    if (this.persist && this.storagePath) {
      const claim = claimLedgerAuthority(this.storagePath)
      if (claim.ok === false) {
        readOnly = true
        console.warn(
          `[hub-spaces] another hub process owns this ledger (${describeAuthority(claim.holder)}) — ` +
            `${this.storagePath} is read-only for this process; its space changes will NOT persist`,
        )
      }
    }
    this.readOnly = readOnly
    this.events = options.events === undefined ? new SpaceEventBus() : options.events
    // D8 — reap config: options.reap → env → defaults; HUB_SPACE_REAP=off
    // (or reap.enabled === false) disables the sweep entirely.
    this.reapEnabled = !(
      options.reap?.enabled === false || process.env.HUB_SPACE_REAP === 'off'
    )
    this.reapEmptyTtlMs = resolveReapTtl(
      options.reap?.emptyTtlMs,
      process.env.HUB_SPACE_EMPTY_TTL_MS,
      REAP_EMPTY_TTL_MS_DEFAULT,
    )
    this.reapSpaceTtlMs = resolveReapTtl(
      options.reap?.spaceTtlMs,
      process.env.HUB_SPACE_TTL_MS,
      REAP_SPACE_TTL_MS_DEFAULT,
    )
    this.state = this.load()
    // D8 — load-time sweep (fire-and-forget). The synchronous ledger eviction
    // runs to completion before this constructor returns (reapExpiredSpaces
    // awaits nothing until after eviction), so tests can observe the result
    // immediately; only the best-effort tab closes are deferred.
    if (this.reapEnabled) {
      void this.reapExpiredSpaces(this.gateway)
    }
  }

  // ── storage ──

  /**
   * Parse the ledger file without applying tombstones ({} when missing/corrupt).
   *
   * Every read is normalized through migratePersistedState(): a v1 ledger (or
   * any ledger still carrying `tabGroupId`) loads as the current version with
   * the dropped projection field removed. This is the single choke point for
   * the whole storage layer — load() and reload() both read through it,
   * so no stale `tabGroupId` can survive a merge-on-save round-trip.
   */
  private readRaw(): Partial<PersistedState> {
    if (!this.storagePath) return {}
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8')
      return migratePersistedState(JSON.parse(raw))
    } catch {
      return {}
    }
  }

  private load(): PersistedState {
    const raw = this.readRaw()
    const spaces = raw.spaces ?? {}
    return {
      version: SPACE_STORAGE_VERSION,
      spaces,
      // bug #10 — a pointer must never name a space that is not there. The v4
      // migration APPLIES the old tombstones, which can remove a space a
      // pointer still names; a hand-edited or truncated file can too. This is
      // the one choke point every read goes through, so filter here.
      currentSpaceByOwner: Object.fromEntries(
        Object.entries(raw.currentSpaceByOwner ?? {}).filter(
          ([, id]) => spaces[id] !== undefined,
        ),
      ),
    }
  }

  /** Re-read the ledger from disk (跨进程/外部变更时使用). */
  reload(): void {
    this.state = this.load()
  }

  private save(): void {
    if (!this.persist || !this.storagePath) return
    // Single writer by construction: a process that does not own the ledger
    // must not write it (see the constructor).
    if (this.readOnly) return
    const json = JSON.stringify(this.state, null, 2)
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
      const tmp = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        fs.writeFileSync(tmp, json, 'utf-8')
        fs.renameSync(tmp, this.storagePath)
        // Remember what WE wrote, so the storage watcher can tell our own save
        // apart from an external writer's (see lastPersistedJson).
        this.lastPersistedJson = json
      } finally {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          // already renamed away (or never written) — nothing to clean up
        }
      }
    } catch {
      // Ledger persistence is best-effort; in-memory state stays authoritative
      // for this process.
    }
  }

  /**
   * P7-C — converge on ledger changes written by a writer OUTSIDE this process
   * (a `hub --mcp` stdio server, a direct CLI invocation). Those never reach
   * this process's events, so the daemon's `/spaces/stream` feed would keep
   * serving stale state without this.
   *
   * `onChange` fires AFTER the state has been re-read from disk. Best-effort
   * throughout: no watcher available (unsupported FS, unwritable directory)
   * simply means external writers are not pushed — reads stay correct because
   * `reload()` is still available. Idempotent; the watcher is closed by
   * `dispose()`.
   */
  watchStorage(onChange: () => void): void {
    this.storageWatchCallback = onChange
    if (this.storageWatcher || !this.storagePath) return
    const dir = path.dirname(this.storagePath)
    const base = path.basename(this.storagePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      // Fall through: fs.watch will simply fail and be treated as "no watcher".
    }
    try {
      // Watch the DIRECTORY, not the file: save() is an atomic tmp+rename, and
      // the ledger often does not exist yet at daemon startup (watching a
      // missing path throws ENOENT and would permanently disable the feed).
      this.storageWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== base) return // our own .tmp write, etc.
        this.onStorageChanged()
      })
      this.storageWatcher.unref?.()
    } catch {
      this.storageWatcher = undefined
    }
  }

  /** One storage-watcher tick: re-read the file, then notify — self-writes skipped. */
  private onStorageChanged(): void {
    if (!this.storagePath) return
    let raw: string
    try {
      raw = fs.readFileSync(this.storagePath, 'utf-8')
    } catch {
      return // deleted / mid-rename: the next event retries
    }
    if (raw === this.lastPersistedJson) return // our own save, not a change
    try {
      this.state = this.load()
    } catch {
      return // corrupt / partially written: never crash on someone else's file
    }
    this.lastPersistedJson = raw
    try {
      this.storageWatchCallback?.()
    } catch {
      // A throwing subscriber must never break the watcher.
    }
  }

  dispose(): void {
    this.save()
    // Stop converging: the daemon may be shutting down while a subscriber is
    // still attached, and a callback into a half-disposed manager is noise.
    try {
      this.storageWatcher?.close()
    } catch {
      // already closed
    }
    this.storageWatcher = undefined
    // Refcounted ledger authority: drop this process's hold so a later process
    // (or the same one re-constructed with the same storagePath) can claim it.
    // Mirrors the deployed build — only when this instance actually writes.
    if (this.persist && this.storagePath) {
      releaseLedgerAuthority(this.storagePath)
    }
  }

  // ── helpers ──

  private now(): number {
    return Date.now()
  }

  // ── TabFreshness health telemetry (in-memory, no auto decisions) ──

  /** +1 op for a tab that was opened or reused through openTabWithReuse. */
  private recordTabOp(pageId: number): void {
    const current = this.tabHealth.get(pageId)
    if (current) {
      current.ops += 1
    } else {
      this.tabHealth.set(pageId, { ops: 1, openedAt: this.now() })
    }
  }

  /** Drop telemetry for a closed tab. */
  private clearTabStats(pageId: number): void {
    this.tabHealth.delete(pageId)
  }

  /** TabFreshness: current ops + age for a page id (undefined when unknown to this process). */
  tabHealthFor(pageId: number): { ops: number; ageMs: number } | undefined {
    const current = this.tabHealth.get(pageId)
    if (!current) return undefined
    return { ops: current.ops, ageMs: Math.max(0, this.now() - current.openedAt) }
  }

  private toInfo(space: SpaceRecord): SpaceInfo {
    return {
      id: space.id,
      name: space.name,
      taskId: space.taskId,
      owner: space.owner,
      ownership: space.ownership,
      createdAt: new Date(space.createdAt).toISOString(),
      lastActiveAt: new Date(space.lastActiveAt).toISOString(),
      tabIds: space.tabs.map((t) => t.pageId),
      ...(space.windowId !== undefined ? { windowId: space.windowId } : {}),
    }
  }

  private spaceForPage(pageId: number): SpaceRecord | undefined {
    for (const space of Object.values(this.state.spaces)) {
      if (space.tabs.some((t) => t.pageId === pageId)) return space
    }
    return undefined
  }

  /** The ledger ref that claims a pageId, whichever space holds it. */
  private refForPage(pageId: number): TabRef | undefined {
    for (const space of Object.values(this.state.spaces)) {
      const ref = space.tabs.find((t) => t.pageId === pageId)
      if (ref) return ref
    }
    return undefined
  }

  /**
   * M2 follow-up — does this ledger ref actually DESCRIBE this live tab?
   *
   * M2 moved the ledger's stored identity onto the browser's own `tabId`, but
   * the guards kept keying on `pageId` alone — and `pageId` is a per-connection
   * counter. So a ref whose tab is gone could name whatever tab a NEW
   * connection handed that number to: the QuickBI misbinding, reachable as a
   * PRIVILEGE problem (the agent is allowed to read a stranger's tab, and
   * `classifyTabsForAgent` even labels it `mine` and hands back its url).
   *
   *   true      — a comparable anchor (tabId / targetId) agrees
   *   false     — POSITIVE disagreement: every anchor the two have in common
   *               differs, so this is not the tab the ref describes
   *   undefined — nothing to judge with (the ref or the live tab carries no
   *               anchor at all): keep the legacy ledger-only decision
   *
   * Only anchors present on BOTH sides are compared — a gateway that reports
   * one kind and not the other must not be read as a disagreement. The rule is
   * deliberately asymmetric: refuse on positive evidence, never on absence of
   * information (a flaky browser must not lock the agent out of its own tabs).
   */
  private refDescribesLiveTab(
    ref: TabRef,
    live: TabLike,
  ): boolean | undefined {
    const comparable: Array<[number | string, number | string]> = []
    if (ref.tabId !== undefined && live.tabId !== undefined) {
      comparable.push([ref.tabId, live.tabId])
    }
    if (ref.targetId !== undefined && live.targetId !== undefined) {
      comparable.push([ref.targetId, live.targetId])
    }
    if (comparable.length === 0) return undefined
    return comparable.some(([a, b]) => a === b)
  }

  /**
   * Live corroboration for one pageId. Returns the live tab when it could be
   * read, `undefined` when there is nothing to judge with (no gateway, or a
   * list that cannot be read) — never throws.
   */
  private async liveTabForPage(pageId: number): Promise<TabLike | undefined> {
    const gw = this.gateway
    if (!gw) return undefined
    try {
      const live = await gw.listTabs()
      return live.find((t) => t.pageId === pageId)
    } catch {
      return undefined
    }
  }

  private spacesOwnedBy(owner: string): SpaceRecord[] {
    return Object.values(this.state.spaces).filter((s) => s.owner === owner)
  }

  private requireSpace(spaceId: string): SpaceRecord {
    const space = this.state.spaces[spaceId]
    if (!space) {
      throw new SpaceGuardError(
        'space-not-found',
        `space not found: ${spaceId}`,
        { spaceId },
      )
    }
    return space
  }

  private requireOwned(owner: string, space: SpaceRecord): SpaceRecord {
    if (space.owner !== owner) {
      throw new SpaceGuardError(
        'not-space-owner',
        `space ${space.id} is owned by another agent; you cannot operate it`,
        { spaceId: space.id },
      )
    }
    return space
  }

  private userControlling(space: SpaceRecord): SpaceGuardError {
    return new SpaceGuardError(
      'user-controlling',
      `user is controlling space "${space.name}" (${space.id}); ask the user to confirm before resuming, then claim it back (space.claim / hub space takeover)`,
      { spaceId: space.id },
    )
  }

  /** Guard: agent may act on a space it owns when ownership === 'agent'. */
  private assertAgentCanAct(owner: string, space: SpaceRecord): void {
    this.requireOwned(owner, space)
    if (space.ownership !== 'agent') {
      throw this.userControlling(space)
    }
  }

  /** The space's tab set changed — one signal, the frame carries the rest. */
  private emitTabsChanged(space: SpaceRecord): void {
    this.emit('space.tabs_changed', space, { urls: space.tabs.length })
  }

  private emit(
    type: SpaceEventType,
    space: SpaceRecord,
    extra?: Partial<SpaceEvent>,
  ): void {
    this.events?.emit({
      type,
      spaceId: space.id,
      name: space.name,
      owner: space.owner,
      ownership: space.ownership,
      timestamp: this.now(),
      ...extra,
    })
  }

  // ── lifecycle API (3.1) ──

  /** Allocate a new space (只分配 id, 不调用浏览器). Sets it as the owner's current space. */
  async create(owner: string, name: string, taskId?: string): Promise<SpaceInfo> {
    const id = randomUUID()
    const now = this.now()
    const space: SpaceRecord = {
      id,
      name,
      taskId,
      owner,
      ownership: 'agent',
      createdAt: now,
      lastActiveAt: now,
      tabs: [],
    }
    this.state.spaces[id] = space
    this.state.currentSpaceByOwner[owner] = id
    this.save()
    this.emit('space.created', space)
    return this.toInfo(space)
  }

  /** Reuse the (owner, name) space or create it. Sets it as current. */
  async useOrCreateTaskSpace(
    owner: string,
    name: string,
    taskId?: string,
  ): Promise<SpaceInfo> {
    const existing = this.spacesOwnedBy(owner).find((s) => s.name === name)
    if (existing) {
      this.state.currentSpaceByOwner[owner] = existing.id
      existing.lastActiveAt = this.now()
      this.save()
      this.emit('space.switched', existing)
      return this.toInfo(existing)
    }
    return this.create(owner, name, taskId)
  }

  async getSpace(spaceId: string): Promise<SpaceInfo> {
    return this.toInfo(this.requireSpace(spaceId))
  }

  async listSpaces(owner: string): Promise<SpaceInfo[]> {
    return this.spacesOwnedBy(owner)
      .map((s) => this.toInfo(s))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }

  async currentSpace(owner: string): Promise<SpaceInfo | undefined> {
    const id = this.state.currentSpaceByOwner[owner]
    if (!id) return undefined
    const space = this.state.spaces[id]
    if (!space) {
      delete this.state.currentSpaceByOwner[owner]
      this.save()
      return undefined
    }
    return this.toInfo(space)
  }

  /** Switch the conversation's current space. */
  async switch(owner: string, spaceId: string): Promise<SpaceInfo> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    if (space.ownership === 'user') {
      throw this.userControlling(space)
    }
    this.state.currentSpaceByOwner[owner] = spaceId
    space.lastActiveAt = this.now()
    this.save()
    this.emit('space.switched', space)
    return this.toInfo(space)
  }

  /**
   * Open a tab (background by default) and attribute it to the space.
   * Returns pageId. Same URL inside the space is reused by default (ego
   * openOrReuseTab semantics) — see openTabWithReuse for details.
   */
  async openTab(
    owner: string,
    spaceId: string,
    url: string,
    opts?: { background?: boolean; windowId?: number },
    gateway?: SpaceTabGateway,
  ): Promise<number> {
    return (await this.openTabWithReuse(owner, spaceId, url, opts, gateway))
      .pageId
  }

  /**
   * openTab + URL reuse metadata (ego `openOrReuseTab` semantics).
   *
   * opts.reuse:
   *   - false           → force a new tab (legacy behavior)
   *   - 'exact'         → reuse a live tab in this space with the same href
   *                       (normalized via sameRestoreUrl; default when omitted)
   *   - 'origin'        → reuse a live tab in this space with the same origin
   *   - 'origin+path'   → reuse a live tab in this space with the same
   *                       origin + pathname (query/hash ignored)
   *   - 'includes'      → reuse a live tab in this space whose URL string
   *                       contains the requested url
   *
   * Matching only considers tabs already attributed to THIS space that are
   * still alive in the browser (gateway.listTabs), so externally-closed tabs
   * and other spaces' tabs never participate. On a hit the existing tab is
   * switched to (best-effort activate) and `reused: true` is returned — no
   * duplicate is opened.
   */
  /**
   * P7-A — the next durable label for a space: `p<N>` with N one past the
   * highest label ever used here. Monotonic, so a label never silently points
   * at a different tab after a close.
   */
  private nextLabel(space: SpaceRecord): string {
    let max = 0
    for (const tab of space.tabs) {
      const match = /^p(\d+)$/.exec(tab.label ?? '')
      if (match) max = Math.max(max, Number(match[1]))
    }
    return `p${max + 1}`
  }

  /**
   * P7-A — listing a space's tabs is an agent-only view.
   *
   * ego blocks `tabs()` outright while the user controls the space ("browser
   * commands are paused"); hub's browser-level `tabs` tool already redacts such
   * tabs to identity-only, but this space-scoped view would otherwise hand back
   * urls and titles for a space the agent does not currently control.
   */
  async assertTabListingAllowed(owner: string, spaceId: string): Promise<void> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    this.assertAgentCanAct(owner, space)
  }

  /** P7-A — resolve a durable page label inside a space (live tabs only). */
  async pageByLabel(
    owner: string,
    spaceId: string,
    label: string,
  ): Promise<SpaceTabInfo | undefined> {
    await this.assertTabListingAllowed(owner, spaceId)
    const tabs = await this.listTabs(spaceId)
    return tabs.find((tab) => tab.label === label)
  }

  /**
   * P7-H1 — is the ledger's window still there? Cannot verify (no windowList,
   * or the list call failed) → trust the ledger, exactly like the old group
   * wiring did: never duplicate-create on a flaky browser.
   */
  private async windowAlive(
    gw: SpaceTabGateway,
    windowId: number,
  ): Promise<boolean> {
    if (!gw.windowList) return true
    try {
      const windows = await gw.windowList()
      if (!Array.isArray(windows)) return true
      return windows.some((w) => w?.windowId === windowId)
    } catch {
      return true
    }
  }

  async openTabWithReuse(
    owner: string,
    spaceId: string,
    url: string,
    opts?: {
      background?: boolean
      windowId?: number
      reuse?: TabUrlReuseMode
    },
    gateway?: SpaceTabGateway,
  ): Promise<OpenTabResult> {
    const space = this.requireSpace(spaceId)
    this.assertAgentCanAct(owner, space)
    const gw = gateway ?? this.gateway
    if (!gw) {
      throw new SpaceGuardError(
        'no-gateway',
        'openTab requires a browser gateway (no browser connection configured)',
        { spaceId },
      )
    }
    const reuse = opts?.reuse === undefined ? 'exact' : opts.reuse
    if (reuse !== false) {
      const matched = await this.matchReusableTab(space, url, reuse, gw)
      if (matched !== undefined) {
        // ego semantics: switch to the existing tab (active), no duplicate.
        try {
          await gw.activate?.(matched)
        } catch {
          // Activation is best-effort; reuse still succeeds without it.
        }
        space.lastActiveAt = this.now()
        this.save()
        this.recordTabOp(matched)
        const matchedRef = space.tabs.find((t) => t.pageId === matched)
        return {
          pageId: matched,
          reused: true,
          ...(matchedRef?.label !== undefined ? { label: matchedRef.label } : {}),
          ...(matchedRef?.targetId !== undefined
            ? { targetId: matchedRef.targetId }
            : {}),
        }
      }
    }
    // P7-H1 — place the tab in the space's OWN window. Chromium's
    // createWindow always brings exactly one tab, so a space's first tab
    // creates the window WITH itself (no stray about:blank); later tabs join it
    // by windowId. No window support on this gateway → legacy shared window.
    let windowId = opts?.windowId
    if (
      windowId === undefined &&
      space.windowId !== undefined &&
      (await this.windowAlive(gw, space.windowId))
    ) {
      windowId = space.windowId
    }
    let targetId: string | number | undefined
    let createdWindow = false
    if (windowId === undefined && gw.windowCreate) {
      const created = await gw.windowCreate({ url })
      if (created && typeof created.windowId === 'number') {
        windowId = created.windowId
        space.windowId = created.windowId
        createdWindow = true
        this.save()
      }
    }
    if (!createdWindow) {
      // Either the window already existed (add the tab to it) or this gateway
      // has no window support at all (legacy shared window).
      targetId = await gw.newTab(url, {
        background: opts?.background ?? true,
        ...(windowId !== undefined ? { windowId } : {}),
      })
    }
    let pageId: number | undefined
    let stableTargetId: string | undefined
    let nativeTabId: number | undefined
    let placedWindow: number | undefined = windowId
    // Resolve the fresh tab from the live list for EVERY creation path, not
    // just the one that returns a targetId string: this single observation is
    // where the ledger picks up the browser's own tab identity (`tabId`) and
    // the window the tab actually landed in — neither of which a gateway's
    // return value can express. One extra local list call per tab creation.
    let liveTabs: TabLike[] = []
    try {
      liveTabs = await gw.listTabs()
    } catch {
      liveTabs = []
    }
    const fresh =
      typeof targetId === 'string'
        ? liveTabs.find((t) => t.targetId === targetId)
        : windowId === undefined
          ? undefined
          : liveTabs.find(
              (t) =>
                t.windowId === windowId &&
                !space.tabs.some((x) => x.pageId === t.pageId),
            )
    if (typeof targetId === 'number') {
      // Numeric gateway: the returned number IS the page id (no targetId to
      // match on). The live list is still consulted for tabId/windowId.
      pageId = targetId
      const observed = liveTabs.find((t) => t.pageId === targetId)
      stableTargetId = observed?.targetId
      nativeTabId = observed?.tabId
      placedWindow = observed?.windowId ?? placedWindow
    } else {
      stableTargetId =
        fresh?.targetId ?? (typeof targetId === 'string' ? targetId : undefined)
      nativeTabId = fresh?.tabId
      pageId = fresh?.pageId
      placedWindow = fresh?.windowId ?? placedWindow
    }
    if (pageId === undefined) {
      throw new SpaceGuardError(
        'tab-resolve-failed',
        'opened a tab but could not resolve its page id',
        { spaceId },
      )
    }
    space.tabs = space.tabs.filter((t) => t.pageId !== pageId)
    // Fresh tabs are pending restore: the next daemon/MCP start reconciles them
    // (re-attach if still open, re-open by URL if gone) exactly once. The
    // native tabId and the stable targetId ride along so restart
    // reconciliation cannot misbind.
    space.tabs.push({
      pageId,
      ...(nativeTabId !== undefined ? { tabId: nativeTabId } : {}),
      targetId: stableTargetId,
      url,
      title: undefined,
      restored: false,
      label: this.nextLabel(space),
      openedBy: 'agent',
      ...(placedWindow !== undefined ? { windowId: placedWindow } : {}),
    })
    space.lastActiveAt = this.now()
    this.save()
    this.emitTabsChanged(space)
    this.recordTabOp(pageId)
    const created = space.tabs.find((t) => t.pageId === pageId)
    return {
      pageId,
      reused: false,
      ...(created?.label !== undefined ? { label: created.label } : {}),
      ...(created?.targetId !== undefined ? { targetId: created.targetId } : {}),
    }
  }

  /** List tabs attributed to the space; externally-closed tabs are pruned from the ledger. */
  async listTabs(
    spaceId: string,
    gateway?: SpaceTabGateway,
  ): Promise<SpaceTabInfo[]> {
    const space = this.requireSpace(spaceId)
    const gw = gateway ?? this.gateway
    let live: TabLike[] = []
    if (gw) {
      try {
        live = await gw.listTabs()
      } catch {
        live = []
      }
    }
    // M2: the native tabId is the first-class lookup — it is the browser's own
    // identity and the only anchor that exists for every live tab, even one
    // recorded without a targetId.
    const liveByTab = new Map<number, TabLike>()
    for (const t of live) {
      if (t.tabId !== undefined) liveByTab.set(t.tabId, t)
    }
    if (live.length > 0) {
      // Cross-process prune guard: a tab stays when its stable identity is
      // live, or when its pageId is live AND the url agrees (a stranger
      // holding the renumbered id must not keep the ledger entry alive).
      const liveByTarget = new Set(live.map((t) => t.targetId).filter(Boolean))
      const liveById = new Map(live.map((t) => [t.pageId, t]))
      const before = space.tabs.length
      space.tabs = space.tabs.filter((t) => {
        if (t.tabId !== undefined && liveByTab.has(t.tabId)) return true
        if (t.targetId && liveByTarget.has(t.targetId)) return true
        const li = liveById.get(t.pageId)
        return !!li && !!t.url && !!li.url && this.sameRestoreUrl(li.url) === this.sameRestoreUrl(t.url)
      })
      if (space.tabs.length !== before) {
        // Drop telemetry with the refs that just went away. pageId is a
        // per-connection counter, so a leaked entry would attach its ops/ageMs
        // to whatever tab is handed that number NEXT — and that telemetry is
        // exactly what the tab-hygiene / wedged-tab decisions read.
        const kept = new Set(space.tabs.map((t) => t.pageId))
        for (const ref of Object.values(this.state.spaces).flatMap((sp) => sp.tabs)) {
          kept.add(ref.pageId)
        }
        for (const pageId of [...this.tabHealth.keys()]) {
          if (!kept.has(pageId)) this.clearTabStats(pageId)
        }
        space.lastActiveAt = this.now()
        this.save()
        this.emitTabsChanged(space)
      }
    }
    return space.tabs.map((ref) => {
      const liveInfo =
        (ref.tabId !== undefined ? liveByTab.get(ref.tabId) : undefined) ??
        (ref.targetId
          ? live.find((t) => t.targetId === ref.targetId)
          : undefined) ??
        live.find((t) => t.pageId === ref.pageId)
      const health = this.tabHealthFor(ref.pageId)
      const nativeTabId = liveInfo?.tabId ?? ref.tabId
      return {
        pageId: ref.pageId,
        ...(ref.label !== undefined ? { label: ref.label } : {}),
        ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
        ...(nativeTabId !== undefined ? { tabId: nativeTabId } : {}),
        targetId: liveInfo?.targetId ?? ref.targetId,
        url: liveInfo?.url ?? ref.url,
        title: liveInfo?.title ?? ref.title,
        isActive: liveInfo?.isActive,
        ...(health ? { ops: health.ops, ageMs: health.ageMs } : {}),
      }
    })
  }

  /**
   * P7-A follow-up — the space's tabs *as they are in the window*, including
   * the ones the ledger does not know.
   *
   * Why this exists: `listTabs()` answers "what does the ledger hold", which is
   * the right question for guards and for `finish`, but it is the wrong answer
   * for an agent standing in its own space — a tab the user dragged into the
   * space window is invisible there, so it can neither be adopted nor reported.
   * ego's `task.tabs()` returns managed AND unmanaged rows for exactly this
   * reason; this is hub's equivalent, with two deliberate differences:
   *
   *   1. unmanaged rows are identity-only (see `UnmanagedTabInfo`) — P1-5;
   *   2. the boundary is the ledger's window, and when that cannot be resolved
   *      we return ledger rows ONLY (`scope: 'ledger-only'`) instead of
   *      falling back to "every live tab in the browser".
   *
   * The managed rows come from `listTabs()`, so the same cross-process prune
   * guard applies to them; the unmanaged rows are read-only observations and
   * never enter the ledger (only `adopt` does that).
   */
  async listTabsWithUnmanaged(
    spaceId: string,
    gateway?: SpaceTabGateway,
  ): Promise<SpaceWindowTabs> {
    const managed = await this.listTabs(spaceId, gateway)
    const space = this.requireSpace(spaceId)
    const gw = gateway ?? this.gateway
    let live: TabLike[] = []
    if (gw) {
      try {
        live = await gw.listTabs()
      } catch {
        live = []
      }
    }
    // Window resolution, most-trusted first:
    //   1. the ledger's own windowId, but ONLY while some live tab still
    //      reports it — a stale id must not scope the listing to a window that
    //      has been recycled onto a stranger;
    //   2. otherwise the live window of one of OUR tabs (the ledger id drifted,
    //      e.g. the browser restarted and the space was re-attached).
    // No live tab carries a windowId at all → the gateway predates the window
    // family → degrade instead of inventing a boundary.
    const reportsWindows = live.some((t) => t.windowId !== undefined)
    let windowId: number | undefined
    if (reportsWindows) {
      if (
        space.windowId !== undefined &&
        live.some((t) => t.windowId === space.windowId)
      ) {
        windowId = space.windowId
      } else {
        const managedTargets = new Set(
          managed.map((t) => t.targetId).filter((v): v is string => !!v),
        )
        const managedIds = new Set(managed.map((t) => t.pageId))
        windowId = live.find(
          (t) =>
            (t.targetId !== undefined && managedTargets.has(t.targetId)) ||
            managedIds.has(t.pageId),
        )?.windowId
      }
    }
    if (windowId === undefined) {
      return {
        tabs: managed,
        ...(space.windowId !== undefined ? { windowId: space.windowId } : {}),
        scope: 'ledger-only',
      }
    }
    const knownTargets = new Set(
      managed.map((t) => t.targetId).filter((v): v is string => !!v),
    )
    const knownIds = new Set(managed.map((t) => t.pageId))
    const unmanaged: UnmanagedTabInfo[] = live
      .filter((t) => t.windowId === windowId)
      .filter(
        (t) =>
          !knownIds.has(t.pageId) &&
          !(t.targetId !== undefined && knownTargets.has(t.targetId)),
      )
      .map((t) => ({
        unmanaged: true as const,
        pageId: t.pageId,
        ...(t.targetId !== undefined ? { targetId: t.targetId } : {}),
        ...(t.isActive !== undefined ? { isActive: t.isActive } : {}),
      }))
    // Ledger rows first (stable order), then the strangers by pageId.
    unmanaged.sort((a, b) => a.pageId - b.pageId)
    return { tabs: [...managed, ...unmanaged], windowId, scope: 'window' }
  }

  /**
   * Best-effort close of one ledger tab through the gateway (bug #8: a
   * direct-connect close process's PageManager renumbers live tabs, so the
   * ledger pageId can be stale). Tries the ledger pageId first; when that
   * throws (e.g. "Tab not found"), falls back to matching the live tab list by
   * exact URL and closes the live tab's id. Never throws — a browser-side
   * close failure must not abort the batch, and the caller's ledger cleanup
   * stays authoritative.
   */
  /** P1: bound one best-effort tab close (gateway call + fallbacks) to a deadline. */
  private async closeTabWithDeadline(
    gw: SpaceTabGateway,
    ref: TabRef,
  ): Promise<void> {
    const CLOSE_TAB_DEADLINE_MS = 20_000
    return new Promise<void>((resolve, _reject) => {
      const timer = setTimeout(
        () => resolve(), // deadline = give up silently; ledger cleanup proceeds
        CLOSE_TAB_DEADLINE_MS,
      )
      this.closeTabBestEffort(gw, ref).then(
        () => { clearTimeout(timer); resolve() },
        () => { clearTimeout(timer); resolve() }, // best-effort: errors are already swallowed inside
      )
    })
  }

  private async closeTabBestEffort(
    gw: SpaceTabGateway,
    ref: TabRef,
  ): Promise<void> {
    // Stable identity first: the ledger pageId is a per-connection number and
    // may address a different tab in this connection; targetId never drifts.
    if (ref.targetId) {
      try {
        await gw.closeTab(ref.targetId)
        return
      } catch {
        // targetId close unsupported/stale — fall through to the legacy path.
      }
    }
    try {
      await gw.closeTab(ref.pageId)
      return
    } catch {
      // Ledger pageId is stale or the tab is already gone — try the live list.
    }
    let live: TabLike[] = []
    try {
      live = await gw.listTabs()
    } catch {
      live = []
    }
    if (live.length === 0) return
    const match = live.find((t) => {
      const liveUrl = t.url
      return liveUrl != null && this.tabUrlMatches(liveUrl, ref.url, 'exact')
    })
    if (!match) return
    const target = match.pageId ?? match.tabId ?? match.targetId
    if (target === undefined) return
    try {
      await gw.closeTab(target)
    } catch {
      // Still failed — skip this tab; ledger cleanup below remains authoritative.
    }
  }

  /** Close one tab: browser first (best-effort), then ledger. */
  async closeTab(
    owner: string,
    spaceId: string,
    pageId: number,
    gateway?: SpaceTabGateway,
  ): Promise<void> {
    const space = this.requireSpace(spaceId)
    this.assertAgentCanAct(owner, space)
    const gw = gateway ?? this.gateway
    if (gw) {
      const ref = space.tabs.find((t) => t.pageId === pageId)
      if (ref) {
        await this.closeTabBestEffort(gw, ref)
      } else {
        try {
          await gw.closeTab(pageId)
        } catch {
          // Browser-side close failure is surfaced but the ledger is still cleaned.
        }
      }
    }
    space.tabs = space.tabs.filter((t) => t.pageId !== pageId)
    // P7-H2 — Chromium destroys a window with its last tab, so a space that
    // just lost its final tab no longer has one; the next open_tab recreates it.
    if (space.tabs.length === 0) delete space.windowId
    space.lastActiveAt = this.now()
    this.save()
    this.emitTabsChanged(space)
    this.clearTabStats(pageId)
  }

  /**
   * Close a space. keep=false closes every tab (needs a gateway); user-held
   * spaces must be claimed first (spec: agent close 需先 claim 再关).
   */
  async closeSpace(
    owner: string,
    spaceId: string,
    opts?: { keep?: boolean },
    gateway?: SpaceTabGateway,
  ): Promise<void> {
    const space = this.requireSpace(spaceId)
    this.assertAgentCanAct(owner, space)
    const keep = opts?.keep ?? false
    if (!keep) {
      const gw = gateway ?? this.gateway
      if (!gw) {
        throw new SpaceGuardError(
          'no-gateway',
          'closeSpace needs a browser gateway to close the tabs; pass keep:true to close only the space ledger, or run under the hub daemon',
          { spaceId },
        )
      }
      // P7-H2 — a space that owns a whole window collapses to ONE closeWindow:
      // Chromium takes the window's tabs with it. Only when the window holds
      // nothing but this space's tabs — a window the user dragged a tab into is
      // closed tab by tab instead, so their tab survives.
      const windowClosed = await this.closeSpaceWindow(space, gw)
      for (const ref of windowClosed ? [] : [...space.tabs]) {
        // Best-effort: stale pageIds fall back to exact-URL matching against
        // the live tab list (bug #8); a still-failing close is skipped and the
        // ledger entry is dropped below regardless. P1 (space.close hang):
        // a wedged closeTab used to hang the whole space.close forever —
        // bound each attempt so closeSpace always finishes; the tab may leak
        // open, which the ledger cleanup below tolerates by design.
        try {
          await this.closeTabWithDeadline(gw, ref)
        } catch (err) {
          console.warn(
            `[hub-spaces] tab close skipped for space ${space.id}: ${(err as Error)?.message ?? String(err)}`,
          )
        }
      }
    }
    delete this.state.spaces[spaceId]
    if (this.state.currentSpaceByOwner[space.owner] === spaceId) {
      const next = this.spacesOwnedBy(space.owner).sort(
        (a, b) => b.lastActiveAt - a.lastActiveAt,
      )[0]
      if (next) this.state.currentSpaceByOwner[space.owner] = next.id
      else delete this.state.currentSpaceByOwner[space.owner]
    }
    this.save()
    this.emit('space.closed', space)
  }

  /**
   * P7-A — remember which tab the user is on at the handoff boundary.
   *
   * Best-effort by design: the live active tab of the space's window when the
   * gateway can tell us, else the space's last-active ledger tab. No gateway →
   * nothing is captured and `userPage()` stays empty (never guessed).
   */
  private async captureHandoffPage(space: SpaceRecord): Promise<void> {
    const gw = this.gateway
    let captured: SpaceRecord['handoffPage']
    if (gw) {
      try {
        const live = await gw.listTabs()
        const inWindow =
          space.windowId === undefined
            ? []
            : live.filter((t) => t.windowId === space.windowId)
        const active = inWindow.find((t) => t.isActive === true) ?? inWindow[0]
        if (active) {
          const ref = space.tabs.find((t) => t.pageId === active.pageId)
          captured = {
            pageId: active.pageId,
            ...(ref?.label !== undefined ? { label: ref.label } : {}),
            ...(active.url !== undefined ? { url: active.url } : {}),
            ...(active.title !== undefined ? { title: active.title } : {}),
          }
        }
      } catch {
        // fall through to the ledger-based capture below
      }
    }
    if (!captured) {
      const last = [...space.tabs].sort(
        (a, b) => (b.restored ? 1 : 0) - (a.restored ? 1 : 0),
      )[0]
      if (last) {
        captured = {
          pageId: last.pageId,
          ...(last.label !== undefined ? { label: last.label } : {}),
          ...(last.url !== undefined ? { url: last.url } : {}),
          ...(last.title !== undefined ? { title: last.title } : {}),
        }
      }
    }
    if (captured) space.handoffPage = captured
  }

  /**
   * P7-C bridge — a read-only snapshot of EVERY space for the browser-side UI.
   *
   * Deliberately owner-agnostic: the Space overview is a browser surface, not an
   * agent, and ego's overview lists every space in the browser. It carries
   * names/ownership/tab counts plus a compact per-tab summary, and nothing here
   * is actionable — every mutation still goes through the guarded tool faces.
   * `unowned` is hub's stand-in for ego's user-owned space: tabs the ledger does
   * not know (the user's own browsing).
   */
  async uiSnapshot(opts?: {
    /** Opt in to the bounded live probe (`unowned` counts + `windows`). */
    probe?: boolean
    gateway?: SpaceTabGateway
  }): Promise<{
    generatedAt: string
    spaces: Array<
      SpaceInfo & {
        tabCount: number
        tabs: Array<{
          pageId: number
          label?: string
          url: string
          title?: string
          openedBy?: TabOrigin
        }>
      }
    >
    /** Tabs the ledger does not know (the user's). `probed:false` = not asked
     *  for a live look, so the count is 0 by absence of information, not by
     *  measurement. */
    unowned: { tabCount: number; probed: boolean }
    /**
     * M4 — one row per live browser window, which is how the Space overview
     * renders its grid: `spaceId` present → that space's card; absent → a
     * **user window** card.
     *
     * This is the whole point of not making every window a ledger record: the
     * card is SYNTHESIZED from a window enumeration the browser already gives
     * us, so the ledger never has to hold a row — let alone any content — for
     * a window the agent was never given. Counts only: no url/title of a tab
     * the ledger does not own ever crosses this boundary.
     *
     * Empty when the probe was not asked for; `windowsProbed` says which.
     */
    windows: Array<{
      windowId: number
      tabCount: number
      /** The ledger space bound to this window, when there is one. */
      spaceId?: string
      spaceName?: string
      isActive?: boolean
      isVisible?: boolean
      /** Live tabs in this window the ledger does not know (count only). */
      unmanagedTabCount: number
    }>
    windowsProbed: boolean
  }> {
    const spaces = Object.values(this.state.spaces)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((space) => ({
        ...this.toInfo(space),
        tabCount: space.tabs.length,
        tabs: space.tabs.map((tab) => ({
          pageId: tab.pageId,
          ...(tab.label !== undefined ? { label: tab.label } : {}),
          url: tab.url,
          ...(tab.title !== undefined ? { title: tab.title } : {}),
          ...(tab.openedBy !== undefined ? { openedBy: tab.openedBy } : {}),
        })),
      }))
    let unownedTabCount = 0
    let probed = false
    let windows: Array<{
      windowId: number
      tabCount: number
      spaceId?: string
      spaceName?: string
      isActive?: boolean
      isVisible?: boolean
      unmanagedTabCount: number
    }> = []
    // The live probe is OPT-IN and bounded: this feeds a UI endpoint, and a
    // browser that is slow (or still connecting) must never hang the request.
    // The ledger part above is instant and is what the overview needs.
    const gw = opts?.probe === true ? (opts.gateway ?? this.gateway) : undefined
    if (gw) {
      probed = true
      // Bounded: a slow (or still connecting) browser must never hang the
      // request — every probed field degrades to its "no information" value.
      const bounded = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
        Promise.race([
          p.catch(() => fallback),
          new Promise<T>((resolve) =>
            setTimeout(() => resolve(fallback), UI_SNAPSHOT_PROBE_TIMEOUT_MS),
          ),
        ])
      try {
        // M2 — the ownership set is keyed on BOTH anchors: pageId is only
        // meaningful within one connection, tabId within one browser run, and
        // a tab is "known" when either says so.
        const ownedPages = new Set(
          Object.values(this.state.spaces).flatMap((s) =>
            s.tabs.map((t) => t.pageId),
          ),
        )
        const ownedTabIds = new Set(
          Object.values(this.state.spaces).flatMap((s) =>
            s.tabs.map((t) => t.tabId).filter((v): v is number => v !== undefined),
          ),
        )
        const isKnown = (t: TabLike): boolean =>
          ownedPages.has(t.pageId) ||
          (t.tabId !== undefined && ownedTabIds.has(t.tabId))
        const live = await bounded(gw.listTabs(), [] as TabLike[])
        unownedTabCount = live.filter((t) => !isKnown(t)).length

        // M4 — window grid rows. A window is "a space's" only when the ledger
        // binds it; everything else is a user window, by absence of a claim.
        if (gw.windowList) {
          const win = await bounded(
            gw.windowList(),
            [] as Awaited<ReturnType<NonNullable<SpaceTabGateway['windowList']>>>,
          )
          const byWindow = new Map<string, { spaceId: string; spaceName: string }>()
          for (const space of Object.values(this.state.spaces)) {
            if (space.windowId === undefined) continue
            byWindow.set(String(space.windowId), {
              spaceId: space.id,
              spaceName: space.name,
            })
          }
          const unmanagedByWindow = new Map<number, number>()
          for (const t of live) {
            if (t.windowId === undefined || isKnown(t)) continue
            unmanagedByWindow.set(
              t.windowId,
              (unmanagedByWindow.get(t.windowId) ?? 0) + 1,
            )
          }
          windows = win.map((w) => {
            const bound = byWindow.get(String(w.windowId))
            return {
              windowId: w.windowId,
              tabCount:
                typeof w.tabCount === 'number'
                  ? w.tabCount
                  : live.filter((t) => t.windowId === w.windowId).length,
              ...(bound ? { spaceId: bound.spaceId, spaceName: bound.spaceName } : {}),
              ...(w.isActive !== undefined ? { isActive: w.isActive } : {}),
              ...(w.isVisible !== undefined ? { isVisible: w.isVisible } : {}),
              unmanagedTabCount: unmanagedByWindow.get(w.windowId) ?? 0,
            }
          })
        }
      } catch {
        unownedTabCount = 0
        windows = []
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      spaces,
      unowned: { tabCount: unownedTabCount, probed },
      windows,
      windowsProbed: probed && windows.length > 0,
    }
  }

  /**
   * P7-A — the tab the user was on at the handoff boundary (ego `userPage()`).
   *
   * Agent-only, like every other read of a space the agent does not control:
   * ego pauses browser commands outright while the user is in charge, so this
   * answers only once the agent has the space back. Returns undefined when
   * nothing was captured — never a guess.
   */
  async userPage(
    owner: string,
    spaceId: string,
  ): Promise<SpaceRecord['handoffPage']> {
    await this.assertTabListingAllowed(owner, spaceId)
    const space = this.requireSpace(spaceId)
    return space.handoffPage
  }

  /** P7-A — outcome of waitForControl (a timeout is a result, not an error). */
  async waitForControl(
    owner: string,
    spaceId: string,
    opts?: { interval?: number; timeout?: number; signal?: AbortSignal },
  ): Promise<{
    spaceId: string
    ownership: SpaceOwnership
    waitedMs: number
    timedOut: boolean
  }> {
    const interval = Math.max(100, opts?.interval ?? 500)
    const timeout = Math.min(Math.max(1_000, opts?.timeout ?? 60_000), 300_000)
    const started = Date.now()
    for (;;) {
      // Cross-process truth is the ledger file: another process (the user's
      // takeover, a CLI call) writes it, so a poll re-reads it. In-process
      // events could shorten the first hop, but the ledger stays authoritative.
      this.refreshLedgerIfPresent()
      const space = this.state.spaces[spaceId]
      if (!space) {
        throw new SpaceGuardError(
          'space-not-found',
          `space ${spaceId} no longer exists (it was closed while waiting)`,
          { spaceId },
        )
      }
      this.requireOwned(owner, space)
      if (space.ownership === 'agent') {
        return {
          spaceId,
          ownership: space.ownership,
          waitedMs: Date.now() - started,
          timedOut: false,
        }
      }
      const elapsed = Date.now() - started
      if (elapsed >= timeout) {
        return { spaceId, ownership: space.ownership, waitedMs: elapsed, timedOut: true }
      }
      if (opts?.signal?.aborted) {
        throw new SpaceGuardError(
          'user-controlling',
          `waitForControl aborted while the user controls space "${space.name}" (${spaceId})`,
          { spaceId },
        )
      }
      await this.sleep(Math.min(interval, timeout - elapsed), opts?.signal)
    }
  }

  /**
   * Re-read the ledger when it is actually on disk. A manager that never
   * persisted (persist:false, no file yet) must NOT be wiped by a reload.
   */
  private refreshLedgerIfPresent(): void {
    if (!this.storagePath) return
    try {
      if (fs.existsSync(this.storagePath)) this.reload()
    } catch {
      // A transient read failure keeps the in-memory view.
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * P7-A — finish a task space with a REQUIRED retention policy (ego `finish`).
   *
   * `keep` is `'all'` or an explicit list of durable labels; everything else
   * the space manages is closed. Tabs the ledger does not know (the user's) are
   * never candidates — the loop only ever walks ledger refs. The space leaves
   * the ledger only when nothing remains to keep, which is ego's rule ("an empty
   * list closes the space when no protected tabs remain").
   */
  async finishSpace(
    owner: string,
    spaceId: string,
    keep: 'all' | string[],
    gateway?: SpaceTabGateway,
  ): Promise<FinishReceipt> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    this.assertAgentCanAct(owner, space)
    const gw = gateway ?? this.gateway
    const keepAll = keep === 'all'
    const requested = keepAll ? [] : keep
    for (const label of requested) {
      if (!space.tabs.some((t) => t.label === label)) {
        throw new SpaceGuardError(
          'page-not-in-space',
          `no tab labelled ${label} in space ${spaceId}`,
          { spaceId, hint: 'labels come from space.list_tabs / space.open_tab' },
        )
      }
    }
    const kept = keepAll ? space.tabs : space.tabs.filter(
      (t) => t.label !== undefined && requested.includes(t.label),
    )
    const toClose = keepAll ? [] : space.tabs.filter((t) => !kept.includes(t))
    // Count the user's tabs before anything closes (best-effort: needs a live
    // list and a known window).
    let preservedUnmanagedCount = 0
    if (space.windowId !== undefined && gw) {
      try {
        const owned = new Set(space.tabs.map((t) => t.pageId))
        preservedUnmanagedCount = (await gw.listTabs()).filter(
          (t) => t.windowId === space.windowId && !owned.has(t.pageId),
        ).length
      } catch {
        preservedUnmanagedCount = 0
      }
    }
    if (!gw && toClose.length > 0) {
      throw new SpaceGuardError(
        'no-gateway',
        'finish needs a browser gateway to close the tabs it does not keep',
        { spaceId, hint: 'pass keep:"all" to close only the ledger, or run under the hub daemon' },
      )
    }
    let windowClosed = false
    if (
      gw &&
      toClose.length > 0 &&
      toClose.length === space.tabs.length
    ) {
      // Nothing is kept: the window (when entirely ours) goes in one call.
      windowClosed = await this.closeSpaceWindow(space, gw)
    }
    if (!windowClosed && gw) {
      for (const ref of toClose) {
        try {
          await this.closeTabWithDeadline(gw, ref)
        } catch (err) {
          console.warn(
            `[hub-spaces] finish: tab close skipped for space ${space.id}: ${(err as Error)?.message ?? String(err)}`,
          )
        }
      }
    }
    const closedLabels = toClose
      .map((t) => t.label)
      .filter((l): l is string => l !== undefined)
    space.tabs = windowClosed ? [] : kept
    space.lastActiveAt = this.now()
    const closedSpace = space.tabs.length === 0
    // A surviving space changed its tab set; a closing one gets space.closed.
    if (!closedSpace) this.emitTabsChanged(space)
    if (closedSpace) {
      delete this.state.spaces[spaceId]
      if (this.state.currentSpaceByOwner[space.owner] === spaceId) {
        const next = this.spacesOwnedBy(space.owner).sort(
          (a, b) => b.lastActiveAt - a.lastActiveAt,
        )[0]
        if (next) this.state.currentSpaceByOwner[space.owner] = next.id
        else delete this.state.currentSpaceByOwner[space.owner]
      }
    }
    this.save()
    for (const ref of toClose) this.clearTabStats(ref.pageId)
    if (closedSpace) this.emit('space.closed', space)
    return {
      spaceId,
      closedSpace,
      keptLabels: space.tabs
        .map((t) => t.label)
        .filter((l): l is string => l !== undefined),
      closedLabels,
      preservedUnmanagedCount,
    }
  }

  /**
   * P7-H2 — close the space's own window when it is ENTIRELY ours.
   *
   * Returns true when the window was closed (its tabs went with it, so the
   * caller must not close them again). Refuses — falling back to per-tab
   * closes — when the window is unknown, holds a tab that is not ours, or when
   * liveness cannot be verified: killing a user tab to save a round trip is
   * never the right trade.
   */
  private async closeSpaceWindow(
    space: SpaceRecord,
    gw: SpaceTabGateway,
  ): Promise<boolean> {
    const windowId = space.windowId
    if (windowId === undefined || !gw.windowClose) return false
    const owned = new Set(space.tabs.map((t) => t.pageId))
    try {
      const live = await gw.listTabs()
      const foreign = live.filter(
        (t) => t.windowId === windowId && !owned.has(t.pageId),
      )
      if (foreign.length > 0) return false
    } catch {
      return false
    }
    try {
      await gw.windowClose(windowId)
      delete space.windowId
      return true
    } catch {
      return false
    }
  }

  /**
   * P2-1 — session-end sweep: close every space this owner holds.
   *
   * The MCP server process IS the session (P1-3 per-process convoId), so when
   * that process goes down its session-scoped spaces are orphans no caller
   * can ever address again — closing them now, instead of waiting out the D8
   * spaceTtl, is the mechanical floor under the "task ends → tabs close"
   * platform gap. Explicit stable identities (HUB_AGENT_ID) span sessions by
   * design, so hub.mjs wires this only for session-scoped identities.
   */
  async closeSpacesOwnedBy(
    owner: string,
    opts?: { keep?: boolean },
    gateway?: SpaceTabGateway,
  ): Promise<string[]> {
    const ids = this.spacesOwnedBy(owner).map((space) => space.id)
    const closed: string[] = []
    for (const id of ids) {
      await this.closeSpace(owner, id, opts, gateway)
      closed.push(id)
    }
    return closed
  }

  /**
   * TabFreshness 修正版 — space 整组回收原语 (边界新鲜化, 2026-08-03).
   *
   * Closes every tab attributed to the space, then reopens each URL in a
   * fresh tab (ego `openOrReuseTab` exact semantics — since the old tabs are
   * gone the reopen necessarily creates new ones; a close that fails leaves
   * the old tab alive and it is reused rather than duplicated). The space
   * record itself is preserved (same id/name/taskId/owner/ownership/createdAt
   * — only the tabs are replaced), the ledger pageIds are updated to the new
   * tabs, and `space.tabs_recycled` is emitted with the recycled count.
   *
   * NOT automatic: callers (space.recycle MCP tool / `hub space refresh`)
   * invoke it explicitly. useOrCreateTaskSpace never auto-recycles a reused
   * space — official ego/BrowserOS neo recycle only at task/session boundaries,
   * and auto-recycle stays opt-in at the screenshot tool level.
   */
  async recycleSpaceTabs(
    owner: string,
    spaceId: string,
    gateway?: SpaceTabGateway,
  ): Promise<RecycleSpaceTabsResult> {
    const space = this.requireSpace(spaceId)
    this.assertAgentCanAct(owner, space)
    const gw = gateway ?? this.gateway
    if (!gw) {
      throw new SpaceGuardError(
        'no-gateway',
        'recycleSpaceTabs needs a browser gateway to close and reopen the tabs; run under the hub daemon/MCP',
        { spaceId },
      )
    }
    const oldTabs = [...space.tabs]
    const previousWindowId = space.windowId
    // P7-H2 — will the window outlive the closes?
    //
    // Decided from the tab list BEFORE closing, on purpose. A liveness check
    // AFTER the closes races with Chromium's asynchronous window destruction:
    // under load the window is still there when we look, we keep its id, and
    // the reopen then aims at a window that is about to disappear (observed as
    // an intermittent live-smoke failure). The deterministic question is
    // "is anything in that window besides our tabs?" — if yes the window
    // survives and the reopen MUST stay in it (dropping the id would strand the
    // user's window as an orphan the guard will not let the agent clean up); if
    // no, the last close takes the window with it and the id must go first.
    let windowHasForeignTab = false
    if (gw.windowList && previousWindowId !== undefined) {
      try {
        const live = await gw.listTabs()
        const ours = (tab: TabLike): boolean =>
          oldTabs.some(
            (ref) =>
              ref.pageId === tab.pageId ||
              (ref.tabId !== undefined && ref.tabId === tab.tabId) ||
              (ref.targetId !== undefined && ref.targetId === tab.targetId),
          )
        windowHasForeignTab = live.some(
          (tab) => tab.windowId === previousWindowId && !ours(tab),
        )
      } catch {
        // Cannot see the window's contents: fall back to "it dies with its last
        // tab", which is the safe side — a fresh window always works, while a
        // stale id makes the reopen fail outright.
        windowHasForeignTab = false
      }
    }
    if (!windowHasForeignTab) delete space.windowId
    // 1. Close every tab (best-effort). A failed close leaves the tab alive;
    //    the exact-mode reopen below then reuses it instead of duplicating it.
    for (const ref of oldTabs) {
      try {
        await gw.closeTab(ref.pageId)
        this.clearTabStats(ref.pageId)
      } catch {
        // Continue closing the rest.
      }
    }
    // Closing is asynchronous on the browser side, and the reopen below asks
    // for `reuse: 'exact'` — so reopening immediately can find a tab that is
    // still on its way out and "reuse" it: no fresh window is created, and the
    // space comes back with NO window binding (observed intermittently:
    // `windowId` was `undefined` after a recycle). Wait, bounded, for the
    // closes to land. A tab still alive after that is a genuine close failure,
    // and then the reuse fallback is exactly right (no duplicate).
    if (oldTabs.length > 0 && gw.listTabs) {
      const deadline = Date.now() + 1500
      for (;;) {
        let live: TabLike[] = []
        try {
          live = await gw.listTabs()
        } catch {
          break // cannot see: do not stall the recycle
        }
        const stillThere = live.some((tab) =>
          oldTabs.some(
            (ref) =>
              ref.pageId === tab.pageId ||
              (ref.tabId !== undefined && ref.tabId === tab.tabId) ||
              (ref.targetId !== undefined && ref.targetId === tab.targetId),
          ),
        )
        if (!stillThere || Date.now() > deadline) break
        await this.sleep(50)
      }
    }
    // 2. Reopen each URL. First occurrence uses exact reuse (finds nothing new
    //    after a successful close); duplicate URLs force a fresh tab per
    //    occurrence so the tab count is preserved.
    const tabs: RecycleTabResult[] = []
    const seen = new Set<string>()
    let failed = 0
    for (const ref of oldTabs) {
      const duplicate = seen.has(ref.url)
      seen.add(ref.url)
      try {
        const { pageId, reused } = await this.openTabWithReuse(
          owner,
          spaceId,
          ref.url,
          { background: true, reuse: duplicate ? false : 'exact' },
          gw,
        )
        tabs.push({
          oldPageId: ref.pageId,
          newPageId: pageId,
          url: ref.url,
          reused,
        })
      } catch {
        // Reopen failed (e.g. browser down): the old tab is gone, so the ref
        // is dropped and the failure is reported in the result.
        failed += 1
      }
    }
    // 3. Drop ledger refs that were not reopened (failed reopens / stale).
    const reopened = new Set(tabs.map((t) => t.newPageId))
    space.tabs = space.tabs.filter((t) => reopened.has(t.pageId))
    // Whatever path the reopen took (fresh window / reused tab), the ledger
    // must say where the tabs ACTUALLY are. Without this a reused tab left
    // `windowId` undefined and the space lost its window binding.
    try {
      const live = await gw.listTabs()
      const windows = new Set(
        live
          .filter((tab) =>
            space.tabs.some(
              (ref) =>
                ref.pageId === tab.pageId ||
                (ref.tabId !== undefined && ref.tabId === tab.tabId) ||
                (ref.targetId !== undefined && ref.targetId === tab.targetId),
            ),
          )
          .map((tab) => tab.windowId)
          .filter((w): w is number => w !== undefined),
      )
      if (windows.size === 1) space.windowId = [...windows][0]
    } catch {
      // Best-effort: an unreadable list leaves the id as it was.
    }
    space.lastActiveAt = this.now()
    this.save()
    this.emit('space.tabs_recycled', space, { urls: tabs.length })
    return {
      recycled: tabs.length,
      tabs,
      ...(failed > 0 ? { failed } : {}),
    }
  }

  /**
   * D8 — legacy-space auto-reap (unified TTL scheme).
   *
   * Tier 1: empty space (tabs.length === 0) idle longer than emptyTtl
   *   (default 24h) → ledger eviction.
   * Tier 2: agent-owned space idle longer than spaceTtl (default 7d), any
   *   tab count → ledger eviction + best-effort tab/group close.
   * user-held spaces (ownership === 'user') are never reaped; records whose
   * lastActiveAt is missing/invalid are conservatively skipped.
   *
   * The synchronous part is authoritative and fast: scan this.state.spaces,
   * evict expired ones (spaces delete + owner current-pointer clear +
   * record removal), and save() — only when something was actually
   * evicted. The browser close for Tier 2 is best-effort and fire-and-forget
   * (any failure is logged, never blocks, never affects the ledger); with no
   * gateway only the ledger is evicted and the tabs remain as ordinary
   * browser tabs.
   */
  async reapExpiredSpaces(
    gateway?: SpaceTabGateway,
  ): Promise<{ evicted: ReapEviction[] }> {
    const gw = gateway ?? this.gateway
    const now = this.now()
    const evicted: ReapEviction[] = []
    const evictedSpaces = new Map<string, SpaceRecord>()
    let changed = false
    for (const space of Object.values(this.state.spaces)) {
      if (space.ownership === 'user') continue
      if (
        typeof space.lastActiveAt !== 'number' ||
        !Number.isFinite(space.lastActiveAt)
      ) {
        // Missing/legacy lastActiveAt — conservative skip, never reap on guess.
        continue
      }
      const ageMs = Math.max(0, now - space.lastActiveAt)
      let tier: 1 | 2 | undefined
      if (space.tabs.length === 0 && ageMs > this.reapEmptyTtlMs) {
        tier = 1
      } else if (space.ownership === 'agent' && ageMs > this.reapSpaceTtlMs) {
        // "不管有没有 tab": an agent space idle past spaceTtl is reaped even
        // when empty — in practice an empty space crosses the much shorter
        // emptyTtl first, but with a custom emptyTtl > spaceTtl this branch
        // still fires (with zero tabs to close).
        tier = 2
      }
      if (tier === undefined) continue
      evicted.push({
        spaceId: space.id,
        name: space.name,
        owner: space.owner,
        tier,
        ageMs,
        tabs: space.tabs.length,
      })
      evictedSpaces.set(space.id, space)
      // Ledger eviction (authoritative, synchronous).
      delete this.state.spaces[space.id]
      if (this.state.currentSpaceByOwner[space.owner] === space.id) {
        delete this.state.currentSpaceByOwner[space.owner]
      }
      changed = true
      console.log(
        `[hub-spaces] reaped space ${space.id} "${space.name}" (tier ${tier}, age ${ageMs}ms, owner ${space.owner}, tabs ${space.tabs.length})`,
      )
    }
    // Only write the disk when this pass actually evicted something.
    if (changed) this.save()
    // Best-effort, non-blocking: close Tier 2 tabs + the tab group. Errors are
    // logged and never touch the ledger eviction above.
    if (gw) {
      for (const ev of evicted) {
        if (ev.tier !== 2) continue
        const space = evictedSpaces.get(ev.spaceId)
        if (!space) continue
        void this.reapCloseTabs(gw, space).catch((err) => {
          console.warn(
            `[hub-spaces] tab close skipped for reaped space ${space.id}: ${(err as Error)?.message ?? String(err)}`,
          )
        })
      }
    }
    return { evicted }
  }

  /** D8 — best-effort close of a reaped space's tabs (never throws). */
  private async reapCloseTabs(
    gw: SpaceTabGateway,
    space: SpaceRecord,
  ): Promise<void> {
    // P7-H2 — the TTL reaper closes the window when it is entirely ours.
    if (await this.closeSpaceWindow(space, gw)) return
    for (const ref of space.tabs) {
      await this.closeTabBestEffort(gw, ref)
    }
  }

  /** Restart recovery: re-open every agent-owned space tab by URL (no targetId persisted). */
  async restore(gateway?: SpaceTabGateway): Promise<number> {
    const gw = gateway ?? this.gateway
    if (!gw) {
      throw new SpaceGuardError(
        'no-gateway',
        'restore requires a browser gateway',
      )
    }
    let live: TabLike[] = []
    let liveOk = false
    try {
      live = await gw.listTabs()
      liveOk = true
    } catch {
      // A broken live list must not block recovery: we fall back to opening
      // every pending tab by URL (legacy behavior).
      live = []
    }
    const used = new Set<number>()
    let reconciled = 0
    // F16 — zombie-renderer gate. A live tab whose renderer hung still lists
    // in the browser but never answers JS; adopting it as restored makes
    // every later command on the space hang to its own timeout. Probe once
    // per tab (cached across refs and strategies); tabs still loading skip
    // the probe (busy ≠ dead); a gateway without probeTab, or an untrusted
    // live list, keeps the legacy adopt-blind behavior.
    const probeCache = new Map<number, boolean>()
    const adoptable = async (tab: TabLike): Promise<boolean> => {
      if (!liveOk || tab.isLoading === true || !gw.probeTab) return true
      if (!probeCache.has(tab.pageId)) {
        try {
          probeCache.set(tab.pageId, await gw.probeTab(tab.pageId))
        } catch {
          probeCache.set(tab.pageId, false)
        }
      }
      return probeCache.get(tab.pageId)!
    }
    const spaces = Object.values(this.state.spaces)
      .filter((s) => s.ownership === 'agent')
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    for (const space of spaces) {
      // P7-H1 — liveness-check the ledger's window ONCE per space (a dead id
      // must not be handed to newTab, and must not survive the round).
      const spaceWindowId =
        space.windowId !== undefined &&
        (await this.windowAlive(gw, space.windowId))
          ? space.windowId
          : undefined
      const next: TabRef[] = []
      // D8 — did this round actually change the space? A refresh of
      // lastActiveAt is allowed only when at least one ref went
      // pending→restored or a stale ref was pruned; an untouched pass must
      // not keep an idle space "fresh" forever or the TTL reaper never fires.
      let touched = false
      for (const ref of space.tabs) {
        // 0. Native tab id — the browser's OWN identity (Chromium SessionID),
        //    immutable for the life of the tab. Checked before targetId
        //    because it is the one anchor that exists for EVERY live tab:
        //    a ref recorded without a targetId (or by a gateway that does not
        //    report one) still reconciles instead of falling through to the
        //    url heuristic. Unique within one browser run only — see 3/4 below.
        const byTabId =
          ref.tabId !== undefined
            ? live.find((t) => t.tabId === ref.tabId && !used.has(t.pageId))
            : undefined
        if (byTabId && (await adoptable(byTabId))) {
          used.add(byTabId.pageId)
          next.push({
            pageId: byTabId.pageId,
            tabId: byTabId.tabId ?? ref.tabId,
            // Same tab (matched by native id), so the ref's own targetId is
            // still this tab's when the live list does not report one.
            targetId: byTabId.targetId ?? ref.targetId,
            url: byTabId.url ?? ref.url,
            title: byTabId.title ?? ref.title,
            restored: true,
            // P7-A — the durable label and origin survive reconciliation.
            ...(ref.label !== undefined ? { label: ref.label } : {}),
            ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
          })
          if (!ref.restored || byTabId.pageId !== ref.pageId) {
            reconciled++
            touched = true
          }
          continue
        }
        // 0b. M3 — the browser says which PERSISTED tab this live tab came
        //     from. This is the only cross-restart evidence that exists; when
        //     the browser does not report it, every live tab simply fails this
        //     check and the URL strategies below run exactly as before.
        const byRestoredFrom =
          ref.tabId !== undefined
            ? live.find(
                (t) =>
                  t.restoredFromTabId === ref.tabId && !used.has(t.pageId),
              )
            : undefined
        if (byRestoredFrom && (await adoptable(byRestoredFrom))) {
          used.add(byRestoredFrom.pageId)
          next.push({
            pageId: byRestoredFrom.pageId,
            // The live tab's CURRENT native id — the old one is dead.
            ...(byRestoredFrom.tabId !== undefined
              ? { tabId: byRestoredFrom.tabId }
              : {}),
            targetId: byRestoredFrom.targetId ?? ref.targetId,
            url: byRestoredFrom.url ?? ref.url,
            title: byRestoredFrom.title ?? ref.title,
            restored: true,
            // P7-A — the durable label and origin survive a restart.
            ...(ref.label !== undefined ? { label: ref.label } : {}),
            ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
          })
          reconciled++
          touched = true
          continue
        }
        // 1a. Stable targetId match — the cross-process anchor. pageId is a
        //     per-connection sequence number and MUST NOT reconcile a ledger
        //     on its own: a new connection renumbers tabs, and binding by the
        //     stale number silently re-attributes whatever tab holds it now
        //     (then overwrites the ledger url with that wrong tab's url —
        //     the QuickBI-ledger-turned-newtab corruption).
        const byTarget = ref.targetId
          ? live.find(
              (t) => t.targetId === ref.targetId && !used.has(t.pageId),
            )
          : undefined
        if (byTarget && (await adoptable(byTarget))) {
          used.add(byTarget.pageId)
          next.push({
            pageId: byTarget.pageId,
            tabId: byTarget.tabId ?? ref.tabId,
            targetId: byTarget.targetId,
            url: byTarget.url ?? ref.url,
            title: byTarget.title ?? ref.title,
            restored: true,
            // P7-A — the durable label and origin survive reconciliation.
            ...(ref.label !== undefined ? { label: ref.label } : {}),
            ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
          })
          if (!ref.restored || byTarget.pageId !== ref.pageId) {
            reconciled++
            touched = true
          }
          continue
        }
        // 1b. Same pageId AND same url → keep (same-connection idempotency;
        //     the url check rejects a renumbered stranger holding the id).
        const liveById = live.find(
          (t) => t.pageId === ref.pageId && !used.has(t.pageId),
        )
        if (
          liveById &&
          liveById.url &&
          ref.url &&
          this.sameRestoreUrl(liveById.url) === this.sameRestoreUrl(ref.url) &&
          (await adoptable(liveById))
        ) {
          used.add(liveById.pageId)
          next.push({
            pageId: ref.pageId,
            tabId: liveById.tabId ?? ref.tabId,
            targetId: liveById.targetId ?? ref.targetId,
            url: liveById.url ?? ref.url,
            title: liveById.title ?? ref.title,
            restored: true,
            // P7-A — the durable label and origin survive reconciliation.
            ...(ref.label !== undefined ? { label: ref.label } : {}),
            ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
          })
          if (!ref.restored) {
            reconciled++
            touched = true
          }
          continue
        }
        // 2. pageId drifted across a browser-session restart → re-attach the
        //    live tab by URL instead of opening a duplicate.
        const byUrl = live.find(
          (t) =>
            !used.has(t.pageId) &&
            t.url &&
            ref.url &&
            this.sameRestoreUrl(t.url) === this.sameRestoreUrl(ref.url),
        )
        if (byUrl && (await adoptable(byUrl))) {
          used.add(byUrl.pageId)
          next.push({
            pageId: byUrl.pageId,
            tabId: byUrl.tabId ?? ref.tabId,
            targetId: byUrl.targetId ?? ref.targetId,
            url: ref.url,
            title: ref.title ?? byUrl.title,
            restored: true,
            // P7-A — the durable label and origin survive reconciliation.
            ...(ref.label !== undefined ? { label: ref.label } : {}),
            ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
          })
          if (!ref.restored) {
            reconciled++
            touched = true
          }
          continue
        }
        // 3. Already restored and gone → deliberately closed after the last
        //    restore; prune the stale ref (only when the live list is
        //    trustworthy — a failed listTabs must not drop ledger entries).
        if (ref.restored) {
          if (!liveOk) {
            next.push(ref)
          } else {
            // Stale ref pruned — the space changed this round.
            touched = true
          }
          continue
        }
        // 4. Pending → re-open by URL (background tab, no targetId persisted).
        //    P7-H1: reopen INTO the space's own window when it still exists —
        //    otherwise a restart would quietly migrate the space to the shared
        //    window. `spaceWindowId` is the liveness-checked value.
        try {
          const targetId = await gw.newTab(ref.url, {
            background: true,
            ...(spaceWindowId !== undefined ? { windowId: spaceWindowId } : {}),
          })
          let pageId: number | undefined
          if (typeof targetId === 'number') pageId = targetId
          else {
            const tabs = await gw.listTabs()
            pageId = tabs.find((t) => t.targetId === targetId)?.pageId
          }
          if (pageId !== undefined) {
            used.add(pageId)
            const reopenedTargetId =
              typeof targetId === 'string' ? targetId : undefined
            const reopened = live.find((t) => t.pageId === pageId)
            next.push({
              pageId,
              // A reopened tab is a NEW tab: it gets a new native id, and the
              // ref's old one must NOT be carried over (that would be a
              // confident misbinding on the next round).
              ...(reopened?.tabId !== undefined ? { tabId: reopened.tabId } : {}),
              targetId: reopenedTargetId ?? ref.targetId,
              url: ref.url,
              title: ref.title,
              restored: true,
              // P7-A — labels and origin survive a restart.
              ...(ref.label !== undefined ? { label: ref.label } : {}),
              ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
              ...(spaceWindowId !== undefined ? { windowId: spaceWindowId } : {}),
            })
            reconciled++
            touched = true
          }
        } catch {
          // Skip unrecoverable tabs.
        }
      }
      // P7-H1 — re-bind the space's window from the tabs we just reconciled.
      // Window ids do not survive a browser restart, so the ledger value is
      // advisory: refresh it from the live tabs, and drop it when the window is
      // gone (the next open_tab recreates it lazily).
      const liveByPage = new Map(live.map((t) => [t.pageId, t]))
      let reboundWindow: number | undefined
      for (const ref of next) {
        const win = liveByPage.get(ref.pageId)?.windowId
        if (win !== undefined) {
          ref.windowId = win
          reboundWindow ??= win
        }
      }
      if (reboundWindow !== undefined) space.windowId = reboundWindow
      else if (spaceWindowId === undefined) delete space.windowId

      space.tabs = next
      // Refs dropped by this pass (stale / unrecoverable) must not leave their
      // telemetry behind for the next tab that inherits the pageId.
      const stillOurs = new Set(
        Object.values(this.state.spaces).flatMap((sp) => sp.tabs.map((t) => t.pageId)),
      )
      for (const pageId of [...this.tabHealth.keys()]) {
        if (!stillOurs.has(pageId)) this.clearTabStats(pageId)
      }
      if (reconciled > 0) this.emitTabsChanged(space)
      // Mark the space restored so the pending list is empty for the next
      // daemon/MCP start (idempotent restarts never duplicate tabs).
      space.restoredAt = this.now()
      // D8 — only refresh lastActiveAt when this space was actually reconciled
      // (pending→restored or a prune) this round. restoredAt stays
      // informational and updates every time (not part of the TTL).
      if (touched) space.lastActiveAt = this.now()
    }
    this.save()
    return reconciled
  }

  /**
   * URL normalization for restore re-attachment. Chrome reports the resolved
   * href (e.g. `https://example.com/`); the ledger stores the requested URL
   * (possibly without the trailing slash) — compare hrefs so a daemon restart
   * recognizes a still-open tab instead of opening a duplicate.
   */
  private sameRestoreUrl(url: string): string {
    try {
      return new URL(url).href
    } catch {
      return url
    }
  }

  /**
   * Find a live tab already attributed to this space whose URL matches the
   * requested url under the given mode. Returns its pageId or undefined.
   * Only tabs still alive in the browser (gateway.listTabs) participate, so
   * externally-closed tabs are never reused.
   */
  private async matchReusableTab(
    space: SpaceRecord,
    url: string,
    mode: Exclude<TabUrlReuseMode, false>,
    gw: SpaceTabGateway,
  ): Promise<number | undefined> {
    let live: TabLike[] = []
    try {
      live = await gw.listTabs()
    } catch {
      // A broken live list must not cause duplicate opens to be *assumed*
      // safe; without liveness info we conservatively open a new tab.
      live = []
    }
    if (live.length === 0) return undefined
    const liveById = new Map(live.map((t) => [t.pageId, t]))
    // bug #21 (same family as #15): pageId is a per-connection sequence — a
    // fresh CLI/MCP process renumbers tabs, so a ledger ref's pageId points at
    // a random live tab (or nothing) and reuse never hits, opening a duplicate
    // tab on every adapter command (observed: one new tab per persistent
    // adapter run). Match targetId first (stable across processes); bare
    // pageId hits require the URL to agree, mirroring restore()'s guard.
    const liveByTarget = new Map(
      live.filter((t) => t.targetId).map((t) => [t.targetId as string, t]),
    )
    for (const ref of space.tabs) {
      let info: TabLike | undefined
      if (ref.targetId) info = liveByTarget.get(ref.targetId)
      if (!info) {
        const byId = liveById.get(ref.pageId)
        // Bare pageId match is only trusted when the URL agrees (same-process
        // idempotent case); a drifted number naming a different page must not
        // cause a false reuse.
        if (byId && byId.url && ref.url && this.sameRestoreUrl(byId.url) === this.sameRestoreUrl(ref.url)) {
          info = byId
        }
      }
      if (!info) continue
      const liveUrl = info.url ?? ref.url
      if (!liveUrl) continue
      if (this.tabUrlMatches(liveUrl, url, mode)) return info.pageId
    }
    return undefined
  }

  /** ego tabMatchesUrl: exact / origin / origin+path / includes. */
  private tabUrlMatches(
    liveUrl: string,
    requested: string,
    mode: Exclude<TabUrlReuseMode, false>,
  ): boolean {
    switch (mode) {
      case 'origin':
        return this.sameOrigin(liveUrl, requested)
      case 'origin+path':
        return this.sameOriginAndPath(liveUrl, requested)
      case 'includes':
        return liveUrl.includes(requested)
      default:
        // exact — reuse the sameRestoreUrl normalization used by restore().
        return this.sameRestoreUrl(liveUrl) === this.sameRestoreUrl(requested)
    }
  }

  private sameOrigin(a: string, b: string): boolean {
    try {
      return new URL(a).origin === new URL(b).origin
    } catch {
      return this.sameRestoreUrl(a) === this.sameRestoreUrl(b)
    }
  }

  private sameOriginAndPath(a: string, b: string): boolean {
    try {
      const ua = new URL(a)
      const ub = new URL(b)
      return ua.origin === ub.origin && ua.pathname === ub.pathname
    } catch {
      return this.sameRestoreUrl(a) === this.sameRestoreUrl(b)
    }
  }

  // ── ownership state machine (3.2) ──

  /** agent → agentDelegatedToUser (agent requests handoff). */
  async handOff(
    owner: string,
    spaceId: string,
  ): Promise<SpaceInfo> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    if (space.ownership === 'user') {
      // ego semantics: handoff on a user-owned space is a no-op skip.
      return this.toInfo(space)
    }
    if (space.ownership === 'agent') {
      // P7-A — capture the user's tab at the boundary BEFORE handing over.
      await this.captureHandoffPage(space)
      space.ownership = 'agentDelegatedToUser'
      space.lastActiveAt = this.now()
      this.save()
      this.emit('space.handoff_requested', space)
    }
    return this.toInfo(space)
  }

  /** agentDelegatedToUser → user (user confirms taking control). */
  async confirmUserControl(owner: string, spaceId: string): Promise<SpaceInfo> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    if (space.ownership === 'agent') {
      throw new SpaceGuardError(
        'not-handed-off',
        `space ${space.id} has not been handed off; call space.handoff first`,
        { spaceId },
      )
    }
    if (space.ownership === 'user') return this.toInfo(space)
    // P7-A — refresh the boundary capture as the user actually takes over.
    await this.captureHandoffPage(space)
    space.ownership = 'user'
    space.lastActiveAt = this.now()
    this.save()
    this.emit('space.interrupted', space)
    return this.toInfo(space)
  }

  /** user/agentDelegatedToUser → agent. Requires explicit confirmation (takeOver 需用户确认). */
  async takeOver(
    owner: string,
    spaceId: string,
    opts?: { confirmed?: boolean },
  ): Promise<SpaceInfo> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    if (space.ownership === 'agent') return this.toInfo(space)
    if (opts?.confirmed !== true) {
      throw new SpaceGuardError(
        'needs-confirmation',
        `takeOver of space ${space.id} requires user confirmation; only call it after the user explicitly confirms (pass confirmed:true / hub space takeover)`,
        { spaceId },
      )
    }
    space.ownership = 'agent'
    space.lastActiveAt = this.now()
    this.save()
    this.emit('space.agent_active', space)
    return this.toInfo(space)
  }

  /** ego claimTaskSpace: claim (user-owned needs confirmation) then select as current. */
  async claimTaskSpace(
    owner: string,
    spaceRef: string,
    opts?: { confirmed?: boolean },
  ): Promise<SpaceInfo> {
    const space =
      this.state.spaces[spaceRef] ??
      this.spacesOwnedBy(owner).find((s) => s.name === spaceRef)
    if (!space) {
      throw new SpaceGuardError(
        'space-not-found',
        `space not found: ${spaceRef}`,
        { spaceId: spaceRef },
      )
    }
    this.requireOwned(owner, space)
    if (space.ownership !== 'agent' && opts?.confirmed !== true) {
      throw new SpaceGuardError(
        'needs-confirmation',
        `claiming space ${space.id} requires user confirmation; only call it after the user explicitly confirms`,
        { spaceId: space.id },
      )
    }
    if (space.ownership !== 'agent') {
      space.ownership = 'agent'
      space.lastActiveAt = this.now()
      this.save()
      this.emit('space.agent_active', space)
    }
    this.state.currentSpaceByOwner[owner] = space.id
    this.save()
    return this.toInfo(space)
  }

  // ── agent-level tab isolation guard (3.3) ──

  /**
   * D3 (2026-08-03): space is a hard precondition for operating tabs.
   * `isolationActive` is true once the agent owns ≥1 space; an agent with no
   * space is NOT granted a legacy open world — every page operation rejects
   * with `no-space` and `tabs list` shows an empty list.
   */
  private isolationActive(owner: string): boolean {
    return this.spacesOwnedBy(owner).length > 0
  }

  /** D3 — the agent owns no space: every tab operation is rejected until space.create. */
  private noSpaceError(owner: string): SpaceGuardError {
    return new SpaceGuardError(
      'no-space',
      `agent ${owner} has no space; create one first with space.create (or 'hub space create <name>')`,
      { hint: 'create a task space first, then operate on its tabs' },
    )
  }

  /** Reject a single page that is not in (or not agent-operable within) the agent's space. */
  async assertPageControllable(owner: string, pageId: number): Promise<void> {
    return this.assertPageControllableWith(owner, pageId)
  }

  /**
   * The body of the check, with the live list injectable so a batch pays for
   * ONE browser round trip instead of one per page.
   */
  private async assertPageControllableWith(
    owner: string,
    pageId: number,
    live?: TabLike[],
  ): Promise<void> {
    if (!this.isolationActive(owner)) throw this.noSpaceError(owner)
    const space = this.spaceForPage(pageId)
    if (!space || space.owner !== owner) {
      throw new SpaceGuardError(
        'page-not-in-space',
        `page ${pageId} is not in your space. List your tabs with tabs action="list" or open one with space.open_tab`,
        { pageId },
      )
    }
    // M2 follow-up: the ledger entry alone is not proof — pageId is a
    // per-connection number, so corroborate it against the live browser before
    // granting control. A browser we cannot read leaves the legacy ledger-only
    // decision in place (never lock the agent out on absence of information).
    const ref = this.refForPage(pageId)
    if (ref) {
      const liveTab = live
        ? live.find((t) => t.pageId === pageId)
        : await this.liveTabForPage(pageId)
      if (liveTab && this.refDescribesLiveTab(ref, liveTab) === false) {
        throw new SpaceGuardError(
          'page-not-in-space',
          `page ${pageId} is not the tab your space recorded (the id was renumbered onto another tab); list your tabs again`,
          {
            pageId,
            hint: 'page ids are per-connection — re-read them with tabs action="list"',
          },
        )
      }
    }
    this.assertAgentCanAct(owner, space)
  }

  async assertPagesControllable(
    owner: string,
    pageIds: number[],
  ): Promise<void> {
    if (pageIds.length === 0) return
    if (!this.isolationActive(owner)) throw this.noSpaceError(owner)
    // One live read for the whole batch; a browser we cannot read degrades to
    // the ledger-only decision exactly like the single-page path.
    let live: TabLike[] | undefined
    if (pageIds.length > 1 && this.gateway) {
      try {
        live = await this.gateway.listTabs()
      } catch {
        live = undefined
      }
    }
    for (const pageId of pageIds) {
      await this.assertPageControllableWith(owner, pageId, live)
    }
  }

  /**
   * tabs new guard: D3 — rejected with `no-space` while the agent owns no
   * space (space must be the precondition for opening tabs too); rejected
   * with `user-controlling` while the agent's current space is user-held.
   */
  async assertCurrentSpaceAgentControllable(owner: string): Promise<void> {
    if (!this.isolationActive(owner)) throw this.noSpaceError(owner)
    const currentId = this.state.currentSpaceByOwner[owner]
    if (!currentId) return
    const space = this.state.spaces[currentId]
    if (!space || space.owner !== owner) return
    if (space.ownership !== 'agent') throw this.userControlling(space)
  }

  /**
   * Filter a live tabs list down to what the agent may see. D3 — an agent
   * with no space sees an EMPTY list (no legacy open-world listing).
   */
  async filterTabsForAgent(owner: string, tabs: TabLike[]): Promise<TabLike[]> {
    if (!this.isolationActive(owner)) return []
    const ownedIds = new Set(this.spacesOwnedBy(owner).map((s) => s.id))
    return tabs.filter((tab) => {
      const space = this.spaceForPage(tab.pageId)
      if (space === undefined || !ownedIds.has(space.id)) return false
      // M2 follow-up: same corroboration, free here — the live tab is in hand.
      const ref = space.tabs.find((t) => t.pageId === tab.pageId)
      return !ref || this.refDescribesLiveTab(ref, tab) !== false
    })
  }

  /**
   * P1-5 — tri-bucket ownership classification of live tabs for one agent:
   *   mine         — a tab in one of the caller's agent-controlled spaces
   *   user         — a tab in a user-held space (handed off), or a tab that
   *                  belongs to no space at all (opened by the human)
   *   other-agent  — a tab in another owner's space
   *
   * Visibility without leakage (D3 in mind): non-mine tabs keep only their
   * identity (pageId + ownership + ownerLabel = the owning space's name) —
   * url/title are stripped so the caller learns WHO holds a tab, not WHAT
   * is in it. Mirrors BrowserOS tab_ownership.rs's annotate-style view.
   */
  async classifyTabsForAgent(
    owner: string,
    tabs: TabLike[],
  ): Promise<Array<TabLike & { ownership: TabOwnership; ownerLabel?: string }>> {
    if (!this.isolationActive(owner)) return []
    return tabs.map((tab) => {
      const space = this.spaceForPage(tab.pageId)
      // M2 follow-up: a stale pageId must not be reported as the caller's own
      // tab — that both grants control AND defeats the P1-5 redaction below
      // (a mismatched ref made a stranger's tab come back as `mine` WITH its
      // url/title). A positive mismatch falls through to the 'user' bucket:
      // identity only.
      const ref = space?.tabs.find((t) => t.pageId === tab.pageId)
      if (space && ref && this.refDescribesLiveTab(ref, tab) === false) {
        return { pageId: tab.pageId, ownership: 'user' as const }
      }
      if (!space) {
        return { pageId: tab.pageId, ownership: 'user' as const }
      }
      if (space.owner === owner) {
        return space.ownership === 'agent'
          ? { ...tab, ownership: 'mine' as const }
          : { pageId: tab.pageId, ownership: 'user' as const }
      }
      return {
        pageId: tab.pageId,
        ownership: 'other-agent' as const,
        ownerLabel: space.name,
      }
    })
  }

  /** Attribute a freshly opened tab to the agent's current space (best-effort). */
  async recordTabForCurrentSpace(
    owner: string,
    pageId: number,
    url?: string,
    targetId?: string,
    tabId?: number,
  ): Promise<boolean> {
    const currentId = this.state.currentSpaceByOwner[owner]
    if (!currentId) return false
    const space = this.state.spaces[currentId]
    if (!space || space.owner !== owner) return false
    // P1-6 invariant: a page belongs to at most one space — refuse to claim
    // a tab that already belongs to another space (normal callers only
    // record freshly opened tabs, which are unowned).
    const holder = this.spaceForPage(pageId)
    if (holder && holder.id !== space.id) return false
    this.assertAgentCanAct(owner, space)
    if (space.tabs.some((t) => t.pageId === pageId)) return true
    space.tabs.push({
      pageId,
      ...(tabId !== undefined ? { tabId } : {}),
      targetId,
      url: url ?? 'about:blank',
      restored: false,
      label: this.nextLabel(space),
      openedBy: 'agent',
    })
    space.lastActiveAt = this.now()
    this.save()
    this.emitTabsChanged(space)
    return true
  }

  /**
   * P7-A — adopt an unowned tab into a space (ego `adopt`).
   *
   * The tab must be LIVE and belong to no space yet (P1-6: at most one owner).
   * Origin is stamped `unknown`: adopting brings a tab under management, it does
   * not make the tab ours — ego keeps `openedBy` immutable for exactly this
   * reason, and the finish/release rules treat `unknown` as user-owned.
   */
  async adoptTab(
    owner: string,
    pageId: number,
    opts?: { spaceId?: string; as?: string },
  ): Promise<SpaceTabInfo> {
    const spaceId = opts?.spaceId ?? this.state.currentSpaceByOwner[owner]
    if (!spaceId) {
      throw new SpaceGuardError(
        'no-space',
        `agent ${owner} has no space; create one first (space.create / 'hub space create <name>')`,
        { hint: 'adopt brings a tab into a space, so there must be one' },
      )
    }
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    this.assertAgentCanAct(owner, space)
    const holder = this.spaceForPage(pageId)
    if (holder) {
      if (holder.id !== space.id) {
        throw new SpaceGuardError(
          'page-not-in-space',
          `page ${pageId} already belongs to space ${holder.id}`,
          { pageId, spaceId: holder.id, hint: 'a page belongs to at most one space' },
        )
      }
      const already = (await this.listTabs(space.id)).find(
        (t) => t.pageId === pageId,
      )
      if (already) return already // idempotent
    }
    const gw = this.gateway
    if (!gw) {
      throw new SpaceGuardError(
        'no-gateway',
        'adopt needs a browser gateway to verify the tab is live',
        { spaceId },
      )
    }
    let live: TabLike[] = []
    try {
      live = await gw.listTabs()
    } catch {
      live = []
    }
    const tab = live.find((t) => t.pageId === pageId)
    if (!tab) {
      throw new SpaceGuardError(
        'tab-resolve-failed',
        `page ${pageId} is not a live tab in this browser`,
        { pageId, spaceId, hint: 'list tabs first (tabs view=all) and adopt one of those ids' },
      )
    }
    const label = opts?.as ?? this.nextLabel(space)
    if (space.tabs.some((t) => t.label === label)) {
      throw new SpaceGuardError(
        'label-taken',
        `label ${label} is already used in space ${space.id}`,
        { spaceId, pageId, hint: 'pick another label, or omit `as` to take the next free one' },
      )
    }
    space.tabs.push({
      pageId,
      ...(tab.tabId !== undefined ? { tabId: tab.tabId } : {}),
      targetId: tab.targetId,
      url: tab.url ?? 'about:blank',
      title: tab.title,
      restored: true,
      label,
      openedBy: 'unknown',
      ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
    })
    space.lastActiveAt = this.now()
    this.save()
    this.emitTabsChanged(space)
    const info = (await this.listTabs(space.id)).find((t) => t.pageId === pageId)
    if (!info) {
      throw new SpaceGuardError('tab-resolve-failed', `adopted page ${pageId} vanished`, { pageId, spaceId })
    }
    return info
  }

  /**
   * P7-A — hand a tab back to the user WITHOUT closing it (ego `release`).
   *
   * Only unknown-origin tabs may be released. An agent-created tab is ours to
   * close, and ego refuses the call outright ("page p2 was created by the agent;
   * close it instead of releasing it") — that refusal is what stops an agent
   * from quietly dumping its own mess on the user.
   */
  async releaseTab(
    owner: string,
    spaceId: string,
    target: { pageId?: number; label?: string },
  ): Promise<SpaceTabInfo> {
    const space = this.requireSpace(spaceId)
    this.requireOwned(owner, space)
    this.assertAgentCanAct(owner, space)
    const ref =
      target.label !== undefined
        ? space.tabs.find((t) => t.label === target.label)
        : space.tabs.find((t) => t.pageId === target.pageId)
    if (!ref) {
      throw new SpaceGuardError(
        'page-not-in-space',
        `no tab ${target.label ?? target.pageId} in space ${space.id}`,
        { spaceId, ...(target.pageId !== undefined ? { pageId: target.pageId } : {}) },
      )
    }
    if (ref.openedBy === 'agent') {
      throw new SpaceGuardError(
        'tab-agent-owned',
        `page ${ref.pageId}${ref.label ? ` (${ref.label})` : ''} was created by the agent; close it instead of releasing it`,
        { spaceId, pageId: ref.pageId, hint: 'use space.close_tab for tabs the agent opened' },
      )
    }
    space.tabs = space.tabs.filter((t) => t.pageId !== ref.pageId)
    space.lastActiveAt = this.now()
    this.save()
    this.emitTabsChanged(space)
    this.clearTabStats(ref.pageId)
    return {
      pageId: ref.pageId,
      ...(ref.label !== undefined ? { label: ref.label } : {}),
      ...(ref.openedBy !== undefined ? { openedBy: ref.openedBy } : {}),
      url: ref.url,
      title: ref.title,
    }
  }

  /**
   * P1-7 方向 B — explicit tab ownership transfer. This is the ONLY path that
   * moves a page between spaces' ledgers (D-P9 removed the tab-group
   * projection, so nothing implicit moves ownership any more). The owner must
   * own BOTH spaces involved (a cross-owner transfer would be tab theft —
   * escalate instead of automating it). Claiming an UNOWNED tab (e.g. a human
   * tab the user hands over) is allowed: to-space only.
   */
  async transferTab(
    owner: string,
    opts: { pageId: number; toSpaceId?: string },
  ): Promise<{
    fromSpaceId: string | null
    toSpaceId: string
    /** P7-H2 outcome of the physical cross-window move. Absent = not attempted
     *  (same window, no moveTab on the gateway, or a pure claim). */
    moved?: boolean
    /** Why the physical move failed, when it did. */
    moveError?: string
  }> {
    const toId =
      opts.toSpaceId ?? this.state.currentSpaceByOwner[owner]
    if (!toId) {
      throw new SpaceGuardError(
        'no-space',
        `agent ${owner} has no space; create one first with space.create (or 'hub space create <name>')`,
        { hint: 'create a task space first, then transfer tabs into it' },
      )
    }
    const to = this.requireSpace(toId)
    this.requireOwned(owner, to)
    this.assertAgentCanAct(owner, to)

    // M2 on the WRITE path — resolve the caller's pageId to the LIVE tab
    // before touching the ledger.
    //
    // `pageId` is a per-connection counter and it drifts (a fresh CDP session
    // renumbers live tabs), so the ledger's own copy of it goes stale while the
    // tab is still open. Matching the ref by pageId then misses it entirely:
    // the call looks like "claim an unowned tab", the source space is never
    // emptied, and the ledger gains a second entry for a tab it already owns.
    // The live tab's NATIVE anchors are what identify the ref.
    const gw = this.gateway
    let live: TabLike[] = []
    if (gw) {
      try {
        live = await gw.listTabs()
      } catch {
        live = []
      }
    }
    const liveTab = live.find((t) => t.pageId === opts.pageId)
    const matchesLive = (t: TabRef): boolean =>
      liveTab !== undefined &&
      ((liveTab.tabId !== undefined && t.tabId === liveTab.tabId) ||
        (liveTab.targetId !== undefined && t.targetId === liveTab.targetId))

    if (to.tabs.some((t) => t.pageId === opts.pageId || matchesLive(t))) {
      // Already there — idempotent no-op.
      return { fromSpaceId: null, toSpaceId: to.id }
    }
    // Prefer the identity match; fall back to the raw pageId so a ref whose tab
    // is already closed can still be moved between spaces (pure bookkeeping).
    let from: SpaceRecord | undefined
    let existing: TabRef | undefined
    if (liveTab) {
      for (const candidate of Object.values(this.state.spaces)) {
        const ref = candidate.tabs.find(matchesLive)
        if (ref) {
          from = candidate
          existing = ref
          break
        }
      }
    }
    if (!from) {
      from = this.spaceForPage(opts.pageId)
      existing = from?.tabs.find((t) => t.pageId === opts.pageId)
    }
    // The pageId the ledger should carry from here on: the live one when we
    // have it, so a renumber self-heals instead of leaving a stale number.
    const effectivePageId = liveTab?.pageId ?? opts.pageId
    if (from) {
      this.requireOwned(owner, from)
      this.assertAgentCanAct(owner, from)
      from.tabs = from.tabs.filter((t) => t !== existing)
      from.lastActiveAt = this.now()
    }
    // Claim with the stable identity when the gateway knows this tab: the
    // live targetId anchors future reconciles, and the live url beats the
    // about:blank fallback (a pageId-only entry gets pruned by listTabs'
    // cross-process guard when the ids drift).
    let claimedTargetId = existing?.targetId
    let claimedTabId = existing?.tabId
    let claimedUrl = existing?.url
    let claimedWindowId = existing?.windowId
    const sawLive = liveTab !== undefined
    if (liveTab) {
      claimedTargetId = claimedTargetId ?? liveTab.targetId
      claimedTabId = claimedTabId ?? liveTab.tabId
      if (liveTab.url && (!claimedUrl || claimedUrl === 'about:blank')) {
        claimedUrl = liveTab.url
      }
      claimedWindowId = liveTab.windowId ?? claimedWindowId
    }
    // A pageId that is in no space AND not live is NOT a tab to claim — it is
    // a stale number. Fabricating a ref for it produced a phantom ledger entry
    // (about:blank, no anchors) whose pageId could later be renumbered onto a
    // STRANGER's tab, which the guards would then treat as ours. Refuse
    // instead: pageIds are per-connection, so a caller must re-read them.
    if (!from && !existing && !sawLive) {
      throw new SpaceGuardError(
        'tab-resolve-failed',
        `page ${opts.pageId} is not a live tab and is in no space; refusing to claim a stale page id`,
        {
          pageId: opts.pageId,
          spaceId: to.id,
          hint: 'page ids are per-connection — re-read them with tabs action="list"',
        },
      )
    }
    to.tabs.push({
      pageId: effectivePageId,
      ...(claimedTabId !== undefined ? { tabId: claimedTabId } : {}),
      targetId: claimedTargetId,
      url: claimedUrl ?? 'about:blank',
      title: existing?.title,
      restored: true, // the browser tab is live by construction (drag/claim)
      // M2 — where the tab ACTUALLY is right now. The cross-window move below
      // may overwrite it; when the move fails this is the truth, and leaving
      // it unset left the ref with no window at all.
      ...(claimedWindowId !== undefined ? { windowId: claimedWindowId } : {}),
      // P7-A — keep the label when the target space does not use it yet,
      // otherwise mint a fresh one (labels are per space).
      label:
        existing?.label !== undefined &&
        !to.tabs.some((t) => t.label === existing.label)
          ? existing.label
          : this.nextLabel(to),
      // Origin is immutable: a tab that was not provably ours stays 'unknown'.
      openedBy: existing?.openedBy ?? 'unknown',
    })
    to.lastActiveAt = this.now()
    this.save()
    // Both ends of a transfer changed their tab set.
    this.emitTabsChanged(to)
    if (from) this.emitTabsChanged(from)
    // P7-H2 — the physical tab follows the ownership transfer: a space's window
    // is its boundary (P7-H1), so a tab left behind would sit in a window that
    // no longer owns it. Best-effort — a gateway without moveTab keeps the old
    // behaviour, and the ledger is authoritative either way.
    let moved: boolean | undefined
    let moveError: string | undefined
    if (
      gw?.moveTab &&
      to.windowId !== undefined &&
      from !== undefined &&
      from.windowId !== to.windowId
    ) {
      try {
        await gw.moveTab(effectivePageId, to.windowId)
        const movedRef = to.tabs.find((t) => t.pageId === effectivePageId)
        if (movedRef) movedRef.windowId = to.windowId
        this.save()
        moved = true
      } catch (err) {
        // Ownership already moved in the ledger, but the browser did not
        // follow. That is a REAL outcome the caller must be able to see (the
        // tab now sits in a window that no longer owns it) — so report it
        // instead of swallowing it, and keep the ref pointing at the window
        // the tab is actually in.
        moved = false
        moveError = (err as Error)?.message ?? String(err)
        console.warn(
          `[hub-spaces] transferTab: physical move failed for page ${opts.pageId}: ${moveError}`,
        )
      }
    }
    return {
      fromSpaceId: from?.id ?? null,
      toSpaceId: to.id,
      ...(moved !== undefined ? { moved } : {}),
      ...(moveError !== undefined ? { moveError } : {}),
    }
  }

  /**
   * bug #7 — sync a space tab's ledger URL after in-browser navigation.
   *
   * Adapter commands navigate the space tab through the page handle, behind
   * the manager's back; this is how the ledger learns the tab's real URL.
   * Idempotent and strictly best-effort: updates the matching tab's `url`
   * (+ the space's `lastActiveAt`) and saves; a missing space, foreign
   * owner, or non-matching pageId is a no-op that returns false. Never
   * creates tabs and never throws — callers (adapter command completion)
   * treat it as fire-and-forget.
   */
  async updateTabUrl(
    owner: string,
    spaceId: string,
    pageId: number,
    url: string,
  ): Promise<boolean> {
    const space = this.state.spaces[spaceId]
    if (!space || space.owner !== owner) return false
    const tab = space.tabs.find((t) => t.pageId === pageId)
    if (!tab) return false
    tab.url = url
    space.lastActiveAt = this.now()
    this.save()
    return true
  }

  /** The space a page belongs to (if any). */
  async spaceIdForPage(pageId: number): Promise<string | undefined> {
    return this.spaceForPage(pageId)?.id
  }
}
