#!/usr/bin/env node
/**
 * hub-browser CLI entry point.
 *
 * Two modes:
 * 1. CLI (default): check if daemon is running -> HTTP forward; else spawn daemon then forward.
 * 2. Daemon (HUB_DAEMON=true): persistent process holding CDP connection + UnifiedPage singleton.
 *
 * Daemon uses the same CdpBackend from @browseros/browser-core as BrowserClaw's apps/server,
 * with built-in keepalive + auto-reconnect. Chrome supports multiple CDP clients simultaneously,
 * so daemon and apps/server can each maintain independent WebSocket connections to the same port.
 */

process.env.OPENCLI_BROWSER = 'claw';

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

const DAEMON_PORT = parseInt(process.env.HUB_DAEMON_PORT ?? '9300', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.HUB_DAEMON_IDLE_TIMEOUT ?? '300000', 10); // 5 min

// ─── Daemon mode ──────────────────────────────────────────────────
if (process.env.HUB_DAEMON === 'true') {
  globalThis.__HubDaemonMode = true;

  const { createServer } = await import('node:http');
  const { UnifiedBrowserFactory } = await import('../src/factory.ts');
  const { createProgram } = await import('../src/opencli-engine/cli.js');
  const { rewriteBrowserArgv, escapeLeadingDashPositional } = await import('../src/opencli-engine/cli-argv-preprocess.js');
  const { discoverClis, discoverPlugins, ensureUserCliCompatShims, ensureUserAdapters } = await import('../src/opencli-engine/discovery.js');
  const { emitHook } = await import('../src/opencli-engine/hooks.js');

  const BUILTIN_CLIS = join(PROJECT_ROOT, 'clis');
  const USER_CLIS = join(os.homedir(), '.opencli', 'clis');

  let factory = null;
  let idleTimer = null;
  let discoveryDone = false;

  async function getFactory() {
    if (!factory) {
      factory = new UnifiedBrowserFactory();
      await factory.connect();
      globalThis.__HubBrowserFactory = factory;
    }
    return factory;
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

  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok' }));
      resetIdleTimer();
      return;
    }

    if (req.method === 'POST' && req.url === '/command') {
      resetIdleTimer();
      let body = '';
      for await (const chunk of req) body += chunk;
      let args;
      try {
        args = JSON.parse(body).args;
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
        }

        const program = createProgram(BUILTIN_CLIS, USER_CLIS);
        // exitOverride: prevent commander from calling process.exit on --help or errors
        // Use a custom handler that captures output instead of throwing
        program.exitOverride({
          output: { write: (str) => stdoutChunks.push(Buffer.from(str)) },
          error: { write: (str) => stderrChunks.push(Buffer.from(str)) },
        });
        await program.parseAsync(['node', 'hub', ...rewritten]);
      } catch (err) {
        // CommanderError from --help has exitCode 0; real errors have exitCode 1+
        exitCode = err.exitCode ?? (err.code ?? 1);
        // Don't add commander help output to stderr (it was already captured via output.write)
        if (err.message && !err.code?.startsWith?.('commander.')) {
          stderrChunks.push(Buffer.from(err.message + '\n'));
        }
      } finally {
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
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    process.stderr.write(`[hub-daemon] listening on http://127.0.0.1:${DAEMON_PORT}\n`);
    resetIdleTimer();
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
      body: JSON.stringify({ args }),
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
      await import('../src/opencli-engine/main.js');
    }
  }
}
