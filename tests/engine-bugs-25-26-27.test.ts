/**
 * Dogfooding battle 9 (ZKH ESP recon, 2026-08-31) — engine defects #25/#26/#27:
 *
 *  Bug #25  `wait xhr` matched stale ring entries — the standard
 *           "click → wait xhr → read payload" idiom latched onto the previous
 *           action's request and handed back zero-ms "success" with wrong data.
 *           Round 2 (same evening): the strict gate also killed the idiom
 *           itself (the request lands ~250ms into the click, before the wait
 *           starts) — `--since <dur>` widens the gate to a relative window.
 *  Bug #26  process.exit() right after process.stdout.write dropped >64KB of
 *           piped stdout — agents consuming `hub browser ... | jq` got invalid
 *           JSON. Round 2: the fix only covered cli.js's exits, but every
 *           agent command exits through hub.mjs's sendCommand forward; and
 *           the writableLength===0 fast path lies on Bun (reports 0 with
 *           ~450KB still queued). Both fixed here.
 *  Bug #27  snapshot({compact:true}) was declared but never threaded through
 *           any path — DOM, AX, CLI, and MCP all silently returned the full view.
 *
 * #25 is verified by structure (the wait loop gates on anchorTs; --since
 * computes it from a relative window); #26 by an end-to-end child-process pipe
 * measurement that EXECUTES THE REAL helper extracted from cli.js (the round-1
 * test inlined a console.log variant that Bun sync-flushes — it never touched
 * the bug); #27 by the pure compactSnapshotText transform plus threading checks.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactSnapshotText } from '../src/opencli/snapshotFormatter.js';

const CLI_SRC = readFileSync(new URL('../src/opencli-engine/cli.js', import.meta.url), 'utf-8');
const HUB_MJS_SRC = readFileSync(new URL('../bin/hub.mjs', import.meta.url), 'utf-8');
const OBS_QUERY_SRC = readFileSync(new URL('../src/opencli-engine/browser/observation-query.js', import.meta.url), 'utf-8');

// Extract a top-level function body from formatted source (inner braces stay
// indented; only the function's own closing brace sits at column 0).
function extractFunction(source, name) {
    const re = new RegExp(`(?:async )?function ${name}\\(`);
    const m = re.exec(source);
    if (!m)
        throw new Error(`${name} not found`);
    const end = source.indexOf('\n}', m.index);
    return source.slice(m.index, end + 2);
}

// ── Bug #25: wait xhr freshness gate + --since window (structure) ──────────

describe('wait xhr freshness (bug #25)', () => {
    it('the wait-xhr match loop gates entries on the anchor timestamp', () => {
        // Bug #34 moved the anchor + poll + timestamp filter into
        // observation-query.js's waitForNetworkEntry so adapters driving the
        // page API run the same code the CLI exercises. The stale-match
        // contract: entries already in the ring when the wait begins must
        // not satisfy it (bare-wait honesty).
        expect(OBS_QUERY_SRC).toContain('export async function waitForNetworkEntry');
        const helper = extractFunction(OBS_QUERY_SRC, 'waitForNetworkEntry');
        expect(helper).toContain('const anchorTs = opts.sinceMs != null ? startTs - opts.sinceMs : startTs');
        expect(helper).toContain('Number(e.timestamp ?? 0) >= anchorTs');
        expect(helper).toContain('while (Date.now() < deadline && !matched)');
    });

    it('the CLI wait command routes through the shared primitive, no private loop', () => {
        // Round 3 (bug #34): the CLI must not keep a second copy of the loop.
        expect(CLI_SRC).toContain('await waitForNetworkEntry(page, value, {');
        expect(CLI_SRC).not.toContain('const anchorTs = sinceMs ? startTs - sinceMs : startTs');
    });

    it('the strict default gate is widened by --since, not replaced', () => {
        // Round 2: the click → wait idiom's request lands BEFORE the wait
        // starts, so the strict gate rejected the very request the agent
        // awaited. --since shifts the anchor back by a relative window.
        expect(CLI_SRC).toContain("option('--since <duration>'");
        // Bare waits keep the honest stale message.
        expect(CLI_SRC).toContain('requests observed before this wait began are not counted');
        // And the failure hint now teaches the idiom's escape hatch.
        expect(CLI_SRC).toContain('pass --since 30s');
    });
});

// ── Bug #26: piped stdout drain before exit (end-to-end, real helper) ──────

describe('flushAndExit pipe drain (bug #26)', () => {
    it('large process.stdout.write output survives exit on a pipe — via the REAL cli.js helper', async () => {
        // Round 1's test inlined a console.log variant: Bun sync-flushes
        // console.log, so the bug never fired and the test proved nothing.
        // Round 2 additionally proved write('', cb) does NOT drain on Bun
        // (empty-write callback fires immediately; 65536 bytes delivered).
        // cli.js now exits NATURALLY (pending writes hold the loop until
        // flushed) with an unref'd hard-exit backstop — execute the real
        // helper here and measure what a PIPE consumer receives.
        const helper = extractFunction(CLI_SRC, 'flushAndExit');
        const script = `${helper}
process.stdout.write('x'.repeat(500000));
await flushAndExit(0);
`;
        const dir = mkdtempSync(join(tmpdir(), 'hub-flush-test-'));
        const scriptPath = join(dir, 'flush-probe.mjs');
        writeFileSync(scriptPath, script);
        try {
            const child = spawn(process.execPath, [scriptPath]);
            let bytes = 0;
            child.stdout.on('data', (d) => { bytes += d.length; });
            const exitCode = await new Promise<number | null>((r) => child.on('close', r));
            // The unfixed path delivered 65536; so did the round-2 write('')
            // drain on Bun. Natural exit delivers the full payload.
            expect(bytes).toBe(500000);
            expect(exitCode).toBe(0);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20000);

    it('the cli.js helper exits naturally with an unref\'d hard-exit backstop', () => {
        const helper = extractFunction(CLI_SRC, 'flushAndExit');
        // Neither Bun queue probe is trusted (both lie on Bun).
        expect(helper).not.toContain('writableLength');
        expect(helper).not.toContain("write(''");
        // Natural exit: exitCode is set, the only hard exit sits inside the
        // 2s backstop timer, and the timer is unref'd.
        expect(helper).toContain('process.exitCode = code');
        expect(helper).toMatch(/setTimeout\(\(\) => process\.exit\(code\), 2000\)/);
        expect(helper).toContain('unref');
    });

    it('the real CLI exit paths call flushAndExit, not process.exit', () => {
        expect(CLI_SRC).toContain('async function flushAndExit');
        expect(CLI_SRC).not.toContain('process.exit(process.exitCode || 0)');
    });

    it('hub.mjs awaits the data writes themselves — via the REAL writeAllAndExit helper', async () => {
        // hub.mjs is the path EVERY agent command takes (daemon forward);
        // its output is written with process.stdout.write, which Bun only
        // drains via the write's own callback.
        const helper = extractFunction(HUB_MJS_SRC, 'writeAllAndExit');
        const script = `${helper}
await writeAllAndExit(0, [[process.stdout, 'x'.repeat(500000)], [process.stderr, '']]);
`;
        const dir = mkdtempSync(join(tmpdir(), 'hub-flush-test-'));
        const scriptPath = join(dir, 'flush-probe.mjs');
        writeFileSync(scriptPath, script);
        try {
            const child = spawn(process.execPath, [scriptPath]);
            let bytes = 0;
            child.stdout.on('data', (d) => { bytes += d.length; });
            const exitCode = await new Promise<number | null>((r) => child.on('close', r));
            expect(bytes).toBe(500000);
            expect(exitCode).toBe(0);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20000);

    it('hub.mjs routes sendCommand and --llm-txt through writeAllAndExit (round-2 root cause)', () => {
        const helper = extractFunction(HUB_MJS_SRC, 'writeAllAndExit');
        expect(helper).not.toContain('writableLength');
        expect(helper).toContain('stream.write(chunk, resolve)');
        // The daemon-forward exit passes BOTH result.stdout and result.stderr.
        expect(HUB_MJS_SRC).toContain('await writeAllAndExit(result.exitCode || 0, [');
        expect(HUB_MJS_SRC).toContain('[process.stdout, result.stdout]');
        expect(HUB_MJS_SRC).toContain('[process.stderr, result.stderr]');
        // --llm-txt's big text output routes through it too.
        expect(HUB_MJS_SRC).toContain("await writeAllAndExit(0, [[process.stdout, parts.join('\\n') + '\\n']])");
        // The old write-then-exit shape is gone entirely.
        expect(HUB_MJS_SRC).not.toContain('process.exit(result.exitCode || 0)');
    });
});

// ── Bug #27: compact snapshot threading ────────────────────────────────────

describe('snapshot compact (bug #27)', () => {
    it('compactSnapshotText strips ref annotations and collapses whitespace', () => {
        const raw = [
            '  - generic "Order list"',
            '  - textbox "Start date" [ref=e62]: "2026-08-01"',
            '  - button "Search" [ref=e63] [cursor=pointer]',
            '',
            '   - link "Next page" [ref=e64]',
        ].join('\n');
        const compacted = compactSnapshotText(raw);
        expect(compacted).toBe([
            '- generic "Order list"',
            '- textbox "Start date": "2026-08-01"',
            '- button "Search"',
            '- link "Next page"',
        ].join('\n'));
        // Assertion value must survive compaction — the standard's use case.
        expect(compacted).toContain('"2026-08-01"');
    });

    it('empty input passes through', () => {
        expect(compactSnapshotText('')).toBe('');
    });

    it('DOM path threads compact (base-page snapshot)', () => {
        const src = readFileSync(new URL('../src/opencli/base-page.ts', import.meta.url), 'utf-8');
        expect(src).toContain('if (opts.compact && typeof result === \'string\') return compactSnapshotText(result)');
    });

    it('AX path threads compact (UnifiedPage snapshot)', () => {
        const src = readFileSync(new URL('../src/page.ts', import.meta.url), 'utf-8');
        expect(src).toContain('opts?.compact ? compactSnapshotText(text) : text');
    });

    it('MCP snapshot tool exposes the compact parameter', () => {
        const src = readFileSync(new URL('../src/browser-mcp/src/tools/snapshot.ts', import.meta.url), 'utf-8');
        expect(src).toContain('compact: z');
    });
});
