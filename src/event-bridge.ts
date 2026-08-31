import type { CdpBackend } from '@browseros/browser-core';

/** Subscribe to CDP events for a specific session */
export function onSessionEvent(
  cdp: CdpBackend,
  sessionId: string,
  event: string,
  handler: (params: unknown) => void,
): () => void {
  return cdp.onSessionEvent(event, (params, sid) => {
    if (sid === sessionId) handler(params);
  });
}

/** Console message collector (P0-15: Runtime.enable required) */
export class ConsoleCollector {
  private messages: Array<{ type: string; text: string; timestamp: number }> = [];
  private unsub: (() => void)[] = [];
  started = false;

  constructor(
    private cdp: CdpBackend,
    private sessionId: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // P0-15: must enable Runtime to receive console events
    await this.cdp.rawSendJson('Runtime.enable', '{}', this.sessionId);
    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Runtime.consoleAPICalled', (p) => {
      const params = p as { type?: string; args?: Array<{ value?: string; description?: string }> };
      const text = (params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
      this.messages.push({ type: params.type ?? 'log', text, timestamp: Date.now() });
      if (this.messages.length > 500) this.messages.shift();
    }));
    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Runtime.exceptionThrown', (p) => {
      const params = p as { exceptionDetails?: { exception?: { description?: string } } };
      const desc = params.exceptionDetails?.exception?.description ?? '';
      if (desc) {
        this.messages.push({ type: 'error', text: desc, timestamp: Date.now() });
        if (this.messages.length > 500) this.messages.shift();
      }
    }));
  }

  get(level: string = 'all'): Array<{ type: string; text: string; timestamp: number }> {
    if (level === 'all') return [...this.messages];
    if (level === 'error') return this.messages.filter(m => m.type === 'error' || m.type === 'warning');
    return this.messages.filter(m => m.type === level);
  }

  stop(): void {
    this.unsub.forEach(fn => fn());
    this.unsub = [];
    this.messages = [];
    this.started = false;
  }
}

/** Network request collector (P0-14: use this.cdp.rawSendJson, not destructured) */
export class NetworkCollector {
  // B1 fix: cap the ring buffer — collectors now outlive individual page
  // objects (registry on the BrowserSession), so a long-lived daemon must
  // not accumulate entries without bound.
  private static readonly MAX_ENTRIES = 500;
  /** Bug #22: request bodies are the replay contract, not a preview — cap at
   * 1MiB (aligned with the JS interceptor path) instead of the 8KiB response
   * preview budget. Form-encoded query payloads are KB-scale; 1MiB covers
   * them with headroom while keeping worst-case memory bounded
   * (MAX_ENTRIES × 1MiB only if every entry is a max-size POST — in practice
   * request bodies are tiny and the 500-entry ring bounds the tail). */
  private static readonly MAX_REQUEST_BODY = 1024 * 1024;
  /** Response bodies above this live in the O5 sidecar store (see the
   * module-level `responseBodies` docs) instead of only as a preview. */
  private static readonly PREVIEW_LIMIT = 8192;
  private entries: Array<Record<string, unknown>> = [];
  private pending = new Map<string, number>();
  private unsub: (() => void)[] = [];
  capturing = false;

  constructor(
    private cdp: CdpBackend,
    private sessionId: string,
  ) {}

