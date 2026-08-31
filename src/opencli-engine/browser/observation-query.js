/**
 * P2-6 (batch 2) — shared observation-query pipeline for the `network` and
 * `console` capabilities. Extracted verbatim from the CLI direct
 * implementations so the CLI command and the MCP tool run ONE pipeline
 * (single source); both faces keep their output contracts:
 *
 *   - success: { ok: true, envelope }   — envelope is the JSON the CLI prints
 *   - failure: { ok: false, error: { code, message, ...extra } }
 *     (the CLI renders these with its exit-code map; the tool face renders
 *     them as structured error results)
 *
 * Time-window helpers (parseDurationMs/toIsoTimestamp/filterByTimeWindow/
 * timestampFromRaw) moved here from cli.js — cli.js now imports them.
 */
import { inferShape } from './shape.js';
import { assignKeys } from './network-key.js';
import { DEFAULT_TTL_MS, findEntry, loadNetworkCache, saveNetworkCache } from './network-cache.js';
import { shapeMatchesFilter } from './shape-filter.js';
import { buildFindJs, buildSemanticFindJs, isFindError } from './find.js';
import { analyzeSite, previewNetworkBody } from './analyze.js';
import { getRegistry } from '../registry.js';
import { NETWORK_INTERCEPTOR_JS } from './network-interceptor.js';
import { log } from '../logger.js';

// ── time / timestamp helpers (shared by console + network) ─────────────────

export function parseDurationMs(raw, label) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    const str = String(raw).trim();
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(str);
    if (!match)
        return { error: `${label} must be a duration like 500ms, 30s, 2m, got "${str}"` };
    const value = Number.parseFloat(match[1]);
    const unit = match[2] ?? 'ms';
    const multiplier = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
    return Math.round(value * multiplier);
}

export function timestampFromRaw(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Date.now();
}

export function toIsoTimestamp(timestamp) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0)
        return undefined;
    return new Date(timestamp).toISOString();
}

export function filterByTimeWindow(items, opts, now = Date.now()) {
    const sinceTs = opts.sinceMs != null ? now - opts.sinceMs : undefined;
    const untilTs = opts.untilMs != null ? now - opts.untilMs : undefined;
    return items.filter((item) => {
        const ts = item.timestamp ?? now;
        if (sinceTs !== undefined && ts < sinceTs)
            return false;
        if (untilTs !== undefined && ts > untilTs)
            return false;
        return true;
    });
}

/** The page/CDP session id (`page-<pageId>`), used for the capture cache key. */
export function pageSessionOf(page) {
    const session = page.session;
    if (typeof session === 'string' && session.trim())
        return session.trim();
    throw new Error('Browser page is missing a session');
}

/** Fresh-by-timestamp selection for the CLI --follow poll loops. */
export function selectFreshByTimestamp(items, lastSeenTs) {
    const fresh = items.filter((item) => Number(item.timestamp ?? 0) > lastSeenTs);
    const nextSeenTs = fresh.length > 0
        ? Math.max(lastSeenTs, ...fresh.map((item) => Number(item.timestamp ?? 0)).filter(Number.isFinite))
        : lastSeenTs;
    return { fresh, lastSeenTs: nextSeenTs };
}

// ── network: capture normalization ──────────────────────────────────────────

/**
 * Normalize raw capture entries (from CDP `readNetworkCapture` or the JS
 * interceptor's `window.__opencli_net`) into a consistent shape.
 * Response preview is parsed as JSON when possible, otherwise kept as string.
 * `bodyFullSize` / `bodyTruncated` surface capture-layer truncation so the
 * agent-facing envelope can warn when the body isn't whole.
 */
