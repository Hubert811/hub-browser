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

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SpaceOwnership = 'agent' | 'agentDelegatedToUser' | 'user'

export interface SpaceIdentity {
  /** Stable per-conversation / per-agent identifier. */
  agentId: string
  /** Human-readable name (e.g. MCP client name). */
  displayName?: string
}

/** Live browser tab shape (superset of what browser-core pages.list returns). */
export interface TabLike {
  pageId: number
  targetId?: string
  tabId?: number
  url?: string
  title?: string
  isActive?: boolean
}

/** One tab attributed to a space (ledger). */
export interface TabRef {
  pageId: number
  url: string
  title?: string
  /**
   * True once a restore() pass has reconciled this tab with the live browser.
   * Freshly opened tabs are pending (restored === undefined/false) so the next
   * daemon/MCP start re-attaches or re-opens them exactly once (Phase 3 A).
   */
  restored?: boolean
}

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
  tabs: TabRef[]
  /**
   * D5 (2026-08-03): the browser tab group this space is projected onto
   * (title = space name, color = deterministicColor(id)). Absent until the
   * first tab is wired into a group. Persisted with the ledger so a restarted
   * daemon/MCP reuses the same group instead of creating a duplicate.
   */
  tabGroupId?: string
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
  /**
   * D5 (2026-08-03): the browser tab group this space is projected onto
   * (same value as SpaceRecord.tabGroupId). Absent until the first tab is
   * wired into a group. Exposed so CLI/MCP consumers (`space current --json`
   * etc.) can surface it without reading the raw ledger.
   */
  tabGroupId?: string
}

export interface SpaceTabInfo {
  pageId: number
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

/** URL-reuse matching modes (ego openOrReuseTab semantics). */
export type TabUrlReuseMode =
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

/** Minimal browser surface TaskSpaceManager needs to open/close/list tabs. */
export interface SpaceTabGateway {
  newTab(
    url: string,
    opts?: { background?: boolean; windowId?: number; tabGroupId?: string },
  ): Promise<string | number | undefined>
  closeTab(target: number | string): Promise<void>
  listTabs(): Promise<TabLike[]>
  /**
   * Best-effort activation: make the given tab the agent's active tab
   * (e.g. UnifiedPage.selectTab). Optional — callers must tolerate absence.
   */
  activate?(target: number | string): Promise<void>

  // ── D5 (2026-08-03): space ↔ tab group 双向同步 — tab-group capability family ──
  //
  // Every method is OPTIONAL: a browser/provider without tab-group support
  // simply lacks the method, and callers must tolerate absence (best-effort,
  // silent degradation — tab attribution never depends on group success).
  // `tabGroupList` returns the raw Browser.getTabGroups group objects
  // ({ groupId, title, color, collapsed, tabIds: tabId[], windowId });
  // `tabGroupCreate` returns the created group or undefined.
  tabGroupList?(): Promise<unknown[]>
  tabGroupCreate?(
    pages: number[],
    title?: string,
  ): Promise<
    | { groupId?: string; tabIds?: number[]; title?: string; color?: string }
    | undefined
  >
  tabGroupAddTabs?(groupId: string, pages: number[]): Promise<void>
  tabGroupUpdate?(
    groupId: string,
    opts: { title?: string; color?: string; collapsed?: boolean },
  ): Promise<unknown>
  tabGroupClose?(groupId: string): Promise<void>
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

  on(type: SpaceEventType, listener: SpaceEventListener): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => this.off(type, listener)
  }

