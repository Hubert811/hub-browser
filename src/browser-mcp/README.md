# @hub/browser-mcp — UnifiedPage-backed browser MCP fork

Fork of `@browseros/browser-mcp` (vendored at `vendor/browseros/.../packages/browser-mcp/`,
read-only). Implements **6.10 统一计划 · 方案 A**: every tool handler now operates on
hub-browser's `UnifiedPage` (`src/page.ts`) instead of `browser-core`'s
`Observer`/`Input`, so the MCP path and the OpenCLI path share one page-operation
implementation.

- Tool names, Zod schemas, and result shapes (`text`/`data`/`error`/structuredContent)
  are preserved — verified by `tools/structured-contract.test.ts`, which pins the exact
  structured keys of all 17 tools.
- The vendored package is untouched; this fork is the switchable copy.

## Context contract

`ToolContext.session: BrowserSession` was replaced by a page provider:

```ts
interface UnifiedPageProvider {
  connect(opts?: { pageId?: number; cdpEndpoint?: string; timeout?: number; session?: string }): Promise<UnifiedPage>
}

interface ToolContext {
  page: UnifiedPage            // active/front page (browser-level tools)
  pageFor(pageId: number): Promise<UnifiedPage>  // page-bound instance
  defaultWindowId?: number
  defaultTabGroupId?: string
  signal?: AbortSignal
}
```

`UnifiedBrowserFactory` (`src/factory.ts`) satisfies `UnifiedPageProvider`.
Page instances are cached per page id in `tools/register.ts`, so AX-ref/diff state
survives across tool calls (snapshot → act), matching the session-level guarantee the
vendored server got from `BrowserSession`.

`createBrowserMcpServer(options)` now takes `options.browser: UnifiedPageProvider`
instead of `options.browserSession`.

## Tool → UnifiedPage mapping

| tool | UnifiedPage call |
|---|---|
| `tabs list/active` | `page.tabs()` |
| `tabs new` | `page.newTab(url, {background, windowId, tabGroupId})` + `page.tabs()` (pageId from targetId) |
| `tabs close` | `page.closeTab(pageId)` |
| `tab_groups list` | `page.tabGroupList()` + `page.tabs()` (tabId↔pageId) |
| `tab_groups create/update/ungroup/close` | `page.tabGroupCreate/Update/Ungroup/Close`; add-to-existing-group via `page.cdp('Browser.addTabsToGroup')` |
| `history` | `page.cdp('History.getRecent')` |
| `navigate` | url → `page.goto(url)`; back/forward/reload → `page.cdp('Page.goBack'/'Page.goForward'/'Page.reload')`; auto snapshot post-action |
| `snapshot` | `page.snapshot()` (AX observer, `[ref=eN]` refs) |
| `diff` | `page.diff()` |
| `act click` | `page.click(ref)` (UnifiedPage ref cascade: AX backendNodeId → DOM marker → fingerprint) |
| `act click_at` | `page.nativeClick(x, y)` |
| `act type/type_at` | `page.nativeType(text)` (type_at: nativeClick + nativeType) |
| `act fill` | `page.fillText(ref, value)` |
| `act press` | `page.pressKey(key)` |
| `act hover` | `page.hover(ref)`; `hover_at` → `page.cdp('Input.dispatchMouseEvent')` |
| `act focus/check/uncheck` | `page.focus(ref)` / `page.setChecked(ref, bool)` |
| `act select` | `page.selectOption(ref, value)` (added to UnifiedPage; AX-ref + DOM marker paths) |
| `act scroll` | real `Input.dispatchMouseEvent` mouseWheel at viewport/ref center, 120px/notch (browser-core semantics) |
| `act drag/drag_at` | `page.drag(ref, targetRef)`; drag_at → CDP mouse sequence |
| `download` | `Page.downloadWillBegin/downloadProgress` events on the live page session (mirrors vendored implementation) |
| `upload` | `page.uploadFiles(ref, files)` |
| `read` | `page.evaluate(buildContentMarkdownExpression / innerText / links expr)` |
| `grep` | ax → `page.snapshot()`; content → `page.evaluate("document.body?.innerText")` |
| `screenshot` | `page.screenshot(...)` / `page.annotatedScreenshot(...)` (annotate) |
| `pdf` | `page.cdp('Page.printToPDF')` |
| `wait` | `for=time` delay; text/selector → poll `page.evaluate(...)` |
| `windows list/create/close/activate` | `page.windowList()/windowCreate()/windowClose()/windowActivate()` |
| `evaluate` | `page.evaluate(async IIFE)` with timeout race |
| `run` | injected `browser` SDK built over `UnifiedPage` (pages/observe/input/nav/cdp) |

