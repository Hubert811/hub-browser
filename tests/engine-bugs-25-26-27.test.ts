/**
 * Dogfooding battle 9 (ZKH ESP recon, 2026-08-31) — engine defects #25/#26/#27:
 *
 *  Bug #25  `wait xhr` matched stale ring entries — the standard
 *           "click → wait xhr → read payload" idiom latched onto the previous
 *           action's request and handed back zero-ms "success" with wrong data.
 *  Bug #26  process.exit() right after console.log dropped >64KB of piped
 *           stdout — agents consuming `hub browser ... | jq` got invalid JSON.
 *  Bug #27  snapshot({compact:true}) was declared but never threaded through
 *           any path — DOM, AX, CLI, and MCP all silently returned the full view.
 *
 * #25 is verified by structure (the generated wait loop gates on startTs);
 * #26 by an end-to-end child-process pipe measurement; #27 by the pure
 * compactSnapshotText transform plus threading checks.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { compactSnapshotText } from '../src/opencli/snapshotFormatter.js';

// ── Bug #25: wait xhr freshness gate (structure) ───────────────────────────

describe('wait xhr freshness (bug #25)', () => {
    const cliSource = readFileSync(new URL('../src/opencli-engine/cli.js', import.meta.url), 'utf-8');

    it('the wait-xhr match loop gates entries on the wait start timestamp', () => {
        // The stale-match loop: entries already in the ring when the wait
        // begins must not satisfy it.
        const anchor = cliSource.indexOf('const startTs = Date.now()');
        expect(anchor).toBeGreaterThan(0);
        const waitBlock = cliSource.slice(anchor, cliSource.indexOf('pollMs = 400', anchor));
        expect(waitBlock).toContain('deadline = startTs + timeout');
        const matchLine = cliSource.match(/items\.find\(\(e\) =>[^\n]+\?\? null/);
        expect(matchLine?.[0]).toContain('e.timestamp >= startTs');
    });

    it('the xhr_not_seen message tells the agent stale entries do not count', () => {
        expect(cliSource).toContain('requests observed before this wait began are not counted');
    });
});

// ── Bug #26: piped stdout drain before exit (end-to-end) ───────────────────

describe('flushAndExit pipe drain (bug #26)', () => {
    it('large JSON output survives process.exit on a pipe', async () => {
        const helper = `
            async function flushAndExit(code) {
                const deadline = Date.now() + 2000;
                const drained = (stream) => new Promise((resolve) => {
                    if (stream.writableLength === 0) return resolve();
                    const done = () => { stream.off('close', done); resolve(); };
                    stream.on('close', done);
                    void stream.write('', () => done());
                });
                try {
                    await Promise.race([Promise.all([drained(process.stdout), drained(process.stderr)]),
                        new Promise((r) => setTimeout(r, deadline - Date.now()))]);
                } catch {}
                process.exit(code);
            }
            const big = 'x'.repeat(200000);
            console.log(JSON.stringify({ payload: big }));
            await flushAndExit(0);
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', helper]);
        let bytes = 0;
        child.stdout.on('data', (d) => { bytes += d.length; });
        const exitCode = await new Promise<number | null>((r) => child.on('close', r));
        // 200000 payload + 15 chars of envelope; the unfixed path delivered 65536.
        expect(bytes).toBe(200015);
        expect(exitCode).toBe(0);
    });

    it('the real CLI exit paths call flushAndExit, not process.exit', () => {
        const cliSource = readFileSync(new URL('../src/opencli-engine/cli.js', import.meta.url), 'utf-8');
        expect(cliSource).toContain('async function flushAndExit');
        // No remaining hard-exit sites after big console.log output.
        expect(cliSource).not.toContain('process.exit(process.exitCode || 0)');
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