  off(type: SpaceEventType, listener: SpaceEventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(event: SpaceEvent): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
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
  version: 1
  spaces: Record<string, SpaceRecord>
  currentSpaceByOwner: Record<string, string>
  /**
   * Cross-process close tombstones (Phase 3.3 dual-identity robustness).
   *
   * Space ids closed by any process. They are persisted so that a
   * merge-on-save in another process never resurrects a space that was
   * deliberately closed, even when that other process still holds a stale
   * in-memory copy. Entries are low-volume UUIDs; not pruned because a
   * process we cannot see may still hold the id in memory.
   */
  deletedSpaces?: string[]
}

export const SPACE_STORAGE_VERSION = 1

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
  try {
    if (fs.existsSync(targetPath)) return false
    if (!fs.existsSync(legacyPath)) return false
    const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as Partial<PersistedState>
    if (!raw || typeof raw !== 'object') return false
    const deleted = new Set(raw.deletedSpaces ?? [])
    const spaces = Object.fromEntries(
      Object.entries(raw.spaces ?? {}).filter(([id]) => !deleted.has(id)),
    )
    const merged: PersistedState = {
      version: SPACE_STORAGE_VERSION,
      spaces,
      currentSpaceByOwner: raw.currentSpaceByOwner ?? {},
      deletedSpaces: raw.deletedSpaces ?? [],
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const tmp = `${targetPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8')
    fs.renameSync(tmp, targetPath)
    return true
  } catch {
    return false
  }
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic tab-group color (3.4)
// ─────────────────────────────────────────────────────────────────────────────

export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const

/**
 * D5 — hard bound on one lazy tab-group reconcile pass. An unreachable browser
 * can make the provider gateway's connect() take CDP_CONNECT (10s); the sync
 * is best-effort and must never block space reads / the page guard / open.
 */
export const TAB_GROUP_SYNC_TIMEOUT_MS = 1000

export function deterministicColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return TAB_GROUP_COLORS[Math.abs(hash) % TAB_GROUP_COLORS.length]
}

/** Raw tab-group shape returned by Browser.getTabGroups (subset we read). */
interface LiveTabGroup {
  groupId?: string
  title?: string
  color?: string
  collapsed?: boolean
  tabIds?: Array<string | number>
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateways (UnifiedPage / provider adapters)
// ─────────────────────────────────────────────────────────────────────────────

type PageLike = {
  newTab?(
    url?: string,
    opts?: { background?: boolean; windowId?: number; tabGroupId?: string },
  ): Promise<string | number | undefined>
  closeTab?(target: number | string): Promise<void>
  tabs?(): Promise<unknown[]>
  selectTab?(target: number | string): Promise<void>
  // D5 — optional tab-group surface (UnifiedPage). Pages that cannot group
  // tabs omit these; the gateway then omits the corresponding methods.
  tabGroupList?(): Promise<unknown[]>
  tabGroupCreate?(pages: number[], title?: string): Promise<unknown>
  addTabsToGroup?(pages: number[], groupId: string): Promise<void>
  tabGroupUpdate?(
    groupId: string,
    opts: { title?: string; color?: string; collapsed?: boolean },
  ): Promise<unknown>
  tabGroupClose?(groupId: string): Promise<void>
}

/** D5 — expose exactly the tab-group methods a page supports (absent → omitted). */
function pageTabGroupMethods(page: PageLike): Partial<SpaceTabGateway> {
  const methods: Partial<SpaceTabGateway> = {}
  if (page.tabGroupList) {
    methods.tabGroupList = () => page.tabGroupList!()
  }
  if (page.tabGroupCreate) {
    methods.tabGroupCreate = (pages, title) =>
      page.tabGroupCreate!(pages, title) as Promise<
        | { groupId?: string; tabIds?: number[]; title?: string; color?: string }
        | undefined
      >
  }
  if (page.addTabsToGroup) {
    methods.tabGroupAddTabs = async (groupId, pages) => {
      await page.addTabsToGroup!(pages, groupId)
    }
  }
  if (page.tabGroupUpdate) {
    methods.tabGroupUpdate = (groupId, opts) => page.tabGroupUpdate!(groupId, opts)
  }
  if (page.tabGroupClose) {
    methods.tabGroupClose = (groupId) => page.tabGroupClose!(groupId)
  }
  return methods
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
    ...(page.selectTab
      ? {
          activate: async (target: number | string) => {
            await page.selectTab!(target)
          },
        }
      : {}),
    // D5 — pass through the tab-group family the page supports (best-effort).
    ...pageTabGroupMethods(page),
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
    activate: async (target) => {
      const page = await provider.connect()
      if (page.selectTab) await page.selectTab(target)
    },
    // D5 — tab-group family, connect-lazy like the rest of the provider
    // gateway. Every call is best-effort: a page/provider without the
    // capability no-ops (empty list / undefined / no-op) instead of throwing,
    // so tab attribution never depends on group support.
    tabGroupList: async () => {
      try {
        const page = await provider.connect()
        return (await page.tabGroupList?.()) ?? []
      } catch {
        return []
      }
    },
    tabGroupCreate: async (pages, title) => {
      try {
        const page = await provider.connect()
        return (await page.tabGroupCreate?.(pages, title)) as
          | { groupId?: string; tabIds?: number[]; title?: string; color?: string }
          | undefined
      } catch {
        return undefined
      }
    },
    tabGroupAddTabs: async (groupId, pages) => {
      try {
        const page = await provider.connect()
        await page.addTabsToGroup?.(pages, groupId)
      } catch {
        // Best-effort — a failed group write never breaks tab attribution.
      }
    },
    tabGroupUpdate: async (groupId, opts) => {
      try {
        const page = await provider.connect()
        return await page.tabGroupUpdate?.(groupId, opts)
      } catch {
        return undefined
      }
    },
    tabGroupClose: async (groupId) => {
      try {
        const page = await provider.connect()
        await page.tabGroupClose?.(groupId)
      } catch {
        // Best-effort — a failed group close never breaks space close.
      }
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
  deletedSpaces: [],
})

export class TaskSpaceManager {
  readonly events: SpaceEventBus | null
  private state: PersistedState
  private readonly storagePath: string | undefined
  private readonly gateway: SpaceTabGateway | undefined
  private readonly persist: boolean
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

  constructor(options: TaskSpaceManagerOptions = {}) {
    this.storagePath = options.storagePath ?? defaultStoragePath()
    // One-time legacy migration: only when this manager is using the default
    // ledger location (no HUB_SPACES_FILE / explicit temp override), so tests
    // with temp ledgers and opt-out deployments are never touched. Idempotent —
    // migrateLegacyLedger no-ops once the new path exists.
    if (!options.storagePath || options.storagePath === defaultStoragePath()) {
      migrateLegacyLedger(this.storagePath)
    }
    this.gateway = options.gateway
    this.persist = options.persist ?? true
    this.events = options.events === undefined ? new SpaceEventBus() : options.events
    this.state = this.load()
  }

  // ── storage ──

  /** Parse the ledger file without applying tombstones ({} when missing/corrupt). */
  private readRaw(): Partial<PersistedState> {
    if (!this.storagePath) return {}
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      if (!parsed || typeof parsed !== 'object' || !parsed.spaces) return {}
      return parsed
    } catch {
      return {}
    }
  }

  private load(): PersistedState {
    const raw = this.readRaw()
    const deleted = new Set(raw.deletedSpaces ?? [])
    const spaces = Object.fromEntries(
      Object.entries(raw.spaces ?? {}).filter(([id]) => !deleted.has(id)),
    )
    return {
      version: SPACE_STORAGE_VERSION,
      spaces,
      currentSpaceByOwner: raw.currentSpaceByOwner ?? {},
      // Tombstones persist (never pruned): another process may still hold the
      // id in memory, and its merge-on-save must not resurrect the space.
      deletedSpaces: raw.deletedSpaces ?? [],
    }
  }

  /** Re-read the ledger from disk (跨进程/外部变更时使用). */
  reload(): void {
    const fresh = this.load()
    fresh.deletedSpaces = [
      ...new Set([
        ...(this.state.deletedSpaces ?? []),
        ...(fresh.deletedSpaces ?? []),
      ]),
    ]
    this.state = fresh
  }

  /**
   * Merge-on-save (Phase 3.3 dual-identity robustness): instead of clobbering
   * the shared file with this process's view, keep spaces/current-mappings the
   * process has never seen (other agents' spaces written by other MCP/daemon
   * processes) and apply close tombstones from memory AND disk. In-memory
   * state stays authoritative for ids this process knows.
   */
  private mergeWithDisk(): PersistedState {
    const disk = this.readRaw()
    const deleted = new Set([
      ...(this.state.deletedSpaces ?? []),
      ...(disk.deletedSpaces ?? []),
    ])
    const spaces: Record<string, SpaceRecord> = {
      ...(disk.spaces ?? {}),
      ...this.state.spaces,
    }
    for (const id of deleted) delete spaces[id]
    // bug #10: closeSpace deletes the owner's current-space pointer from
    // memory, but disk may still hold the stale id — a naive merge would
    // resurrect it (pointing at a space that no longer exists). Filter the
    // merged map so every pointer targets a live, non-deleted space.
    const currentSpaceByOwner = Object.fromEntries(
      Object.entries({
        ...(disk.currentSpaceByOwner ?? {}),
        ...this.state.currentSpaceByOwner,
      }).filter(([, id]) => !deleted.has(id) && spaces[id]),
    )
    return {
      version: SPACE_STORAGE_VERSION,
      spaces,
      currentSpaceByOwner,
      deletedSpaces: [
        ...new Set([
          ...(this.state.deletedSpaces ?? []),
          ...(disk.deletedSpaces ?? []),
        ]),
      ],
    }
  }

  private save(): void {
    if (!this.persist || !this.storagePath) return
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
      const tmp = `${this.storagePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.mergeWithDisk(), null, 2), 'utf-8')
      fs.renameSync(tmp, this.storagePath)
    } catch {
      // Ledger persistence is best-effort; in-memory state stays authoritative
      // for this process.
    }
  }

  dispose(): void {
    this.save()
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
      tabGroupId: space.tabGroupId,
    }
  }

  private spaceForPage(pageId: number): SpaceRecord | undefined {
    for (const space of Object.values(this.state.spaces)) {
      if (space.tabs.some((t) => t.pageId === pageId)) return space
    }
    return undefined
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
    // D5 — lazy reconcile before answering (human tab-group edits → ledger),
    // scoped to this owner's spaces. No gateway → no-op.
    await this.reconcileTabGroups(this.gateway, owner)
    return this.spacesOwnedBy(owner)
      .map((s) => this.toInfo(s))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }

  async currentSpace(owner: string): Promise<SpaceInfo | undefined> {
    // D5 — lazy reconcile before answering (human tab-group edits → ledger).
    await this.reconcileTabGroups(this.gateway, owner)
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
    opts?: { background?: boolean; windowId?: number; tabGroupId?: string },
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
  async openTabWithReuse(
    owner: string,
    spaceId: string,
    url: string,
    opts?: {
      background?: boolean
      windowId?: number
      tabGroupId?: string
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
    // D5 — lazy reconcile before opening, so human tab-group edits (拖入/拖出)
    // are reflected in the ledger before URL-reuse matching runs.
    await this.reconcileTabGroups(gw, owner)
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
        return { pageId: matched, reused: true }
      }
    }
    const targetId = await gw.newTab(url, {
      background: opts?.background ?? true,
      windowId: opts?.windowId,
      tabGroupId: opts?.tabGroupId,
    })
    let pageId: number | undefined
    if (typeof targetId === 'number') {
      pageId = targetId
    } else {
      const tabs = await gw.listTabs()
      pageId = tabs.find((t) => t.targetId === targetId)?.pageId
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
    // (re-attach if still open, re-open by URL if gone) exactly once.
    space.tabs.push({ pageId, url, title: undefined, restored: false })
    space.lastActiveAt = this.now()
    this.save()
    this.recordTabOp(pageId)
    // D5 — 正向自动接线：确保 group 存在，然后把新 tab 入组。Best-effort：
    // 浏览器不支持 tab group / 跨连接 pageId 解析失败时 log.warn 不阻断，
    // tab 归属与现有行为不受影响。
    try {
      const groupId = await this.ensureSpaceGroup(space, gw)
      if (groupId && gw.tabGroupAddTabs) {
        await gw.tabGroupAddTabs(groupId, [pageId])
      }
    } catch (err) {
      console.warn(
        `[hub-spaces] tab-group wiring skipped for space ${space.id}: ${(err as Error)?.message ?? String(err)}`,
      )
    }
    return { pageId, reused: false }
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
    if (live.length > 0) {
      const liveIds = new Set(live.map((t) => t.pageId))
      const before = space.tabs.length
      space.tabs = space.tabs.filter((t) => liveIds.has(t.pageId))
      if (space.tabs.length !== before) {
        space.lastActiveAt = this.now()
        this.save()
      }
    }
    return space.tabs.map((ref) => {
      const liveInfo = live.find((t) => t.pageId === ref.pageId)
      const health = this.tabHealthFor(ref.pageId)
      return {
        pageId: ref.pageId,
        url: liveInfo?.url ?? ref.url,
        title: liveInfo?.title ?? ref.title,
        isActive: liveInfo?.isActive,
        ...(health ? { ops: health.ops, ageMs: health.ageMs } : {}),
      }
    })
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
  private async closeTabBestEffort(
    gw: SpaceTabGateway,
    ref: TabRef,
  ): Promise<void> {
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
    space.lastActiveAt = this.now()
    this.save()
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
      for (const ref of [...space.tabs]) {
        // Best-effort: stale pageIds fall back to exact-URL matching against
        // the live tab list (bug #8); a still-failing close is skipped and the
        // ledger entry is dropped below regardless.
        await this.closeTabBestEffort(gw, ref)
      }
      // D5 — 关组（连 tab 一起，已有语义）。Best-effort：失败继续，账本清理照旧。
      if (space.tabGroupId && gw.tabGroupClose) {
        try {
          await gw.tabGroupClose(space.tabGroupId)
        } catch (err) {
          console.warn(
            `[hub-spaces] tab-group close skipped for space ${space.id}: ${(err as Error)?.message ?? String(err)}`,
          )
        }
      }
    }
    delete this.state.spaces[spaceId]
    // Persist a close tombstone so merge-on-save in any process (including
    // this one) never resurrects the space from another process's stale copy.
    const deleted = new Set(this.state.deletedSpaces ?? [])
    deleted.add(spaceId)
    this.state.deletedSpaces = [...deleted]
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
   * space — official ego/BrowserClaw recycle only at task/session boundaries,
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
    space.lastActiveAt = this.now()
    this.save()
    this.emit('space.tabs_recycled', space, { urls: tabs.length })
    return {
      recycled: tabs.length,
      tabs,
      ...(failed > 0 ? { failed } : {}),
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
    const spaces = Object.values(this.state.spaces)
      .filter((s) => s.ownership === 'agent')
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    for (const space of spaces) {
      const next: TabRef[] = []
      for (const ref of space.tabs) {
        // 1. Same pageId still live → keep (same-process / same-connection idempotency).
        const liveById = live.find(
          (t) => t.pageId === ref.pageId && !used.has(t.pageId),
        )
        if (liveById) {
          used.add(liveById.pageId)
          next.push({
            pageId: ref.pageId,
            url: liveById.url ?? ref.url,
            title: liveById.title ?? ref.title,
            restored: true,
          })
          if (!ref.restored) reconciled++
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
        if (byUrl) {
          used.add(byUrl.pageId)
          next.push({
            pageId: byUrl.pageId,
            url: ref.url,
            title: ref.title ?? byUrl.title,
            restored: true,
          })
          if (!ref.restored) reconciled++
          continue
        }
        // 3. Already restored and gone → deliberately closed after the last
        //    restore; prune the stale ref (only when the live list is
        //    trustworthy — a failed listTabs must not drop ledger entries).
        if (ref.restored) {
          if (!liveOk) next.push(ref)
          continue
        }
        // 4. Pending → re-open by URL (background tab, no targetId persisted).
        try {
          const targetId = await gw.newTab(ref.url, { background: true })
          let pageId: number | undefined
          if (typeof targetId === 'number') pageId = targetId
          else {
            const tabs = await gw.listTabs()
            pageId = tabs.find((t) => t.targetId === targetId)?.pageId
          }
          if (pageId !== undefined) {
            used.add(pageId)
            next.push({ pageId, url: ref.url, title: ref.title, restored: true })
            reconciled++
          }
        } catch {
          // Skip unrecoverable tabs.
        }
      }
      space.tabs = next
      // D5 — 幂等重建：restore 时确保 group 存在（浏览器重启丢了 group 则按账本
      // 重建），并把本空间 reconcile 出的 tab 批量入组（best-effort；已有 group
      // 时 addTabs 对已在组内的 tab 是 no-op）。这样后续 sync 的「拖出移除」
      // 不会把 restore 刚恢复的 tab 误删。
      try {
        const groupId = await this.ensureSpaceGroup(space, gw)
        if (groupId && gw.tabGroupAddTabs && next.length > 0) {
          await gw.tabGroupAddTabs(
            groupId,
            next.map((t) => t.pageId),
          )
        }
      } catch (err) {
        console.warn(
          `[hub-spaces] tab-group restore wiring skipped for space ${space.id}: ${(err as Error)?.message ?? String(err)}`,
        )
      }
      // Mark the space restored so the pending list is empty for the next
      // daemon/MCP start (idempotent restarts never duplicate tabs).
      space.restoredAt = this.now()
      space.lastActiveAt = this.now()
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
    for (const ref of space.tabs) {
      const info = liveById.get(ref.pageId)
      if (!info) continue
      const liveUrl = info.url ?? ref.url
      if (!liveUrl) continue
      if (this.tabUrlMatches(liveUrl, url, mode)) return ref.pageId
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

  // ── D5 (2026-08-03): space ↔ tab group 双向同步 ──

  /**
   * 正向接线：确保 space 在浏览器里有一个 tab group（title=space 名，
   * color=deterministicColor(space.id)）。
   *
   * - space.tabGroupId 已存在且 group 还活着 → 直接返回（不重建、不改名/色，
   *   尊重人类对 group 的呈现修改）。
   * - space.tabGroupId 缺失或 group 已消失 → `tabGroupCreate`（带上 space 当前
   *   账本 pageId，使重建的 group 立刻包含该 space 的 tab），创建成功后把 groupId
   *   写账本并 best-effort 补上确定性颜色（CDP createTabGroup 不带 color）。
   * - 全部 best-effort：浏览器不支持 / 调用失败 → 返回 undefined，绝不影响 tab 归属。
   */
  private async ensureSpaceGroup(
    space: SpaceRecord,
    gw: SpaceTabGateway,
  ): Promise<string | undefined> {
    if (!gw.tabGroupCreate) return undefined
    // An empty space has nothing to group — creating an empty tab group is
    // pointless (and can be rejected by the browser). The group is created on
    // the next openTab, which passes the fresh tab into tabGroupCreate.
    if (space.tabs.length === 0) return space.tabGroupId
    if (space.tabGroupId) {
      let exists = false
      try {
        const groups = (await gw.tabGroupList?.()) ?? []
        exists = Array.isArray(groups) && groups.some(
          (g) => (g as LiveTabGroup)?.groupId === space.tabGroupId,
        )
      } catch {
        // Cannot verify the group — trust the ledger (never duplicate-create
        // when the group list is unavailable).
        return space.tabGroupId
      }
      if (exists) return space.tabGroupId
      // Group is gone (e.g. human closed it) → recreate below.
    }
    try {
      const created = await gw.tabGroupCreate(
        space.tabs.map((t) => t.pageId),
        space.name,
      )
      if (!created?.groupId) return undefined
      space.tabGroupId = created.groupId
      // CDP createTabGroup has no color param — apply the deterministic color
      // best-effort right after creation (this is OUR group, not a human edit).
      try {
        await gw.tabGroupUpdate?.(created.groupId, {
          color: deterministicColor(space.id),
        })
      } catch {
        // Color is cosmetic — never block group wiring on it.
      }
      this.save()
      return created.groupId
    } catch {
      return undefined
    }
  }

  /**
   * D5 反向同步核心（lazy reconcile）：人类改 tab group → space 账本。
   *
   * 只处理「已建过 group」的 space：tabGroupId 存在，或 live group 能按
   * (title=space.name, color=deterministicColor(space.id)) 匹配到。无 group 的
   * space 一律跳过，绝不误判。规则：
   *   a. group 内新增 tab（group.tabIds 反查 tabId→pageId）→ 写账本归属 (added++)
   *   b. 账本 tab 不在 group 内 且 该 space 已有 tabGroupId（人类拖出）→ 移除
   *      (removed++)。防误伤：无 tabGroupId 的 space 从不走移除方向；另外
   *      刚写入账本、尚未入组的 pending 新 tab（restored === false 且浏览器里
   *      pageId 仍存活）视为"pending 入组"保留不删（任务 2 竞态修复）。
   *   c. 人类改 group 名/色 → 不反写（这里绝不调用 tabGroupUpdate）。
   *   d. group 被删 → 本次跳过（tab 保留），由下一次 openTabWithReuse / restore
   *      的 ensureSpaceGroup 自动重建。
   * 无 gateway / 浏览器不支持 tab group → no-op {0,0}。内部只读 gateway 的
   * tabGroupList/listTabs 并写账本，绝不调用其它 manager 方法 —— 不会递归触发
   * sync。owner 可选：触发点传 owner 只处理该 owner 的 space（避免跨 owner 写账本）；
   * 不传则处理账本中所有已建 group 的 space（显式调用 / 测试）。
   */
  private async reconcileTabGroups(
    gw: SpaceTabGateway | undefined,
    owner?: string,
  ): Promise<{ added: number; removed: number }> {
    if (!gw?.tabGroupList || !gw.listTabs) return { added: 0, removed: 0 }
    // Best-effort bound: never let a slow/unreachable browser drag the lazy
    // trigger paths (currentSpace/listSpaces/openTabWithReuse/guard) down.
    // A timed-out pass simply does not reconcile this round; the next call
    // retries. The inner work may finish in the background (no cancellation
    // available through CDP) — its ledger write is still a correct reconcile.
    try {
      return await Promise.race([
        this.reconcileTabGroupsUnbounded(gw, owner),
        new Promise<{ added: number; removed: number }>((resolve) => {
          setTimeout(() => resolve({ added: 0, removed: 0 }), TAB_GROUP_SYNC_TIMEOUT_MS)
        }),
      ])
    } catch {
      return { added: 0, removed: 0 }
    }
  }

  private async reconcileTabGroupsUnbounded(
    gw: SpaceTabGateway,
    owner?: string,
  ): Promise<{ added: number; removed: number }> {
    let groups: unknown[] = []
    let live: TabLike[] = []
    try {
      groups = await gw.tabGroupList()
    } catch {
      return { added: 0, removed: 0 }
    }
    try {
      live = await gw.listTabs()
    } catch {
      return { added: 0, removed: 0 }
    }
    if (!Array.isArray(groups)) return { added: 0, removed: 0 }

    // tabId → pageId 反查表（group.tabIds 是 tabId；pageId 来自 listTabs）。
    const pageIdByTabId = new Map<string | number, number>()
    for (const t of live) {
      if (t.tabId !== undefined && t.pageId !== undefined) {
        pageIdByTabId.set(t.tabId, t.pageId)
      }
    }
    const liveById = new Map(live.map((t) => [t.pageId, t]))

    let added = 0
    let removed = 0
    const candidates = Object.values(this.state.spaces).filter(
      (s) => owner === undefined || s.owner === owner,
    )
    for (const space of candidates) {
      const group = this.spaceTabGroup(space, groups)
      if (!group) continue // 无 group 的 space 不处理
      const groupPageIds = new Set<number>()
      for (const tabId of group.tabIds ?? []) {
        const pageId = pageIdByTabId.get(tabId)
        if (pageId !== undefined) groupPageIds.add(pageId)
      }
      const ledgerIds = new Set(space.tabs.map((t) => t.pageId))
      let mutated = false

      // a. group 内新增 tab → 归属该 space（视觉边界=归属边界）。
      for (const pageId of groupPageIds) {
        if (ledgerIds.has(pageId)) continue
        const info = liveById.get(pageId)
        space.tabs.push({
          pageId,
          url: info?.url ?? 'about:blank',
          title: info?.title,
          // The tab is already attached to a live browser tab — mark it
          // restored so the next restore() never re-opens a duplicate.
          restored: true,
        })
        ledgerIds.add(pageId)
        added++
        mutated = true
      }

      // b. 拖出移除 —— 只在该 space 已有 tabGroupId 时生效（防误伤：刚开还没
      //    入组的 tab / 无 group 的 space 都不会被误删）。
      if (space.tabGroupId) {
        const before = space.tabs.length
        space.tabs = space.tabs.filter((t) => {
          if (groupPageIds.has(t.pageId)) return true
          // 任务 2 竞态保护：openTabWithReuse 先写账本（restored:false，步骤 2）
          // 再 tabGroupAddTabs 入组（步骤 4），两步之间的窗口里 sync 若触发，
          // 会把刚开的新 tab 误判为「人类拖出」而从账本移除（视觉还在、账本
          // 短暂无主）。只要该 tab 仍是 pending（restored === false）且浏览器里
          // pageId 还存活（liveById 有它），就视为「pending 入组」保留不删；
          // 只有确认已 restored（restore() 已 reconcile 过）且不在 group 的
          // tab 才是真拖出、移除。restored === undefined 的旧账本数据保持原
          // 行为（不在 group 即移除）。
          if (t.restored === false && liveById.has(t.pageId)) return true
          return false
        })
        const delta = before - space.tabs.length
        removed += delta
        if (delta > 0) mutated = true
      }

      if (mutated) {
        space.lastActiveAt = this.now()
        this.save()
      }
    }
    return { added, removed }
  }

  /**
   * 找 space 对应的 live group：先按 tabGroupId，再按 (title, color) 匹配。
   * 返回 undefined 表示该 space 没有（可识别的）group —— 调用方跳过。
   * 按 title/color 匹配成功时把发现的 groupId 写账本（后续 ensureSpaceGroup
   * 与 sync 就能直接按 id 校验）。
   */
  private spaceTabGroup(
    space: SpaceRecord,
    groups: unknown[],
  ): LiveTabGroup | undefined {
    const byId = groups.find(
      (g) => (g as LiveTabGroup)?.groupId === space.tabGroupId,
    ) as LiveTabGroup | undefined
    if (byId) return byId
    if (space.tabGroupId) return undefined // 账本说有此 group，但已消失 → 跳过
    const byMeta = groups.find(
      (g) =>
        (g as LiveTabGroup)?.title === space.name &&
        (g as LiveTabGroup)?.color === deterministicColor(space.id),
    ) as LiveTabGroup | undefined
    if (byMeta?.groupId) {
      space.tabGroupId = byMeta.groupId
      this.save()
    }
    return byMeta
  }

  /**
   * D5 — 公开反向同步入口：读 gateway 的 tab group + live tabs，与 space 账本
   * diff（group 内新增归属 / 拖出移除 / 改名不反写 / 组删重建留待 ensure）。
   * 无 gateway 或浏览器不支持 tab group → no-op 返回 {0,0}。
   */
  async syncWithTabGroups(
    gateway?: SpaceTabGateway,
  ): Promise<{ added: number; removed: number }> {
    return this.reconcileTabGroups(gateway ?? this.gateway)
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
    // D5 — lazy reconcile before the guard: 视觉边界=归属边界。人类把 tab 拖进
    // space 的 group 后，agent 就能操作它；拖出后则不再可控。无 gateway 跳过。
    await this.reconcileTabGroups(this.gateway, owner)
    if (!this.isolationActive(owner)) throw this.noSpaceError(owner)
    const space = this.spaceForPage(pageId)
    if (!space || space.owner !== owner) {
      throw new SpaceGuardError(
        'page-not-in-space',
        `page ${pageId} is not in your space. List your tabs with tabs action="list" or open one with space.open_tab`,
        { pageId },
      )
    }
    this.assertAgentCanAct(owner, space)
  }

  async assertPagesControllable(
    owner: string,
    pageIds: number[],
  ): Promise<void> {
    for (const pageId of pageIds) {
      await this.assertPageControllable(owner, pageId)
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
      return space !== undefined && ownedIds.has(space.id)
    })
  }

  /** Attribute a freshly opened tab to the agent's current space (best-effort). */
  async recordTabForCurrentSpace(
    owner: string,
    pageId: number,
    url?: string,
  ): Promise<boolean> {
    const currentId = this.state.currentSpaceByOwner[owner]
    if (!currentId) return false
    const space = this.state.spaces[currentId]
    if (!space || space.owner !== owner) return false
    this.assertAgentCanAct(owner, space)
    if (space.tabs.some((t) => t.pageId === pageId)) return true
    space.tabs.push({ pageId, url: url ?? 'about:blank', restored: false })
    space.lastActiveAt = this.now()
    this.save()
    return true
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

  /** tab_groups 3.4: current space → title (space name) + deterministic color. */
  async currentSpaceGroupMeta(
    owner: string,
  ): Promise<{ spaceId?: string; title?: string; color?: string }> {
    const current = await this.currentSpace(owner)
    if (!current) return {}
    return {
      spaceId: current.id,
      title: current.name,
      color: deterministicColor(current.id),
    }
  }
}