## Phase 3 — Task spaces (shared cookie + agent-level tab isolation)

The fork adds a shared `TaskSpaceManager` (统一 Core single point) at
`hub-browser/src/space/task-space-manager.ts`, importable by both the MCP tools
and the OpenCLI (`space` command group). Spaces are ledger-only (same default
BrowserContext → cookie/localStorage are shared with the user by design —
Layer 1, no physical isolation):

- **Ledger**: JSON file (`$BROWSEROS_DIR/hub-spaces.json` or `~/.opencli/hub-spaces.json`),
  atomic writes, `tab→space` mapping, per-conversation `current_space_id`.
- **Ownership state machine**: `agent → agentDelegatedToUser → user`;
  `takeOver`/`claim` of a user-held space requires explicit confirmation.
  While user-held, agent page operations fail with `user is controlling`.
- **Guard**: wired into `executeTool` (framework.ts) when the ctx carries both
  `identity` and `spaces`. `tabs` list is filtered to the agent's own space;
  control tools (act/navigate/read/evaluate/screenshot/run/grep/wait/…) reject
  pages outside it with `page not in your space`. Agents that own no space yet
  keep the legacy open-world behavior.
- **space.\* tools**: `SPACE_TOOLS` (13 tools: create/use/list/current/switch/
  open_tab/list_tabs/close_tab/close/**recycle**/handoff/takeover/claim)
  registered after the 17-tool contract list.
- **space.recycle (TabFreshness 边界新鲜化)**: `space.recycle` closes every tab
  in the given (or current) space and reopens each URL in a fresh tab — the
  space record (id/name/taskId/owner/ownership) is preserved, only the tabs are
  replaced; the ledger pageIds are updated and `space.tabs_recycled` is emitted
  (carrying the recycled count). Requires agent control (user-held spaces must
  be claimed first) and a browser gateway. **Default conservative**: recycle is
  never automatic — new tasks use a new space (fresh tabs), long tasks call
  `space.recycle` explicitly mid-way when tabs grow stale/wedge, and task end
  uses `space.close` (keep:false default) to clean up.
- **open_tab URL reuse (ego `openOrReuseTab`)**: `space.open_tab` defaults to
  `reuse:'exact'` — if the space already has a *live* tab with the same
  normalized href it is switched to and the result carries `reused:true`
  instead of opening a duplicate. `reuse` accepts `exact` (default),
  `origin`, `origin+path` (same origin + pathname), `includes` (tab URL string
  contains the requested url), or `false` to force a new tab. Matching is
  scoped to the current space only and uses the same `sameRestoreUrl`
  normalization as restore; externally-closed tabs never participate. The CLI
  `browser open` (current space) uses the same exact-reuse behavior.
- **Identity**: explicit `identity` option on `createBrowserMcpServer` /
  `registerBrowserTools`, else `$HUB_AGENT_ID`, else MCP clientInfo name.
- **Events**: in-process `SpaceEventBus` (`space.created/agent_active/
  handoff_requested/interrupted/switched/closed/tabs_recycled`); cross-process
  push is Phase 7.