export async function captureNetworkItems(page) {
    if (page.readNetworkCapture) {
        const raw = await page.readNetworkCapture();
        if (Array.isArray(raw) && raw.length > 0) {
            return raw.map((e) => {
                const preview = e.responsePreview ?? null;
                let body = null;
                if (preview) {
                    try {
                        body = JSON.parse(preview);
                    }
                    catch {
                        body = preview;
                    }
                }
                const fullSize = typeof e.responseBodyFullSize === 'number'
                    ? e.responseBodyFullSize
                    : (preview ? preview.length : 0);
                const truncated = e.responseBodyTruncated === true;
                return {
                    url: e.url || '',
                    method: e.method || 'GET',
                    status: e.responseStatus || 0,
                    size: fullSize,
                    ct: e.responseContentType || '',
                    body,
                    // O5: 'store' marks a body resolved from the collector's
                    // full-response sidecar store; absence = preview-only.
                    ...(e.responseBodySource === 'store' ? { bodySource: 'store' } : {}),
                    // C1: request body captured by the collector — the other
                    // half of an API's contract (response bodies alone are
                    // not enough to replay a POST).
                    ...(typeof e.requestBody === 'string' ? { requestBody: e.requestBody } : {}),
                    ...(e.requestBodyTruncated === true ? { requestBodyTruncated: true } : {}),
                    bodyFullSize: fullSize,
                    bodyTruncated: truncated,
                    timestamp: timestampFromRaw(e.timestamp),
                };
            });
        }
    }
    const raw = await page.evaluate(`(function(){ var out = window.__opencli_net || []; window.__opencli_net = []; return JSON.stringify(out); })()`);
    try {
        const parsed = JSON.parse(raw);
        return parsed.map((item) => ({ ...item, timestamp: timestampFromRaw(item.timestamp) }));
    }
    catch {
        if (process.env.OPENCLI_VERBOSE)
            log.warn(`[network] Failed to parse interceptor buffer: ${typeof raw === 'string' ? raw.slice(0, 200) : String(raw)}`);
        return [];
    }
}

// ── network: wait primitive (bug #34) ───────────────────────────────────────

/**
 * Wait for a captured request whose URL matches `pattern` (regex source or
 * RegExp), with the same freshness semantics the CLI `wait xhr --since`
 * command exposes:
 *
 * - default: only entries whose timestamp is >= the moment this call starts,
 *   so a bare wait cannot latch onto a previous action's request and hand
 *   back the wrong payload
 * - `sinceMs`: widen the gate to a relative window — the caller asserts
 *   which entries are "theirs". This revives the click → wait idiom, whose
 *   request typically lands before the wait starts (daemon commands
 *   serialize, so "start listening, then click" is structurally impossible).
 *
 * Bug #34: this loop used to live only inside the CLI command. Adapters
 * driving the page API had to reinvent it per-site — fetch/XHR monkey-patches
 * with private rings and timestamps (clis/instagram, the adapter standard's
 * installRequestCapture) — each a fresh copy of the same anchor + poll +
 * timestamp filter. One implementation now serves the CLI, adapters, and any
 * future MCP wait tool.
 *
 * `ensureCapture` (default true) starts the page's network capture first —
 * the CDP collector when the page supports it, the in-page interceptor
 * otherwise — and drains the interceptor ring BEFORE anchoring, so stale
 * entries cannot sneak in through the fallback path (the CDP ring is
 * non-destructive; the anchor gate handles it). Pass false when the caller
 * already owns the capture channel.
 *
 * Returns the normalized matched entry (same shape `captureNetworkItems`
 * produces: url/method/status/ct/body/requestBody/timestamp) or null after
 * `timeoutMs` (default 10s) without a match. Throws on an invalid regex.
 */