  async start(pattern: string = ''): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    this.entries = [];
    this.pending.clear();
    await this.cdp.rawSendJson('Network.enable', '{}', this.sessionId);

    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.requestWillBeSent', (p) => {
      const params = p as { requestId: string; request: { method: string; url: string; postData?: string } };
      if (!pattern || params.request.url.includes(pattern)) {
        const entry: Record<string, unknown> = {
          url: params.request.url,
          method: params.request.method,
          timestamp: Date.now(),
          // O5: sidecar-store key for this response body (internal only —
          // read() resolves it before anything crosses the page boundary).
          requestId: params.requestId,
        };
        // C1 fix: keep the request body (POST payloads are the adapter
        // contract — without them, replaying a query API is guesswork).
        // Bug #22 (2026-08-27, QuickBI order-detail dogfooding): request bodies
        // used to share the 8KiB response-preview budget, silently truncating
        // the adapter replay contract — the order-detail olap body is ~12KB and
        // `network --detail` handed out a cut mid-JSON body. Request bodies are
        // the CONTRACT (replay target), not a preview: cap them at 1MiB,
        // aligned with the JS interceptor path (network-interceptor.js), so both
        // capture channels agree. Response previews stay at 8KiB (memory
        // budget; see O5).
        if (typeof params.request.postData === 'string' && params.request.postData.length > 0) {
          const cap = NetworkCollector.MAX_REQUEST_BODY;
          entry.requestBody = params.request.postData.slice(0, cap);
          if (params.request.postData.length > cap) {
            entry.requestBodyTruncated = true;
          }
        }
        const idx = this.entries.push(entry) - 1;
        this.pending.set(params.requestId, idx);
        if (this.entries.length > NetworkCollector.MAX_ENTRIES) {
          // Drop the oldest entry and reindex the pending map so response
          // events still land on the right entry.
          const evicted = this.entries.shift();
          if (typeof evicted?.requestId === 'string') {
            storeDelete(storeKey(this.sessionId, evicted.requestId));
          }
          for (const [k, v] of this.pending) {
            if (v <= 0) this.pending.delete(k);
            else this.pending.set(k, v - 1);
          }
        }
      }
    }));

    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.responseReceived', (p) => {
      const params = p as { requestId: string; response: { status: number; mimeType?: string } };
      const idx = this.pending.get(params.requestId);
      if (idx !== undefined && idx < this.entries.length) {
        this.entries[idx].responseStatus = params.response.status;
        this.entries[idx].responseContentType = params.response.mimeType ?? '';
      }
    }));

    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.loadingFinished', (p) => {
      void this.handleLoadingFinished(p as { requestId: string });
    }));
    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.loadingFailed', (p) => {
      const params = p as { requestId: string };
      this.pending.delete(params.requestId);
    }));

  }

  // try-catch 不可移除：void 不防止 unhandledRejection，try-catch 是唯一保障
  private async handleLoadingFinished(params: { requestId: string }): Promise<void> {
    const idx = this.pending.get(params.requestId);
    if (idx === undefined || idx >= this.entries.length) return;
    try {
      const bodyResult = await this.cdp.rawSendJson(
        'Network.getResponseBody',
        JSON.stringify({ requestId: params.requestId }),
        this.sessionId,
      );
      const r = bodyResult as { body?: string; base64Encoded?: boolean };
      if (typeof r?.body === 'string') {
        const entry = this.entries[idx];
        entry.responsePreview = r.base64Encoded
          ? `base64:${r.body.slice(0, NetworkCollector.PREVIEW_LIMIT)}`
          : r.body.slice(0, NetworkCollector.PREVIEW_LIMIT);
        // Same honesty contract as requestBody above: the preview is capped
        // at 8KiB, so surface the truncation + full size. Without these the
        // downstream marker chain (bodyTruncated -> body_truncated -> detail
        // warning) is dead code and `network --detail` silently hands out a
        // body that looks whole but is cut mid-JSON — an adapter author
        // parsing it concludes the response is corrupt when it was merely
        // truncated (observed on QuickBI olap responses: 8192-byte body cut
        // mid-SQL, JSON.parse failing with Unterminated string).
        if (r.body.length > NetworkCollector.PREVIEW_LIMIT) {
          entry.responseBodyTruncated = true;
          entry.responseBodyFullSize = r.body.length;
          // O5: CDP just handed us the COMPLETE body — keep it in the
          // sidecar store so read() can resolve the whole response for
          // `--detail` and shape inference. Bodies within the preview
          // budget need no store copy: the preview already IS the body.
          storePut(storeKey(this.sessionId, params.requestId), r.body, r.base64Encoded === true);
        }
      }
    } catch { /* body unavailable */ }
    this.pending.delete(params.requestId);
  }

  read(): Array<Record<string, unknown>> {
    return this.entries.map((entry) => {
      const rid = entry.requestId;
      if (typeof rid !== 'string') return entry;
      const stored = responseBodies.get(storeKey(this.sessionId, rid));
      if (stored === undefined) return entry;
      // O5 resolution: swap the 8KiB preview for the stored full body. When
      // the stored copy covers the whole response, the preview-era
      // truncation markers no longer apply (the body is complete); a >1MiB
      // body keeps them (the stored copy is capped).
      const resolved: Record<string, unknown> = {
        ...entry,
        responsePreview: stored.base64Encoded ? `base64:${stored.body}` : stored.body,
        responseBodySource: 'store',
      };
      const fullSize = typeof entry.responseBodyFullSize === 'number'
        ? entry.responseBodyFullSize
        : stored.body.length;
      if (stored.body.length >= fullSize) {
        delete resolved.responseBodyTruncated;
        delete resolved.responseBodyFullSize;
      }
      return resolved;
    });
  }

  async stop(): Promise<void> {
    this.unsub.forEach(fn => fn());
    this.unsub = [];
    // P1-17: disable Network domain
    await this.cdp.rawSendJson('Network.disable', '{}', this.sessionId).catch(() => {});
    this.entries = [];
    this.pending.clear();
    this.capturing = false;
    // stop() wipes the entry ring — release this session's store slices so
    // the budget does not pin bodies nothing references anymore.
    const prefix = `${this.sessionId}:`;
    for (const key of [...responseBodies.keys()]) {
      if (key.startsWith(prefix)) storeDelete(key);
    }
  }
}