- **TabFreshness canary + telemetry (2026-08-03)**: the `screenshot` tool probes
  the capture pipeline with a tiny 16×16 clip (`UnifiedPage.canaryCapture()`,
  ~2.5s timeout, usually a few ms) **before** capturing, so a per-tab wedged
  capture pipeline is detected immediately instead of after a full screenshot
  timeout. On wedge the tool returns the existing actionable hint
  (`[hint: tab-wedged -> open a fresh tab via space.open_tab or tabs new, then retry]`)
  by default (`onWedged:'hint'`); opt-in `onWedged:'auto-recycle'` instead calls
  `space.recycle` on the page's space and retries once on the fresh tab (falls
  back to the hint when the ctx has no spaces/identity wiring or the page is not
  in a space). Set `canary:false` to disable the pre-probe. Health telemetry is
  in-memory only (ledger structure untouched, no auto decisions): each
  `space.open_tab` (reuse hit or new tab) increments `ops` for the tab,
  `closeTab`/recycle clears it, and `space.list_tabs` carries `ops`/`ageMs` per
  tab to inform future thresholds.

Known limitations (recorded per Phase 3 spec): each MCP/daemon process keeps its
own manager instance. Writes to the shared JSON ledger are merge-on-save (a save
keeps spaces written by other processes plus close tombstones, so two agents'
processes never clobber each other; see `task-space-manager.ts`), but live
cross-process state push (events/reload) is not in scope. `windows`/`history`
remain browser-level (unfiltered), and `run` guards only its default page (its
SDK can still address arbitrary pageIds). Note that page ids are per-connection
counters: the same number in two MCP processes can denote different tabs —
isolation is enforced per process against its own ledger (URLs are the stable
cross-process identity).

## How consumers switch

1. **Direct (in-process)**: build the fork server and bind it to a factory —

```ts
import { UnifiedBrowserFactory } from '@hub/browser/factory'
import { createBrowserMcpServer } from '@hub/browser-mcp/mcp-server'

const server = createBrowserMcpServer({
  name: 'my-agent-mcp',
  title: 'hub-browser MCP',
  version: '0.1.0',
  browser: new UnifiedBrowserFactory(),
})
await server.connect(transport) // e.g. StdioServerTransport
```

2. **Runnable entry**: `bin/hub.mjs --mcp` (or `HUB_MCP=true`) starts the fork as a
   stdio MCP server:

```sh
BROWSEROS_CDP_PORT=9110 bun bin/hub.mjs --mcp
```

   Point your MCP client (Claude Desktop / claude code / any SDK client) at it with
   stdio transport.

3. **Existing vendored consumers** (`apps/server` `/chat` + `/mcp` are read-only
   vendor code): switch by re-importing `@hub/browser-mcp/mcp-server` +
   `@hub/browser/factory` in the server's browser-MCP wiring and passing
   `browser: factory` instead of `browserSession`. The fork is intentionally
   drop-in shaped: same `createBrowserMcpServer`, `registerBrowserTools`,
   `BROWSER_TOOLS`, and result envelopes.

## Vendored consumers (apps/server) — session-mode compatibility (方案 2)

`apps/server` (vendored, read-only) still calls the fork through the old
contract:

```ts
import { BROWSER_TOOLS } from '@browseros/browser-mcp/registry'
import { executeTool } from '@browseros/browser-mcp/tools/framework'
// ...
executeTool(def, params, { session, signal })   // old ctx: no page/pageFor
```

`tools/session-adapter.ts` bridges the two ctx shapes: `executeTool` detects a
`session`-shaped ctx and builds `page`/`pageFor` (`UnifiedPage` over the same
`BrowserSession` + its `CdpBackend`, exactly like `UnifiedBrowserFactory`), so
the 17 handlers are unchanged and apps/server needs **no source change**.

Resolution: hub-browser's root postinstall creates
`node_modules/@browseros/browser-mcp -> src/browser-mcp`, so the vendored
specifier lands on the fork (apps/server resolves it by walking up to the
hub-browser root node_modules). If the browseros-agent workspace itself is
installed, its own `node_modules/@browseros/browser-mcp` (vendored) shadows
the root link; redirect that link the same way or use a browseros-agent
`overrides` entry.

