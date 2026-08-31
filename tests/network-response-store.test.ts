import { afterEach, describe, expect, test } from 'bun:test';
import { NetworkCollector } from '../src/event-bridge';

/**
 * O5 — full-response sidecar store on the CDP collector.
 *
 * CDP delivers the COMPLETE body at loadingFinished; the 8KiB preview was
 * a memory-budget choice. The store keeps bodies above the preview budget
 * whole (1MiB per entry, process-wide byte budget, oldest-first eviction)
 * and read() resolves them; evicted/budget-dropped bodies fall back to the
 * 8KiB preview with the honest truncation markers.
 */

type SessionEventHandler = (params: unknown, sessionId: string) => void;

function fakeCdp(bodies: Record<string, { body: string; base64Encoded?: boolean }>) {
  const handlers = new Map<string, SessionEventHandler[]>();
  return {
    handlers,
    onSessionEvent(event: string, handler: SessionEventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const cur = handlers.get(event) ?? [];
        handlers.set(event, cur.filter((h) => h !== handler));
      };
    },
    rawSendJson: async (method: string, paramsJson: string) => {
      if (method === 'Network.getResponseBody') {
        const { requestId } = JSON.parse(paramsJson) as { requestId: string };
        return bodies[requestId] ?? {};
      }
      return {};
    },
    emit(event: string, sessionId: string, params: unknown) {
      for (const h of handlers.get(event) ?? []) h(params, sessionId);
    },
  };
}

async function collect(
  sessionId: string,
  bodies: Record<string, { body: string; base64Encoded?: boolean }>,
  count = 1,
) {
  const cdp = fakeCdp(bodies);
  const collector = new NetworkCollector(cdp as never, sessionId);
  await collector.start();
  for (let i = 1; i <= count; i++) {
    cdp.emit('Network.requestWillBeSent', sessionId, {
      requestId: `r${i}`,
      request: { method: 'POST', url: `https://example.com/api/q${i}`, postData: 'x=1' },
    });
  }
  for (let i = 1; i <= count; i++) {
    cdp.emit('Network.responseReceived', sessionId, {
      requestId: `r${i}`,
      response: { status: 200, mimeType: 'application/json' },
    });
    cdp.emit('Network.loadingFinished', sessionId, { requestId: `r${i}` });
  }
  await new Promise((resolve) => setTimeout(resolve, 15));
  return collector;
}

afterEach(() => {
  delete process.env.HUB_NETWORK_BODY_STORE_BYTES;
});

describe('O5 response body sidecar store (CDP collector)', () => {
  test('a 52KB body (QuickBI olap scale) is resolved whole, no truncation markers', async () => {
    const full = JSON.stringify({ data: 'x'.repeat(52 * 1024) });
    const collector = await collect('O5-A', { r1: { body: full } });
    const entries = collector.read();
    expect(entries).toHaveLength(1);
    expect((entries[0].responsePreview as string).length).toBe(full.length);
    expect(entries[0].responseBodySource).toBe('store');
    expect(entries[0].responseBodyTruncated).toBeUndefined();
    expect(entries[0].responseBodyFullSize).toBeUndefined();
  });

  test('bodies within the 8KiB preview budget never enter the store', async () => {
    const small = '{"ok":true}';
    const collector = await collect('O5-B', { r1: { body: small } });
    const entries = collector.read();
    expect(entries[0].responsePreview).toBe(small);
    // No store provenance — the preview IS the whole body.
    expect(entries[0].responseBodySource).toBeUndefined();
  });

  test('bodies over 1MiB are stored capped and honestly marked truncated', async () => {
    const huge = 'y'.repeat(1024 * 1024 + 100);
    const collector = await collect('O5-C', { r1: { body: huge } });
    const entries = collector.read();
    expect((entries[0].responsePreview as string).length).toBe(1024 * 1024);
    expect(entries[0].responseBodySource).toBe('store');
    expect(entries[0].responseBodyTruncated).toBe(true);
    expect(entries[0].responseBodyFullSize).toBe(huge.length);
  });

  test('budget eviction: the oldest stored body falls back to its 8KiB preview', async () => {
    process.env.HUB_NETWORK_BODY_STORE_BYTES = '10000';
    const a = 'a'.repeat(9000);
    const b = 'b'.repeat(9000);
    const collector = await collect('O5-D', { r1: { body: a }, r2: { body: b } }, 2);
    const entries = collector.read();
    // r1 was evicted (9000 + 9000 > 10000): preview + honest markers.
    expect((entries[0].responsePreview as string).length).toBe(8192);
    expect(entries[0].responseBodyTruncated).toBe(true);
    expect(entries[0].responseBodyFullSize).toBe(9000);
    expect(entries[0].responseBodySource).toBeUndefined();
    // r2 survived whole.
    expect((entries[1].responsePreview as string).length).toBe(9000);
    expect(entries[1].responseBodySource).toBe('store');
  });

  test('base64 bodies keep the base64: prefix when resolved from the store', async () => {
    const raw = 'QUJD'.repeat(3000); // 12KB base64 payload
    const collector = await collect('O5-E', { r1: { body: raw, base64Encoded: true } });
    const entries = collector.read();
    const preview = entries[0].responsePreview as string;
    expect(preview.startsWith('base64:')).toBe(true);
    expect(preview.length).toBe('base64:'.length + raw.length);
    expect(entries[0].responseBodySource).toBe('store');
    expect(entries[0].responseBodyTruncated).toBeUndefined();
  });

  test('ring-buffer eviction keeps entries and store in step (500-entry cap)', async () => {
    const bodies: Record<string, { body: string }> = {};
    for (let i = 1; i <= 501; i++) bodies[`r${i}`] = { body: 'z'.repeat(9000) };
    const collector = await collect('O5-F', bodies, 501);
    const entries = collector.read();
    expect(entries).toHaveLength(500);
    // r1 was ring-evicted; the head of the ring is r2 with its stored body.
    expect(entries[0].responseBodySource).toBe('store');
    expect((entries[0].responsePreview as string).length).toBe(9000);
  });
});
