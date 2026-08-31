/**
 * Bug #34 (battle-9 round 3, 2026-08-31): the anchor + poll + timestamp-filter
 * loop behind CLI `wait xhr --since` existed only inside the cli.js command.
 * Adapters driving the page API reinvented it per-site — instagram's
 * fetch/XHR monkey-patch, the adapter standard's installRequestCapture — so
 * manual verification (CLI) and shipped adapters (page API) ran different
 * code for the same semantic.
 *
 * The loop now lives in observation-query.js's waitForNetworkEntry; this file
 * drives the REAL function with a fake page, pinning the exact semantics:
 * strict default gate, --since relative window, regex filtering, and the
 * normalized entry shape adapters consume (requestBody included).
 */
import { describe, expect, it } from 'bun:test';
import { waitForNetworkEntry } from '../src/opencli-engine/browser/observation-query.js';

/** Fake page exposing the CDP-collector surface (raw capture-entry shape). */
function fakeNetPage(entries) {
    return {
        startNetworkCapture: async () => true,
        readNetworkCapture: async () => entries,
        evaluate: async () => '[]',
    };
}

function staleEntry(url = 'https://x.com/api/orders') {
    return {
        url,
        method: 'POST',
        responseStatus: 200,
        responseContentType: 'application/json',
        responsePreview: '{"data":{"rows":[1,2,3]}}',
        requestBody: 'pageNum=1&pageSize=20',
        timestamp: Date.now() - 5000,
    };
}

describe('waitForNetworkEntry (bug #34: one loop for CLI + adapters)', () => {
    it('strict default rejects entries older than the wait itself', async () => {
        const page = fakeNetPage([staleEntry()]);
        const matched = await waitForNetworkEntry(page, 'api/orders', { timeoutMs: 150, pollMs: 20 });
        expect(matched).toBeNull();
    });

    it('sinceMs widens the gate to a relative window — the click → wait idiom', async () => {
        const page = fakeNetPage([staleEntry()]);
        const matched = await waitForNetworkEntry(page, 'api/orders', {
            sinceMs: 30_000,
            timeoutMs: 150,
            pollMs: 20,
        });
        expect(matched).not.toBeNull();
        expect(matched?.url).toBe('https://x.com/api/orders');
        expect(matched?.method).toBe('POST');
        expect(matched?.status).toBe(200);
        expect(matched?.ct).toBe('application/json');
        // captureNetworkItems normalization: JSON preview parsed, request body kept.
        expect(matched?.body).toEqual({ data: { rows: [1, 2, 3] } });
        expect(matched?.requestBody).toBe('pageNum=1&pageSize=20');
    });

    it('entries landing after the wait start satisfy the strict gate', async () => {
        // The entry appears in the ring mid-poll — what a real click's XHR does.
        const late = staleEntry('https://x.com/api/orders');
        let visible = false;
        const page = {
            startNetworkCapture: async () => true,
            readNetworkCapture: async () => (visible ? [late] : []),
            evaluate: async () => '[]',
        };
        setTimeout(() => {
            late.timestamp = Date.now();
            visible = true;
        }, 60);
        const matched = await waitForNetworkEntry(page, 'api/orders', { timeoutMs: 2000, pollMs: 20 });
        expect(matched?.url).toBe('https://x.com/api/orders');
    });

    it('regex filters non-matching URLs', async () => {
        const page = fakeNetPage([staleEntry('https://x.com/static/app.js')]);
        const matched = await waitForNetworkEntry(page, 'api/orders', {
            sinceMs: 30_000,
            timeoutMs: 150,
            pollMs: 20,
        });
        expect(matched).toBeNull();
    });

    it('accepts a RegExp instance as well as a source string', async () => {
        const page = fakeNetPage([staleEntry()]);
        const matched = await waitForNetworkEntry(page, /api\/orders/, {
            sinceMs: 30_000,
            timeoutMs: 150,
            pollMs: 20,
        });
        expect(matched?.url).toContain('api/orders');
    });

    it('throws a clear error on an invalid regex', async () => {
        const page = fakeNetPage([]);
        await expect(waitForNetworkEntry(page, '([unclosed')).rejects.toThrow('Invalid regex');
    });

    it('ensureCapture:false never touches the page setup — the caller owns the channel', async () => {
        // An adapter that installed its own fetch/XHR patch must be able to
        // wait without the interceptor install re-wrapping (or clobbering)
        // it. evaluate throwing proves the default setup path is skipped.
        const page = {
            readNetworkCapture: async () => [staleEntry()],
            evaluate: async () => { throw new Error('interceptor install attempted'); },
        };
        const matched = await waitForNetworkEntry(page, 'api/orders', {
            sinceMs: 30_000,
            timeoutMs: 150,
            pollMs: 20,
            ensureCapture: false,
        });
        expect(matched?.url).toContain('api/orders');
    });
});