/**
 * O5 — sidecar store for full response bodies. CDP delivers the COMPLETE
 * body at loadingFinished; the 8KiB preview was a memory-budget choice, not
 * a data limit, and adapters kept hitting it (QuickBI olap responses are
 * 10-100KB, observed cut mid-JSON). The store keeps bodies above the
 * preview budget whole so `network --detail` hands out parseable JSON and
 * shape inference sees the full structure. Bounded three ways: a per-entry
 * 1MiB cap (same as request bodies and the JS interceptor channel), a
 * process-wide byte budget (default 32MB, HUB_NETWORK_BODY_STORE_BYTES to
 * override) shared by every collector in this process — a daemon with
 * several capturing tabs must not multiply the budget — and oldest-first
 * eviction once over budget. Bodies evicted from the budget (or orphaned by
 * a stopped collector) fall back to the 8KiB preview with the honest
 * truncation markers: exactly the pre-O5 behavior, never worse.
 */
const STORE_MAX_ENTRY = 1024 * 1024;
const STORE_BUDGET_DEFAULT = 32 * 1024 * 1024;
const responseBodies = new Map<string, { body: string; base64Encoded: boolean }>();
let responseBodiesBytes = 0;

function storeBudget(): number {
  const raw = Number(process.env.HUB_NETWORK_BODY_STORE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : STORE_BUDGET_DEFAULT;
}

function storeKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function storePut(key: string, body: string, base64Encoded: boolean): void {
  const stored = body.length > STORE_MAX_ENTRY ? body.slice(0, STORE_MAX_ENTRY) : body;
  responseBodies.set(key, { body: stored, base64Encoded });
  responseBodiesBytes += stored.length;
  while (responseBodiesBytes > storeBudget()) {
    const oldest = responseBodies.keys().next().value;
    if (oldest === undefined) break;
    storeDelete(oldest);
  }
}

function storeDelete(key: string): void {
  const entry = responseBodies.get(key);
  if (entry !== undefined) {
    responseBodiesBytes -= entry.body.length;
    responseBodies.delete(key);
  }
}