Harnesses:
- `src/browser-mcp/src/tools/session-adapter.test.ts` — fork `bun test` suite
  (fake session, all 17 tools via `executeTool` with `{ session }`).
- `tests/session-mode-harness.ts` — root `bun run test:session-adapter`
  (imports through the `@browseros/browser-mcp/*` specifiers; proves
  resolution + bridge).
- `tests/session-mode-live-smoke.ts` — real CDP 9110 smoke with a real
  `CdpBackend` + `BrowserSession` (tabs list/new, navigate, snapshot, close).

## Verification

- `bun run typecheck` (fork + hub-browser root): pass
- `bun test` (fork): 32/32 pass, incl. structured-contract (17 tools) & register/mcp-server
- hub-browser e2e `BROWSEROS_CDP_PORT=9110 bun run tests/test-phase2a.ts`: 24/24 pass
- Live smoke against Chrome CDP 9110 (`src/smoke-mcp.ts`, in-process) and
  `src/smoke-stdio-client.ts` (spawns `hub --mcp`, real MCP client):
  tabs / navigate / snapshot / read / evaluate / windows / history / diff all pass.

## Session-replay (rrweb) impact

**None.** The replay chain lives entirely in vendored BrowserClaw and is untouched:

- `apps/claw-app/entrypoints/recorder.content.ts` — content script collects rrweb
  events → `modules/recorder/recorder-buffer.ts` → `chrome.runtime.sendMessage`
  (`recorder-events`) → background → `recordings-relay.ts` HTTP ingest.
- `apps/claw-server-rust` `src/api/http/recordings.rs` (`append_document_events`)
  → `services/recordings/{ingest,store}.rs` → replay data.
- `apps/claw-app/screens/replay/*` + `modules/api/replay.hooks.ts` — replay UI/metadata.

This fork only changes the *tool-handler* layer (`src/browser-mcp/**`) plus
`bin/hub.mjs --mcp`. It never touches the extension content script, the ingest API,
or the replay builder. Evidence: `git status` shows `vendor/` clean; the recorder and
replay modules import neither `browser-mcp` nor `browser-core`; claw-server-rust
recordings tests (9/9) and replay builder tests (5/5) pass; claw-app replay logic
tests pass (React-component `.tsx` tests fail only because `react` is not installed
in this checkout, pre-existing).

## Known behavior changes (by design)

- **Refs**: `act` refs now resolve through UnifiedPage's cascade (AX `eN` refs via
  backendNodeId, OpenCLI numeric refs via `data-opencli-ref`, then fingerprint
  re-identification) instead of `Observer.resolveRef` alone — the whole point of 6.10.
- `act click` honors `button`/`clickCount`: default left/single goes through
  `page.click(ref)` (UnifiedPage cascade); non-default dispatches
  `Input.dispatchMouseEvent` at the ref center (via `page.refCenter`) or at raw
  coordinates for `click_at` — matches the vendored `Input.click/clickAt`.
- `type_at` honors `clear` by dispatching select-all + Backspace (browser-core's
  `clearField`) before typing.
- `scroll` dispatches a real `Input.dispatchMouseEvent` mouseWheel at the viewport
  center (or the ref center) with 120px per notch — same semantics as
  browser-core `Input.scroll`.
- `download` waits on `Page.downloadWillBegin`/`downloadProgress` events, mirroring
  the vendored implementation (no directory polling).
- `tabs new` passes `background` + `windowId`/`tabGroupId` defaults through to
  `page.newTab` when provided.
- Known quirk (pre-existing, affects vendored browser-core equally): CDP
  `mouseWheel` on a **background** tab times out; scroll only works once the tab
  is the active/foreground page.
- `windows`/`history`/`tab_groups` now use raw CDP responses via `page.cdp()` (page
  session), which Chrome accepts for browser domains in this setup (verified live).
