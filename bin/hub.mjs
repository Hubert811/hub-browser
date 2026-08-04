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
 * Daemon uses the same CdpBackend from @browseros/browser-core as BrowserClaw's apps/server,
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
const __filename = fileURLToPath(import.meta.url);
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
const RUNTIME = `../${RUNTIME_BASE}`;

const DAEMON_PORT = parseInt(process.env.HUB_DAEMON_PORT ?? '9300', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.HUB_DAEMON_IDLE_TIMEOUT ?? '300000', 10); // 5 min

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
    // falls back to the MCP client name (clientInfo).
    identity: process.env.HUB_AGENT_ID
      ? { agentId: process.env.HUB_AGENT_ID, displayName: 'hub-browser mcp agent' }
      : undefined,
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
  // Keep the process alive while the stdio transport is connected.
  process.stdin.resume();
} else

// ─── Daemon mode ──────────────────────────────────────────────────
if (process.env.HUB_DAEMON === 'true') {
  globalThis.__HubDaemonMode = true;

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
  const { discoverClis, discoverPlugins, ensureUserCliCompatShims, ensureUserAdapters, hubUserRoot } = await import(`${RUNTIME}/opencli-engine/discovery.js`);
  const { emitHook } = await import(`${RUNTIME}/opencli-engine/hooks.js`);

  const BUILTIN_CLIS = join(PROJECT_ROOT, 'clis');
  const USER_CLIS = join(hubUserRoot(), 'clis');

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
      globalThis.__HubBrowserFactory = factory;
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
      const [, ,] = await Promise.all([
        ensureUserCliCompatShims(),
        ensureUserAdapters(),
        discoverClis(BUILTIN_CLIS),
      ]);
      await discoverClis(USER_CLIS);
      await discoverPlugins();
    } catch (err) {
      process.stderr.write('[hub-daemon] discovery error: ' + (err?.message ?? String(err)) + '\n');
    }
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      process.stderr.write('[hub-daemon] idle timeout, exiting\n');
      try { await factory?.close(); } catch {}
      process.exit(0);
    }, IDLE_TIMEOUT_MS);
  }

  // ── /command executor ────────────────────────────────────────────
  // The daemon is a shared process: every request applies per-command identity
  // env (HUB_AGENT_ID / HUB_SPACES_FILE) to process.env (bug #3 — identity
  // collapse), and the console-capture buffers are process-global, so /command
  // runs are serialized: only one command executes at a time.
  let commandQueue = Promise.resolve();

  /** Apply per-command space env; returns a restore() for the daemon's values. */
  function applyCommandEnv(env) {
    const saved = {
      HUB_AGENT_ID: process.env.HUB_AGENT_ID,
      HUB_SPACES_FILE: process.env.HUB_SPACES_FILE,
    };
    if (env?.HUB_AGENT_ID !== undefined) process.env.HUB_AGENT_ID = env.HUB_AGENT_ID;
    if (env?.HUB_SPACES_FILE !== undefined) process.env.HUB_SPACES_FILE = env.HUB_SPACES_FILE;
    return () => {
      if (saved.HUB_AGENT_ID === undefined) delete process.env.HUB_AGENT_ID;
      else process.env.HUB_AGENT_ID = saved.HUB_AGENT_ID;
      if (saved.HUB_SPACES_FILE === undefined) delete process.env.HUB_SPACES_FILE;
      else process.env.HUB_SPACES_FILE = saved.HUB_SPACES_FILE;
    };
  }

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

    // Capture stdout/stderr so we can return output to the CLI caller.
    const stdoutChunks = [];
    const stderrChunks = [];
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const origInfo = console.info;
    console.log = (...a) => { stdoutChunks.push(Buffer.from(a.join(' ') + '\n')); };
    console.error = (...a) => { stderrChunks.push(Buffer.from(a.join(' ') + '\n')); };
    console.warn = (...a) => { stderrChunks.push(Buffer.from(a.join(' ') + '\n')); };
    console.info = (...a) => { stdoutChunks.push(Buffer.from(a.join(' ') + '\n')); };
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => { stdoutChunks.push(Buffer.from(chunk)); return true; };
    process.stderr.write = (chunk) => { stderrChunks.push(Buffer.from(chunk)); return true; };

    // Apply the caller's space-related env for this command only (bug #3):
    // identity must follow the per-command HUB_AGENT_ID, not the daemon's.
    const restoreEnv = applyCommandEnv(commandEnv);
    let exitCode = 0;
    try {
      // Run adapter discovery before parsing (mirrors main.js)
      await ensureDiscovery();
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
      restoreEnv();
      process.exitCode = 0;
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      console.info = origInfo;
      process.stdout.write = origWrite;
      process.stderr.write = origErrWrite;
    }

    res.end(JSON.stringify({
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
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
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode || 0);
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
