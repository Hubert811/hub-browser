#!/usr/bin/env node
/**
 * hub-browser CLI entry point.
 *
 * Three modes:
 * 1. CLI (default): check if daemon is running -> HTTP forward; else spawn daemon then forward.
 * 2. Daemon (HUB_DAEMON=true): persistent process holding CDP connection + UnifiedPage singleton.
 * 3. MCP (hub --mcp | HUB_MCP=true): stdio MCP server backed by the @hub/browser-mcp fork,
 *    which routes every browser tool through UnifiedPage.
 *
 * Daemon uses the same CdpBackend from @browseros/browser-core as BrowserOS neo's apps/server,
 * with built-in keepalive + auto-reconnect. Chrome supports multiple CDP clients simultaneously,
 * so daemon and apps/server can each maintain independent WebSocket connections to the same port.
 */

process.env.OPENCLI_BROWSER = 'claw';

// The vendored browser-core CDP backend uses the global WebSocket. Node 20 has
// no global WebSocket, so polyfill from the `ws` dependency (already required
// at runtime). Bun provides a native global and skips this.
if (typeof globalThis.WebSocket === 'undefined') {
  const { WebSocket: WS } = await import('ws');
  globalThis.WebSocket = WS;
}

// ── Shared path setup (mirrors main.js) ──────────────────────────
if (process.platform !== 'win32') {
  const std = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const cur = new Set((process.env.PATH ?? '').split(':').filter(Boolean));
  for (const p of std) cur.add(p);
  process.env.PATH = [...cur].join(':');
}

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
let __filename = fileURLToPath(import.meta.url);
// bun --compile rewrites import.meta.url to a virtual bunfs path
// (/$bunfs/root/hub) — every fs anchor derived from it (PROJECT_ROOT,
// RUNTIME, spawn cwd) would point into a nonexistent filesystem. The real
// executable lives at process.execPath; anchor to it when compiled.
const COMPILED = __filename.startsWith('/$bunfs');
if (COMPILED && process.execPath && !process.execPath.startsWith('/$bunfs')) {
  __filename = process.execPath;
}
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

// Published package ships compiled JS in dist/ (Node cannot type-strip .ts
// under node_modules); the dev tree runs TS via bun. Pick the runtime root so
// one bin works for both layouts:
//   - dev tree under bun:      src  (fresh TS, bun resolves .js -> .ts)
//   - dev tree under node:     dist (compiled JS; src TS would not run)
//   - published package:       dist (src/ not shipped)
// All relative imports below use `.js` specifiers.
const HAS_SRC = fs.existsSync(join(PROJECT_ROOT, 'src', 'opencli-engine', 'main.js'));
const HAS_DIST = fs.existsSync(join(PROJECT_ROOT, 'dist', 'opencli-engine', 'main.js'));
const RUNTIME_BASE = !HAS_SRC || (HAS_DIST && typeof Bun === 'undefined') ? 'dist' : 'src';
// Absolute form: under --compile the module's own URL lives on the virtual
// bunfs disk, so a relative specifier would resolve there instead of next
// to the real executable. Absolute paths resolve identically in dev.
const RUNTIME = join(PROJECT_ROOT, RUNTIME_BASE);

const DAEMON_PORT = parseInt(process.env.HUB_DAEMON_PORT ?? '9300', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.HUB_DAEMON_IDLE_TIMEOUT ?? '300000', 10); // 5 min

// Bug #26 (round 2): every agent consumes hub output through a PIPE, and
// process.exit() right after process.stdout.write drops >64KB still queued.
// This is the exit every forwarded command takes (sendCommand below) and
// --llm-txt's — the paths cli.js's flushAndExit never covered. Round-2 probes
// ruled out both queue probes on Bun: writableLength reports 0 with ~450KB
// queued, and write('', cb) fires immediately WITHOUT draining (65536 bytes
// delivered through a pipe). What works on both runtimes: await the callback
// of the data write itself — it fires only after the chunk is flushed. The
// 2s deadline race bounds a wedged pipe consumer.
async function writeAllAndExit(code, writes) {
  const deadline = Date.now() + 2000;
  try {
    await Promise.race([
      Promise.all(
        writes
          .filter(([, chunk]) => chunk != null && chunk !== '')
          .map(([stream, chunk]) => new Promise((resolve) => { stream.write(chunk, resolve); })),
      ),
      new Promise((r) => setTimeout(r, deadline - Date.now())),
    ]);
  } catch {
    /* best-effort */
  }
  process.exit(code);
}