export async function waitForNetworkEntry(page, pattern, opts = {}) {
    let re;
    try {
        re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    }
    catch (err) {
        throw new Error(`Invalid regex "${String(pattern)}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (opts.ensureCapture !== false) {
        const hasSessionCapture = await page.startNetworkCapture?.() ?? false;
        if (!hasSessionCapture) {
            try {
                await page.evaluate(NETWORK_INTERCEPTOR_JS);
            }
            catch { /* non-fatal */ }
        }
        await captureNetworkItems(page);
    }
    const timeoutMs = opts.timeoutMs ?? 10000;
    const pollMs = opts.pollMs ?? 400;
    const startTs = Date.now();
    const anchorTs = opts.sinceMs != null ? startTs - opts.sinceMs : startTs;
    const deadline = startTs + timeoutMs;
    let matched = null;
    while (Date.now() < deadline && !matched) {
        const items = await captureNetworkItems(page);
        matched = items.find((e) => Number(e.timestamp ?? 0) >= anchorTs && re.test(e.url ?? '')) ?? null;
        if (!matched)
            await new Promise((r) => setTimeout(r, pollMs));
    }
    return matched;
}

/** Drop static-resource / telemetry noise so agents see only API-shaped traffic. */
export function filterNetworkItems(items) {
    return items.filter((r) => {
        const ct = r.ct?.toLowerCase() ?? '';
        // C4: data:/blob: URIs (inline svg icons and friends) are page
        // furniture, not network traffic — keep them out of the default view.
        if (/^(data|blob):/i.test(r.url))
            return false;
        return ((ct.includes('json') || ct.includes('xml') || ct.includes('text/plain') || ct.includes('javascript')) &&
            !/\.(js|css|png|jpg|gif|svg|woff|ico|map)(\?|$)/i.test(r.url) &&
            !/analytics|tracking|telemetry|beacon|pixel|gtag|fbevents/i.test(r.url));
    });
}

// ── network: query faces ────────────────────────────────────────────────────

/**
 * Full (non-follow) network query: fresh capture → noise filter → time window
 * → failed filter → key assignment → cache persist → shape view → envelope.
 * `opts.filterFields` is an already-parsed array (the CLI parses the flag
 * string, the tool schema takes an array — both call this with the array).
 */
export async function runNetworkQuery(page, opts = {}) {
    const session = pageSessionOf(page);
    // A2 fix: a bare network query used to read a never-started collector and
    // report "Captured 0 requests" while the page had fired dozens — the
    // caller had to know analyze (of all tools) was the secret to switch
    // capture on. Ensure the collector is running; when THIS call started it,
    // history begins now and the envelope says so.
    let captureStartedNow = false;
    try {
        if (typeof page.ensureNetworkCapture === 'function') {
            captureStartedNow = await page.ensureNetworkCapture();
        }
    }
    catch { /* fall through to the read below */ }
    let rawItems;
    try {
        rawItems = await captureNetworkItems(page);
    }
    catch (err) {
        return { ok: false, error: { code: 'capture_failed', message: `Could not read network capture: ${err.message}` } };
    }
    let items = opts.all ? rawItems : filterNetworkItems(rawItems);
    items = filterByTimeWindow(items, { sinceMs: opts.sinceMs, untilMs: opts.untilMs });
    if (opts.failed)
        items = items.filter((item) => item.status === 0 || item.status >= 400);
    const filteredOut = rawItems.length - items.length;
    const keyed = assignKeys(items);
    const cacheEntries = keyed.map((it) => ({
        key: it.key,
        url: it.url,
        method: it.method,
        status: it.status,
        size: it.size,
        ct: it.ct,
        body: it.body,
        // O5: full bodies from the sidecar store persist into the cache so
        // `--detail` (a separate process reading the cache file) sees them
        // whole; body_source records the provenance.
        ...(it.bodySource === 'store' ? { body_source: 'store' } : {}),
        ...(typeof it.requestBody === 'string' ? { requestBody: it.requestBody } : {}),
        ...(it.requestBodyTruncated === true ? { requestBodyTruncated: true } : {}),
        ...(typeof it.timestamp === 'number' ? { timestamp: it.timestamp } : {}),
        ...(it.bodyTruncated ? { body_truncated: true } : {}),
        ...(it.bodyTruncated && typeof it.bodyFullSize === 'number'
            ? { body_full_size: it.bodyFullSize }
            : {}),
    }));
    // Soft failure: the caller already has the data, so surface a warning
    // via the output envelope rather than erroring out the whole command.
    let cacheWarning = null;
    try {
        saveNetworkCache(session, cacheEntries);
    }
    catch (err) {
        cacheWarning = `Could not persist capture cache: ${err.message}. --detail lookups may miss this capture.`;
    }
    // Pair each cache entry with its shape up front so --filter can read
    // segments without recomputing, and the --raw view can keep the full
    // body. Cache persistence above stored the unfiltered set on purpose:
    // later `--detail <key>` lookups must still see requests that the
    // current --filter narrowed out.
    const shaped = cacheEntries.map((e) => ({ entry: e, shape: inferShape(e.body) }));
    const visible = opts.filterFields
        ? shaped.filter((s) => shapeMatchesFilter(s.shape, opts.filterFields))
        : shaped;
    const filterDropped = opts.filterFields ? shaped.length - visible.length : 0;
    const envelope = {
        session,
        captured_at: new Date().toISOString(),
        count: visible.length,
        filtered_out: filteredOut,
    };
    if (opts.filterFields) {
        envelope.filter = opts.filterFields;
        envelope.filter_dropped = filterDropped;
    }
    if (cacheWarning)
        envelope.cache_warning = cacheWarning;
    if (captureStartedNow) {
        envelope.capture_started_now = true;
        envelope.capture_hint = 'Capture started with this query — only requests from this moment on are visible. Re-trigger the page action (click, navigate) and query again.';
    }
    const truncatedCount = visible.filter((s) => s.entry.body_truncated).length;
    if (truncatedCount > 0) {
        envelope.body_truncated_count = truncatedCount;
        envelope.body_truncated_hint = 'Some bodies exceeded the capture store cap (1MiB/entry, 32MB total); their `shape` and `body` reflect only the stored prefix.';
    }
    if (opts.raw) {
        envelope.entries = visible.map((s) => ({
            ...s.entry,
            ...(typeof s.entry.timestamp === 'number' ? { timestamp: toIsoTimestamp(s.entry.timestamp) } : {}),
        }));
    }
    else {
        envelope.entries = visible.map((s) => ({
            key: s.entry.key,
            method: s.entry.method,
            ...(typeof s.entry.timestamp === 'number' ? { timestamp: toIsoTimestamp(s.entry.timestamp) } : {}),
            status: s.entry.status,
            url: s.entry.url,
            ct: s.entry.ct,
            size: s.entry.size,
            shape: s.shape,
            ...(s.entry.body_truncated ? { body_truncated: true } : {}),
        }));
        envelope.detail_hint = 'Run "browser network --detail <key>" for full body.';
    }
    return { ok: true, envelope };
}

/**
 * `--detail <key>` short-circuit: read from the persisted capture cache only,
 * no live capture. `maxBody` (0 = unlimited) applies a transport-level body
 * cap on top of any capture-layer truncation.
 */
export function runNetworkDetail(session, key, opts = {}) {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const maxBody = opts.maxBody ?? 0;
    const res = loadNetworkCache(session, { ttlMs });
    if (res.status === 'missing') {
        return { ok: false, error: { code: 'cache_missing', message: `No cached capture. Run "browser network" first (in session "${session}").` } };
    }
    if (res.status === 'expired') {
        return { ok: false, error: { code: 'cache_expired', message: `Cache is stale (age ${res.ageMs}ms > ttl ${ttlMs}ms). Re-run "browser network" to refresh.` } };
    }
    if (res.status === 'corrupt' || !res.file) {
        return { ok: false, error: { code: 'cache_corrupt', message: 'Cache file is malformed; re-run "browser network" to regenerate.' } };
    }
    const entry = findEntry(res.file, key);
    if (!entry) {
        return { ok: false, error: { code: 'key_not_found', message: `Key "${key}" not in cache.`, available_keys: res.file.entries.map((e) => e.key) } };
    }
    // Body shape/source:
    // - If capture already truncated it (entry.body_truncated), the body is a string.
    // - If the adapter stored a JSON value, it parsed cleanly at capture time; leave it.
    // - maxBody applies a transport-level cap when the caller wants to keep output small.
    let outputBody = entry.body;
    let transportTruncated = false;
    if (maxBody > 0 && typeof entry.body === 'string' && entry.body.length > maxBody) {
        outputBody = entry.body.slice(0, maxBody);
        transportTruncated = true;
    }
    const captureTruncated = entry.body_truncated === true;
    // C1: request body (POST payload) — parse as JSON when possible so the
    // adapter author can lift filter objects straight from it.
    let requestBody = entry.requestBody ?? null;
    if (typeof requestBody === 'string') {
        try {
            requestBody = JSON.parse(requestBody);
        }
        catch { /* keep the raw string */ }
    }
    const detailEnvelope = {
        key: entry.key,
        url: entry.url,
        method: entry.method,
        status: entry.status,
        ct: entry.ct,
        size: entry.size,
        ...(typeof entry.timestamp === 'number' ? { timestamp: toIsoTimestamp(entry.timestamp) } : {}),
        shape: inferShape(entry.body),
        body: outputBody,
        // O5: provenance — 'store' bodies were resolved from the capture
        // sidecar store and are complete (unless also marked truncated).
        ...(entry.body_source === 'store' ? { body_source: 'store' } : {}),
        ...(requestBody !== null ? { requestBody } : {}),
        ...(entry.requestBodyTruncated === true ? { requestBodyTruncated: true } : {}),
    };
    if (captureTruncated || transportTruncated) {
        detailEnvelope.body_truncated = true;
        detailEnvelope.body_full_size = entry.body_full_size ?? entry.size;
        detailEnvelope.body_truncation_reason = captureTruncated
            ? 'capture-limit'
            : 'max-body';
    }
    return { ok: true, envelope: detailEnvelope };
}

// ── console ─────────────────────────────────────────────────────────────────

/**
 * Console snapshot query (the non-follow subset): level filter ('error'
 * includes warning), time window, timestamp normalization. The `--follow`
 * poll loop stays CLI-local — streaming does not fit the tool request/response
 * model.
 */
export async function runConsoleQuery(page, opts = {}) {
    const session = pageSessionOf(page);
    const level = opts.level ?? 'all';
    const normalize = (messages) => messages.map((message) => {
        if (message && typeof message === 'object') {
            const record = message;
            return {
                ...record,
                timestamp: timestampFromRaw(record.timestamp),
            };
        }
        return { type: 'log', text: String(message), timestamp: Date.now() };
    });
    const filter = (messages) => filterByTimeWindow(messages, { sinceMs: opts.sinceMs, untilMs: opts.untilMs }).filter((message) => {
        if (level === 'all')
            return true;
        const type = String(message.type ?? message.level ?? '').toLowerCase();
        return level === 'error'
            ? type === 'error' || type === 'warning'
            : type === String(level).toLowerCase();
    });
    // A2 (console twin): the collector starts on first contact — messages
    // logged before this process's first console query are not visible. The
    // envelope says so when the buffer is empty rather than letting "0
    // messages" read as "the page logged nothing".
    const messages = filter(normalize(await page.consoleMessages(level)));
    const envelope = {
        session,
        captured_at: new Date().toISOString(),
        count: messages.length,
        messages: messages.map((message) => ({
            ...message,
            timestamp: toIsoTimestamp(message.timestamp),
        })),
    };
    if (messages.length === 0) {
        envelope.capture_hint = 'Console capture starts on first query per process — earlier messages are not retained. Re-trigger the action and query again.';
    }
    return { ok: true, envelope };
}

// ── find (structured CSS / semantic-locator query) ──────────────────────────

/**
 * The find query behind the CLI `browser find` and the MCP `find` tool: build
 * the in-page expression (CSS or semantic locator), evaluate, and unwrap the
 * result. `opts.locator` is a {role?, name?, label?, text?, testid?} object —
 * exactly one of `css` / `locator` must be present (callers validate usage
 * errors in their own contract first; this re-checks defensively).
 */
export async function runFindQuery(page, opts) {
    const hasCss = typeof opts.css === 'string' && opts.css.length > 0;
    const hasLocator = !!opts.locator && typeof opts.locator === 'object';
    if (hasCss === hasLocator) {
        return { ok: false, error: { code: 'usage_error', message: 'Pass either a css selector or semantic locator fields, not both.' } };
    }
    const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? opts.limit : undefined;
    const textMax = typeof opts.textMax === 'number' && Number.isFinite(opts.textMax) ? opts.textMax : undefined;
    const js = hasCss
        ? buildFindJs(opts.css, { limit, textMax })
        : buildSemanticFindJs({ ...opts.locator, limit, textMax });
    const result = await page.evaluate(js);
    if (isFindError(result)) {
        return { ok: false, error: result.error };
    }
    return { ok: true, result };
}

// ── analyze (site recon) ────────────────────────────────────────────────────

/**
 * The site-analysis pipeline behind the CLI `browser analyze` and the MCP
 * `analyze` tool: navigate → capture network → probe cookies/initial-state →
 * classify (anti-bot vendor, API candidates, pattern, nearest adapter).
 * `registry` defaults to the engine registry (run discovery first for the
 * nearest-adapter match to be meaningful). Runtime failures (goto etc.)
 * bubble as throws — both faces already have a catch-all error path.
 */
export async function runSiteAnalysis(page, url, opts = {}) {
    const hasSessionCapture = await page.startNetworkCapture?.() ?? false;
    await page.goto(url);
    await page.wait(2);
    if (!hasSessionCapture) {
        try {
            await page.evaluate(NETWORK_INTERCEPTOR_JS);
        }
        catch { /* non-fatal */ }
    }
    await captureNetworkItems(page);
    // Best-effort: give the page another beat so XHR after DOMContentLoaded lands.
    await page.wait(1);
    let rawItems = await captureNetworkItems(page);
    // Bug #28: slow SPAs fire their main data API after auth/router settle —
    // one bounded re-poll when nothing data-shaped has landed yet, instead of
    // reporting dictionary endpoints as the whole API surface.
    if (!rawItems.some((e) => /json/i.test(e.ct) && e.body)) {
        await page.wait(2);
        rawItems = await captureNetworkItems(page);
    }
    const networkEntries = rawItems.map((e) => ({
        url: e.url,
        method: e.method || 'GET',
        status: e.status,
        contentType: e.ct,
        // Bug #28 (round 2): the ring hands us PARSED bodies (O5 sidecar
        // store) — previewNetworkBody serializes structure-preserving
        // (arrays capped at 3 items, long strings clipped) so the scorer
        // still sees business keys inside the 64KiB budget. The round-1
        // stringify-then-slice cut 87KB envelopes mid-JSON and buried the
        // main data API under small dictionaries.
        bodyPreview: previewNetworkBody(e.body),
    }));
    const probeJs = `(function(){
        return {
          cookieNames: (document.cookie || '').split(';').map(function(c){ return c.trim().split('=')[0]; }).filter(Boolean),
          initialState: {
            __INITIAL_STATE__: typeof window.__INITIAL_STATE__ !== 'undefined',
            __NUXT__: typeof window.__NUXT__ !== 'undefined',
            __NEXT_DATA__: typeof window.__NEXT_DATA__ !== 'undefined',
            __APOLLO_STATE__: typeof window.__APOLLO_STATE__ !== 'undefined',
          },
          title: document.title || '',
          finalUrl: location.href,
        };
      })()`;
    const probe = await page.evaluate(probeJs);
    const browserCookieNames = (await page.getCookies({ url: probe.finalUrl || url }).catch(() => []))
        .map((c) => c.name)
        .filter(Boolean);
    const cookieNames = [...new Set([...probe.cookieNames, ...browserCookieNames])];
    const signals = {
        requestedUrl: url,
        finalUrl: probe.finalUrl,
        cookieNames,
        networkEntries,
        initialState: probe.initialState,
        title: probe.title,
    };
    const report = analyzeSite(signals, opts.registry ?? getRegistry());
    return { ok: true, report };
}

export { DEFAULT_TTL_MS };
