/**
 * Dogfooding battle 9 follow-up (bug #35, 2026-08-31): daemon-side adapter
 * edits never took effect. discoverClisFromFs imports each adapter via
 * `import(pathToFileURL(filePath).href)` — ESM caches modules by URL, so the
 * mtime-signature refresh (#11: "user adapters changed, re-discovered") only
 * ever worked for NEW files (new URL = fresh module). Editing an existing
 * file logged a successful re-discovery and then silently executed the OLD
 * code; only killing the daemon helped. Query-busting the entry URL cannot
 * fix it (the entry's './lib' imports resolve back to clean URLs, so the
 * dependency chain stays cached — and bun 1.3.x exposes no module
 * invalidation API at all).
 *
 * Fix under test: buildFreshCliMirror() copies the user clis tree to a fresh
 * generation path; importing from a new URL re-evaluates the WHOLE graph.
 * The money assertion is that an edit to lib.js — NOT the entry — surfaces.
 *
 * The site dir lives inside the repo so '@jackwener/opencli' resolves through
 * the repo node_modules symlink, exactly like ~/.hub/clis does through the
 * <root> shim. Module re-evaluation is observed via an import side-effect
 * log; the "new handler actually runs" proof is the live-daemon E2E.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClis, buildFreshCliMirror } from '../src/opencli-engine/discovery.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB_MJS_SRC = readFileSync(new URL('../bin/hub.mjs', import.meta.url), 'utf-8');

// Site name unique to this test; the adapter's cli() registers into the
// engine registry of this test process and dies with it.
const SITE = 'probe35';

function writeLib(clisDir, version) {
    mkdirSync(join(clisDir, SITE), { recursive: true });
    writeFileSync(join(clisDir, SITE, 'lib.js'), `export const VERSION = ${JSON.stringify(version)}\n`);
}

function writeEntry(clisDir, logPath) {
    // The entry appends its lib VERSION to the log at import time. The
    // absolute path is embedded so the original AND the mirror copies of
    // this module all append to ONE log.
    writeFileSync(join(clisDir, SITE, 'entry.js'), [
        `import { appendFileSync } from 'node:fs'`,
        `import { cli } from '@jackwener/opencli/registry'`,
        `import { VERSION } from './lib.js'`,
        `appendFileSync(${JSON.stringify(logPath)}, VERSION + '\\n')`,
        `cli({ site: ${JSON.stringify(SITE)}, name: 'echo', description: 'bug35 probe', access: 'read', browser: false, args: [], func: async (kwargs) => [{ result: VERSION }] })`,
    ].join('\n'));
}

function readLog(logPath) {
    return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
}

describe('adapter reload (bug #35)', () => {
    it('re-importing an edited adapter from its original path is a silent no-op', async () => {
        const tmp = mkdtempSync(join(REPO_ROOT, '.bug35-'));
        const clisDir = join(tmp, 'clis');
        const logPath = join(tmp, 'imported.log');
        writeLib(clisDir, 'v1');
        writeEntry(clisDir, logPath);
        try {
            await discoverClis(clisDir);
            expect(readLog(logPath)).toEqual(['v1']);
            // Edit the LIB — ESM's URL cache means this re-discovery runs the
            // cached module graph and the edit stays invisible (#35 repro).
            writeLib(clisDir, 'v2');
            await discoverClis(clisDir);
            expect(readLog(logPath)).toEqual(['v1']);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('buildFreshCliMirror re-evaluates the whole graph, lib edits included', async () => {
        const tmp = mkdtempSync(join(REPO_ROOT, '.bug35-'));
        const clisDir = join(tmp, 'clis');
        const logPath = join(tmp, 'imported.log');
        const mirrorRoot = join(tmp, 'mirror');
        writeLib(clisDir, 'v1');
        writeEntry(clisDir, logPath);
        try {
            await discoverClis(clisDir);
            expect(readLog(logPath)).toEqual(['v1']);

            writeLib(clisDir, 'v2');
            const mirror = await buildFreshCliMirror(clisDir, mirrorRoot);
            expect(typeof mirror).toBe('string');
            expect(readFileSync(join(mirror, SITE, 'lib.js'), 'utf-8')).toContain('v2');
            await discoverClis(mirror);
            expect(readLog(logPath)).toEqual(['v1', 'v2']);

            // Second generation: another edit, another fresh path, and only
            // one live generation under the mirror root (prune on rebuild).
            writeLib(clisDir, 'v3');
            const mirror2 = await buildFreshCliMirror(clisDir, mirrorRoot);
            expect(typeof mirror2).toBe('string');
            expect(mirror2).not.toBe(mirror);
            await discoverClis(mirror2);
            expect(readLog(logPath)).toEqual(['v1', 'v2', 'v3']);
            expect(readdirSync(mirrorRoot)).toHaveLength(1);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('mirror degrades to null when the clis dir is absent', async () => {
        const tmp = mkdtempSync(join(REPO_ROOT, '.bug35-'));
        try {
            expect(await buildFreshCliMirror(join(tmp, 'nope'), join(tmp, 'mirror'))).toBeNull();
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('hub.mjs refresh imports from the mirror with a legacy fallback', () => {
        const refresh = HUB_MJS_SRC.slice(
            HUB_MJS_SRC.indexOf('async function refreshUserAdaptersIfChanged'),
            HUB_MJS_SRC.indexOf('function resetIdleTimer'),
        );
        expect(refresh).toContain('buildFreshCliMirror(USER_CLIS)');
        expect(refresh).toContain('discoverClis(mirrorDir ?? USER_CLIS)');
        // The fallback must be honest about what it cannot do.
        expect(refresh).toContain('edits to existing adapters still need a daemon restart');
    });
});
