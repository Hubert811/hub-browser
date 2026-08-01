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
  private entries: Array<Record<string, unknown>> = [];
  private pending = new Map<string, number>();
  private unsub: (() => void)[] = [];
  private capturing = false;

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
      const params = p as { requestId: string; request: { method: string; url: string } };
      if (!pattern || params.request.url.includes(pattern)) {
        const idx = this.entries.push({
          url: params.request.url,
          method: params.request.method,
          timestamp: Date.now(),
        }) - 1;
        this.pending.set(params.requestId, idx);
      }
    }));

    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.responseReceived', (p) => {
      const params = p as { requestId: string; response: { status: number; mimeType?: string } };
      const idx = this.pending.get(params.requestId);
      if (idx !== undefined) {
        this.entries[idx].responseStatus = params.response.status;
        this.entries[idx].responseContentType = params.response.mimeType ?? '';
      }
    }));

    this.unsub.push(onSessionEvent(this.cdp, this.sessionId, 'Network.loadingFinished', async (p) => {
      const params = p as { requestId: string };
      const idx = this.pending.get(params.requestId);
      if (idx !== undefined) {
        try {
          const bodyResult = await this.cdp.rawSendJson(
            'Network.getResponseBody',
            JSON.stringify({ requestId: params.requestId }),
            this.sessionId,
          );
          const r = bodyResult as { body?: string; base64Encoded?: boolean };
          if (typeof r?.body === 'string') {
            this.entries[idx].responsePreview = r.base64Encoded
              ? `base64:${r.body.slice(0, 8192)}`
              : r.body.slice(0, 8192);
          }
        } catch { /* body unavailable */ }
        this.pending.delete(params.requestId);
      }
    }));
  }

  read(): Array<Record<string, unknown>> {
    return [...this.entries];
  }

  async stop(): Promise<void> {
    this.unsub.forEach(fn => fn());
    this.unsub = [];
    // P1-17: disable Network domain
    await this.cdp.rawSendJson('Network.disable', '{}', this.sessionId).catch(() => {});
    this.entries = [];
    this.pending.clear();
    this.capturing = false;
  }
}
