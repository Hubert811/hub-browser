/**
 * Dogfooding battle 9 (ZKH ESP recon, 2026-08-31) — four engine defects found
 * by the second-site adapter session, each verified against the real site
 * before fixing:
 *
 *  Bug #25  wait xhr accepted stale ring entries (covered in cli tests)
 *  Bug #26  stdout pipe 64KB truncation (covered in cli tests)
 *  Bug #27  snapshot compact never threaded (covered in snapshotFormatter tests)
 *  Bug #28  analyze misjudgments — anti_bot false positive on passive Aliyun
 *           cookies, api_candidates repeats + large-API burial, nearest_adapter
 *           cross-application apex match. This file covers the pure functions.
 */
import { describe, expect, it } from 'bun:test';
import {
    detectAntiBot,
    findNearestAdapter,
    scoreEndpointEvidence,
    scoreNetworkEvidence,
} from '../src/opencli-engine/browser/analyze.js';

// ── Bug #28.1: anti_bot strong/weak signal split ───────────────────────────

describe('detectAntiBot (bug #28: passive edge cookies are not challenges)', () => {
    it('passive acw_tc alone does NOT claim detection (ZKH ESP case)', () => {
        const result = detectAntiBot({ cookieNames: ['esp_bearer', 'acw_tc', 'JSESSIONID'], networkEntries: [] });
        expect(result.detected).toBe(false);
        expect(result.vendor).toBeNull();
        // The agent must see why the cookie did not fire the alarm.
        expect(result.weak_signals).toHaveLength(1);
        expect(result.weak_signals[0].vendor).toBe('aliyun_waf');
        expect(result.weak_signals[0].evidence[0]).toBe('cookie:acw_tc');
        expect(result.implication).toContain('passive');
        expect(result.implication).not.toContain('slider HTML');
    });

    it('acw_sc__v2 (post-challenge) DOES claim detection', () => {
        const result = detectAntiBot({ cookieNames: ['acw_sc__v2', 'acw_tc'], networkEntries: [] });
        expect(result.detected).toBe(true);
        expect(result.vendor).toBe('aliyun_waf');
        expect(result.evidence).toContain('cookie:acw_sc__v2');
        expect(result.implication).toContain('slider HTML');
    });

    it('captcha body markers are strong regardless of cookies', () => {
        const result = detectAntiBot({
            cookieNames: [],
            networkEntries: [{ url: 'https://x.com/captcha', bodyPreview: 'window.arg1 = \'ABCDEF012345678901234567890123456789\'' }],
        });
        expect(result.detected).toBe(true);
        expect(result.vendor).toBe('aliyun_waf');
        expect(result.evidence[0]).toBe('body:https://x.com/captcha');
    });

    it('cloudflare __cf_bm alone stays weak; cf_clearance is strong', () => {
        const weak = detectAntiBot({ cookieNames: ['__cf_bm'], networkEntries: [] });
        expect(weak.detected).toBe(false);
        expect(weak.weak_signals?.[0]?.vendor).toBe('cloudflare');
        const strong = detectAntiBot({ cookieNames: ['cf_clearance'], networkEntries: [] });
        expect(strong.detected).toBe(true);
        expect(strong.vendor).toBe('cloudflare');
    });

    it('no signals at all: no weak_signals field', () => {
        const result = detectAntiBot({ cookieNames: ['session'], networkEntries: [] });
        expect(result.detected).toBe(false);
        expect(result.weak_signals).toBeUndefined();
    });
});

// ── Bug #28.2: api_candidates dedup + large-API scoring ─────────────────────

describe('scoreNetworkEvidence (bug #28: dedup + truncated-JSON credit)', () => {
    const bigApi = {
        url: 'https://esp.example.com/espApi/o/list',
        status: 200,
        contentType: 'application/json',
        // 2000-char cap used to cut this mid-JSON → opaque string → buried.
        bodyPreview: '{"data":{"rows":[{"orderNo":"1","skuNo":"a","productFullName":"x"'
            .repeat(80).slice(0, 60000),
    };
    const dictionary = {
        url: 'https://esp.example.com/o/web/order/status/list',
        status: 200,
        contentType: 'application/json',
        bodyPreview: '{"data":{"1":"pending","2":"shipped","3":"done"}}',
    };

    it('repeated URLs collapse into one candidate with a repeats count', () => {
        const result = scoreNetworkEvidence({
            networkEntries: [dictionary, dictionary, dictionary, bigApi],
        });
        const urls = result.map((e) => e.url);
        expect(new Set(urls).size).toBe(urls.length);
        const dict = result.find((e) => e.url === dictionary.url);
        expect(dict?.repeats).toBe(3);
    });

    it('a large truncated JSON API outranks small dictionaries', () => {
        const result = scoreNetworkEvidence({
            networkEntries: [dictionary, dictionary, dictionary, bigApi],
        });
        expect(result[0]?.url).toBe(bigApi.url);
        expect(result[0]?.reasons).toContain('truncated json body (api-shaped)');
        expect(result[0]?.real_data_score).toBeGreaterThan(
            result.find((e) => e.url === dictionary.url)?.real_data_score ?? 0,
        );
    });

    it('plain text body keeps the old weak credit', () => {
        const result = scoreEndpointEvidence({
            url: 'https://x.com/file',
            status: 200,
            contentType: 'text/plain',
            bodyPreview: 'hello world this is a plain text response',
        });
        expect(result.reasons).toContain('non-empty text body');
        expect(result.reasons).not.toContain('truncated json body (api-shaped)');
    });
});

// ── Bug #28.3: nearest_adapter host anchoring ──────────────────────────────

describe('findNearestAdapter (bug #28: no cross-application apex match)', () => {
    const registry = new Map([
        ['quickbi 1', { site: 'quickbi', name: 'fetch', domain: 'quickbi.zkh360.com' }],
        ['quickbi 2', { site: 'quickbi', name: 'verify', domain: 'quickbi.zkh360.com' }],
    ]);

    it('sibling subdomain on the same apex does NOT match (esp vs quickbi)', () => {
        // The exact battle-9 misfire: esp.zkh360.com got quickbi advice.
        const result = findNearestAdapter('https://esp.zkh360.com/order/list', registry);
        expect(result).toBeNull();
    });

    it('same host still matches', () => {
        const result = findNearestAdapter('https://quickbi.zkh360.com/dash', registry);
        expect(result?.site).toBe('quickbi');
        expect(result?.reason).toContain('host');
    });

    it('subdomain of the adapter domain matches', () => {
        const result = findNearestAdapter('https://app.quickbi.zkh360.com/dash', registry);
        expect(result?.site).toBe('quickbi');
    });

    it('site-name containment still works (site name == subdomain convention)', () => {
        const byName = new Map([
            ['quickbi 1', { site: 'quickbi', name: 'fetch', domain: '' }],
        ]);
        const result = findNearestAdapter('https://quickbi.zkh360.com/dash', byName);
        expect(result?.site).toBe('quickbi');
    });
});
