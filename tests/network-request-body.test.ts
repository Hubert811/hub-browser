import { describe, expect, test } from 'bun:test';
import { NetworkCollector } from '../src/event-bridge';

/**
 * Bug #22 (2026-08-27, QuickBI order-detail dogfooding): request bodies are
 * the adapter replay contract, not a preview. They used to share the 8KiB
 * response-preview budget — the order-detail olap body is ~12KB, so
 * `network --detail` handed out a body cut mid-JSON. The contract is now a
 * 1MiB cap (aligned with the JS interceptor path); the preview budget stays
 * 8KiB for response bodies only.
 */

type SessionEventHandler = (params: unknown, sessionId: string) => void;

function fakeCdp() {
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
    rawSendJson: async () => ({}),
    emit(event: string, sessionId: string, params: unknown) {
      for (const h of handlers.get(event) ?? []) h(params, sessionId);
    },
  };
}

async function startedCollector() {
  const cdp = fakeCdp();
  const collector = new NetworkCollector(cdp as never, 'SID');
  await collector.start();
  return { cdp, collector };
}

describe('NetworkCollector request body capture (bug #22)', () => {
  test('12KB form-encoded body is captured whole — no truncation marker', async () => {
    const { cdp, collector } = await startedCollector();
    // QuickBI order-detail olapQueryParam is ~12KB — over the old 8KiB budget
    const body = 'olapQueryParam=' + 'x'.repeat(12 * 1024);
    cdp.emit('Network.requestWillBeSent', 'SID', {
      requestId: 'r1',
      request: { method: 'POST', url: 'https://example.com/api/olap/query', postData: body },
    });
    const entries = collector.read();
    expect(entries).toHaveLength(1);
    expect((entries[0].requestBody as string).length).toBe(body.length);
    expect(entries[0].requestBodyTruncated).toBeUndefined();
  });

  test('bodies over 1MiB are capped and honestly marked truncated', async () => {
    const { cdp, collector } = await startedCollector();
    const body = 'y'.repeat(1024 * 1024 + 512);
    cdp.emit('Network.requestWillBeSent', 'SID', {
      requestId: 'r2',
      request: { method: 'POST', url: 'https://example.com/api/olap/query', postData: body },
    });
    const entries = collector.read();
    expect((entries[0].requestBody as string).length).toBe(1024 * 1024);
    expect(entries[0].requestBodyTruncated).toBe(true);
  });

  test('small bodies keep the exact original string', async () => {
    const { cdp, collector } = await startedCollector();
    const body = 'a=1&b=2';
    cdp.emit('Network.requestWillBeSent', 'SID', {
      requestId: 'r3',
      request: { method: 'POST', url: 'https://example.com/api/x', postData: body },
    });
    expect(collector.read()[0].requestBody).toBe(body);
  });

  test('events from other sessions are ignored', async () => {
    const { cdp, collector } = await startedCollector();
    cdp.emit('Network.requestWillBeSent', 'OTHER', {
      requestId: 'r4',
      request: { method: 'POST', url: 'https://example.com/api/x', postData: 'x=1' },
    });
    expect(collector.read()).toHaveLength(0);
  });
});
