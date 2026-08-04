#!/usr/bin/env node
/**
 * hub — Make any website your CLI. AI-powered.
 */
// Ensure standard system paths are available for child processes.
// Some environments (GUI apps, cron, IDE terminals) launch with a minimal PATH
// that excludes /usr/local/bin, /usr/sbin, etc., causing external CLIs to fail.
if (process.platform !== 'win32') {
    const std = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const cur = new Set((process.env.PATH ?? '').split(':').filter(Boolean));
    for (const p of std)
        cur.add(p);
    process.env.PATH = [...cur].join(':');
}
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompletionsFromManifest, hasAllManifests, printCompletionScriptFast } from './completion-fast.js';
import { getCliManifestPath, findPackageRoot } from './package-paths.js';
import { PKG_VERSION } from './version.js';
import { EXIT_CODES } from './errors.js';
import { isSupportedNodeVersion, MIN_SUPPORTED_NODE_MAJOR } from './runtime-detect.js';
import { isIgnorableDaemonPortEnv, unsupportedDaemonPortEnvMessage } from './constants.js';
import { hubUserRoot, migrateLegacyUserClis } from './discovery.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Adapters are JS-first and live at <package-root>/clis/.
// Resolve from the package root (walks up to the hubBrowserRoot package.json),
// NOT process.cwd(): the globally-installed `hub` must find its own clis/
// regardless of the caller's working directory. Works from src/ (dev) and
// dist/opencli-engine/ (published build) alike.
const BUILTIN_CLIS = path.join(findPackageRoot(__filename), 'clis');
// User adapters live under the product-owned root (方案 C): <root>/clis
// (default root: ~/.hub; BROWSEROS_DIR overrides).
const USER_CLIS = path.join(hubUserRoot(), 'clis');
// ── Ultra-fast path: lightweight commands bypass full discovery ──────────
// These are high-frequency or trivial paths that must not pay the startup tax.
const argv = process.argv.slice(2);
if (typeof globalThis.Bun === 'undefined' && !isSupportedNodeVersion(process.version)) {
    process.stderr.write([
        `OpenCLI requires Node.js >= ${MIN_SUPPORTED_NODE_MAJOR}.0.0.`,
        `Current runtime: ${process.version}`,
        'Upgrade Node.js, then retry the same command.',
        '',
    ].join('\n'));
    process.exit(EXIT_CODES.CONFIG_ERROR);
}
if (!isIgnorableDaemonPortEnv(process.env.OPENCLI_DAEMON_PORT)) {
    process.stderr.write(`error: ${unsupportedDaemonPortEnvMessage(process.env.OPENCLI_DAEMON_PORT)}\n`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
}
// Fast path: --version (only when it's the top-level intent, not passed to a subcommand)
// e.g. `hub --version` or `hub -V`, but NOT `hub gh --version`
if (argv[0] === '--version' || argv[0] === '-V') {
    process.stdout.write(PKG_VERSION + '\n');
    process.exit(EXIT_CODES.SUCCESS);
}
// Fast path: completion <shell> — print shell script without discovery
if (argv[0] === 'completion' && argv.length >= 2) {
    if (printCompletionScriptFast(argv[1])) {
        process.exit(EXIT_CODES.SUCCESS);
    }
    // Unknown shell — fall through to full path for proper error handling
}
// Fast path: --get-completions — read from manifest, skip discovery
const getCompIdx = process.argv.indexOf('--get-completions');
if (getCompIdx !== -1) {
    // Only include manifests that actually exist on disk.
    // With sparse override, the user clis dir may exist but have no manifest.
    const manifestPaths = [getCliManifestPath(BUILTIN_CLIS)];
    const userManifest = getCliManifestPath(USER_CLIS);
    try {
        fs.accessSync(userManifest);
        manifestPaths.push(userManifest);
    }
    catch { /* no user manifest */ }
    if (hasAllManifests(manifestPaths)) {
        const rest = process.argv.slice(getCompIdx + 1);
        let cursor;
        const words = [];
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '--cursor' && i + 1 < rest.length) {
                cursor = parseInt(rest[i + 1], 10);
                i++;
            }
            else {
                words.push(rest[i]);
            }
        }
        if (cursor === undefined)
            cursor = words.length;
        const candidates = getCompletionsFromManifest(words, cursor, manifestPaths);
        process.stdout.write(candidates.join('\n') + '\n');
        process.exit(EXIT_CODES.SUCCESS);
    }
    // No manifest — fall through to full discovery path below
}
// ── Full startup path ───────────────────────────────────────────────────
// Dynamic imports: these are deferred so the fast path above never pays the cost.
const { discoverClis, discoverPlugins, ensureUserCliCompatShims, ensureUserAdapters } = await import('./discovery.js');
const { getCompletions } = await import('./completion.js');
const { runCli } = await import('./cli.js');
const { emitHook } = await import('./hooks.js');
const { installNodeNetwork } = await import('./node-network.js');
const { registerUpdateNoticeOnExit, checkForUpdateBackground } = await import('./update-check.js');
installNodeNetwork();
// Parallelise independent startup I/O:
//  - Built-in adapter discovery has no dependency on user-dir setup.
//  - ensureUserCliCompatShims and ensureUserAdapters operate on different paths
//    (<root>/node_modules/ vs <root>/clis/ + adapter-manifest.json).
//  - registerCommand() overwrites on name collision (see registry.ts), so
//    user-CLI discovery MUST run after built-in discovery to preserve the
//    intended override order (user adapters override built-in ones).
//  - discoverPlugins runs last: plugins may override both built-in and user CLIs.
const skipUserDiscovery = argv[0] === 'convention-audit';
if (skipUserDiscovery) {
    await discoverClis(BUILTIN_CLIS);
}
else {
    // Parallelise independent startup I/O. migrateLegacyUserClis() is a
    // best-effort one-time copy of ~/.opencli/clis/ → <root>/clis/ and must
    // not block startup on failure.
    const [, , ,] = await Promise.all([
        ensureUserCliCompatShims(),
        ensureUserAdapters(),
        migrateLegacyUserClis(),
        discoverClis(BUILTIN_CLIS),
    ]);
    await discoverClis(USER_CLIS);
    await discoverPlugins();
}
// Register exit hook: notice appears after command output (same as npm/gh/yarn)
registerUpdateNoticeOnExit();
// Kick off background fetch for next run (non-blocking)
checkForUpdateBackground();
// ── Fallback completion: manifest unavailable, use full registry ─────────
if (getCompIdx !== -1) {
    const rest = process.argv.slice(getCompIdx + 1);
    let cursor;
    const words = [];
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--cursor' && i + 1 < rest.length) {
            cursor = parseInt(rest[i + 1], 10);
            i++;
        }
        else {
            words.push(rest[i]);
        }
    }
    if (cursor === undefined)
        cursor = words.length;
    const candidates = getCompletions(words, cursor);
    process.stdout.write(candidates.join('\n') + '\n');
    process.exit(EXIT_CODES.SUCCESS);
}
// Rewrite `hub browser <session> <subcommand> ...` so commander (which
// can't combine a parent positional with subcommand dispatch) sees the internal
// `--session <name>` flag form. Also refuses the retired `hub browser
// --session foo ...` user form with a friendly usage error.
const { rewriteBrowserArgv, BrowserSessionArgvError, escapeLeadingDashPositional } = await import('./cli-argv-preprocess.js');
try {
    let rewritten = rewriteBrowserArgv(process.argv.slice(2));
    // Insert a `--` separator before a required positional whose value starts
    // with `-` (e.g. BOSS 直聘 securityId tokens; #1160). Skipped when the
    // manifest is unavailable so the user-cli / dev paths still work.
    try {
        const manifestPath = getCliManifestPath(BUILTIN_CLIS);
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (Array.isArray(manifest))
                rewritten = escapeLeadingDashPositional(rewritten, manifest);
        }
    }
    catch { /* manifest unavailable; skip the dash escape */ }
    process.argv.splice(2, process.argv.length - 2, ...rewritten);
}
catch (err) {
    if (err instanceof BrowserSessionArgvError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(EXIT_CODES.GENERIC_ERROR);
    }
    throw err;
}
await emitHook('onStartup', { command: '__startup__', args: {} });
runCli(BUILTIN_CLIS, USER_CLIS);
