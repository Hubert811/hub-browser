import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { networkInterceptorJs } from '../src/opencli-engine/browser/network-interceptor.js';

/**
 * O5 — the injected page-side interceptor carries the same total byte budget
 * as the CDP sidecar store (default 32MB): once exceeded, the oldest entries
 * are evicted first. Byte accounting must survive JSON parsing (the stored
 * string is gone after parse — a parallel Map keeps the count exact).
 */

const realFetch = globalThis.fetch;

class FakeXhr {
  open() {}
  send() {}
  addEventListener() {}
  getResponseHeader() {
    return null;
  }
}

function fakeResponse(body: string, url: string) {
  return {
    status: 200,
    url,
    headers: { get: () => 'application/json' },
    clone() {
      return { text: async () => body };
    },
  };
}


beforeEach(() => {
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXhr;
  delete (globalThis as Record<string, unknown>).__opencli_net;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).fetch = realFetch;
  delete (globalThis as Record<string, unknown>).__opencli_net;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
});

describe('O5 interceptor total byte budget', () => {
  test('a body between 8KiB and 1MiB is captured whole (parsed)', async () => {
    const body = JSON.stringify({ rows: 'x'.repeat(20 * 1024) });
    (globalThis as Record<string, unknown>).fetch = async () =>
      fakeResponse(body, 'https://x/api/a');
    eval(networkInterceptorJs(32 * 1024 * 1024));
    await (globalThis.fetch as unknown as (u: string) => Promise<unknown>)('https://x/api/a');
    const net = (globalThis as Record<string, unknown>).__opencli_net as Array<Record<string, unknown>>;
    expect(net).toHaveLength(1);
    expect(net[0].body).toEqual(JSON.parse(body));
    expect(net[0].bodyTruncated).toBeUndefined();
  });

  test('over the per-entry 1MiB cap: truncated + bodyFullSize', async () => {
    const body = 'y'.repeat(1024 * 1024 + 10);
    (globalThis as Record<string, unknown>).fetch = async () => fakeResponse(body, 'https://x/api/big');
    eval(networkInterceptorJs(32 * 1024 * 1024));
    await (globalThis.fetch as unknown as (u: string) => Promise<unknown>)('https://x/api/big');
    const net = (globalThis as Record<string, unknown>).__opencli_net as Array<Record<string, unknown>>;
    expect((net[0].body as string).length).toBe(1024 * 1024);
    expect(net[0].bodyTruncated).toBe(true);
    expect(net[0].bodyFullSize).toBe(body.length);
  });

  test('over the total budget: oldest entries evicted first', async () => {
    const body = 'z'.repeat(4000);
    (globalThis as Record<string, unknown>).fetch = async (u: unknown) =>
      fakeResponse(body, String(u));
    eval(networkInterceptorJs(10000));
    for (const url of ['https://x/1', 'https://x/2', 'https://x/3']) {
      await (globalThis.fetch as unknown as (u: string) => Promise<unknown>)(url);
    }
    const net = (globalThis as Record<string, unknown>).__opencli_net as Array<Record<string, unknown>>;
    // 3 × 4000 > 10000 → the first entry was evicted; the last two remain.
    expect(net).toHaveLength(2);
    expect(net[0].url).toBe('https://x/2');
    expect(net[1].url).toBe('https://x/3');
  });

  test('eviction accounting is exact for parsed JSON bodies', async () => {
    // Parsed bodies hold no string to measure — the parallel Map must still
    // count their original text size and evict them under budget pressure.
    const bodies = [
      JSON.stringify({ a: 'p'.repeat(3500) }),
      JSON.stringify({ b: 'q'.repeat(3500) }),
      JSON.stringify({ c: 'r'.repeat(3500) }),
    ];
    let i = 0;
    (globalThis as Record<string, unknown>).fetch = async () => {
      const body = bodies[i++];
      return fakeResponse(body, `https://x/p${i}`);
    };
    eval(networkInterceptorJs(10000));
    for (let k = 0; k < 3; k++) {
      await (globalThis.fetch as unknown as () => Promise<unknown>)();
    }
    const net = (globalThis as Record<string, unknown>).__opencli_net as Array<Record<string, unknown>>;
    expect(net).toHaveLength(2);
    expect(net[0].body).toEqual(JSON.parse(bodies[1]));
  });
});