// ─── P2-9: agent self-description (hub --llm-txt) ────────────────
// Prints the agent guide straight from the installed build: the bundled
// hub-browser SKILL.md (single source — the very file the skills system
// ships, no second copy to maintain) plus a tool surface enumerated LIVE
// from this build's modules, so the listing can never drift from what
// `hub --mcp` actually registers. Never fails on a missing resource: a
// package without the skill file still gets the dynamic surface.
if (process.argv.includes('--llm-txt')) {
  const {
    BROWSER_TOOLS, SPACE_TOOLS,
    PAGE_INFO_TOOLS, OBSERVATION_TOOLS, DISCOVERY_TOOLS, PROBE_TOOLS,
  } = await import(`${RUNTIME}/browser-mcp/src/tools/registry.js`);
  const { AUDIT_TOOLS } = await import(`${RUNTIME}/browser-mcp/src/tools/audit-tools.js`);
  const { ADAPTER_TOOLS } = await import(`${RUNTIME}/browser-mcp/src/tools/adapter-tools.js`);
  const { REPLAY_TOOLS } = await import(`${RUNTIME}/browser-mcp/src/tools/replay-tools.js`);
  const pkg = JSON.parse(fs.readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  const skillPath = [
    join(PROJECT_ROOT, 'skills', 'hub-browser', 'SKILL.md'),
    join(PROJECT_ROOT, 'dist', 'skills', 'hub-browser', 'SKILL.md'),
  ].find((p) => fs.existsSync(p));
  const firstLine = (s) => (s ?? '').split('\n')[0].trim();
  // Every family register.ts mounts must appear here — P2-6's three new
  // families (page-info/observation/discovery) initially missed this list and
  // the "never drifts" promise broke (41 registered, 35 advertised). Caught
  // by the 0.2.0 release pipeline's node-dist smoke.
  const tools = [
    ...BROWSER_TOOLS, ...SPACE_TOOLS, ...AUDIT_TOOLS, ...REPLAY_TOOLS, ...ADAPTER_TOOLS,
    ...PAGE_INFO_TOOLS, ...OBSERVATION_TOOLS, ...DISCOVERY_TOOLS, ...PROBE_TOOLS,
  ];
  const toolLines = tools.map((t) => `- ${t.name}: ${firstLine(t.description)}`).join('\n');
  const parts = [
    '# hub-browser agent guide (hub --llm-txt)',
    '',
    `hub-browser ${pkg.version} — printed from this installed build. The tool list below is enumerated live from the build's own modules and always matches what \`hub --mcp\` registers.`,
    '',
    `## MCP tool surface (${tools.length} tools)`,
    '',
    toolLines,
    '',
    'CLI face: `hub --help` lists commands; `hub <site> <cmd>` runs site adapters (same list as `adapter.run`). Env knobs: HUB_AGENT_ID (stable identity), HUB_SESSION_END_SPACES (close|keep|off at session end), HUB_AUDIT (off) / HUB_AUDIT_DB, HUB_SPACES_FILE.',
    '',
  ];
  if (skillPath) {
    parts.push(fs.readFileSync(skillPath, 'utf-8').trimEnd(), '');
  }
  await writeAllAndExit(0, [[process.stdout, parts.join('\n') + '\n']]);
}

// ─── MCP mode (hub --mcp | HUB_MCP=true) ───────────────────────────
// Stdio MCP server bound to the @hub/browser-mcp fork. All browser tools
// resolve their target page through UnifiedBrowserFactory -> UnifiedPage, i.e.
// the same page-operation logic the OpenCLI path uses. External agents connect
// with `hub --mcp` (stdio) and set BROWSEROS_CDP_PORT to the Chrome CDP port.
if (process.env.HUB_MCP === 'true' || process.argv.includes('--mcp')) {
  const { UnifiedBrowserFactory } = await import(`${RUNTIME}/factory.js`);
  const { createBrowserMcpServer } = await import(`${RUNTIME}/browser-mcp/src/mcp-server.js`);
  const { TaskSpaceManager, gatewayFromProvider } = await import(`${RUNTIME}/space/task-space-manager.js`);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const browser = new UnifiedBrowserFactory();
  // Phase 3: shared TaskSpaceManager (统一 Core). The gateway bridges the
  // UnifiedPage provider so space.open_tab/close/restore drive the same
  // browser connection every tool uses. Cross-process sync of the ledger is a
  // known limitation (each MCP/daemon process keeps its own manager instance;
  // the JSON ledger file is the shared ground truth).
  const spaces = new TaskSpaceManager({
    // Same ledger the OpenCLI side uses (HUB_SPACES_FILE wins, like cli.js).
    storagePath: process.env.HUB_SPACES_FILE || (await import(`${RUNTIME}/space/task-space-manager.js`)).defaultStoragePath(),
    gateway: gatewayFromProvider(browser),
  });
  // D8 — legacy-space auto-reap for the long-lived MCP process. The daemon
  // branch adds no timer: every daemon command goes through loadSpaceManager,
  // whose constructor already runs the load-time sweep. HUB_SPACE_REAP=off
  // disables the reaper entirely (no sweep, no timer).
  if (process.env.HUB_SPACE_REAP !== 'off') {
    const reapIntervalMs = parseInt(process.env.HUB_SPACE_REAP_INTERVAL_MS ?? '300000', 10) || 300000;
    const reapTimer = setInterval(() => {
      spaces.reapExpiredSpaces().catch((err) => {
        process.stderr.write(`[hub-mcp] space reap error: ${err?.message ?? String(err)}\n`);
      });
    }, reapIntervalMs);
    reapTimer.unref?.();
  }
  // P2-1 — this process's session ownership key, set by onSessionIdentity
  // on the first tool call (declared before the server so the callback can
  // never race the declaration).
  let sessionOwner = null;
  const server = createBrowserMcpServer({
    name: 'hub-browser',
    title: 'hub-browser MCP (UnifiedPage)',
    version: '0.1.0',
    browser,
    spaces,
    // Phase 7: bridge the in-process space event bus to MCP notifications so
    // UI/agent clients can subscribe to space state changes in real time.
    // Cross-process push stays out of scope (each process keeps its own bus;
    // the ledger JSON file is the shared ground truth).
    spaceEvents: spaces.events ?? undefined,
    // Per-conversation identity: set HUB_AGENT_ID uniquely per conversation
    // when several agents share one client; otherwise the registration layer
    // derives a session-scoped identity from MCP client info (P1-3: with a
    // unique convoId per server session).
    identity: process.env.HUB_AGENT_ID
      ? {
          agentId: process.env.HUB_AGENT_ID,
          convoId: process.env.HUB_AGENT_ID,
          displayName: 'hub-browser mcp agent',
        }
      : undefined,
    // P2-1 — session-scoped spaces die with the session: remember this
    // process's ownership key (per-process convoId, P1-3) so the exit hooks
    // below can sweep its spaces. Stable HUB_AGENT_ID identities span
    // sessions by design — no tracking, no auto-close for them.
    ...(process.env.HUB_AGENT_ID
      ? {}
      : process.env.HUB_SESSION_END_SPACES !== 'off' && {
          onSessionIdentity: (identity) => {
            sessionOwner = identity.convoId ?? identity.agentId;
          },
        }),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Phase 3 A: auto-restore agent-owned space tabs after the manager is loaded
  // and the browser connects. Fire-and-forget: a CDP failure must never take
  // the MCP server down (restore() is idempotent via ledger markers, so
  // repeated starts never duplicate still-open tabs).
  spaces
    .restore()
    .then((n) => {
      if (n > 0) process.stderr.write(`[hub-mcp] restored ${n} space tab(s)\n`);
    })
    .catch((err) => {
      process.stderr.write(`[hub-mcp] space restore skipped: ${err?.message ?? String(err)}\n`);
    });
  // F17 backstop: end claw sessions left Live by processes that died before
  // their exit hook (kill -9 / crash). Stale-only; fire-and-forget.
  void (async () => {
    try {
      const { clawHarnessReporter } = await import(`${RUNTIME}/browser-mcp/src/tools/claw-reporter.js`);
      await clawHarnessReporter.sweepStaleSessions();
    } catch { /* best-effort */ }
  })();
  // Keep the process alive while the stdio transport is connected.
  process.stdin.resume();

  // ── P2-1: session-end space sweep ─────────────────────────────
  // The MCP process IS the session: when it goes down (client disconnect =
  // stdin end, or a signal), its session-scoped spaces are orphans nobody
  // can address again (per-process convoId). Close them now instead of
  // waiting out the D8 7d TTL. HUB_SESSION_END_SPACES:
  //   close (default) — close tabs + tab groups + ledger eviction
  //   keep            — ledger eviction only (tabs stay for review)
  //   off             — leave everything (D8 TTL still applies eventually)
  let sessionClosing = false;
  async function closeSessionSpacesAndExit(code) {
    if (sessionClosing) return;
    sessionClosing = true;
    try {
      // F17: end every claw working-period session this process started.
      // Deliberately OUTSIDE the sessionOwner gate below — that gate encodes
      // the space-ownership semantics (stable HUB_AGENT_ID spaces span
      // sessions by design); the claw session is an audit-timeline grouping
      // and dies with the process regardless of identity stability.
      try {
        const { clawHarnessReporter } = await import(`${RUNTIME}/browser-mcp/src/tools/claw-reporter.js`);
        await clawHarnessReporter.endAllSessions('closed');
      } catch { /* best-effort; claw orphan cleanup is the backstop */ }
      if (sessionOwner) {
        const keep = process.env.HUB_SESSION_END_SPACES === 'keep';
        // A hung CDP close must never keep the exit pending — bounded wait,
        // ledger eviction inside closeSpace has already persisted by then or
        // the D8 TTL remains the backstop.
        await Promise.race([
          spaces.closeSpacesOwnedBy(sessionOwner, keep ? { keep } : undefined),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    } catch (err) {
      process.stderr.write('[hub-mcp] session space close failed: ' + (err?.message ?? String(err)) + '\n');
    } finally {
      process.exit(code);
    }
  }
  process.stdin.on('end', () => closeSessionSpacesAndExit(0));
  process.on('SIGINT', () => closeSessionSpacesAndExit(130));
  process.on('SIGTERM', () => closeSessionSpacesAndExit(143));
} else

// ─── Daemon mode ──────────────────────────────────────────────────
if (process.env.HUB_DAEMON === 'true') {
  // P1-4 phase C: process globals go through the centralized contract module
  // (imported before use — setDaemonMode must be initialized first).
  const { setDaemonMode, setDaemonFactory } = await import(`${RUNTIME}/opencli-engine/runtime-globals.js`);
  setDaemonMode();

  // Catch uncaught errors so the daemon doesn't silently crash.
  process.on('uncaughtException', (err) => {
    process.stderr.write("[hub-daemon] uncaughtException: " + (err?.stack ?? err) + "\n");
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write("[hub-daemon] unhandledRejection: " + (err?.stack ?? err) + "\n");
  });

  const { createServer } = await import('node:http');
  const { UnifiedBrowserFactory } = await import(`${RUNTIME}/factory.js`);
  const { createProgram } = await import(`${RUNTIME}/opencli-engine/cli.js`);
  const { rewriteBrowserArgv, escapeLeadingDashPositional } = await import(`${RUNTIME}/opencli-engine/cli-argv-preprocess.js`);
  const { createUserSourceReloader, hubUserRoot } = await import(`${RUNTIME}/opencli-engine/discovery.js`);
  const { emitHook } = await import(`${RUNTIME}/opencli-engine/hooks.js`);
  const { createCommandContext, runWithCommandContext } = await import(`${RUNTIME}/command-context.js`);

  const BUILTIN_CLIS = join(PROJECT_ROOT, 'clis');
  const USER_CLIS = join(hubUserRoot(), 'clis');
  // #35 follow-ups: the shared discovery/refresh unit (same one the MCP face
  // uses) — user clis AND plugins reload through fresh mirror paths, with
  // the hook map restored to the post-builtin snapshot so re-evaluated
  // modules don't accumulate stale-generation hook handlers.
  const reloader = createUserSourceReloader(BUILTIN_CLIS);

  let factory = null;
  let idleTimer = null;
  let discoveryDone = false;

  async function getFactory() {
    if (!factory) {
      const candidate = new UnifiedBrowserFactory();
      await candidate.connect();
      // Only cache a successfully connected factory — a failed startup restore
      // must not poison the lazy browser-command path.
      factory = candidate;
      setDaemonFactory(factory);
    }
    return factory;
  }

  // Phase 3 A: daemon startup + first successful browser connection trigger a
  // best-effort space restore. restore() is idempotent (persisted restored
  // markers), so a daemon restart never duplicates tabs that are still open in
  // Chrome. Never blocks or crashes the daemon: every failure is logged.
  let spacesRestored = false;
  async function ensureSpacesRestored() {
    if (spacesRestored) return;
    try {
      const {
        TaskSpaceManager,
        gatewayFromPage,
        defaultStoragePath,
      } = await import(`${RUNTIME}/space/task-space-manager.js`);
      const factory = await getFactory();
      const page = await factory.connect();
      const manager = new TaskSpaceManager({
        storagePath: process.env.HUB_SPACES_FILE || defaultStoragePath(),
        gateway: gatewayFromPage(page),
      });
      const restored = await manager.restore();
      spacesRestored = true;
      if (restored > 0) {
        process.stderr.write(`[hub-daemon] restored ${restored} space tab(s)\n`);
      }
    } catch (err) {
      process.stderr.write(`[hub-daemon] space restore skipped: ${err?.message ?? String(err)}\n`);
    }
  }

  // Run adapter discovery once (mirrors main.js startup sequence)
  async function ensureDiscovery() {
    if (discoveryDone) return;
    discoveryDone = true;
    try {
      await reloader.discoverAll();
    } catch (err) {
      process.stderr.write('[hub-daemon] discovery error: ' + (err?.message ?? String(err)) + '\n');
    }
  }

  // #11 + #35: the registry is cached in daemon memory, so sources written or
  // edited AFTER daemon startup need a pre-command check. Any change in the
  // user clis OR plugins tree re-imports both from a fresh mirror path — a
  // new URL re-evaluates the whole module graph, which re-importing from the
  // original path cannot do (ESM caches by URL). Builtin clis stay
  // startup-scoped — they only change with the package itself.
  async function refreshUserAdaptersIfChanged() {
    if (!discoveryDone) return;
    try {
      const result = await reloader.refreshIfChanged();
      if (result.changed) {
        const what = [
          result.clisChanged && 'clis',
          result.pluginsChanged && 'plugins',
        ].filter(Boolean).join('+');
        if (result.mirrorDegraded) {
          process.stderr.write(`[hub-daemon] user sources changed (${what}), re-discovered (reload mirror unavailable — edits to existing adapters still need a daemon restart)\n`);
        } else {
          process.stderr.write(`[hub-daemon] user sources changed (${what}), re-discovered\n`);
        }
      }
    } catch (err) {
      process.stderr.write('[hub-daemon] adapter refresh check failed: ' + (err?.message ?? String(err)) + '\n');
    }
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      process.stderr.write('[hub-daemon] idle timeout, exiting\n');
      // F17: close every claw working-period session this daemon started so
      // the cockpit timeline shows honest durations (bounded wait inside).
      try {
        const { clawHarnessReporter } = await import(`${RUNTIME}/browser-mcp/src/tools/claw-reporter.js`);
        await clawHarnessReporter.endAllSessions('closed');
      } catch { /* best-effort; claw orphan cleanup is the backstop */ }
      try { await factory?.close(); } catch {}
      process.exit(0);
    }, IDLE_TIMEOUT_MS);
  }
  // Same sweep when the daemon is asked to terminate (kill -9 still relies on
  // the browser-side reconcile-on-start orphan cleanup).
  process.on('SIGTERM', async () => {
    try {
      const { clawHarnessReporter } = await import(`${RUNTIME}/browser-mcp/src/tools/claw-reporter.js`);
      await clawHarnessReporter.endAllSessions('closed');
    } catch { /* best-effort */ }
    try { await factory?.close(); } catch {}
    process.exit(143);
  });

  // ── /command executor ────────────────────────────────────────────
  // The daemon is a shared process: every request executes inside an explicit
  // CommandContext (P1-3 part 2) — identity + output capture are scoped by
  // runWithCommandContext (which also bridges the per-command env for
  // cli.js's env-based LOCAL_SPACE_IDENTITY, bug #3). /command runs stay
  // serialized: console capture is process-global, only one context at a
  // time (true concurrency needs P3-4 process unification).
  let commandQueue = Promise.resolve();

  async function handleDaemonCommand(req, res) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let args;
    let commandEnv;
    try {
      const parsed = JSON.parse(body);
      args = parsed.args;
      commandEnv = parsed.env ?? {};
    } catch {
      res.end(JSON.stringify({ stdout: '', stderr: 'invalid JSON body', exitCode: 1 }));
      return;
    }

    // P1-3 part 2: explicit per-command context (identity + output capture +
    // env bridge), replacing the inline env mutation + console monkey-patch.
    const ctx = createCommandContext(commandEnv);
    const stdoutChunks = ctx.output.stdout;
    const stderrChunks = ctx.output.stderr;
    let exitCode = 0;

    await runWithCommandContext(ctx, async () => {
      try {
        // Run adapter discovery before parsing (mirrors main.js)
        await ensureDiscovery();
        // #11: pick up adapters written after daemon startup.
        await refreshUserAdaptersIfChanged();
        await emitHook('onStartup', { command: '__startup__', args: {} });

        // Rewrite argv: browser <session> <cmd> -> browser --session <name> <cmd>
        let rewritten = rewriteBrowserArgv(args);
        try {
          const manifestPath = join(BUILTIN_CLIS, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (Array.isArray(manifest))
              rewritten = escapeLeadingDashPositional(rewritten, manifest);
          }
        } catch { /* manifest unavailable; skip */ }

        // Create factory lazily (only needed for browser commands, not for list/init/etc)
        // We check if this is a browser command to avoid unnecessary CDP connection
        const isBrowserCmd = rewritten[0] === 'browser';
        if (isBrowserCmd) {
          await getFactory();
          // Phase 3 A: first successful browser connection is also a restore
          // trigger (boot attempt may have been skipped while CDP was down).
          void ensureSpacesRestored();
        }

        const program = createProgram(BUILTIN_CLIS, USER_CLIS);
        // exitOverride: re-throw CommanderError so catch block can extract exitCode.
        // Apply to program AND all subcommands recursively (subcommands inherit settings
        // at creation time, before exitOverride is set, so they still have null _exitCallback).
        const exitHandler = (err) => { throw err; };
        program.exitOverride(exitHandler);
        const applyExitOverride = (cmd) => {
          cmd._exitCallback = exitHandler;
          cmd.commands?.forEach(applyExitOverride);
        };
        program.commands.forEach(applyExitOverride);
        // configureOutput: redirect commander help/error text into capture buffers.
        program.configureOutput({
          writeOut: (str) => stdoutChunks.push(Buffer.from(str)),
          writeErr: (str) => stderrChunks.push(Buffer.from(str)),
        });
        await program.parseAsync(['node', 'hub', ...rewritten]);
        // Propagate process.exitCode set by commands (replay/space error paths)
        // into the HTTP response; reset it so a later command in this daemon
        // process starts from a clean slate.
        exitCode = process.exitCode ?? 0;
      } catch (err) {
        // CommanderError from --help has exitCode 0; real errors have exitCode 1+
        exitCode = err.exitCode ?? (err.code ?? 1);
        // Don't add commander help output to stderr (it was already captured via output.write)
        if (err.message && !err.code?.startsWith?.('commander.')) {
          stderrChunks.push(Buffer.from(err.message + '\n'));
        }
      } finally {
        process.exitCode = 0;
      }
    });

    // P2-2: the daemon command lands an audit row (source='daemon'). Output
    // CONTENT stays out (byte counts only — stdout can carry whole pages);
    // on failure the stderr head lands as the error. recordDispatch never
    // throws and self-degrades, so the HTTP response path is untouched.
    const { getAuditSink } = await import(`${RUNTIME}/audit/audit-log.js`);
    const stderrText = Buffer.concat(stderrChunks).toString('utf-8');
    getAuditSink().recordDispatch({
      convoId: ctx.identity.convoId,
      agentLabel: ctx.identity.displayName,
      source: 'daemon',
      toolName: `hub ${args
        .filter((a) => !String(a).startsWith('-'))
        .slice(0, 3)
        .join(' ')}`,
      args: { argv: args },
      resultMeta: {
        exitCode,
        stdoutBytes: Buffer.concat(stdoutChunks).length,
        stderrBytes: stderrText.length,
      },
      durationMs: Date.now() - ctx.startedAt,
      ok: exitCode === 0,
      ...(exitCode !== 0 && {
        error: stderrText.slice(0, 200).trim() || `exit code ${exitCode}`,
      }),
      createdAt: ctx.startedAt,
    });

    res.end(JSON.stringify({
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: stderrText,
      exitCode,
    }));
  }

  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok' }));
      resetIdleTimer();
      return;
    }

    if (req.method === 'POST' && req.url === '/command') {
      resetIdleTimer();
      // Serialize /command runs (one at a time): per-command env mutates
      // process.env and console capture is process-global, so concurrent
      // requests must not interleave (bug #3 — identity collapse).
      commandQueue = commandQueue
        .then(() => handleDaemonCommand(req, res))
        .catch((err) => {
          // Defensive: never leave the caller hanging or poison the queue.
          try {
            res.end(JSON.stringify({
              stdout: '',
              stderr: 'daemon command failed: ' + (err?.message ?? String(err)),
              exitCode: 1,
            }));
          } catch { /* response already sent */ }
        });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    process.stderr.write(`[hub-daemon] listening on http://127.0.0.1:${DAEMON_PORT}\n`);
    resetIdleTimer();
    // Phase 3 A: restore agent-owned space tabs as soon as the browser connects.
    // Fire-and-forget so daemon startup never waits on CDP or restore failures.
    void ensureSpacesRestored();
    // F17 backstop: end claw sessions left Live by previous processes that
    // died before their exit hook (kill -9 / crash). Stale-only; a live
    // concurrent process's session is protected by the last-activity check.
    void (async () => {
      try {
        const { clawHarnessReporter } = await import(`${RUNTIME}/browser-mcp/src/tools/claw-reporter.js`);
        const ended = await clawHarnessReporter.sweepStaleSessions();
        if (ended > 0) process.stderr.write(`[hub-daemon] claw orphan sweep ended ${ended} stale session(s)\n`);
        // Keep sweeping every 60s (official parity: the server's own
        // session_sweep_interval) — a startup-only sweep would leave a
        // kill -9 orphan Live for as long as a busy daemon never restarts.
        const sweepTimer = setInterval(() => {
          void clawHarnessReporter.sweepStaleSessions().catch(() => {});
        }, 60_000);
        sweepTimer.unref?.();
      } catch { /* best-effort */ }
    })();
  });

} else {
  // ─── CLI mode ──────────────────────────────────────────────────

  async function checkDaemon() {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function waitForDaemon(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await checkDaemon()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async function sendCommand(args) {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        args,
        // Pass through only the space-related env (bug #3): the caller's
        // identity + ledger path must reach the daemon, nothing else.
        env: {
          HUB_AGENT_ID: process.env.HUB_AGENT_ID,
          HUB_SPACES_FILE: process.env.HUB_SPACES_FILE,
        },
      }),
    });
    const result = await res.json();
    await writeAllAndExit(result.exitCode || 0, [
      [process.stdout, result.stdout],
      [process.stderr, result.stderr],
    ]);
  }

  async function spawnDaemon() {
    const { spawn } = await import('node:child_process');
    const proc = spawn(process.execPath, [__filename], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HUB_DAEMON: 'true' },
      cwd: PROJECT_ROOT,
    });
    proc.unref();
    return proc;
  }

  // Try daemon first; spawn if needed; fallback to direct execution
  if (await checkDaemon()) {
    await sendCommand(process.argv.slice(2));
  } else {
    await spawnDaemon();
    if (await waitForDaemon()) {
      await sendCommand(process.argv.slice(2));
    } else {
      // Fallback: run directly (no daemon, each command creates its own connection)
      await import(`${RUNTIME}/opencli-engine/main.js`);
    }
  }
}
