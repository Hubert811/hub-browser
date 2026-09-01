/**
 * #35 follow-ups (2026-08-31): the reload unit promoted into discovery.js as
 * createUserSourceReloader, shared by the daemon and the MCP server. Covers
 * the three leftovers the original #35 fix left open:
 *
 *  1. the MCP face discovered adapters once per process — no refresh at all,
 *     so an edit while the server ran was invisible until restart;
 *  2. plugins were startup-scoped in every face (#11 only covered clis);
 *  3. a mirror reload re-evaluates modules, which register NEW hook function
 *     objects — addHook dedupes by identity, so stale-generation handlers
 *     accumulate forever unless the hook map is restored to the post-builtin
 *     snapshot on every reload.
 *
 * It also locks in the removal of execution.js's in-band `?t=` query-bust:
 * user-level manifests do not exist (nothing writes <root>/cli-manifest.json),
 * so that path was unreachable — and query-busting the entry could never
 * refresh its './lib' chain anyway (mixed old/new state).
 *
 * Trees live under REPO_ROOT so '@jackwener/opencli' resolves through the
 * repo node_modules link, exactly like ~/.hub/clis does through the <root>
 * shim that discoverAll() creates. Registry and hooks are globalThis-backed,
 * so modules registered via the dist-facing shim are visible to these
 * src-side imports.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, utimesSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserSourceReloader } from '../src/opencli-engine/discovery.js';
import { getRegistry } from '../src/opencli-engine/registry.js';
import { emitHook } from '../src/opencli-engine/hooks.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB_MJS_SRC = readFileSync(new URL('../bin/hub.mjs', import.meta.url), 'utf-8');
const ADAPTER_TOOLS_SRC = readFileSync(new URL('../src/browser-mcp/src/tools/adapter-tools.ts', import.meta.url), 'utf-8');
const EXECUTION_SRC = readFileSync(new URL('../src/opencli-engine/execution.js', import.meta.url), 'utf-8');

const SITE = 'probeR';
const PLUGIN = 'probeP';

function makeRoot() {
    const root = mkdtempSync(join(REPO_ROOT, '.usrsrc-'));
    mkdirSync(join(root, 'clis', SITE), { recursive: true });
    return root;
}

function writeAdapterLib(root, version) {
    writeFileSync(join(root, 'clis', SITE, 'lib.js'), `export const VERSION = ${JSON.stringify(version)}\n`);
}

function writeAdapterEntry(root, logPath) {
    // The entry registers a hook AND a command: the hook proves the snapshot
    // restore (no accumulation across generations), the command proves the
    // new code actually executes.
    writeFileSync(join(root, 'clis', SITE, 'entry.js'), [
        `import { appendFileSync } from 'node:fs'`,
        `import { cli, onBeforeExecute } from '@jackwener/opencli/registry'`,
        `import { VERSION } from './lib.js'`,
        `appendFileSync(${JSON.stringify(logPath)}, 'import:' + VERSION + '\\n')`,
        `onBeforeExecute(() => { appendFileSync(${JSON.stringify(logPath)}, 'hook:' + VERSION + '\\n') })`,
        `cli({ site: ${JSON.stringify(SITE)}, name: 'echo', description: 'reload probe', access: 'read', browser: false, args: [], func: async () => [{ result: VERSION }] })`,
    ].join('\n'));
}

function writePlugin(root, logPath, version) {
    const pluginDir = join(root, 'plugins', PLUGIN);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'lib.js'), `export const VERSION = ${JSON.stringify(version)}\n`);
    writeFileSync(join(pluginDir, 'main.js'), [
        `import { appendFileSync } from 'node:fs'`,
        `import { cli } from '@jackwener/opencli/registry'`,
        `import { VERSION } from './lib.js'`,
        `appendFileSync(${JSON.stringify(logPath)}, 'plugin-import:' + VERSION + '\\n')`,
        `cli({ site: ${JSON.stringify(PLUGIN)}, name: 'ping', description: 'plugin reload probe', access: 'read', browser: false, args: [], func: async () => [{ result: VERSION }] })`,
    ].join('\n'));
}

function readLog(logPath) {
    return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
}

// Same-second writes can be invisible to mtimeMs signatures (#11 lesson):
// push the edited files safely into the future of the last snapshot.
function touchFuture(...files) {
    const future = new Date(Date.now() + 2000);
    for (const file of files)
        utimesSync(file, future, future);
}

function makeReloader(root) {
    return createUserSourceReloader(join(root, 'builtin'), {
        clisDir: join(root, 'clis'),
        pluginsDir: join(root, 'plugins'),
    });
}

describe('user source reload (#35 follow-ups)', () => {
    it('an adapter edit reloads the tree and hook handlers do NOT accumulate', async () => {
        const root = makeRoot();
        const logPath = join(root, 'log');
        writeAdapterLib(root, 'v1');
        writeAdapterEntry(root, logPath);
        try {
            const reloader = makeReloader(root);
            await reloader.discoverAll();
            expect(readLog(logPath)).toEqual(['import:v1']);
            await emitHook('onBeforeExecute', { command: 'x', args: {} });
            expect(readLog(logPath)).toEqual(['import:v1', 'hook:v1']);

            writeAdapterLib(root, 'v2');
            touchFuture(join(root, 'clis', SITE, 'lib.js'));
            const result = await reloader.refreshIfChanged();
            expect(result).toEqual({
                changed: true,
                clisChanged: true,
                pluginsChanged: false,
                mirrorDegraded: false,
            });
            // Whole graph re-evaluated from the mirror…
            expect(readLog(logPath)).toEqual(['import:v1', 'hook:v1', 'import:v2']);
            // …and exactly ONE handler fires now. Without the snapshot
            // restore the v1 handler would still be registered (new fn
            // objects dedupe nothing) and this emit would append twice.
            await emitHook('onBeforeExecute', { command: 'x', args: {} });
            expect(readLog(logPath)).toEqual(['import:v1', 'hook:v1', 'import:v2', 'hook:v2']);
            // The money proof: the executing command comes from the new code.
            expect(await getRegistry().get(`${SITE}/echo`)?.func({}, false)).toEqual([{ result: 'v2' }]);
            // One live mirror generation, pruned on rebuild.
            expect(readdirSync(join(root, '.adapter-reload'))).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a plugin edit is picked up without a restart (previously startup-scoped)', async () => {
        const root = makeRoot();
        const logPath = join(root, 'log');
        writeAdapterLib(root, 'v1');
        writeAdapterEntry(root, logPath);
        writePlugin(root, logPath, 'v1');
        try {
            const reloader = makeReloader(root);
            await reloader.discoverAll();
            expect(await getRegistry().get(`${PLUGIN}/ping`)?.func({}, false)).toEqual([{ result: 'v1' }]);

            writePlugin(root, logPath, 'v2');
            touchFuture(join(root, 'plugins', PLUGIN, 'lib.js'));
            const result = await reloader.refreshIfChanged();
            expect(result).toEqual({
                changed: true,
                clisChanged: false,
                pluginsChanged: true,
                mirrorDegraded: false,
            });
            // One reload unit: the plugin edit re-evaluates the UNCHANGED
            // clis tree too (documented semantics — hooks must stay
            // consistent, see discovery.js).
            expect(await getRegistry().get(`${PLUGIN}/ping`)?.func({}, false)).toEqual([{ result: 'v2' }]);
            expect(readLog(logPath).filter((line) => line === 'import:v1')).toHaveLength(2);
            expect(readdirSync(join(root, '.plugin-reload'))).toHaveLength(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('refresh is a no-op when nothing changed, and before initial discovery', async () => {
        const root = makeRoot();
        const logPath = join(root, 'log');
        writeAdapterLib(root, 'v1');
        writeAdapterEntry(root, logPath);
        try {
            const reloader = makeReloader(root);
            expect(await reloader.refreshIfChanged()).toEqual({ changed: false });
            await reloader.discoverAll();
            expect(await reloader.refreshIfChanged()).toEqual({ changed: false });
            expect(readLog(logPath)).toEqual(['import:v1']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('both long-lived faces run the shared reloader; execution.js no longer query-busts', () => {
        // Daemon: constructs the shared unit and refreshes before parse.
        expect(HUB_MJS_SRC).toContain('createUserSourceReloader(BUILTIN_CLIS)');
        const refresh = HUB_MJS_SRC.slice(
            HUB_MJS_SRC.indexOf('async function refreshUserAdaptersIfChanged'),
            HUB_MJS_SRC.indexOf('function resetIdleTimer'),
        );
        expect(refresh).toContain('reloader.refreshIfChanged()');
        // The fallback must stay honest about what it cannot do.
        expect(refresh).toContain('edits to existing adapters still need a daemon restart');
        expect(HUB_MJS_SRC).toContain('await refreshUserAdaptersIfChanged()');

        // MCP face: discovery + per-call refresh in ensureAdapterDiscovery.
        const ensure = ADAPTER_TOOLS_SRC.slice(
            ADAPTER_TOOLS_SRC.indexOf('export function ensureAdapterDiscovery'),
            ADAPTER_TOOLS_SRC.indexOf('/** Canonical commands of one site'),
        );
        expect(ensure).toContain('adapterReloader.discoverAll()');
        expect(ensure).toContain('adapterReloader.refreshIfChanged()');

        // The in-band query-bust half-fix is gone (it refreshed the entry
        // but left the './lib' chain cached); lazy loading itself stays.
        expect(EXECUTION_SRC).not.toContain('?t=${Date.now()}');
        expect(EXECUTION_SRC).toContain('_loadedModules');
    });
});
