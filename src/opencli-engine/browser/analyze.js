/**
 * `browser analyze <url>` — turn site-recon guesswork into deterministic CLI output.
 *
 * When an agent starts a new adapter, the first question is "which pattern am
 * I looking at?" (A/B/C/D/E from site-recon docs) and "will Node-side fetch
 * work, or will anti-bot middleware block me?". Today the agent has to open
 * the page, poke `network`, try cURL, fail, guess again. This module condenses
 * that into one call that returns a classification + evidence.
 *
 * Kept pure (no page imports) so the bulk is unit-testable; the CLI wrapper
 * drives a real page, feeds the resulting signals here, and prints the verdict.
 */
/**
 * WAF vendors we can reliably detect from cookies + response body markers.
 *
 * Bug #28 (2026-08-31, ZKH ESP recon): cookie signals split into strong
 * (challenge markers — a JS/cookie challenge was actually solved) and weak
 * (edge infra cookies set passively on every response routed through the
 * vendor). Weak-only matches must NOT claim detection: the ESP site carries
 * a passive `acw_tc`, and the old code's "Node-side fetch will return the
 * slider HTML" implication pushed the agent off a working COOKIE_API
 * strategy toward a 7-8x more expensive one.
 */
const WAF_SIGNATURES = [
    {
        vendor: 'aliyun_waf',
        strongCookiePatterns: [/^acw_sc__v2$/, /^ssxmod_itna/],
        weakCookiePatterns: [/^acw_tc$/],
        bodyPatterns: [/arg1\s*=\s*['"][0-9A-F]{30,}/, /\/ntc_captcha\//i],
        implication: 'Aliyun WAF challenge markers seen — direct Node-side fetch/curl will return the slider HTML. Validate the endpoint in browser context first; HTML COOKIE adapters still finish with Node-side fetch + page.getCookies.',
        weakImplication: 'Aliyun edge cookie acw_tc present without challenge markers — it is set passively on every response routed through Aliyun and does not imply a slider challenge. Node-side fetch usually works.',
    },
    {
        vendor: 'cloudflare',
        strongCookiePatterns: [/^cf_clearance$/],
        weakCookiePatterns: [/^__cf_bm$/, /^__cfduid$/],
        bodyPatterns: [/Cloudflare Ray ID/i, /Checking your browser before accessing/i, /cf-chl-/i],
        implication: 'Cloudflare bot check. Start from a real browser session; probe in browser context first. HTML COOKIE adapters still finish with Node-side fetch + page.getCookies.',
        weakImplication: 'Cloudflare bot-score cookie (__cf_bm) present without challenge markers — set on most Cloudflare-proxied sites; does not imply an active challenge.',
    },
    {
        vendor: 'akamai',
        strongCookiePatterns: [],
        weakCookiePatterns: [/^_abck$/, /^bm_sz$/, /^bm_sv$/],
        bodyPatterns: [/akamai/i],
        implication: 'Akamai Bot Manager challenge. Probe in browser context first; keep final HTML COOKIE adapters on Node-side fetch + page.getCookies.',
        weakImplication: 'Akamai cookies (_abck/bm_sz) present without challenge markers — Akamai sets them on every response when Bot Manager is enabled; challenge state lives in the value, not the presence.',
    },
    {
        vendor: 'geetest',
        strongCookiePatterns: [],
        weakCookiePatterns: [],
        bodyPatterns: [/geetest/i, /gt_captcha/i],
        implication: 'Geetest slider/puzzle captcha. Agent cannot bypass programmatically — requires UI strategy or human-in-loop.',
        weakImplication: '',
    },
];
export function detectAntiBot(signals) {
    const strong = [];
    const weak = [];
    for (const sig of WAF_SIGNATURES) {
        const strongHits = [];
        const weakHits = [];
        for (const pat of sig.strongCookiePatterns) {
            const hit = signals.cookieNames.find((c) => pat.test(c));
            if (hit)
                strongHits.push(`cookie:${hit}`);
        }
        for (const pat of sig.weakCookiePatterns) {
            const hit = signals.cookieNames.find((c) => pat.test(c));
            if (hit)
                weakHits.push(`cookie:${hit}`);
        }
        for (const pat of sig.bodyPatterns) {
            for (const entry of signals.networkEntries) {
                if (entry.bodyPreview && pat.test(entry.bodyPreview)) {
                    strongHits.push(`body:${entry.url}`);
                    break;
                }
            }
        }
        if (strongHits.length > 0) {
            strong.push({ sig, evidence: strongHits });
        }
        else if (weakHits.length > 0) {
            weak.push({ sig, evidence: weakHits });
        }
    }
    if (strong.length > 0) {
        const evidence = strong.flatMap((s) => s.evidence);
        return {
            detected: true,
            vendor: strong[0].sig.vendor,
            evidence,
            implication: strong[0].sig.implication,
        };
    }
    if (weak.length > 0) {
        const weakSignals = weak.map(({ sig, evidence }) => ({
            vendor: sig.vendor,
            evidence,
            implication: sig.weakImplication,
        }));
        return {
            detected: false,
            vendor: null,
            evidence: [],
            weak_signals: weakSignals,
            implication: `No anti-bot challenge markers — only passive edge cookies (${weak.flatMap((w) => w.evidence).join(', ')}). Node-side fetch usually works; validate the endpoint before switching strategy. If blocked, retry from browser context.`,
        };
    }
    return {
        detected: false,
        vendor: null,
        evidence: [],
        implication: 'No known anti-bot signatures. Try Node-side COOKIE fetch first; if endpoint validation is blocked, retry from browser context.',
    };
}
const NOISE_URL_RE = /(?:analytics|beacon|collect|telemetry|tracking|sentry|doubleclick|google-analytics|googletagmanager|adservice|\/ads?(?:[/?#]|$)|metrics?|pixel|personalization|experiment|\/events?(?:[/?#]|$))/i;
const BUSINESS_KEY_RE = /^(?:data|items?|results?|records?|list|rows?|edges?|nodes?|timeline|users?|title|name|text|content|body|price|amount|id|url|avatar|nickname|desc|comments?|likes?|shares?|total|page|cursor|next|rank|score|date|time|author)$/i;
const TRACKING_KEY_RE = /^(?:event|events|trace|traceid|sessionid|clientid|visitorid|experiment|abtest|beacon|analytics|metrics?|pixel|log|logs)$/i;
function clampScore(value) {
    return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
function parseBodyPreview(preview) {
    if (!preview)
        return null;
    const trimmed = preview.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return trimmed;
    }
}
function collectJsonPaths(value, prefix = '$', out = [], depth = 0) {
    if (depth > 4 || out.length >= 24)
        return out;
    if (Array.isArray(value)) {
        out.push(`${prefix}:array(${value.length})`);
        if (value.length > 0)
            collectJsonPaths(value[0], `${prefix}[0]`, out, depth + 1);
        return out;
    }
    if (!value || typeof value !== 'object') {
        out.push(`${prefix}:${typeof value}`);
        return out;
    }
    const entries = Object.entries(value).slice(0, 12);
    for (const [key, child] of entries) {
        out.push(`${prefix}.${key}`);
        if (Array.isArray(child))
            out.push(`${prefix}.${key}:array(${child.length})`);
        else if (child && typeof child === 'object')
            collectJsonPaths(child, `${prefix}.${key}`, out, depth + 1);
        else
            out.push(`${prefix}.${key}:${typeof child}`);
    }
    return out;
}
function countKeys(value, predicate, depth = 0) {
    if (depth > 4 || !value || typeof value !== 'object')
        return 0;
    if (Array.isArray(value))
        return value.slice(0, 3).reduce((sum, item) => sum + countKeys(item, predicate, depth + 1), 0);
    return Object.entries(value).reduce((sum, [key, child]) => (sum + (predicate(key) ? 1 : 0) + countKeys(child, predicate, depth + 1)), 0);
}
function hasNonEmptyArray(value, depth = 0) {
    if (depth > 4 || !value || typeof value !== 'object')
        return false;
    if (Array.isArray(value))
        return value.length > 0;
    return Object.values(value).some((child) => hasNonEmptyArray(child, depth + 1));
}
export function scoreEndpointEvidence(entry) {
    const reasons = [];
    const body = parseBodyPreview(entry.bodyPreview);
    let score = 0;
    if (entry.status >= 200 && entry.status < 300) {
        score += 0.15;
        reasons.push('2xx status');
    }
    else if (entry.status === 401 || entry.status === 403) {
        return {
            url: entry.url,
            status: entry.status,
            contentType: entry.contentType,
            real_data_score: 0.05,
            verdict: 'blocked',
            reasons: ['auth-blocked status'],
            sample_paths: [],
        };
    }
    else {
        reasons.push(`non-2xx status ${entry.status}`);
    }
    if (/json/i.test(entry.contentType)) {
        score += 0.2;
        reasons.push('json content-type');
    }
    else if (/html/i.test(entry.contentType)) {
        score -= 0.25;
        reasons.push('html content-type');
    }
    else if (/javascript|text/i.test(entry.contentType)) {
        score += 0.05;
        reasons.push('text/script content-type');
    }
    if (NOISE_URL_RE.test(entry.url)) {
        score -= 0.3;
        reasons.push('telemetry-like url');
    }
    const samplePaths = collectJsonPaths(body).slice(0, 8);
    if (typeof body === 'string') {
        if (/^\s*</.test(body) || /<!doctype html|<html/i.test(body)) {
            score -= 0.25;
            reasons.push('html body');
        }
        else if (/^[[{]/.test(body)) {
            // Bug #28: JSON-shaped but unparseable = a truncated preview of a
            // LARGE JSON response (small dictionaries always parse whole).
            // Scoring it as opaque text systematically buried the main data
            // API under small config/dictionary endpoints.
            score += 0.2;
            reasons.push('truncated json body (api-shaped)');
        }
        else if (body.trim().length > 20) {
            score += 0.05;
            reasons.push('non-empty text body');
        }
    }
    else if (Array.isArray(body)) {
        if (body.length > 0) {
            score += 0.3;
            reasons.push('non-empty top-level array');
        }
        else {
            score -= 0.15;
            reasons.push('empty array');
        }
    }
    else if (body && typeof body === 'object') {
        const keys = Object.keys(body);
        if (keys.length === 0) {
            score -= 0.15;
            reasons.push('empty object');
        }
        else {
            score += 0.12;
            reasons.push('json object body');
        }
        const businessKeys = countKeys(body, (key) => BUSINESS_KEY_RE.test(key));
        if (businessKeys > 0) {
            score += Math.min(0.3, businessKeys * 0.05);
            reasons.push(`${businessKeys} business-like key${businessKeys === 1 ? '' : 's'}`);
        }
        if (hasNonEmptyArray(body)) {
            score += 0.2;
            reasons.push('nested non-empty array');
        }
        const trackingKeys = countKeys(body, (key) => TRACKING_KEY_RE.test(key));
        if (trackingKeys > 0 && businessKeys === 0) {
            score -= Math.min(0.25, trackingKeys * 0.08);
            reasons.push(`${trackingKeys} tracking-like key${trackingKeys === 1 ? '' : 's'} without business keys`);
        }
    }
    const realDataScore = clampScore(score);
    const verdict = realDataScore >= 0.65
        ? 'likely_data'
        : realDataScore >= 0.35
            ? 'maybe_data'
            : 'noise';
    return {
        url: entry.url,
        status: entry.status,
        contentType: entry.contentType,
        real_data_score: realDataScore,
        verdict,
        reasons,
        sample_paths: samplePaths,
    };
}
export function scoreNetworkEvidence(signals) {
    // Bug #28: dedup by URL — SPAs routinely fire the same dictionary/config
    // endpoint several times during boot, and the old no-dedup list padded
    // api_candidates with repeats (one recon showed the same status dictionary
    // three times) while crowding out the real data API.
    const byUrl = new Map();
    for (const entry of signals.networkEntries) {
        const evidence = scoreEndpointEvidence(entry);
        const existing = byUrl.get(entry.url);
        if (!existing) {
            byUrl.set(entry.url, { ...evidence, repeats: 1 });
        }
        else {
            existing.repeats += 1;
            if (evidence.real_data_score > existing.real_data_score) {
                byUrl.set(entry.url, { ...evidence, repeats: existing.repeats });
            }
        }
    }
    return [...byUrl.values()]
        .filter((evidence) => evidence.verdict !== 'noise' || evidence.real_data_score > 0)
        .sort((a, b) => b.real_data_score - a.real_data_score)
        .slice(0, 8);
}
/**
 * Apply the decision tree from `site-recon.md` mechanically.
 *
 * B beats A when initial-state globals are present: even if the page fetches
 * more data via XHR afterwards, the SSR payload is the highest-leverage source.
 * D (token-gated) dominates when we see 401/403 on what looks like API
 * endpoints — without that, an authenticated route looks identical to A.
 */
export function classifyPattern(signals) {
    const jsonEntries = signals.networkEntries.filter((e) => /json/i.test(e.contentType));
    const endpointEvidence = scoreNetworkEvidence(signals);
    const realDataCandidates = endpointEvidence.filter((e) => e.verdict === 'likely_data' || e.verdict === 'maybe_data').length;
    const authFailures = signals.networkEntries.filter((e) => e.status === 401 || e.status === 403).length;
    const hasInitialState = signals.initialState.__INITIAL_STATE__ ||
        signals.initialState.__NUXT__ ||
        signals.initialState.__NEXT_DATA__ ||
        signals.initialState.__APOLLO_STATE__;
    if (authFailures >= 2 && jsonEntries.length >= 1) {
        return {
            pattern: 'D',
            reason: `${authFailures} auth-failing API responses seen — endpoint is token-gated`,
            json_responses: jsonEntries.length,
            real_data_candidates: realDataCandidates,
            auth_failures: authFailures,
        };
    }
    if (hasInitialState) {
        const which = Object.entries(signals.initialState)
            .filter(([, v]) => v)
            .map(([k]) => k);
        return {
            pattern: 'B',
            reason: `SSR state global present: ${which.join(', ')}`,
            json_responses: jsonEntries.length,
            real_data_candidates: realDataCandidates,
            auth_failures: authFailures,
        };
    }
    if (realDataCandidates >= 1) {
        return {
            pattern: 'A',
            reason: `${realDataCandidates} captured response${realDataCandidates === 1 ? '' : 's'} look like real data — inspect api_candidates before choosing a strategy`,
            json_responses: jsonEntries.length,
            real_data_candidates: realDataCandidates,
            auth_failures: authFailures,
        };
    }
    // No API, no SSR state — probably static HTML or a bundled SPA that lazy-loads.
    // Pattern C (HTML scrape) is the default fallback; E (streaming) we can't
    // reliably detect without watching WebSocket frames, so we label 'C' and
    // leave the agent to upgrade to E manually if they see WS traffic.
    return {
        pattern: 'C',
        reason: jsonEntries.length > 0
            ? `${jsonEntries.length} JSON response${jsonEntries.length === 1 ? '' : 's'} observed, but none look like target data — likely telemetry/side-channel; treat as HTML/DOM until an endpoint validates`
            : 'No JSON XHR and no SSR state — HTML scrape (Pattern C); escalate to E manually if WebSocket traffic appears',
        json_responses: jsonEntries.length,
        real_data_candidates: realDataCandidates,
        auth_failures: authFailures,
    };
}
/**
 * Find existing adapters that target the same site.
 *
 * Bug #28 (2026-08-31, ZKH ESP recon): matching must be host-anchored. The
 * old `domain.endsWith(apex)` matched ANY adapter sharing the registrable
 * domain — esp.zkh360.com got "nearest_adapter: quickbi, reuse
 * strategy/cookie config" even though quickbi.zkh360.com is a completely
 * different application that just happens to sit on the same company apex.
 * Same host or a subdomain of the adapter's registered domain counts; a
 * sibling subdomain does not.
 */
export function findNearestAdapter(finalUrl, registry) {
    let host;
    try {
        host = new URL(finalUrl).hostname;
    }
    catch {
        return null;
    }
    // Strip leading www.; 'www' as a site identifier is never what an adapter uses.
    const cleanedHost = host.replace(/^www\./, '');
    // Extract apex (xx.com) and registrable parts for reporting only.
    const parts = cleanedHost.split('.');
    const siteKey = parts.length > 1 ? parts[parts.length - 2] : cleanedHost;
    const hits = new Map();
    for (const cmd of registry.values()) {
        const domain = cmd.domain?.toLowerCase()
            ?.replace(/^https?:\/\//, '')
            ?.replace(/^www\./, '');
        const hostMatch = !!domain && (cleanedHost === domain || cleanedHost.endsWith(`.${domain}`));
        const siteMatch = cmd.site.toLowerCase() === siteKey?.toLowerCase() ||
            cleanedHost.includes(cmd.site.toLowerCase());
        if (hostMatch || siteMatch) {
            const list = hits.get(cmd.site) ?? [];
            list.push(cmd);
            hits.set(cmd.site, list);
        }
    }
    if (hits.size === 0)
        return null;
    // Pick the site with the most commands — likely the most-developed adapter,
    // and the best reference for a new command on the same host.
    let best = null;
    for (const entry of hits) {
        if (!best || entry[1].length > best[1].length)
            best = entry;
    }
    if (!best)
        return null;
    return {
        site: best[0],
        example_commands: best[1].slice(0, 5).map((c) => `${c.site} ${c.name}`),
        reason: `${best[1].length} existing adapter${best[1].length === 1 ? '' : 's'} target this host — reuse strategy/cookie config`,
    };
}
/**
 * Synthesize the verdict from collected signals + registry.
 *
 * The `recommended_next_step` is deliberately a single imperative
 * sentence — agents act on it directly instead of re-deriving advice from
 * the structured fields.
 */
export function analyzeSite(signals, registry) {
    const pattern = classifyPattern(signals);
    const antiBot = detectAntiBot(signals);
    const apiCandidates = scoreNetworkEvidence(signals);
    const nearest = findNearestAdapter(signals.finalUrl, registry);
    let next;
    if (antiBot.detected) {
        next = antiBot.implication;
    }
    else if (pattern.pattern === 'A') {
        next = 'Inspect `api_candidates`, then replay the best endpoint and record the status/content-type/sample shape in your strategy note; do not choose API strategy from XHR count alone.';
    }
    else if (pattern.pattern === 'B') {
        next = 'Read the SSR global via `hub browser eval "JSON.stringify(window.__INITIAL_STATE__ ?? window.__NUXT__ ?? window.__NEXT_DATA__ ?? window.__APOLLO_STATE__)"` — no API needed.';
    }
    else if (pattern.pattern === 'C') {
        next = 'No API visible — use SSR HTML scrape (e.g. `hub browser extract`) against the rendered page.';
    }
    else if (pattern.pattern === 'D') {
        next = 'Endpoints need auth. Re-open the page from a signed-in session, then retry analyze; see `field-decode-playbook` §4 for token tracing.';
    }
    else if (pattern.pattern === 'E') {
        next = 'WebSocket stream detected — find the underlying HTTP poll/long-poll endpoint; raw WS is not supported.';
    }
    else {
        next = 'No strong signal. Manually inspect `hub browser network --all` and pick a pattern.';
    }
    return {
        requested_url: signals.requestedUrl,
        final_url: signals.finalUrl,
        title: signals.title,
        pattern,
        anti_bot: antiBot,
        initial_state: signals.initialState,
        api_candidates: apiCandidates,
        nearest_adapter: nearest,
        recommended_next_step: next,
    };
}
