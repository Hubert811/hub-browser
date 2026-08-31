/**
 * CLI entry point: registers built-in commands and wires up Commander.
 *
 * Built-in commands are registered inline here (list, validate, explore, etc.).
 * Dynamic adapter commands are registered via commanderAdapter.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { findPackageRoot, getBuiltEntryCandidates } from './package-paths.js';
import { fullName, getRegistry, strategyLabel } from './registry.js';
import { serializeCommand, formatArgSummary } from './serialization.js';
import { render as renderOutput } from './output.js';
import { PKG_VERSION } from './version.js';
import { printCompletionScript } from './completion.js';
import { loadExternalClis, executeExternalCli, installExternalCli, registerExternalCli, isBinaryInstalled, formatExternalCliLabel } from './external.js';
import { isDaemonMode, getDaemonFactory, getBrowserBridgeOverride } from './runtime-globals.js';
import { listOpenCliSkills, readOpenCliSkill } from './skills.js';
import { registerAllCommands } from './commanderAdapter.js';
import { classifyAdapter, formatRootAdapterHelpText, installCommanderNamespaceStructuredHelp, installStructuredHelp, leadingPositionalFromUsage, rootHelpData } from './help.js';
import { EXIT_CODES, getErrorMessage, BrowserConnectError, CliError } from './errors.js';
import { TargetError } from './browser/target-errors.js';
import { resolveTargetJs, getTextResolvedJs, getValueResolvedJs, getAttributesResolvedJs, selectResolvedJs, isAutocompleteResolvedJs } from './browser/target-resolver.js';
import { buildSemanticFindJs, isFindError } from './browser/find.js';
import { assignKeys } from './browser/network-key.js';
import { DEFAULT_TTL_MS } from './browser/network-cache.js';
import { NETWORK_INTERCEPTOR_JS } from './browser/network-interceptor.js';
import { parseFilter } from './browser/shape-filter.js';
import { buildHtmlTreeJs } from './browser/html-tree.js';
// P2-6: extract helpers now live in the shared `extract` tool definition
// (browser-mcp/src/tools/page-info.ts); the CLI command is a thin wrapper.
// P2-6 (batch 2): the network/console pipelines live in the shared
// observation-query module — the CLI commands and the MCP observation tools
// (browser-mcp/src/tools/observation-tools.ts) run ONE implementation.
import {
    captureNetworkItems,
    filterByTimeWindow,
    filterNetworkItems,
    pageSessionOf as getPageSession,
    parseDurationMs,
    selectFreshByTimestamp,
    timestampFromRaw,
    toIsoTimestamp,
} from './browser/observation-query.js';
import { registerAuthCommands } from './commands/auth.js';
import { log } from './logger.js';
import { DEFAULT_BROWSER_CONNECT_TIMEOUT } from './browser/config.js';
import { hubUserRoot } from './discovery.js';
const CLI_FILE = fileURLToPath(import.meta.url);
/** Error class for browser command failures. */
class BrowserCommandError extends Error {
    constructor(message) { super(message); this.name = 'BrowserCommandError'; }
}
const BROWSER_TAB_OPTION_DESCRIPTION = 'Target tab/page identity returned by "browser open", "browser tab new", or "browser tab list"';
const FOLLOW_POLL_MS = 1_000;
/** Exit codes by network error code — usage errors vs runtime failures. */
const NETWORK_ERROR_EXIT = {
    invalid_args: EXIT_CODES.USAGE_ERROR,
    invalid_filter: EXIT_CODES.USAGE_ERROR,
    invalid_max_body: EXIT_CODES.USAGE_ERROR,
};
/** Emit a structured error JSON so agents can branch on `error.code` without regex. */
function emitNetworkError(code, message, extra = {}) {
    console.log(JSON.stringify({ error: { code, message, ...extra } }, null, 2));
    process.exitCode = NETWORK_ERROR_EXIT[code] ?? EXIT_CODES.GENERIC_ERROR;
}
/**
 * Bug #26: process.exit() discards stdout/stderr still queued for the pipe —
 * agents consume CLI output through pipes, and >64KB of buffered output is
 * silently dropped mid-JSON. TTYs and regular files are synchronous writes,
 * so only piped consumers lose data.
 *
 * Round 2 probes (2026-08-31) ruled out BOTH queue probes on Bun:
 * writableLength reports 0 with ~450KB still queued, and write('', cb) fires
 * its callback immediately without draining (65536 bytes delivered). The only
 * drain both runtimes honor for writes whose callbacks we no longer hold is
 * NATURAL process exit — a pending stdio write holds the event loop open
 * until flushed. The unref'd hard exit bounds the case where lingering CDP
 * handles would otherwise wedge the CLI; by then output has had 2s to reach
 * the kernel pipe buffer.
 */
async function flushAndExit(code) {
    if (typeof code === 'number')
        process.exitCode = code;
    const hardExit = setTimeout(() => process.exit(code), 2000);
    hardExit.unref?.();
}
const SITEMAP_HINT = 'Site sitemap available. For navigation context, use the hub-browser-sitemap skill; treat browser state as truth if it disagrees.';
function siteNameCandidatesFromUrl(url, registry = getRegistry()) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    }
    catch {
        return [];
    }
    const scored = new Map();
    for (const command of registry.values()) {
        if (!command.domain)
            continue;
        let domainHost = command.domain.toLowerCase().trim();
        try {
            domainHost = new URL(domainHost.includes('://') ? domainHost : `https://${domainHost}`).hostname.toLowerCase();
        }
        catch {
            domainHost = domainHost.split('/')[0] ?? domainHost;
        }
        domainHost = domainHost.replace(/^www\./, '');
        if (!domainHost)
            continue;
        if (host === domainHost || host.endsWith(`.${domainHost}`)) {
            scored.set(command.site, Math.max(scored.get(command.site) ?? 0, domainHost.length));
        }
    }
    const registrySites = [...scored.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([site]) => site);
    const hostParts = host.split('.').filter(Boolean);
    const fallback = hostParts.length >= 2 ? hostParts[hostParts.length - 2] : hostParts[0];
    return [...new Set([...registrySites, ...(fallback ? [fallback] : [])])];
}
function firstExistingSitemapPath(paths, fileExists) {
    return paths.find((candidate) => fileExists(candidate));
}
function sitemapPathsForSite(site, opts) {
    const safeSite = site.replace(/[^a-zA-Z0-9_-]+/g, '-');
    if (!safeSite)
        return {};
    const localBase = path.join(opts.homeDir, '.hub', 'config', 'sites', safeSite);
    return {
        local: firstExistingSitemapPath([
            path.join(localBase, 'sitemap'),
            path.join(localBase, 'sitemap.md'),
        ], opts.fileExists),
        global: firstExistingSitemapPath([
            path.join(opts.packageRoot, 'sitemaps', safeSite),
            path.join(opts.packageRoot, 'sitemaps', `${safeSite}.md`),
        ], opts.fileExists),
    };
}
export function resolveSitemapAvailabilityForUrl(url, options = {}) {
    const homeDir = options.homeDir ?? os.homedir();
    const packageRoot = options.packageRoot ?? findPackageRoot(CLI_FILE);
    const registry = options.registry ?? getRegistry();
    const fileExists = options.fileExists ?? fs.existsSync;
    for (const site of siteNameCandidatesFromUrl(url, registry)) {
        const paths = sitemapPathsForSite(site, { homeDir, packageRoot, fileExists });
        if (!paths.local && !paths.global)
            continue;
        const source = paths.local && paths.global ? 'local+global' : paths.local ? 'local' : 'global';
        return {
            site,
            available: true,
            source,
            hint: SITEMAP_HINT,
            paths,
        };
    }
    return null;
}
function getBrowserSitemapHintStatePath(scope) {
    const safeScope = scope.replace(/[^a-zA-Z0-9_-]+/g, '_');
    return path.join(getBrowserCacheDir(), 'browser-sitemap-hints', `${safeScope}.json`);
}
function loadBrowserSitemapHintState(scope) {
    try {
        const parsed = JSON.parse(fs.readFileSync(getBrowserSitemapHintStatePath(scope), 'utf-8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.seenSites)) {
            return {
                seenSites: parsed.seenSites.filter((site) => typeof site === 'string'),
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
            };
        }
    }
    catch {
        // First command in this browser session has no hint cache yet.
    }
    return { seenSites: [], updatedAt: new Date(0).toISOString() };
}
function markBrowserSitemapHintSeen(scope, site) {
    const state = loadBrowserSitemapHintState(scope);
    if (!state.seenSites.includes(site))
        state.seenSites.push(site);
    const target = getBrowserSitemapHintStatePath(scope);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ seenSites: state.seenSites, updatedAt: new Date().toISOString() }), 'utf-8');
}
function sitemapHintForBrowserUrl(url, scope, opts) {
    const sitemap = resolveSitemapAvailabilityForUrl(url);
    if (!sitemap)
        return null;
    if (!opts.oncePerSession)
        return sitemap;
    const state = loadBrowserSitemapHintState(scope);
    if (state.seenSites.includes(sitemap.site))
        return null;
    markBrowserSitemapHintSeen(scope, sitemap.site);
    return sitemap;
}
export function checkSiteMemory(site) {
    const siteDir = path.join(hubUserRoot(), 'config', 'sites', site);
    const endpointsPath = path.join(siteDir, 'endpoints.json');
    const notesPath = path.join(siteDir, 'notes.md');
    let endpointsCount = 0;
    let endpointsPresent = fs.existsSync(endpointsPath);
    if (endpointsPresent) {
        try {
            const parsed = JSON.parse(fs.readFileSync(endpointsPath, 'utf-8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                endpointsCount = Object.keys(parsed).length;
            }
            else if (Array.isArray(parsed)) {
                endpointsCount = parsed.length;
            }
        }
        catch {
            endpointsPresent = false;
        }
    }
    const notesPresent = fs.existsSync(notesPath);
    return {
        ok: endpointsPresent && endpointsCount > 0 && notesPresent,
        siteDir,
        endpoints: { present: endpointsPresent, count: endpointsCount, path: endpointsPath },
        notes: { present: notesPresent, path: notesPath },
    };
}
export function printSiteMemoryReport(report, strict) {
    if (report.ok) {
        console.log(`  ✓ Memory: endpoints.json (${report.endpoints.count}), notes.md present at ${report.siteDir}`);
        return;
    }
    const marker = strict ? '✗' : '⚠';
    const missing = [];
    if (!report.endpoints.present)
        missing.push('endpoints.json');
    else if (report.endpoints.count === 0)
        missing.push('endpoints.json (empty)');
    if (!report.notes.present)
        missing.push('notes.md');
    console.log(`  ${marker} Memory: missing ${missing.join(', ')} under ${report.siteDir}`);
    console.log(`    Write the endpoint you just verified + a 1-line session note so the next agent starts from minute 0, not minute 95.`);
    if (!strict) {
        console.log(`    (Re-run with --strict-memory to fail instead of warn.)`);
    }
}
/** Coerce adapter JSON output into a row array. Accepts `[{...}]`, single `{}`, or `{items:[...]}`-style envelopes. */
export function normalizeVerifyRows(data) {
    if (Array.isArray(data)) {
        return data.map((r) => (r && typeof r === 'object' ? r : { value: r }));
    }
    if (data && typeof data === 'object') {
        const obj = data;
        for (const k of ['rows', 'items', 'data', 'results']) {
            if (Array.isArray(obj[k])) {
                return obj[k].map((r) => (r && typeof r === 'object' ? r : { value: r }));
            }
        }
        return [obj];
    }
    return [];
}
/** Render up to 10 rows as a compact padded table for eyeball inspection during verify. */
export function renderVerifyPreview(rows, opts = {}) {
    const maxRows = opts.maxRows ?? 10;
    const maxCols = opts.maxCols ?? 6;
    const cellMax = opts.cellMax ?? 40;
    if (rows.length === 0)
        return '  (no rows)';
    const allCols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const cols = allCols.slice(0, maxCols);
    const shown = rows.slice(0, maxRows);
    const cellOf = (v) => {
        if (v === null || v === undefined)
            return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return s.replace(/\s+/g, ' ').slice(0, cellMax);
    };
    const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => cellOf(r[c]).length)));
    const fmtRow = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
    const out = [];
    out.push(`  ${fmtRow(cols)}`);
    out.push(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
    for (const r of shown)
        out.push(`  ${fmtRow(cols.map((c) => cellOf(r[c])))}`);
    if (rows.length > maxRows)
        out.push(`  ... and ${rows.length - maxRows} more row(s)`);
    if (allCols.length > maxCols)
        out.push(`  (${allCols.length - maxCols} more column(s) hidden)`);
    return out.join('\n');
}
function getBrowserCacheDir() {
    return process.env.OPENCLI_CACHE_DIR || path.join(hubUserRoot(), 'cache');
}
function getBrowserTargetStatePath(scope) {
    const safeSession = scope.replace(/[^a-zA-Z0-9_-]+/g, '_');
    return path.join(getBrowserCacheDir(), 'browser-state', `${safeSession}.json`);
}
function loadBrowserTargetState(scope) {
    try {
        const raw = fs.readFileSync(getBrowserTargetStatePath(scope), 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
// Scope contract: `scope` is the USER SESSION name (the `hub browser <session>
// ...` positional / internal --session), which is the ONLY key getBrowserPage()
// reads through resolveStoredBrowserTarget(). It must never be a page/CDP
// session like `page-<pageId>` — getPageScope(page) is not interchangeable here.
function saveBrowserTargetState(defaultPage, scope) {
    const target = getBrowserTargetStatePath(scope);
    if (!defaultPage) {
        fs.rmSync(target, { force: true });
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ defaultPage, updatedAt: new Date().toISOString() }), 'utf-8');
}
function hasBrowserTabTarget(tabs, targetPage) {
    return tabs.some((tab) => {
        return typeof tab === 'object'
            && tab !== null
            && 'page' in tab
            && typeof tab.page === 'string'
            && tab.page === targetPage;
    });
}
async function resolveBrowserTargetInSession(page, targetPage, opts) {
    const candidate = targetPage.trim();
    if (!candidate)
        return undefined;
    let tabs;
    try {
        tabs = await page.tabs();
    }
    catch (err) {
        if (opts.source === 'saved') {
            saveBrowserTargetState(undefined, opts.scope);
            return undefined;
        }
        throw new Error(`Target tab ${candidate} could not be validated in the current browser session. ` +
            'The Browser Bridge session may have restarted; re-run "hub browser tab list" and choose a current target.', { cause: err });
    }
    if (Array.isArray(tabs) && hasBrowserTabTarget(tabs, candidate)) {
        return candidate;
    }
    if (opts.source === 'saved') {
        saveBrowserTargetState(undefined, opts.scope);
        return undefined;
    }
    throw new Error(`Target tab ${candidate} is not part of the current browser session. ` +
        'The Browser Bridge session may have restarted; re-run "hub browser tab list" and choose a current target.');
}
async function resolveStoredBrowserTarget(page, scope) {
    const defaultPage = loadBrowserTargetState(scope)?.defaultPage?.trim();
    if (!defaultPage)
        return undefined;
    return resolveBrowserTargetInSession(page, defaultPage, { scope, source: 'saved' });
}
/** Create a browser page for browser commands. Uses a named browser session for continuity. */
async function getBrowserPage(session, targetPage, opts = {}) {
    const { BrowserBridge } = await import('./browser/index.js');
    // Test-only seam: tests inject a fake bridge (a class with connect()) via
    // globalThis.__HubBrowserBridgeOverride so browser commands can be exercised
    // without a live CDP connection.
    const BridgeCtor = getBrowserBridgeOverride() ?? BrowserBridge;
    const bridge = new BridgeCtor();
    // Internal GC timeout for browser sessions. Not the per-command runtime timeout.
    const envTimeout = process.env.OPENCLI_BROWSER_IDLE_TIMEOUT;
    const idleTimeout = envTimeout ? parseInt(envTimeout, 10) : undefined;
    const page = await bridge.connect({
        timeout: DEFAULT_BROWSER_CONNECT_TIMEOUT,
        session,
        surface: 'browser',
        ...(idleTimeout && idleTimeout > 0 && { idleTimeout }),
        windowMode: opts.windowMode ?? getBrowserWindowMode(undefined, 'foreground'),
    });
    const targetScope = session;
    const resolvedTargetPage = targetPage
        ? await resolveBrowserTargetInSession(page, targetPage, { scope: targetScope, source: 'explicit' })
        : await resolveStoredBrowserTarget(page, targetScope);
    if (resolvedTargetPage) {
        if (!page.setActivePage) {
            throw new Error('This browser session does not support explicit tab targeting');
        }
        await page.setActivePage(resolvedTargetPage);
    }
    return page;
}
function getBrowserWindowMode(command, defaultMode) {
    const optionRaw = getCommandOption(command, 'window');
    if (optionRaw !== undefined && optionRaw !== '') {
        if (optionRaw === 'foreground' || optionRaw === 'background')
            return optionRaw;
        throw new Error(`--window must be one of: foreground, background. Received: "${String(optionRaw)}"`);
    }
    const envRaw = process.env.OPENCLI_WINDOW;
    if (envRaw !== undefined && envRaw !== '') {
        if (envRaw === 'foreground' || envRaw === 'background')
            return envRaw;
        throw new Error(`OPENCLI_WINDOW must be one of: foreground, background. Received: "${envRaw}"`);
    }
    return defaultMode;
}
function addBrowserTabOption(command) {
    return command.option('--tab <targetId>', BROWSER_TAB_OPTION_DESCRIPTION);
}
function getBrowserTargetId(command) {
    if (!command)
        return undefined;
    const opts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
    return typeof opts.tab === 'string' && opts.tab.trim() ? opts.tab.trim() : undefined;
}
function getCommandOption(command, option) {
    let current = command;
    while (current) {
        const opts = current.opts();
        if (Object.prototype.hasOwnProperty.call(opts, option) && opts[option] !== undefined)
            return opts[option];
        current = current.parent;
    }
    return undefined;
}
function getBrowserSession(command) {
    // The CLI surface is `hub browser <session> <subcommand>`. main.ts rewrites
    // argv to insert `--session <name>` before commander parses it; this helper
    // reads back the rewritten flag.
    const raw = getCommandOption(command, 'session');
    if (typeof raw === 'string' && raw.trim())
        return raw.trim();
    throw new Error('<session> is a required positional argument: hub browser <session> <command>');
}
// The page/CDP session (`page-<pageId>`). Used only for per-page concerns
// (sitemap-hint dedup, `session:` display). NOT the browser-target-state key —
// that file must be keyed by the user session name (see saveBrowserTargetState).
function getPageScope(page) {
    return getPageSession(page);
}
function snapshotMetricText(snapshot) {
    return typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2);
}
function snapshotMetrics(snapshot, elapsedMs) {
    const text = snapshotMetricText(snapshot);
    const interactiveMatch = text.match(/^interactive:\s*(\d+)\s*$/m);
    return {
        ok: true,
        chars: text.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: text ? text.split(/\r?\n/).length : 0,
        approx_tokens: Math.ceil(text.length / 4),
        refs: (text.match(/(^|\n)\s*\[\d+\]/g) ?? []).length,
        frame_sections: (text.match(/(^|\n)frame /g) ?? []).length,
        ...(interactiveMatch ? { interactive: Number(interactiveMatch[1]) } : {}),
        elapsed_ms: elapsedMs,
    };
}
async function snapshotSourceMetrics(page, source) {
    const started = Date.now();
    try {
        const snapshot = await page.snapshot({ viewportExpand: 2000, source });
        return snapshotMetrics(snapshot, Date.now() - started);
    }
    catch (err) {
        return {
            ok: false,
            elapsed_ms: Date.now() - started,
            error: {
                ...(err instanceof Error && 'code' in err ? { code: String(err.code) } : {}),
                message: err instanceof Error ? err.message : String(err),
            },
        };
    }
}
function resolveBrowserTabTarget(targetId, opts) {
    if (typeof targetId === 'string' && targetId.trim())
        return targetId.trim();
    const tab = opts instanceof Command ? opts.opts().tab : opts?.tab;
    if (typeof tab === 'string' && tab.trim())
        return tab.trim();
    return undefined;
}
function parsePositiveIntOption(val, label, fallback) {
    if (val === undefined)
        return fallback;
    const parsed = parseInt(val, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        console.error(`[cli] Invalid ${label}="${val}", using default ${fallback}`);
        return fallback;
    }
    return parsed;
}
function parseScreenshotDim(val, label) {
    if (!/^\d+$/.test(val)) {
        throw new InvalidArgumentError(`--${label} must be a positive integer (got "${val}")`);
    }
    const parsed = parseInt(val, 10);
    if (parsed <= 0) {
        throw new InvalidArgumentError(`--${label} must be a positive integer (got "${val}")`);
    }
    return parsed;
}
function applyVerbose(opts) {
    if (opts.verbose)
        process.env.OPENCLI_VERBOSE = '1';
}
function formatChildCommandSummary(command) {
    return [...new Set(command.commands.map(child => child.name()))]
        .sort((a, b) => a.localeCompare(b))
        .join(', ');
}
function applyRootSubcommandSummaries(program) {
    for (const command of program.commands) {
        if (command.commands.length === 0)
            continue;
        const summary = formatChildCommandSummary(command);
        if (summary)
            command.description(summary);
    }
}
export function createProgram(BUILTIN_CLIS, USER_CLIS) {
    const program = new Command();
    // enablePositionalOptions: prevents parent from consuming flags meant for subcommands;
    // prerequisite for passThroughOptions to forward --help/--version to external binaries
    program
        .name('hub')
        .description('Make any website your CLI. Zero setup. AI-powered.')
        .version(PKG_VERSION)
        .enablePositionalOptions();
    // ── Built-in: list ────────────────────────────────────────────────────────
    program
        .command('list')
        .description('List all available CLI commands')
        .option('-f, --format <fmt>', 'Output format: table, json, yaml, md, csv', 'table')
        .action((opts) => {
        const registry = getRegistry();
        const commands = [...new Set(registry.values())].sort((a, b) => fullName(a).localeCompare(fullName(b)));
        const fmt = opts.format;
        const isStructured = fmt === 'json' || fmt === 'yaml';
        if (fmt !== 'table') {
            const rows = isStructured
                ? commands.map(serializeCommand)
                : commands.map(c => ({
                    command: fullName(c),
                    site: c.site,
                    name: c.name,
                    aliases: c.aliases?.join(', ') ?? '',
                    description: c.description,
                    access: c.access,
                    strategy: strategyLabel(c),
                    browser: !!c.browser,
                    args: formatArgSummary(c.args),
                }));
            renderOutput(rows, {
                fmt,
                columns: ['command', 'site', 'name', 'aliases', 'description', 'access', 'strategy', 'browser', 'args',
                    ...(isStructured ? ['columns', 'domain'] : [])],
                title: 'hub/list',
                source: 'hub list',
            });
            return;
        }
        // Table (default) — grouped by adapter kind (app vs site), then by site name.
        // classifyAdapter() reads the `domain` field: DNS-style domains are sites;
        // localhost/loopback endpoints and bare app names are apps.
        const appsBySite = new Map();
        const sitesBySite = new Map();
        for (const cmd of commands) {
            const target = classifyAdapter(cmd.domain) === 'app' ? appsBySite : sitesBySite;
            const g = target.get(cmd.site) ?? [];
            g.push(cmd);
            target.set(cmd.site, g);
        }
        const renderSiteGroup = (site, cmds) => {
            console.log(`  ${site}`);
            for (const cmd of cmds) {
                const label = strategyLabel(cmd);
                const tag = label === 'public'
                    ? '[public]'
                    : `[${label}]`;
                const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
                console.log(`    ${cmd.name} ${tag}${aliases}${cmd.description ? ` — ${cmd.description}` : ''}`);
            }
            console.log();
        };
        console.log();
        console.log('  hub' + ' — available commands');
        console.log();
        if (appsBySite.size > 0) {
            console.log('  App adapters');
            console.log();
            for (const [site, cmds] of appsBySite)
                renderSiteGroup(site, cmds);
        }
        if (sitesBySite.size > 0) {
            console.log('  Site adapters');
            console.log();
            for (const [site, cmds] of sitesBySite)
                renderSiteGroup(site, cmds);
        }
        const externalClis = loadExternalClis();
        if (externalClis.length > 0) {
            console.log('  external CLIs');
            for (const ext of externalClis) {
                const isInstalled = isBinaryInstalled(ext.binary);
                const tag = isInstalled ? '[installed]' : '[auto-install]';
                console.log(`    ${formatExternalCliLabel(ext)} ${tag}${ext.description ? ` — ${ext.description}` : ''}`);
            }
            console.log();
        }
        console.log(`  ${commands.length} built-in commands across ${appsBySite.size} apps + ${sitesBySite.size} sites, ${externalClis.length} external CLIs`);
        console.log();
    });
    // ── Built-in: validate / verify ───────────────────────────────────────────
    program
        .command('validate')
        .description('Validate CLI definitions')
        .argument('[target]', 'site or site/name')
        .action(async (target) => {
        const { validateClisWithTarget, renderValidationReport } = await import('./validate.js');
        console.log(renderValidationReport(validateClisWithTarget([BUILTIN_CLIS, USER_CLIS], target)));
    });
    program
        .command('verify')
        .description('Validate + smoke test')
        .argument('[target]')
        .option('--smoke', 'Run smoke tests', false)
        .action(async (target, opts) => {
        const { verifyClis, renderVerifyReport } = await import('./verify.js');
        const r = await verifyClis({ builtinClis: BUILTIN_CLIS, userClis: USER_CLIS, target, smoke: opts.smoke });
        console.log(renderVerifyReport(r));
        process.exitCode = r.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.GENERIC_ERROR;
    });
    const skillsCmd = program
        .command('skills')
        .description('Read bundled OpenCLI skills');
    skillsCmd
        .command('list')
        .description('List bundled opencli-* skills')
        .option('-f, --format <fmt>', 'Output format: table, json, yaml, md, csv', 'table')
        .action((opts) => {
        const rows = listOpenCliSkills();
        renderOutput(rows, {
            fmt: opts.format,
            fmtExplicit: !!opts.format,
            columns: ['name', 'description', 'version', 'path'],
            title: 'hub/skills/list',
            source: 'hub skills list',
        });
    });
    skillsCmd
        .command('read')
        .description("Print an opencli-* skill's SKILL.md or reference file")
        .argument('<skill>', 'Skill name, or skill/path like hub-browser-browser/references/foo.md')
        .argument('[path]', 'Path under the skill directory')
        .option('--json', 'Output a JSON envelope instead of raw markdown', false)
        .action((skill, skillPath, opts) => {
        let result;
        try {
            result = readOpenCliSkill(skill, skillPath ?? '');
        }
        catch (err) {
            console.error(`Error: ${getErrorMessage(err)}`);
            if (err instanceof CliError && err.hint)
                console.error(`Hint: ${err.hint}`);
            process.exitCode = err instanceof CliError ? err.exitCode : EXIT_CODES.GENERIC_ERROR;
            return;
        }
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        process.stdout.write(result.content);
        if (!result.content.endsWith('\n'))
            process.stdout.write('\n');
    });
    const authCmd = registerAuthCommands(program);
    program
        .command('convention-audit')
        .description('Scan adapters for agent-native convention violations')
        .argument('[target]', 'site or site/name')
        .option('--site <site>', 'Limit audit to one site')
        .option('-f, --format <fmt>', 'Output format: table, json, yaml', 'table')
        .option('--strict', 'Exit non-zero when violations are found', false)
        .action(async (target, opts) => {
        const { runConventionAudit, renderConventionAuditText } = await import('./convention-audit.js');
        const report = runConventionAudit({
            projectRoot: findPackageRoot(CLI_FILE),
            target,
            site: opts.site,
        });
        const fmt = String(opts.format ?? 'table').toLowerCase();
        if (fmt === 'json' || fmt === 'yaml' || fmt === 'yml') {
            renderOutput(report, { fmt });
        }
        else {
            console.log(renderConventionAuditText(report));
        }
        if (opts.strict && !report.ok)
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
    });
    // ── Built-in: browser (browser control for Claude Code skill) ───────────────
    //
    // Make websites accessible for AI agents.
    // All commands wrapped in browserAction() for consistent error handling.
    const browser = program
        .command('browser')
        // --session is an internal hidden option used by direct
        // program.parseAsync callers (tests). User-facing surface is the <session>
        // positional; main.ts argv preprocessor rewrites positional -> --session.
        .addOption(new Option('--session <name>', 'Internal — set automatically from the <session> positional').hideHelp())
        .option('--window <mode>', 'Browser window mode: foreground or background')
        .description('Browser control — navigate, click, type, extract, wait (no LLM needed)')
        .usage('<session> <command> [options]')
        .addHelpText('after', `
<session> is a required positional: pass the name of the browser session every subcommand should operate on. Reuse the same name across calls to keep the tab/state alive; pick a different name to isolate parallel browser work.

Examples:
  $ hub browser work open https://x.com
  $ hub browser work open https://x.com --window background
  $ hub browser work click 12
  $ hub browser work state
  $ hub browser work bind
  $ hub browser work unbind
`);
    const originalBrowserDescription = browser.description();
    /**
     * Resolve a `<target>` (numeric ref or CSS selector) via the unified resolver.
     * Returns the CSS match count so callers can propagate `matches_n` into the
     * JSON envelope printed back to the agent.
     */
    async function resolveRef(page, ref, opts = {}) {
        const resolution = await page.evaluate(resolveTargetJs(ref, opts));
        if (!resolution.ok) {
            throw new TargetError({
                code: resolution.code,
                message: resolution.message,
                hint: resolution.hint,
                candidates: resolution.candidates,
                matches_n: resolution.matches_n,
            });
        }
        return { matches_n: resolution.matches_n, match_level: resolution.match_level };
    }
    /**
     * Parse `--nth <n>` flag, returning the parsed 0-based index or a usage error.
     * The surface mirrors `--depth` etc. in `browser get html --as json`: the flag
     * is optional, must be a non-negative integer when present, and on failure we
     * emit the structured error envelope rather than throwing past the command.
     */
    function parseNthFlag(raw) {
        if (raw === undefined || raw === null || raw === '')
            return null;
        const str = String(raw);
        if (!/^\d+$/.test(str)) {
            return { error: `--nth must be a non-negative integer, got "${str}"` };
        }
        return Number.parseInt(str, 10);
    }
    /** Emit the `{ error: { code, message, hint?, candidates?, matches_n? } }` envelope used by the selector-first commands. */
    function emitTargetError(err) {
        console.log(JSON.stringify({
            error: {
                code: err.code,
                message: err.message,
                hint: err.hint,
                ...(err.candidates && { candidates: err.candidates }),
                ...(err.matches_n !== undefined && { matches_n: err.matches_n }),
            },
        }, null, 2));
    }
    function isJavaScriptDialogMessage(message) {
        const normalized = message.toLowerCase();
        return normalized.includes('javascript dialog');
    }
    function emitJavaScriptDialogError(message) {
        console.log(JSON.stringify({
            error: {
                code: 'javascript_dialog_open',
                message,
                hint: 'Handle the modal first: hub browser dialog accept (or dismiss). Use --text for prompt dialogs.',
            },
        }, null, 2));
    }
    function emitBrowserCommandErrorEnvelope(err) {
        if (!err.code)
            return;
        console.log(JSON.stringify({
            error: {
                code: err.code,
                message: err.message,
                ...(err.hint ? { hint: err.hint } : {}),
            },
        }, null, 2));
    }
    function logBrowserCommandError(err) {
        log.error(err.message);
        if (err.hint)
            log.error(`Hint: ${err.hint}`);
    }
    /** Wrap browser actions with error handling and optional --json output */
    function browserAction(fn, opts = {}) {
        return async (...args) => {
            let page = null;
            try {
                const command = args.at(-1) instanceof Command ? args.at(-1) : undefined;
                const targetPage = getBrowserTargetId(command);
                // Standalone groups (bookmarks/history) have no <session> positional;
                // browserAction accepts a default session via opts.session.
                const explicitSession = getCommandOption(command, 'session');
                const session = typeof explicitSession === 'string' && explicitSession.trim()
                    ? explicitSession.trim()
                    : (typeof opts.session === 'string' && opts.session.trim()
                        ? opts.session.trim()
                        : getBrowserSession(command));
                const windowMode = getBrowserWindowMode(command, 'foreground');
                page = await getBrowserPage(session, targetPage, { windowMode });
                // Thread the resolved user <session> name through to the action callback so
                // state-writing commands can key the browser-target-state file by the SAME
                // session name getBrowserPage() reads from (not the page/CDP session).
                await fn(page, ...args, session);
            }
            catch (err) {
                if (err instanceof BrowserConnectError) {
                    log.error(err.message);
                    if (err.hint)
                        log.error(`Hint: ${err.hint}`);
                }
                else if (err instanceof BrowserCommandError) {
                    if (isJavaScriptDialogMessage(err.message)) {
                        emitJavaScriptDialogError(err.message);
                    }
                    else {
                        emitBrowserCommandErrorEnvelope(err);
                    }
                    logBrowserCommandError(err);
                }
                else if (err instanceof TargetError) {
                    // Agent-facing structured envelope on stdout + short human line on stderr.
                    emitTargetError(err);
                    log.error(`[${err.code}] ${err.message}`);
                    if (err.hint)
                        log.error(`Hint: ${err.hint}`);
                }
                else if (err && typeof err === 'object' && err.name === 'SpaceGuardError') {
                    // P1-4 error contract: guard rejections carry a structured
                    // code (+ optional hint) — surface both instead of the bare
                    // message (the no-space hint used to be swallowed here).
                    log.error(`[${err.code}] ${err.message}`);
                    if (err.hint)
                        log.error(`Hint: ${err.hint}`);
                }
                else {
                    const msg = getErrorMessage(err);
                    if (isJavaScriptDialogMessage(msg)) {
                        emitJavaScriptDialogError(msg);
                        log.error(msg);
                    }
                    else if (msg.includes('attach failed') || msg.includes('chrome-extension://')) {
                        log.error(`Browser attach failed — another extension may be interfering. Try disabling 1Password.`);
                    }
                    else {
                        log.error(msg);
                    }
                }
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
            }
            finally {
                if (isDaemonMode()) return;
                if (page?.close) {
                    try { await page.close(); } catch {}
                }
                // F17: this short-lived process's claw working-period session
                // ends here (bounded wait inside; no-op when nothing started).
                try {
                    const { clawHarnessReporter } = await import('../browser-mcp/src/tools/claw-reporter.ts');
                    await clawHarnessReporter.endAllSessions('closed');
                } catch {}
                await flushAndExit(process.exitCode || 0);
            }
        };
    }
    /**
     * Phase 4 — run a fork browser tool (src/browser-mcp/src/tools/registry.ts)
     * against the CLI-connected UnifiedPage. The fork tools are the single
     * implementation shared with the MCP server (统一 Core); the CLI commands
     * below are thin wrappers over them.
     */
    async function runForkBrowserTool(toolName, args, page) {
        const { BROWSER_TOOLS, PAGE_INFO_TOOLS, OBSERVATION_TOOLS, DISCOVERY_TOOLS, PROBE_TOOLS } = await import('../browser-mcp/src/tools/registry.ts');
        const { executeTool } = await import('../browser-mcp/src/tools/framework.ts');
        // P2-6: the fork surface is every page-operating tool family — the
        // pinned 17 BROWSER_TOOLS contract plus the families toolified from
        // CLI direct implementations (batch 1: frames/extract; batch 2:
        // network/console; batch 3: find/analyze; probe: inspect). Space /
        // audit / adapter families stay out: they are not page-scoped.
        const def = [...BROWSER_TOOLS, ...PAGE_INFO_TOOLS, ...OBSERVATION_TOOLS, ...DISCOVERY_TOOLS, ...PROBE_TOOLS].find((t) => t.name === toolName);
        if (!def)
            throw new Error(`Fork browser tool "${toolName}" is not registered`);
        // P1-4 (CLI face): fork-wrapped commands pass the SAME executeTool
        // gate as the MCP surface — inject the local identity + shared ledger
        // so guardToolAccess enforces D3 and per-page ownership here too.
        // (These used to run identity-less, i.e. open-world with the guard
        // off — the last CLI path that bypassed the space gate.)
        return executeTool(def, args, {
            page,
            pageFor: async () => page,
            identity: LOCAL_SPACE_IDENTITY(),
            spaces: await loadSpaceManager(),
            auditSource: 'cli',
        });
    }
    /** Tool args carrying the connected page id (fork tools require a numeric page). */
    function forkToolArgsFor(page) {
        return typeof page.pageId === 'number' ? { page: page.pageId } : {};
    }
    /**
     * P2-6 (batch 2): print an observation-tool result (network/console) with
     * the CLI-native contracts — the envelope object on success, and on error
     * the pipeline's structured `{ code, message, ... }` rebuilt into the CLI
     * error shape (agent branching on error.code keeps working), with the same
     * usage-vs-generic exit-code mapping as emitNetworkError.
     */
    function printObservationToolResult(result) {
        if (result.isError) {
            const err = result.structuredContent;
            if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
                const { code, message, ...extra } = err;
                console.log(JSON.stringify({ error: { code, message, ...extra } }, null, 2));
                // P1-4 (phase C): CliError-family results carry their own
                // semantic exit code; engine query errors keep the
                // NETWORK_ERROR_EXIT mapping.
                process.exitCode = typeof extra.exitCode === 'number'
                    ? extra.exitCode
                    : (NETWORK_ERROR_EXIT[code] ?? EXIT_CODES.GENERIC_ERROR);
                return false;
            }
            return printForkToolResult(result);
        }
        console.log(JSON.stringify(result.structuredContent ?? {}, null, 2));
        return true;
    }
    /** Print a fork tool result: formatted text by default, structured envelope with --json. */
    function printForkToolResult(result, opts = {}) {
        const text = result.content?.find?.((c) => c.type === 'text')?.text ?? '';
        if (result.isError) {
            // P1-4 (phase C): structured error results from the executeTool
            // gate carry the real platform code (+ hint/candidates/spaceId/
            // exitCode contract fields) — surface those instead of the legacy
            // blanket 'tool_error'. Non-contract failures keep the legacy
            // envelope.
            const sc = result.structuredContent;
            if (sc && typeof sc === 'object' && typeof sc.code === 'string' && typeof sc.message === 'string') {
                const { code, message, ...extra } = sc;
                console.log(JSON.stringify({ error: { code, message, ...extra } }, null, 2));
                process.exitCode = typeof extra.exitCode === 'number'
                    ? extra.exitCode
                    : EXIT_CODES.GENERIC_ERROR;
                return false;
            }
            console.log(JSON.stringify({
                error: {
                    code: 'tool_error',
                    message: text || 'browser tool failed',
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
            return false;
        }
        if (opts.json) {
            console.log(JSON.stringify(result.structuredContent ?? { text }, null, 2));
            return true;
        }
        console.log(text);
        return true;
    }
    function stripAtPrefix(ref) {
        return typeof ref === 'string' ? ref.replace(/^@+/, '') : ref;
    }
    /** Parse an optional integer option; returns { error } when present but invalid. */
    function parseIntOption(raw, flagName, fallback) {
        if (raw === undefined || raw === null || raw === '')
            return fallback;
        const n = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(n))
            return { error: `--${flagName} must be an integer, got "${raw}"` };
        return n;
    }

    function browserSessionCommandAction(fn) {
       return async (optsOrCommand, maybeCommand) => {
            const command = optsOrCommand instanceof Command ? optsOrCommand : maybeCommand;
           const session = getBrowserSession(command);
            let bridge = null;
            try {
                const { BrowserBridge } = await import('./browser/index.js');
                bridge = new BrowserBridge();
                await bridge.connect({ timeout: DEFAULT_BROWSER_CONNECT_TIMEOUT, session, surface: 'browser' });
                await fn({ session });
            }
            catch (err) {
                if (err instanceof BrowserCommandError) {
                    emitBrowserCommandErrorEnvelope(err);
                    logBrowserCommandError(err);
                }
                else {
                    log.error(err instanceof Error ? err.message : String(err));
                    if (err && typeof err === 'object' && 'hint' in err && err.hint)
                        log.error(`Hint: ${err.hint}`);
                }
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
            }
            finally {
                if (isDaemonMode()) return;
                if (bridge?.close) {
                    try { await bridge.close(); } catch {}
                }
                // F17: end this short-lived process's claw working-period
                // session (no-op when nothing was reported).
                try {
                    const { clawHarnessReporter } = await import('../browser-mcp/src/tools/claw-reporter.ts');
                    await clawHarnessReporter.endAllSessions('closed');
                } catch {}
                await flushAndExit(process.exitCode || 0);
            }
        };
    }
    browser.command('bind')
        .description('Bind the current Chrome tab/window to the browser session named by <session>')
        .action(browserSessionCommandAction(async ({ session }) => {
        throw new Error('browser bind not available in hub-browser (use hub adapters instead)');
    }));
    browser.command('unbind')
        .description('Detach the bound browser session named by <session> without closing the user tab/window')
        .action(browserSessionCommandAction(async ({ session }) => {
        throw new Error('browser unbind not available in hub-browser (use hub adapters instead)');
    }));
    const browserTab = browser
        .command('tab')
        .description('Tab management — list, create, and close tabs in the browser session');
    browserTab.command('list')
        .description('List tabs in the browser session with target IDs')
        .option('-f, --format <fmt>', 'Output format: table, json, yaml, md, csv', 'table')
        .action(browserAction(async (page, opts) => {
        let tabs = await page.tabs();
        // Phase 3 B: with a current space the listing is scoped to that
        // space's tabs (legacy unfiltered behavior without one).
        // bug 1 (D5): pass the already-connected page as the manager gateway
        // so raw tab-group edits (拖入/拖出) are reconciled into the ledger
        // before the scoped answer — no second bridge/cleanup needed here
        // (browserAction owns the page lifecycle).
        const { gatewayFromPage } = await import('../space/task-space-manager.ts');
        tabs = await scopeTabsToCurrentSpace(tabs, gatewayFromPage(page));
        renderOutput(tabs, {
            fmt: opts.format,
            fmtExplicit: !!opts.format,
            columns: ['pageId', 'targetId', 'title', 'url', 'isActive'],
            title: 'browser/tab/list',
            source: 'hub browser <session> tab list',
        });
    }));
    browserTab.command('new')
        .argument('[url]', 'Optional URL to open in the new tab')
        .description('Create a new tab and print its target ID')
        .action(browserAction(async (page, url) => {
        if (!page.newTab) {
            throw new Error('This browser session does not support creating tabs');
        }
        // D3 (2026-08-03): space is the precondition for opening tabs — without
        // a current space `tab new` is rejected (mirrors the MCP `tabs new`
        // guard) so a fresh tab is never silently created unattributed.
        const { manager, space } = await currentSpaceForBrowser();
        if (!space) {
            throw await noSpaceErrorForBrowser();
        }
        const createdPage = await page.newTab(url);
        // Phase 3 B: attribute the fresh tab to the current space so scoped
        // listings and `space close` include it.
        let attributed = null;
        if (typeof createdPage === 'string') {
            try {
                const tabs = await page.tabs();
                const info = tabs.find((t) => t.targetId === createdPage);
                if (info?.pageId !== undefined) {
                    const ok = await manager.recordTabForCurrentSpace(
                        LOCAL_SPACE_IDENTITY().agentId,
                        info.pageId,
                        url ?? 'about:blank',
                    );
                    if (ok) attributed = { spaceId: space.id, pageId: info.pageId };
                }
            }
            catch { /* attribution is best-effort */ }
        }
        console.log(JSON.stringify({
            page: createdPage,
            url: url ?? null,
            ...(attributed ? { space: attributed.spaceId, pageId: attributed.pageId } : {}),
        }, null, 2));
    }));
    addBrowserTabOption(browserTab.command('select')
        .argument('[targetId]', 'Target tab/page identity returned by "browser open", "browser tab new", or "browser tab list"')
        .description('Select a tab by target ID and make it the default browser tab'))
        .action(browserAction(async (page, targetId, opts, command, session) => {
        // D3 (2026-08-03): space is the precondition — reject before resolving
        // the target so the no-space hint is always the surfaced error.
        const { space } = await currentSpaceForBrowser();
        if (!space) {
            throw await noSpaceErrorForBrowser();
        }
        const resolvedTarget = resolveBrowserTabTarget(targetId, opts);
        if (!resolvedTarget) {
            throw new Error('Target tab required. Pass it as an argument or --tab <targetId>.');
        }
        // Phase 3 B guard (bug #4): the tab must belong to the current space;
        // selecting another agent's tab is rejected.
        await assertTabInCurrentSpace(page, resolvedTarget);
        await page.selectTab(resolvedTarget);
        // Persist the default tab under the USER SESSION name (`<session>.json`),
        // the same key getBrowserPage() reads via resolveStoredBrowserTarget().
        // getPageScope(page) is the CDP/page session (`page-<pageId>`) and is
        // never read by the restore path — using it here breaks cross-command
        // default-tab continuity (audit: session 落盘键不一致).
        saveBrowserTargetState(resolvedTarget, session);
        console.log(JSON.stringify({ selected: resolvedTarget }, null, 2));
    }));
    addBrowserTabOption(browserTab.command('close')
        .argument('[targetId]', 'Target tab/page identity returned by "browser open", "browser tab new", or "browser tab list"')
        .description('Close a tab by target ID'))
        .action(browserAction(async (page, targetId, opts, command, session) => {
        // D3 (2026-08-03): space is the precondition — reject before resolving
        // the target so the no-space hint is always the surfaced error.
        const { space } = await currentSpaceForBrowser();
        if (!space) {
            throw await noSpaceErrorForBrowser();
        }
        const resolvedTarget = resolveBrowserTabTarget(targetId, opts);
        if (!page.closeTab) {
            throw new Error('This browser session does not support closing tabs');
        }
        if (!resolvedTarget) {
            throw new Error('Target tab required. Pass it as an argument or --tab <targetId>.');
        }
        const validatedTarget = await resolveBrowserTargetInSession(page, resolvedTarget, {
            scope: session,
            source: 'explicit',
        });
        if (!validatedTarget) {
            throw new Error(`Target tab ${resolvedTarget} is not part of the current browser session.`);
        }
        // Phase 3 B: when the tab belongs to the current space, close it through
        // the manager so the space ledger stays in sync. The raw fallback must
        // never bypass the guard (bug #4: closing another agent's tab); D3 —
        // without a space this path is already rejected above.
        const closedThroughSpace = await closeTabThroughCurrentSpace(page, validatedTarget);
        if (!closedThroughSpace) {
            await assertTabInCurrentSpace(page, validatedTarget);
            await page.closeTab(validatedTarget);
        }
        // The default-tab state is keyed by the USER SESSION name (same key
        // getBrowserPage() reads); clear it only when the closed tab was the
        // session's saved default.
        const scope = session;
        if (loadBrowserTargetState(scope)?.defaultPage === validatedTarget) {
            saveBrowserTargetState(undefined, scope);
        }
        console.log(JSON.stringify({ closed: validatedTarget }, null, 2));
    }));
    // ── Tab Group ──
    const browserTabGroup = browser
        .command('group')
        .description('Tab group management — list, create, update, ungroup, and close tab groups');
    addBrowserTabOption(browserTabGroup.command('list')
        .description('List all tab groups in the browser session'))
        .action(browserAction(async (page) => {
        const groups = await page.tabGroupList();
        console.log(JSON.stringify(groups, null, 2));
    }));
    addBrowserTabOption(browserTabGroup.command('create')
        .description('Create a tab group from existing pages')
        .option('--title <title>', 'Tab group title')
        .option('--pages <pageIds>', 'Comma-separated page IDs (e.g. 1,2)'))
        .action(browserAction(async (page, opts) => {
        if (!opts.pages) throw new Error('--pages <pageIds> is required (e.g. --pages 1,2)');
        const pages = String(opts.pages).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (pages.length === 0) throw new Error('No valid page IDs provided');
        // P1-4 / P1-1 矩阵补洞: same gate as the MCP tab_groups tool — every
        // page must belong to the current space. D5 treats dragging a tab INTO
        // a group as an ownership transfer, so an unguarded create could steal
        // another agent's tabs into this space's group.
        await assertPagesInCurrentSpace(pages);
        const group = await page.tabGroupCreate(pages, opts.title);
        console.log(JSON.stringify(group, null, 2));
    }));
    addBrowserTabOption(browserTabGroup.command('update')
        .argument('<groupId>', 'Tab group ID')
        .description('Update a tab group (title, color, collapsed state)')
        .option('--title <title>', 'New tab group title')
        .option('--color <color>', 'Tab group color (grey, blue, red, yellow, green, pink, purple, cyan, orange)')
        .option('--collapsed', 'Collapse the tab group'))
        .action(browserAction(async (page, groupId, opts) => {
        await assertGroupInCurrentSpace(page, groupId);
        const updateOpts = {};
        if (opts.title !== undefined) updateOpts.title = opts.title;
        if (opts.color !== undefined) updateOpts.color = opts.color;
        if (opts.collapsed !== undefined) updateOpts.collapsed = opts.collapsed;
        const group = await page.tabGroupUpdate(groupId, updateOpts);
        console.log(JSON.stringify(group, null, 2));
    }));
    addBrowserTabOption(browserTabGroup.command('ungroup')
        .description('Remove tabs from their tab group')
        .option('--pages <pageIds>', 'Comma-separated page IDs (e.g. 1,2)'))
        .action(browserAction(async (page, opts) => {
        if (!opts.pages) throw new Error('--pages <pageIds> is required (e.g. --pages 1,2)');
        const pages = String(opts.pages).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (pages.length === 0) throw new Error('No valid page IDs provided');
        // Same gate as group create (MCP tab_groups parity — pages must be
        // this space's; ungrouping another agent's tabs redirects its group).
        await assertPagesInCurrentSpace(pages);
        await page.tabGroupUngroup(pages);
        console.log(JSON.stringify({ ungrouped: pages }, null, 2));
    }));
    addBrowserTabOption(browserTabGroup.command('close')
        .argument('<groupId>', 'Tab group ID')
        .description('Close a tab group and all its tabs'))
        .action(browserAction(async (page, groupId) => {
        // Same groupId gate as update — closing a foreign group would take
        // another space's tabs down with it.
        await assertGroupInCurrentSpace(page, groupId);
        await page.tabGroupClose(groupId);
        console.log(JSON.stringify({ closed: groupId }, null, 2));
    }));
    // ── Window ──
    const browserWindow = browser
        .command('window')
        .description('Window management — list, create, close, and activate browser windows');
    addBrowserTabOption(browserWindow.command('list')
        .description('List all browser windows'))
        .action(browserAction(async (page) => {
        const windows = await page.windowList();
        console.log(JSON.stringify(windows, null, 2));
    }));
    addBrowserTabOption(browserWindow.command('create')
        .description('Create a new browser window'))
        .action(browserAction(async (page) => {
        const win = await page.windowCreate();
        console.log(JSON.stringify(win, null, 2));
    }));
    addBrowserTabOption(browserWindow.command('close')
        .argument('<windowId>', 'Window ID')
        .description('Close a browser window'))
        .action(browserAction(async (page, windowId) => {
        await page.windowClose(parseInt(windowId, 10));
        console.log(JSON.stringify({ closed: windowId }, null, 2));
    }));
    addBrowserTabOption(browserWindow.command('activate')
        .argument('<windowId>', 'Window ID')
        .description('Activate (bring to front) a browser window'))
        .action(browserAction(async (page, windowId) => {
        await page.windowActivate(parseInt(windowId, 10));
        console.log(JSON.stringify({ activated: windowId }, null, 2));
    }));
    // ── Navigation ──
    addBrowserTabOption(browser.command('open').argument('<url>').description('Open URL in the browser session'))
        .action(browserAction(async (page, url, opts, command) => {
        // Phase 3 B: with a current space (and no explicit --tab target) the
        // open is routed through the manager's openTab path — a fresh tab is
        // created in the space and made active, so subsequent browser commands
        // operate on it and `space close` cleans it up.
        // D3 (2026-08-03): without a current space the open is REJECTED — the
        // legacy navigate-the-connected-page behavior is gone (including the
        // explicit --tab path), matching the MCP navigate guard.
        const explicitTab = getBrowserTargetId(command);
        const { space } = await currentSpaceForBrowser();
        if (!space) {
            throw await noSpaceErrorForBrowser();
        }
        const opened = explicitTab ? null : await openIntoCurrentSpace(page, url);
        // Start session-level capture before navigation (catches initial requests)
        const hasSessionCapture = await page.startNetworkCapture?.() ?? false;
        if (!opened) {
            await page.goto(url);
        }
        await page.wait(2);
        // Fallback: inject JS interceptor when session capture is unavailable
        if (!hasSessionCapture) {
            try {
                await page.evaluate(NETWORK_INTERCEPTOR_JS);
            }
            catch { /* non-fatal */ }
        }
        const currentUrl = await page.getCurrentUrl?.() ?? url;
        const sitemap = sitemapHintForBrowserUrl(currentUrl, getPageScope(page), { oncePerSession: true });
        console.log(JSON.stringify({
            url: currentUrl,
            ...(opened
                ? { pageId: opened.pageId, spaceId: opened.spaceId, reused: opened.reused }
                : {}),
            ...(page.getActivePage?.() ? { page: page.getActivePage?.() } : {}),
            ...(sitemap ? { sitemap } : {}),
        }, null, 2));
    }));
    addBrowserTabOption(browser.command('back').description('Go back in browser history'))
        .action(browserAction(async (page, opts) => {
        await page.evaluate('history.back()');
        await page.wait(2);
        console.log('Navigated back');
    }));
    addBrowserTabOption(browser.command('scroll').argument('<direction>', 'up or down').option('--amount <pixels>', 'Pixels to scroll', '500'))
        .description('Scroll page')
        .action(browserAction(async (page, direction, opts) => {
        if (direction !== 'up' && direction !== 'down') {
            console.error(`Invalid direction "${direction}". Use "up" or "down".`);
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        await page.scroll(direction, parseInt(opts.amount, 10));
        console.log(`Scrolled ${direction}`);
    }));
    // ── Inspect ──
    addBrowserTabOption(browser.command('state').description('Page state: URL, title, interactive elements with [N] indices')
        .option('--source <source>', 'Snapshot backend: dom (default) or ax prototype', 'dom')
        .option('--compact', 'Compact the snapshot text (strip [N] ref/attr annotations, collapse whitespace)', false)
        .option('--compare-sources', 'Print DOM vs AX snapshot metrics for observation promotion decisions', false))
        .action(browserAction(async (page, opts) => {
        if (opts.compareSources === true) {
            const [dom, ax] = await Promise.all([
                snapshotSourceMetrics(page, 'dom'),
                snapshotSourceMetrics(page, 'ax'),
            ]);
            console.log(JSON.stringify({
                url: await page.getCurrentUrl?.() ?? '',
                sources: { dom, ax },
            }, null, 2));
            return;
        }
        const source = String(opts.source ?? 'dom').toLowerCase();
        if (source !== 'dom' && source !== 'ax') {
            console.log(JSON.stringify({
                error: {
                    code: 'invalid_source',
                    message: `--source must be "dom" or "ax", got "${opts.source}"`,
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const snapshot = await page.snapshot({ viewportExpand: 2000, source: source, compact: !!opts.compact });
        const url = await page.getCurrentUrl?.() ?? '';
        console.log(`URL: ${url}\n`);
        console.log(typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2));
    }));
    // O1 fix: MCP↔CLI naming alignment. The MCP tool is `snapshot` (AX tree
    // with [ref=eN]); the CLI only exposed it as `state --source ax`, so an
    // agent moving between the two faces hit `unknown command 'snapshot'`.
    // `snapshot` is the AX face (matching MCP semantics); `state` keeps its
    // DOM-backend default for the opencli-compatible [N]-index surface.
    addBrowserTabOption(browser.command('snapshot').description('AX-tree snapshot with [ref=eN] (same as MCP snapshot; = state --source ax)')
        .option('--source <source>', 'Snapshot backend: ax (default) or dom', 'ax')
        .option('--compact', 'Compact the snapshot text (strip [ref=eN] annotations, collapse whitespace)', false)
        .option('--compare-sources', 'Print DOM vs AX snapshot metrics for observation promotion decisions', false))
        .action(browserAction(async (page, opts) => {
        if (opts.compareSources === true) {
            const [dom, ax] = await Promise.all([
                snapshotSourceMetrics(page, 'dom'),
                snapshotSourceMetrics(page, 'ax'),
            ]);
            console.log(JSON.stringify({
                url: await page.getCurrentUrl?.() ?? '',
                sources: { dom, ax },
            }, null, 2));
            return;
        }
        const source = String(opts.source ?? 'ax').toLowerCase();
        if (source !== 'dom' && source !== 'ax') {
            console.log(JSON.stringify({
                error: {
                    code: 'invalid_source',
                    message: `--source must be "ax" or "dom", got "${opts.source}"`,
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const snapshot = await page.snapshot({ viewportExpand: 2000, source: source, compact: !!opts.compact });
        const url = await page.getCurrentUrl?.() ?? '';
        console.log(`URL: ${url}\n`);
        console.log(typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2));
    }));
    // F15 (probe): CLI twin of the MCP `inspect` tool — deep-probe one
    // snapshot ref (classes, attributes, ancestor path, verified-unique
    // candidate selectors). Same shared tool definition via executeTool, so
    // the call is guarded and audited like every other dispatch.
    addBrowserTabOption(browser.command('inspect')
        .argument('<ref>', 'Element ref from the last snapshot, e.g. e12')
        .option('--json', 'Output the structured detail object instead of text')
        .description('Deep-probe the element behind one snapshot ref (classes, attributes, path, candidate selectors)'))
        .action(browserAction(async (page, ref, opts) => {
        let result = await runForkBrowserTool('inspect', { ...forkToolArgsFor(page), ref: String(ref) }, page);
        // Observer refs are in-memory per process: an unknown ref means the
        // ref was minted by a process that is gone (direct CLI run, daemon
        // restart). Snapshot numbering is deterministic on a stable DOM, so a
        // fresh snapshot re-mints the same numbers — retry exactly once.
        const errText = () => result.content?.find?.((c) => c.type === 'text')?.text ?? '';
        if (result.isError && errText().includes('Unknown ref')) {
            await page.snapshot({ viewportExpand: 2000, source: 'ax' });
            result = await runForkBrowserTool('inspect', { ...forkToolArgsFor(page), ref: String(ref) }, page);
        }
        if (opts.json === true) {
            printForkToolResult(result, { json: true });
            return;
        }
        printForkToolResult(result);
    }));
    addBrowserTabOption(browser.command('frames').description('List cross-origin iframe targets in snapshot order'))
        .action(browserAction(async (page) => {
        // P2-6 (batch 1): thin wrapper over the shared `frames` tool definition
        // (browser-mcp/src/tools/page-info.ts) — the same implementation the
        // MCP face registers, run through executeTool so the call is guarded
        // and audited like every other tool dispatch. CLI output contract
        // (bare JSON array of frames) is preserved by the wrapper.
        const result = await runForkBrowserTool('frames', forkToolArgsFor(page), page);
        if (result.isError) {
            printForkToolResult(result);
            return;
        }
        console.log(JSON.stringify(result.structuredContent?.frames ?? [], null, 2));
    }));
    addBrowserTabOption(browser.command('screenshot').argument('[path]', 'Save to file (base64 if omitted)'))
        .option('--full-page', 'Capture the full scrollable page, not just the viewport', false)
        .option('--annotate', 'Overlay visible browser state ref labels on the screenshot', false)
        .option('--width <n>', 'Override viewport width in CSS pixels for this screenshot only', (v) => parseScreenshotDim(v, 'width'))
        .option('--height <n>', 'Override viewport height in CSS pixels for this screenshot only (ignored with --full-page)', (v) => parseScreenshotDim(v, 'height'))
        .description('Take screenshot')
        .action(browserAction(async (page, path, opts) => {
        const shotOpts = {
            fullPage: opts.fullPage === true,
            annotate: opts.annotate === true,
            width: opts.width,
            height: opts.height,
        };
        const capture = opts.annotate === true
            ? (page.annotatedScreenshot ?? page.screenshot).bind(page)
            : page.screenshot.bind(page);
        if (path) {
            await capture({ ...shotOpts, path });
            console.log(`Screenshot saved to: ${path}`);
        }
        else {
            console.log(await capture({ ...shotOpts, format: 'png' }));
        }
    }));
    addBrowserTabOption(browser.command('console'))
        .option('--level <level>', 'Console level: all, error, warning, log, info, debug', 'all')
        .option('--since <duration>', 'Only include messages from the last duration (for example: 30s, 2m)')
        .option('--until <duration>', 'Only include messages older than the duration from now')
        .option('--follow', 'Continuously print new console messages as JSON lines', false)
        .description('Read recent browser console messages')
        .action(browserAction(async (page, opts) => {
        const sinceMs = parseDurationMs(opts.since, 'since');
        const untilMs = parseDurationMs(opts.until, 'until');
        if (sinceMs && typeof sinceMs === 'object') {
            console.log(JSON.stringify({ error: { code: 'invalid_since', message: sinceMs.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        if (untilMs && typeof untilMs === 'object') {
            console.log(JSON.stringify({ error: { code: 'invalid_until', message: untilMs.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const level = String(opts.level ?? 'all');
        if (opts.follow) {
            // --follow stays CLI-local: a poll stream does not fit the tool
            // request/response model (the snapshot path below is the tool face).
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
            const filter = (messages) => filterByTimeWindow(messages, { sinceMs, untilMs }).filter((message) => {
                if (level === 'all')
                    return true;
                const type = String(message.type ?? message.level ?? '').toLowerCase();
                return level === 'error'
                    ? type === 'error' || type === 'warning'
                    : type === String(level).toLowerCase();
            });
            let lastSeenTs = 0;
            while (true) {
                const messages = filter(normalize(await page.consoleMessages('all')));
                const next = selectFreshByTimestamp(messages, lastSeenTs);
                for (const message of next.fresh) {
                    console.log(JSON.stringify({
                        ...message,
                        timestamp: toIsoTimestamp(message.timestamp),
                    }));
                }
                lastSeenTs = next.lastSeenTs;
                await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
            }
        }
        // P2-6 (batch 2): the snapshot path is a thin wrapper over the shared
        // `console` tool — same pipeline (observation-query.js), now guarded
        // and audited through executeTool.
        const result = await runForkBrowserTool('console', {
            ...forkToolArgsFor(page),
            level,
            ...(sinceMs ? { sinceMs } : {}),
            ...(untilMs ? { untilMs } : {}),
        }, page);
        printObservationToolResult(result);
    }));
    // ── Analyze (site recon, agent-native) ──
    //
    // Mechanizes the `site-recon.md` decision tree into one CLI call. The agent
    // calls `browser analyze <url>` and gets back:
    //
    //   - pattern: A/B/C/D (mapped from network + SSR-globals signals)
    //   - anti_bot: vendor + evidence + the one-liner for "what to do next"
    //   - api_candidates: captured endpoints scored as real data vs telemetry
    //   - initial_state: which window globals are populated
    //   - nearest_adapter: existing commands for the same site, if any
    //   - recommended_next_step: a single imperative sentence
    //
    // Intent: replace the "open → eyeball network → curl → WAF → try again"
    // feedback loop with a single deterministic verdict. Without this, agents
    // burn ~20min per WAF-protected site re-discovering anti-bot posture.
    addBrowserTabOption(browser.command('analyze').argument('<url>'))
        .description('Classify site: anti-bot vendor, real-data API candidates, pattern (A/B/C/D), nearest adapter, next step')
        .action(browserAction(async (page, url) => {
        // P2-6 (batch 3): thin wrapper over the shared `analyze` tool — same
        // pipeline (observation-query.js runSiteAnalysis: navigate → capture →
        // probe → analyzeSite classification), guarded and audited through
        // executeTool. The sitemap hint stays CLI-local (a display nicety
        // keyed off the report's final_url).
        const result = await runForkBrowserTool('analyze', {
            ...forkToolArgsFor(page),
            url,
        }, page);
        if (result.isError) {
            printObservationToolResult(result);
            return;
        }
        const report = result.structuredContent ?? {};
        const finalUrl = typeof report.final_url === 'string' ? report.final_url : url;
        const sitemap = resolveSitemapAvailabilityForUrl(finalUrl);
        console.log(JSON.stringify({
            ...report,
            ...(sitemap ? { sitemap } : {}),
        }, null, 2));
    }));
    // ── Find (structured CSS query, agent-native) ──
    //
    // `browser find --css <sel>` lets agents jump straight from a semantic
    // selector to a JSON list of matching elements, without having to parse
    // the free-text state snapshot to recover indices.
    const addSemanticLocatorOptions = (cmd) => cmd
        .option('--role <role>', 'Semantic role (button, link, textbox, option, etc.)')
        .option('--name <text>', 'Accessible name contains text (aria-label, label, title, placeholder, or visible text)')
        .option('--label <text>', 'Associated label contains text')
        .option('--text <text>', 'Visible text contains text')
        .option('--testid <id>', 'data-testid / data-test / test-id contains id');
    const addPrefixedSemanticLocatorOptions = (cmd, prefix) => cmd
        .option(`--${prefix}-role <role>`, `${prefix} semantic role`)
        .option(`--${prefix}-name <text>`, `${prefix} accessible name contains text`)
        .option(`--${prefix}-label <text>`, `${prefix} associated label contains text`)
        .option(`--${prefix}-text <text>`, `${prefix} visible text contains text`)
        .option(`--${prefix}-testid <id>`, `${prefix} data-testid / data-test / test-id contains id`);
    const semanticLocatorFromOptions = (opts) => {
        const locator = {};
        for (const key of ['role', 'name', 'label', 'text', 'testid']) {
            const value = opts[key];
            if (typeof value === 'string' && value.trim())
                locator[key] = value.trim();
        }
        return Object.keys(locator).length > 0 ? locator : null;
    };
    const prefixedSemanticLocatorFromOptions = (opts, prefix) => {
        const locator = {};
        const map = {
            role: `${prefix}Role`,
            name: `${prefix}Name`,
            label: `${prefix}Label`,
            text: `${prefix}Text`,
            testid: `${prefix}Testid`,
        };
        for (const key of ['role', 'name', 'label', 'text', 'testid']) {
            const value = opts[map[key]];
            if (typeof value === 'string' && value.trim())
                locator[key] = value.trim();
        }
        return Object.keys(locator).length > 0 ? locator : null;
    };
    const semanticTargetFromLocator = async (page, locator, mode) => {
        const result = await page.evaluate(buildSemanticFindJs({ ...locator, limit: 6 }));
        if (isFindError(result))
            return result;
        if (mode === 'write' && result.matches_n !== 1) {
            return {
                error: {
                    code: 'semantic_ambiguous',
                    message: `Semantic locator matched ${result.matches_n} elements; write actions require a unique target.`,
                    hint: 'Add --name/--label/--text/--testid or use browser find with a narrower locator.',
                    matches_n: result.matches_n,
                    entries: result.entries,
                },
            };
        }
        const first = result.entries[0];
        if (!first) {
            return {
                error: {
                    code: 'semantic_not_found',
                    message: 'Semantic locator matched 0 elements',
                    hint: 'Try browser state, --source ax, or relax the semantic locator.',
                },
            };
        }
        const target = String(first.ref);
        if (mode === 'read') {
            return {
                target,
                ...(result.matches_n > 1 ? { total_matches: result.matches_n } : {}),
            };
        }
        return target;
    };
    const semanticTargetFromOptions = async (page, opts, mode) => {
        const locator = semanticLocatorFromOptions(opts);
        if (!locator)
            return null;
        return semanticTargetFromLocator(page, locator, mode);
    };
    const resolveExplicitOrSemanticTarget = async (page, target, opts, mode) => {
        const explicit = typeof target === 'string' && target.trim() ? target.trim() : '';
        const hasSemantic = !!semanticLocatorFromOptions(opts);
        if (explicit && hasSemantic) {
            return {
                error: {
                    code: 'usage_error',
                    message: 'Pass either <target> or semantic locator flags, not both.',
                },
            };
        }
        if (explicit)
            return explicit;
        const semantic = await semanticTargetFromOptions(page, opts, mode);
        if (semantic)
            return semantic;
        return {
            error: {
                code: 'usage_error',
                message: 'Missing target. Pass a numeric ref/CSS selector, or semantic flags like --role button --name Submit.',
            },
        };
    };
    const printTargetResolutionError = (resolved) => {
        console.log(JSON.stringify(resolved, null, 2));
        process.exitCode = EXIT_CODES.USAGE_ERROR;
    };
    const resolveWriteTargetOrPrint = async (page, target, opts) => {
        const resolvedTarget = await resolveExplicitOrSemanticTarget(page, target, opts, 'write');
        if (typeof resolvedTarget === 'string')
            return resolvedTarget;
        if ('error' in resolvedTarget)
            printTargetResolutionError(resolvedTarget);
        return null;
    };
    const resolveWriteTargetAndValueOrPrint = async (page, targetOrValue, value, opts, valueLabel) => {
        const hasSemantic = !!semanticLocatorFromOptions(opts);
        if (hasSemantic && value !== undefined) {
            printTargetResolutionError({
                error: {
                    code: 'usage_error',
                    message: `When using semantic locator flags, pass only <${valueLabel}> as the positional argument.`,
                },
            });
            return null;
        }
        const resolvedValue = hasSemantic ? targetOrValue : value;
        if (resolvedValue === undefined) {
            printTargetResolutionError({
                error: {
                    code: 'usage_error',
                    message: `Missing ${valueLabel}.`,
                    hint: hasSemantic
                        ? `With semantic locator flags, pass the ${valueLabel} as the only positional argument.`
                        : `Pass both a target and ${valueLabel}.`,
                },
            });
            return null;
        }
        const resolvedTarget = await resolveWriteTargetOrPrint(page, hasSemantic ? undefined : targetOrValue, opts);
        if (!resolvedTarget)
            return null;
        return { target: resolvedTarget, value: String(resolvedValue) };
    };
    const resolvePrefixedWriteTargetOrPrint = async (page, target, opts, prefix, label) => {
        const explicit = typeof target === 'string' && target.trim() ? target.trim() : '';
        const locator = prefixedSemanticLocatorFromOptions(opts, prefix);
        if (explicit && locator) {
            printTargetResolutionError({
                error: {
                    code: 'usage_error',
                    message: `Pass either <${label}> or --${prefix}-* semantic locator flags, not both.`,
                },
            });
            return null;
        }
        if (explicit)
            return explicit;
        if (locator) {
            const resolved = await semanticTargetFromLocator(page, locator, 'write');
            if (typeof resolved === 'string')
                return resolved;
            if ('error' in resolved)
                printTargetResolutionError(resolved);
            return null;
        }
        printTargetResolutionError({
            error: {
                code: 'usage_error',
                message: `Missing ${label}. Pass a numeric ref/CSS selector, or --${prefix}-role/--${prefix}-name semantic flags.`,
            },
        });
        return null;
    };
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('find'))
        .option('--css <selector>', 'CSS selector (required)')
        .option('--limit <n>', 'Max entries returned', '50')
        .option('--text-max <n>', 'Max chars of trimmed text per entry', '120')
        .description('Find DOM elements by CSS or semantic locator — returns JSON {matches_n, entries[]}'))
        .action(browserAction(async (page, opts) => {
        const locator = semanticLocatorFromOptions(opts);
        if ((!opts.css || typeof opts.css !== 'string') && !locator) {
            console.log(JSON.stringify({
                error: {
                    code: 'usage_error',
                    message: '--css <selector> or a semantic locator flag is required',
                    hint: 'Examples: hub browser find --css ".btn.primary"; hub browser find --role button --name Save',
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        if (opts.css && locator) {
            console.log(JSON.stringify({
                error: {
                    code: 'usage_error',
                    message: 'Pass either --css or semantic locator flags, not both.',
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const limit = parseNthFlag(opts.limit);
        if (limit && typeof limit === 'object' && 'error' in limit) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: limit.error.replace('--nth', '--limit') } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const textMax = parseNthFlag(opts.textMax);
        if (textMax && typeof textMax === 'object' && 'error' in textMax) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: textMax.error.replace('--nth', '--text-max') } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        // P2-6 (batch 3): thin wrapper over the shared `find` tool — same
        // pipeline (browser/find.js via observation-query.js runFindQuery),
        // guarded and audited through executeTool. CLI output contract (the
        // {matches_n, entries[]} object / the find error envelope) is the
        // tool's structuredContent.
        const result = await runForkBrowserTool('find', {
            ...forkToolArgsFor(page),
            ...(typeof opts.css === 'string' && opts.css.length > 0 ? { css: opts.css } : {}),
            ...(locator ? locator : {}),
            ...(limit != null ? { limit } : {}),
            ...(textMax != null ? { textMax } : {}),
        }, page);
        printObservationToolResult(result);
    }));
    // ── Get commands (structured data extraction) ──
    const get = browser.command('get').description('Get page properties');
    addBrowserTabOption(get.command('title').description('Page title'))
        .action(browserAction(async (page) => {
        console.log(await page.evaluate('document.title'));
    }));
    addBrowserTabOption(get.command('url').description('Current page URL'))
        .action(browserAction(async (page) => {
        console.log(await page.getCurrentUrl?.() ?? await page.evaluate('location.href'));
    }));
    // Read commands (`get text/value/attributes`) always emit a JSON envelope:
    //
    //   { value, matches_n }                           — success
    //   { error: { code, message, hint, matches_n? } } — structured failure
    //
    // `<target>` accepts either a numeric ref (from `browser state`/`browser find`)
    // or a CSS selector. On multi-match CSS, the first element wins and the real
    // match count is exposed via `matches_n`; `--nth <n>` picks a specific one.
    const runGetCommand = async (page, target, opts, evalJs, field) => {
        const resolvedTarget = await resolveExplicitOrSemanticTarget(page, target, opts, 'read');
        if (typeof resolvedTarget !== 'string' && 'error' in resolvedTarget) {
            console.log(JSON.stringify(resolvedTarget, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const targetRef = typeof resolvedTarget === 'string' ? resolvedTarget : resolvedTarget.target;
        const totalMatches = typeof resolvedTarget === 'string' ? undefined : resolvedTarget.total_matches;
        const nth = parseNthFlag(opts.nth);
        if (nth && typeof nth === 'object' && 'error' in nth) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: nth.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { matches_n, match_level } = await resolveRef(page, targetRef, {
            firstOnMulti: nth === null,
            ...(typeof nth === 'number' ? { nth } : {}),
        });
        const raw = await page.evaluate(evalJs);
        let value;
        if (field === 'attributes') {
            // getAttributesResolvedJs stringifies the attribute record — parse it back so
            // the JSON envelope contains a real object rather than a nested JSON string.
            try {
                value = raw == null ? {} : JSON.parse(String(raw));
            }
            catch {
                value = raw;
            }
        }
        else {
            value = raw ?? null;
        }
        console.log(JSON.stringify({
            value,
            matches_n,
            match_level,
            ...(totalMatches && totalMatches > 1 ? { total_matches: totalMatches } : {}),
        }, null, 2));
    };
    addBrowserTabOption(addSemanticLocatorOptions(get.command('text'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'Pick the nth match (0-based) when <target> is a multi-match CSS selector')
        .description('Element text content — JSON envelope {value, matches_n}'))
        .action(browserAction(async (page, target, opts) => runGetCommand(page, target, opts ?? {}, getTextResolvedJs(), 'text')));
    addBrowserTabOption(addSemanticLocatorOptions(get.command('value'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'Pick the nth match (0-based) when <target> is a multi-match CSS selector')
        .description('Input/textarea value — JSON envelope {value, matches_n}'))
        .action(browserAction(async (page, target, opts) => runGetCommand(page, target, opts ?? {}, getValueResolvedJs(), 'value')));
    addBrowserTabOption(get.command('html')
        .option('--selector <css>', 'CSS selector scope (first match)')
        .option('--as <format>', 'Output format: "html" (default) or "json" for structured tree', 'html')
        .option('--max <n>', 'Max characters of raw HTML to return (0 = unlimited)', '0')
        .option('--depth <n>', '(--as json) Max tree depth below root (0 = root only, 0 disables = unlimited via empty)', '')
        .option('--children-max <n>', '(--as json) Max element children kept per node (empty = unlimited)', '')
        .option('--text-max <n>', '(--as json) Max chars of direct text kept per node (empty = unlimited)', '')
        .description('Page HTML (or scoped); use --as json for a {tag, attrs, text, children} tree'))
        .action(browserAction(async (page, opts) => {
        const format = String(opts.as || 'html').toLowerCase();
        if (format !== 'html' && format !== 'json') {
            console.log(JSON.stringify({ error: { code: 'invalid_format', message: `--as must be "html" or "json", got "${opts.as}"` } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        // `--max` is validated up-front (before touching the page) so a bad value
        // gets the same structured error regardless of selector/format path.
        const rawMax = String(opts.max ?? '0');
        if (!/^\d+$/.test(rawMax)) {
            console.log(JSON.stringify({ error: { code: 'invalid_max', message: `--max must be a non-negative integer, got "${opts.max}"` } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const max = Number.parseInt(rawMax, 10);
        if (format === 'json') {
            const parseBudget = (flag, value) => {
                const raw = value === undefined || value === null ? '' : String(value);
                if (raw === '')
                    return null;
                if (!/^\d+$/.test(raw))
                    return { error: `${flag} must be a non-negative integer, got "${raw}"` };
                return Number.parseInt(raw, 10);
            };
            const depth = parseBudget('--depth', opts.depth);
            const childrenMax = parseBudget('--children-max', opts.childrenMax);
            const textMax = parseBudget('--text-max', opts.textMax);
            for (const budget of [depth, childrenMax, textMax]) {
                if (budget && typeof budget === 'object' && 'error' in budget) {
                    console.log(JSON.stringify({ error: { code: 'invalid_budget', message: budget.error } }, null, 2));
                    process.exitCode = EXIT_CODES.USAGE_ERROR;
                    return;
                }
            }
            const js = buildHtmlTreeJs({
                selector: opts.selector ?? null,
                depth: depth,
                childrenMax: childrenMax,
                textMax: textMax,
            });
            const result = await page.evaluate(js);
            if (result && typeof result === 'object' && 'invalidSelector' in result && result.invalidSelector) {
                console.log(JSON.stringify({
                    error: { code: 'invalid_selector', message: `Selector "${opts.selector}" is not a valid CSS selector: ${result.reason}` },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const ok = result;
            if (!ok || ok.matched === 0) {
                console.log(JSON.stringify({
                    error: {
                        code: 'selector_not_found',
                        message: opts.selector
                            ? `Selector "${opts.selector}" matched 0 elements.`
                            : 'Page has no documentElement.',
                    },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            console.log(JSON.stringify(ok, null, 2));
            return;
        }
        // Raw HTML path — unbounded by default; --max optionally caps with a visible marker.
        // Selector lookup is wrapped in try/catch inside page context so an invalid
        // selector returns a structured signal instead of throwing through page.evaluate.
        const sel = opts.selector ? JSON.stringify(opts.selector) : 'null';
        const rawResult = await page.evaluate(`(() => {
          const s = ${sel};
          if (s) {
            try {
              const el = document.querySelector(s);
              return { kind: 'ok', html: el ? el.outerHTML : null };
            } catch (e) {
              return { kind: 'invalid_selector', reason: (e && e.message) || String(e) };
            }
          }
          return { kind: 'ok', html: document.documentElement ? document.documentElement.outerHTML : null };
        })()`);
        if (rawResult.kind === 'invalid_selector') {
            console.log(JSON.stringify({
                error: { code: 'invalid_selector', message: `Selector "${opts.selector}" is not a valid CSS selector: ${rawResult.reason}` },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const html = rawResult.html;
        if (html === null) {
            if (opts.selector) {
                console.log(JSON.stringify({
                    error: { code: 'selector_not_found', message: `Selector "${opts.selector}" matched 0 elements.` },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            console.log('(empty)');
            return;
        }
        if (max > 0 && html.length > max) {
            console.log(`<!-- hub: truncated ${max} of ${html.length} chars; re-run without --max (or --max 0) for full -->\n${html.slice(0, max)}`);
            return;
        }
        console.log(html);
    }));
    addBrowserTabOption(addSemanticLocatorOptions(get.command('attributes'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'Pick the nth match (0-based) when <target> is a multi-match CSS selector')
        .description('Element attributes — JSON envelope {value, matches_n}'))
        .action(browserAction(async (page, target, opts) => runGetCommand(page, target, opts ?? {}, getAttributesResolvedJs(), 'attributes')));
    // ── Interact ──
    //
    // Write commands (`click/type/select`) share the same `<target>` contract
    // as the read commands but *reject* multi-match CSS as `selector_ambiguous`
    // unless the caller passes `--nth <n>`. That asymmetry is intentional:
    // clicking "one of three buttons" at random is almost never what the agent
    // meant. Every branch emits a JSON envelope on stdout; error envelopes go
    // through the unified TargetError handler in browserAction.
    /**
     * Parse the `--nth` flag and convert it to `ResolveOptions`.
     * Returns `{ error }` when the flag was malformed (so the command can
     * print the structured usage error and exit) or `{ opts }` to feed
     * into resolveRef / page.click / page.typeText.
     */
    function nthToResolveOpts(raw) {
        const parsed = parseNthFlag(raw);
        if (parsed && typeof parsed === 'object' && 'error' in parsed)
            return parsed;
        if (typeof parsed === 'number')
            return { opts: { nth: parsed } };
        return { opts: {} };
    }
    function resolveUploadFilePaths(rawFiles) {
        const inputs = Array.isArray(rawFiles) ? rawFiles : [];
        if (inputs.length === 0) {
            return {
                error: {
                    code: 'usage_error',
                    message: 'At least one file path is required.',
                    hint: 'Example: hub browser upload "input[type=file]" ./receipt.pdf',
                },
            };
        }
        const files = [];
        for (const input of inputs) {
            const raw = String(input);
            const expanded = raw === '~' || raw.startsWith(`~${path.sep}`)
                ? path.join(os.homedir(), raw.slice(2))
                : raw;
            const resolved = path.resolve(expanded);
            if (!fs.existsSync(resolved)) {
                return { error: { code: 'file_not_found', message: `File not found: ${resolved}` } };
            }
            const stat = fs.statSync(resolved);
            if (!stat.isFile()) {
                return { error: { code: 'not_a_file', message: `Not a regular file: ${resolved}` } };
            }
            files.push(resolved);
        }
        return { files };
    }
    function parseResolveFlag(raw, flag) {
        const parsed = parseNthFlag(raw);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            return { error: parsed.error.replace('--nth', flag) };
        }
        if (typeof parsed === 'number')
            return { opts: { nth: parsed } };
        return { opts: {} };
    }
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('click'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Click element — JSON envelope {clicked, target, matches_n}'))
        .action(browserAction(async (page, target, opts) => {
        const resolvedTarget = await resolveExplicitOrSemanticTarget(page, target, opts ?? {}, 'write');
        if (typeof resolvedTarget !== 'string') {
            console.log(JSON.stringify(resolvedTarget, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { matches_n, match_level } = await page.click(resolvedTarget, parsed.opts);
        console.log(JSON.stringify({ clicked: true, target: resolvedTarget, matches_n, match_level }, null, 2));
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('type'))
        .argument('[targetOrText]', 'Numeric ref/CSS target, or text when using --role/--name/etc.')
        .argument('[text]', 'Text to type')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Click element, then type text — JSON envelope {typed, text, target, matches_n, autocomplete}'))
        .action(browserAction(async (page, targetOrText, text, opts) => {
        const resolved = await resolveWriteTargetAndValueOrPrint(page, targetOrText, text, opts ?? {}, 'text');
        if (!resolved)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        // Click first (focuses the field), wait briefly, then type.
        await page.click(resolved.target, parsed.opts);
        await page.wait(0.3);
        const { matches_n, match_level } = await page.typeText(resolved.target, resolved.value, parsed.opts);
        // __resolved is already set by the resolver call inside page.typeText
        const isAutocomplete = await page.evaluate(isAutocompleteResolvedJs());
        if (isAutocomplete)
            await page.wait(0.4);
        console.log(JSON.stringify({
            typed: true,
            text: resolved.value,
            target: resolved.target,
            matches_n,
            match_level,
            autocomplete: !!isAutocomplete,
        }, null, 2));
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('hover'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Move the mouse over an element — JSON envelope {hovered, target, matches_n}'))
        .action(browserAction(async (page, target, opts) => {
        if (typeof page.hover !== 'function')
            throw new Error('browser hover is not supported by this browser backend');
        const resolvedTarget = await resolveWriteTargetOrPrint(page, target, opts ?? {});
        if (!resolvedTarget)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { matches_n, match_level } = await page.hover(resolvedTarget, parsed.opts);
        console.log(JSON.stringify({ hovered: true, target: resolvedTarget, matches_n, match_level }, null, 2));
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('focus'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Focus an element — JSON envelope {focused, target, matches_n}'))
        .action(browserAction(async (page, target, opts) => {
        if (typeof page.focus !== 'function')
            throw new Error('browser focus is not supported by this browser backend');
        const resolvedTarget = await resolveWriteTargetOrPrint(page, target, opts ?? {});
        if (!resolvedTarget)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { focused, matches_n, match_level } = await page.focus(resolvedTarget, parsed.opts);
        console.log(JSON.stringify({ focused, target: resolvedTarget, matches_n, match_level }, null, 2));
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('dblclick'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Double-click element — JSON envelope {dblclicked, target, matches_n}'))
        .action(browserAction(async (page, target, opts) => {
        if (typeof page.dblClick !== 'function')
            throw new Error('browser dblclick is not supported by this browser backend');
        const resolvedTarget = await resolveWriteTargetOrPrint(page, target, opts ?? {});
        if (!resolvedTarget)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { matches_n, match_level } = await page.dblClick(resolvedTarget, parsed.opts);
        console.log(JSON.stringify({ dblclicked: true, target: resolvedTarget, matches_n, match_level }, null, 2));
    }));
    const runCheckCommand = async (page, target, opts, checked) => {
        if (typeof page.setChecked !== 'function')
            throw new Error(`browser ${checked ? 'check' : 'uncheck'} is not supported by this browser backend`);
        const resolvedTarget = await resolveWriteTargetOrPrint(page, target, opts);
        if (!resolvedTarget)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.setChecked(resolvedTarget, checked, parsed.opts);
        console.log(JSON.stringify({
            checked: result.checked,
            changed: result.changed,
            target: resolvedTarget,
            matches_n: result.matches_n,
            match_level: result.match_level,
            ...(result.kind ? { kind: result.kind } : {}),
        }, null, 2));
    };
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('check'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Ensure a checkbox/radio/aria-checked control is checked — JSON envelope {checked, changed, target, matches_n}'))
        .action(browserAction(async (page, target, opts) => {
        await runCheckCommand(page, target, opts ?? {}, true);
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('uncheck'))
        .argument('[target]', 'Numeric ref (from browser state / find), CSS selector, or omit when using --role/--name/etc.')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Ensure a checkbox/aria-checked control is unchecked — JSON envelope {checked, changed, target, matches_n}'))
        .action(browserAction(async (page, target, opts) => {
        await runCheckCommand(page, target, opts ?? {}, false);
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('upload'))
        .argument('[targetOrFile]', 'Numeric ref/CSS target, or first file when using --role/--name/etc.')
        .argument('[files...]', 'Local file path(s) to attach')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .option('--file <path>', 'Local file to attach (Phase 4.7 fork-tool surface: hub browser upload <ref> --file ./a.pdf)')
        .option('--files <paths>', 'Comma-separated local files to attach (hub browser upload <ref> --files a.pdf,b.pdf)')
        .option('--json', 'Print the structured envelope', false)
        .description('Attach local files to a file input — JSON envelope {uploaded, files, file_names, target, matches_n}'))
        .action(browserAction(async (page, targetOrFile, files, opts) => {
        if (typeof page.uploadFiles !== 'function')
            throw new Error('browser upload is not supported by this browser backend');
        // Phase 4.7 — fork upload tool path (`upload <ref> --file x` / `--files a,b`).
        const optionFiles = (opts?.file !== undefined && String(opts.file).trim())
            ? [String(opts.file)]
            : (typeof opts?.files === 'string' && opts.files.trim())
                ? [...String(opts.files).split(',').map((s) => s.trim()).filter(Boolean),
                   ...(Array.isArray(files) ? files : [])].filter(Boolean)
                : null;
        if (optionFiles !== null) {
            const cleanRef = stripAtPrefix(targetOrFile);
            if (!cleanRef) {
                console.log(JSON.stringify({
                    error: { code: 'usage_error', message: 'Pass the file input ref as the first argument (e.g. hub browser upload 5 --file ./a.pdf)' },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const resolvedFiles = resolveUploadFilePaths(optionFiles);
            if ('error' in resolvedFiles) {
                console.log(JSON.stringify({ error: resolvedFiles.error }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const result = await runForkBrowserTool('upload', {
                ...forkToolArgsFor(page),
                ref: cleanRef,
                files: resolvedFiles.files,
            }, page);
            printForkToolResult(result, { json: opts?.json === true });
            return;
        }
        const hasSemantic = !!semanticLocatorFromOptions(opts ?? {});
        const target = hasSemantic ? undefined : targetOrFile;
        const resolvedTarget = await resolveWriteTargetOrPrint(page, target, opts ?? {});
        if (!resolvedTarget)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const rawFiles = hasSemantic
            ? [targetOrFile, ...(Array.isArray(files) ? files : [])].filter((value) => value !== undefined)
            : files;
        const resolvedFiles = resolveUploadFilePaths(rawFiles);
        if ('error' in resolvedFiles) {
            console.log(JSON.stringify({ error: resolvedFiles.error }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.uploadFiles(resolvedTarget, resolvedFiles.files, parsed.opts);
        console.log(JSON.stringify(result, null, 2));
    }));
    addBrowserTabOption(addPrefixedSemanticLocatorOptions(addPrefixedSemanticLocatorOptions(browser.command('drag'), 'from'), 'to')
        .argument('[source]', 'Numeric ref/CSS selector to drag from, or omit with --from-role/--from-name/etc.')
        .argument('[target]', 'Numeric ref/CSS selector to drop onto, or omit with --to-role/--to-name/etc.')
        .option('--from-nth <n>', 'When <source> is a multi-match CSS selector, pick the nth match (0-based)')
        .option('--to-nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Drag one element to another — JSON envelope {dragged, source, target, source_matches_n, target_matches_n}'))
        .action(browserAction(async (page, source, target, opts) => {
        if (typeof page.drag !== 'function')
            throw new Error('browser drag is not supported by this browser backend');
        const resolvedSource = await resolvePrefixedWriteTargetOrPrint(page, source, opts ?? {}, 'from', 'source');
        if (!resolvedSource)
            return;
        const resolvedTarget = await resolvePrefixedWriteTargetOrPrint(page, target, opts ?? {}, 'to', 'target');
        if (!resolvedTarget)
            return;
        const from = parseResolveFlag(opts?.fromNth, '--from-nth');
        if ('error' in from) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: from.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const to = parseResolveFlag(opts?.toNth, '--to-nth');
        if ('error' in to) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: to.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.drag(resolvedSource, resolvedTarget, { from: from.opts, to: to.opts });
        console.log(JSON.stringify(result, null, 2));
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('fill'))
        .argument('[targetOrText]', 'Numeric ref/CSS target, or text when using --role/--name/etc.')
        .argument('[text]', 'Text to set exactly')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Set input/textarea/contenteditable text exactly and verify the value — JSON envelope {filled, verified, text, actual}'))
        .action(browserAction(async (page, targetOrText, text, opts) => {
        const resolved = await resolveWriteTargetAndValueOrPrint(page, targetOrText, text, opts ?? {}, 'text');
        if (!resolved)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.fillText(resolved.target, resolved.value, parsed.opts);
        if (!result.verified)
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        console.log(JSON.stringify({
            filled: result.filled,
            verified: result.verified,
            target: resolved.target,
            text: resolved.value,
            actual: result.actual,
            length: result.length,
            matches_n: result.matches_n,
            match_level: result.match_level,
            ...(result.mode ? { mode: result.mode } : {}),
        }, null, 2));
    }));
    addBrowserTabOption(addSemanticLocatorOptions(browser.command('select'))
        .argument('[targetOrOption]', 'Numeric ref/CSS target, or option text when using --role/--name/etc.')
        .argument('[option]', 'Option text (or value) to select')
        .option('--nth <n>', 'When <target> is a multi-match CSS selector, pick the nth match (0-based)')
        .description('Select dropdown option — JSON envelope {selected, target, matches_n}'))
        .action(browserAction(async (page, targetOrOption, option, opts) => {
        const resolved = await resolveWriteTargetAndValueOrPrint(page, targetOrOption, option, opts ?? {}, 'option');
        if (!resolved)
            return;
        const parsed = nthToResolveOpts(opts?.nth);
        if ('error' in parsed) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: parsed.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { matches_n, match_level } = await resolveRef(page, resolved.target, parsed.opts);
        const result = await page.evaluate(selectResolvedJs(resolved.value));
        if (result?.error) {
            // The select-specific "Not a <select>" / "Option not found" errors
            // are domain-level failures — emit a structured envelope so agents
            // can branch on code rather than scrape a log line.
            console.log(JSON.stringify({
                error: {
                    code: result.error === 'Not a <select>' ? 'not_a_select' : 'option_not_found',
                    message: result.error,
                    ...(result.available && { available: result.available }),
                    matches_n,
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
            return;
        }
        console.log(JSON.stringify({
            selected: result?.selected ?? resolved.value,
            target: resolved.target,
            matches_n,
            match_level,
        }, null, 2));
    }));
    addBrowserTabOption(browser.command('keys').argument('<key>', 'Key to press (Enter, Escape, Tab, Control+a)'))
        .description('Press keyboard key')
        .action(browserAction(async (page, key) => {
        await page.pressKey(key);
        console.log(`Pressed: ${key}`);
    }));
    const browserDialog = browser
        .command('dialog')
        .description('Handle a blocking JavaScript alert/confirm/prompt dialog');
    addBrowserTabOption(browserDialog.command('accept')
        .option('--text <text>', 'Prompt text to submit for prompt() dialogs')
        .description('Accept the currently open JavaScript dialog'))
        .action(browserAction(async (page, opts) => {
        if (!page.handleJavaScriptDialog) {
            throw new Error('This browser session does not support JavaScript dialog handling');
        }
        try {
            await page.handleJavaScriptDialog(true, opts?.text);
        }
        catch (err) {
            const message = getErrorMessage(err);
            if (message.toLowerCase().includes('no dialog')) {
                console.log(JSON.stringify({
                    error: {
                        code: 'no_javascript_dialog',
                        message: 'No JavaScript dialog is currently open.',
                    },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            throw err;
        }
        console.log(JSON.stringify({ handled: true, action: 'accept', ...(opts?.text !== undefined && { text: opts.text }) }, null, 2));
    }));
    addBrowserTabOption(browserDialog.command('dismiss')
        .description('Dismiss the currently open JavaScript dialog'))
        .action(browserAction(async (page) => {
        if (!page.handleJavaScriptDialog) {
            throw new Error('This browser session does not support JavaScript dialog handling');
        }
        try {
            await page.handleJavaScriptDialog(false);
        }
        catch (err) {
            const message = getErrorMessage(err);
            if (message.toLowerCase().includes('no dialog')) {
                console.log(JSON.stringify({
                    error: {
                        code: 'no_javascript_dialog',
                        message: 'No JavaScript dialog is currently open.',
                    },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            throw err;
        }
        console.log(JSON.stringify({ handled: true, action: 'dismiss' }, null, 2));
    }));
    // ── Wait commands ──
    addBrowserTabOption(browser.command('wait'))
        .argument('<type>', 'selector, text, time, xhr, or download')
        .argument('[value]', 'CSS selector, text string, seconds, XHR URL regex, or download filename/URL pattern')
        .option('--timeout <ms>', 'Timeout in milliseconds', '10000')
        .option('--since <duration>', 'xhr only: count entries from the last duration (e.g. 30s) instead of only entries newer than this wait — revives the click → wait xhr idiom, whose request typically lands before the wait starts')
        .description('Wait for selector, text, time, matching XHR, or browser download (e.g. wait selector ".loaded", wait text "Success", wait time 3, wait xhr "/api/search" --since 30s, wait download receipt.pdf)')
        .action(browserAction(async (page, type, value, opts) => {
        const timeout = parseInt(opts.timeout, 10);
        if (type === 'time') {
            const seconds = parseFloat(value ?? '2');
            await page.wait(seconds);
            console.log(`Waited ${seconds}s`);
        }
        else if (type === 'selector') {
            if (!value) {
                console.error('Missing CSS selector');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            await page.wait({ selector: value, timeout: timeout / 1000 });
            console.log(`Element "${value}" appeared`);
        }
        else if (type === 'text') {
            if (!value) {
                console.error('Missing text');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            await page.wait({ text: value, timeout: timeout / 1000 });
            console.log(`Text "${value}" appeared`);
        }
        else if (type === 'xhr') {
            // Poll the capture ring until an entry matches the URL regex — turns
            // the common "open page, wait N seconds, hope the data landed" idiom
            // into a deterministic barrier keyed on the API the agent actually
            // cares about. Prevents silent "empty DOM" failures on slow SPAs.
            if (!value) {
                console.error('Missing XHR URL regex');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            let re;
            try {
                re = new RegExp(value);
            }
            catch (err) {
                console.error(`Invalid regex "${value}": ${err instanceof Error ? err.message : String(err)}`);
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const hasSessionCapture = await page.startNetworkCapture?.() ?? false;
            if (!hasSessionCapture) {
                try {
                    await page.evaluate(NETWORK_INTERCEPTOR_JS);
                }
                catch { /* non-fatal */ }
            }
            await captureNetworkItems(page);
            // Bug #25: the freshness gate. Default is strict — only entries
            // newer than this wait — so a bare wait cannot latch onto a
            // previous action's request and hand back the wrong payload.
            // But the standard "click, wait xhr, read payload" idiom fires
            // its request ~250ms into the click and it lands in the ring
            // BEFORE the wait starts (daemon commands serialize), so the
            // strict gate rejects the very request the agent wants.
            // `--since 30s` widens the gate to a relative window — the
            // caller asserts which entries are "theirs".
            let sinceMs = null;
            if (opts.since !== undefined) {
                sinceMs = parseDurationMs(opts.since, 'since');
                if (sinceMs && typeof sinceMs === 'object') {
                    emitNetworkError('invalid_since', sinceMs.error);
                    return;
                }
                if (sinceMs === null) {
                    emitNetworkError('invalid_since', `since must be a duration like 30s, 2m, got "${opts.since}"`);
                    return;
                }
            }
            const startTs = Date.now();
            const anchorTs = sinceMs ? startTs - sinceMs : startTs;
            const deadline = startTs + timeout;
            const pollMs = 400;
            let matched = null;
            while (Date.now() < deadline && !matched) {
                const items = await captureNetworkItems(page);
                matched = items.find((e) => e.timestamp >= anchorTs && re.test(e.url)) ?? null;
                if (!matched)
                    await new Promise((r) => setTimeout(r, pollMs));
            }
            if (!matched) {
                console.log(JSON.stringify({
                    error: {
                        code: 'xhr_not_seen',
                        message: `No captured XHR matched /${value}/ within ${timeout}ms${sinceMs ? ` in the last ${opts.since}` : ' (requests observed before this wait began are not counted)'}`,
                        hint: sinceMs
                            ? 'The request may be older than the --since window, or it fired before capture started. Widen --since or check `browser network --since` output.'
                            : 'Check the pattern against `browser network` output; the endpoint may not have fired yet, or capture is disabled. For the click → wait idiom, pass --since 30s — the request usually lands before this wait starts.',
                    },
                }, null, 2));
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            console.log(JSON.stringify({
                matched: { url: matched.url, status: matched.status, contentType: matched.ct },
            }, null, 2));
        }
        else if (type === 'download') {
            if (typeof page.waitForDownload !== 'function') {
                console.log(JSON.stringify({
                    error: {
                        code: 'download_wait_unavailable',
                        message: 'The active browser backend does not support download lifecycle waits.',
                        hint: 'Use the Browser Bridge extension version 1.0.8 or newer, then retry the command.',
                    },
                }, null, 2));
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            const result = await page.waitForDownload(String(value ?? ''), timeout);
            if (!result.downloaded) {
                const code = result.state === 'interrupted' && result.id !== undefined ? 'download_failed' : 'download_not_seen';
                console.log(JSON.stringify({
                    error: {
                        code,
                        message: result.error ?? `No download matched "${value ?? '*'}" within ${timeout}ms`,
                        hint: 'Check the pattern against the expected filename or URL; use a longer --timeout if the download starts slowly.',
                    },
                    download: result,
                }, null, 2));
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            console.error(`Unknown wait type "${type}". Use: selector, text, time, xhr, or download`);
            process.exitCode = EXIT_CODES.USAGE_ERROR;
        }
    }));
    // ── Phase 4: Diff / Read / Grep / PDF / Download (fork tool wrappers) ──
    // Each command is a thin wrapper over the matching src/browser-mcp tool,
    // executed against the CLI-connected UnifiedPage (same implementation the
    // MCP server uses).
    addBrowserTabOption(browser.command('diff')
        .option('--json', 'Print the structured diff envelope instead of formatted text', false)
        .description('Show what changed on the page since the last snapshot/diff'))
        .action(browserAction(async (page, opts) => {
        const result = await runForkBrowserTool('diff', forkToolArgsFor(page), page);
        printForkToolResult(result, { json: opts?.json === true });
    }));
    addBrowserTabOption(browser.command('read')
        .option('--format <format>', 'Content format: markdown (default), text, or links', 'markdown')
        .option('--selector <selector>', 'Restrict extraction to a CSS subtree')
        .option('--viewport-only', 'For markdown reads, include only visible viewport content', false)
        .option('--include-links', 'For markdown reads, render links as markdown links', false)
        .option('--include-images', 'For markdown reads, include image references', false)
        .option('--json', 'Print the structured envelope instead of extracted text', false)
        .description('Extract page content as markdown (default), plain text, or a list of links'))
        .action(browserAction(async (page, opts) => {
        const format = String(opts?.format ?? 'markdown').toLowerCase();
        if (format !== 'markdown' && format !== 'text' && format !== 'links') {
            console.log(JSON.stringify({
                error: {
                    code: 'usage_error',
                    message: `--format must be one of: markdown, text, links. Received: "${opts?.format}"`,
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await runForkBrowserTool('read', {
            ...forkToolArgsFor(page),
            format,
            ...(opts?.selector ? { selector: String(opts.selector) } : {}),
            ...(opts?.viewportOnly ? { viewportOnly: true } : {}),
            ...(opts?.includeLinks ? { includeLinks: true } : {}),
            ...(opts?.includeImages ? { includeImages: true } : {}),
        }, page);
        printForkToolResult(result, { json: opts?.json === true });
    }));
    addBrowserTabOption(browser.command('grep')
        .argument('<pattern>', 'Case-insensitive regular expression')
        .option('--over <source>', 'Search surface: ax (snapshot lines with refs) or content (visible text)', 'ax')
        .option('--limit <n>', 'Max matching lines', '50')
        .option('--json', 'Print the structured envelope instead of matching lines', false)
        .description('Search the page without dumping it — matches keep their refs when over=ax'))
        .action(browserAction(async (page, pattern, opts) => {
        const over = String(opts?.over ?? 'ax').toLowerCase();
        if (over !== 'ax' && over !== 'content') {
            console.log(JSON.stringify({
                error: { code: 'usage_error', message: `--over must be "ax" or "content", got "${opts?.over}"` },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const limit = parseIntOption(opts?.limit, 'limit', 50);
        if (limit && typeof limit === 'object' && 'error' in limit) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: limit.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await runForkBrowserTool('grep', {
            ...forkToolArgsFor(page),
            pattern: String(pattern),
            over,
            ...(typeof limit === 'number' ? { limit } : {}),
        }, page);
        printForkToolResult(result, { json: opts?.json === true });
    }));
    addBrowserTabOption(browser.command('pdf')
        .option('--path <path>', 'Save the PDF to this path (default: a BrowserOS tool-output file)')
        .option('--landscape', 'Use landscape orientation', false)
        .option('--background', 'Compatibility alias for --print-background', false)
        .option('--print-background', 'Print background graphics', false)
        .option('--prefer-css-page-size', 'Use CSS page size when the page defines one', false)
        .option('--json', 'Print the structured envelope', false)
        .description('Print the current page to a PDF'))
        .action(browserAction(async (page, opts) => {
        const result = await runForkBrowserTool('pdf', {
            ...forkToolArgsFor(page),
            ...(opts?.landscape ? { landscape: true } : {}),
            ...(opts?.printBackground || opts?.background ? { printBackground: true } : {}),
            ...(opts?.preferCssPageSize ? { preferCSSPageSize: true } : {}),
        }, page);
        if (result.isError) {
            printForkToolResult(result, { json: opts?.json === true });
            return;
        }
        const generatedPath = result.structuredContent?.path;
        const targetPath = typeof opts?.path === 'string' && opts.path.trim() ? opts.path.trim() : undefined;
        if (!targetPath) {
            if (opts?.json) {
                console.log(JSON.stringify(result.structuredContent ?? {}, null, 2));
            }
            else {
                console.log(result.content?.find?.((c) => c.type === 'text')?.text ?? '');
            }
            return;
        }
        if (typeof generatedPath !== 'string') {
            console.log(JSON.stringify({
                error: { code: 'tool_error', message: 'pdf tool did not return an output path' },
            }, null, 2));
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
            return;
        }
        try {
            const { copyFileSync, mkdirSync } = await import('node:fs');
            const { dirname } = await import('node:path');
            mkdirSync(dirname(targetPath), { recursive: true });
            copyFileSync(generatedPath, targetPath);
        }
        catch (err) {
            console.log(JSON.stringify({
                error: {
                    code: 'pdf_copy_failed',
                    message: `PDF generated to ${generatedPath} but could not be copied to ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
                    hint: 'Check --path points to a writable location.',
                    generatedPath,
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
            return;
        }
        if (opts?.json) {
            console.log(JSON.stringify({ ...(result.structuredContent ?? {}), path: targetPath }, null, 2));
        }
        else {
            console.log(`Saved page as PDF (${result.structuredContent?.bytes ?? '?'} bytes) to: ${targetPath}`);
        }
    }));
    addBrowserTabOption(browser.command('download')
        .argument('<ref>', 'Ref of the element that triggers the download (from browser state / snapshot)')
        .option('--json', 'Print the structured envelope', false)
        .description('Click an element to trigger a file download and save it to a BrowserOS output file'))
        .action(browserAction(async (page, ref, opts) => {
        const cleanRef = stripAtPrefix(ref);
        if (!cleanRef) {
            console.log(JSON.stringify({
                error: { code: 'usage_error', message: 'Pass the element ref that triggers the download (e.g. hub browser download 5)' },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await runForkBrowserTool('download', { ...forkToolArgsFor(page), ref: cleanRef }, page);
        printForkToolResult(result, { json: opts?.json === true });
    }));
    // ── Extract ──
    addBrowserTabOption(browser.command('eval')
        .argument('<js>', 'JavaScript code')
        .option('--frame <index>', 'Cross-origin iframe index from "browser frames"')
        .description('Execute JS in page context, return result'))
        .action(browserAction(async (page, js, opts) => {
        let result;
        if (opts.frame !== undefined) {
            const frameIndex = Number.parseInt(opts.frame, 10);
            if (!Number.isInteger(frameIndex) || frameIndex < 0) {
                console.error(`Invalid frame index "${opts.frame}". Use a 0-based index from "browser frames".`);
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            if (!page.evaluateInFrame) {
                throw new Error('This browser session does not support frame-targeted evaluation');
            }
            result = await page.evaluateInFrame(js, frameIndex);
        }
        else {
            result = await page.evaluate(js);
        }
        if (typeof result === 'string')
            console.log(result);
        else
            console.log(JSON.stringify(result, null, 2));
    }));
    // ── Extract (content reading) ──
    //
    // `extract` answers the "read this page" question that `get html` / `get text`
    // can't: denoise → markdown → paragraph-aware chunking. Agents walk long pages
    // by passing back the `next_start_char` cursor instead of juggling selectors.
    addBrowserTabOption(browser.command('extract')
        .option('--selector <css>', 'CSS selector scope; defaults to <main>/<article>/<body>')
        .option('--chunk-size <chars>', 'Target chunk size in chars', '20000')
        .option('--start <char>', 'Start offset (use next_start_char from a previous extract)', '0')
        .description('Extract page content as markdown, paragraph-aware chunks for long pages'))
        .action(browserAction(async (page, opts) => {
        // Local usage validation keeps the CLI error codes (invalid_chunk_size /
        // invalid_start); page-level failures flow through the tool's unified
        // error path.
        const rawChunk = String(opts.chunkSize ?? '20000');
        if (!/^\d+$/.test(rawChunk) || Number.parseInt(rawChunk, 10) <= 0) {
            console.log(JSON.stringify({ error: { code: 'invalid_chunk_size', message: `--chunk-size must be a positive integer, got "${opts.chunkSize}"` } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const rawStart = String(opts.start ?? '0');
        if (!/^\d+$/.test(rawStart)) {
            console.log(JSON.stringify({ error: { code: 'invalid_start', message: `--start must be a non-negative integer, got "${opts.start}"` } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        // P2-6 (batch 1): thin wrapper over the shared `extract` tool
        // definition (browser-mcp/src/tools/page-info.ts) — same pipeline the
        // MCP face runs (buildExtractHtmlJs + runExtractFromHtml), dispatched
        // through executeTool so the call is guarded and audited. CLI output
        // contract (the chunk envelope object) is the tool's structuredContent.
        const result = await runForkBrowserTool('extract', {
            ...forkToolArgsFor(page),
            ...(typeof opts.selector === 'string' && opts.selector.length > 0 ? { selector: opts.selector } : {}),
            chunkSize: Number.parseInt(rawChunk, 10),
            start: Number.parseInt(rawStart, 10),
        }, page);
        if (result.isError) {
            printForkToolResult(result);
            return;
        }
        console.log(JSON.stringify(result.structuredContent ?? {}, null, 2));
    }));
    // ── Network (API discovery) ──
    //
    // Default output is JSON (agent-native). Each entry carries a stable `key`
    // (GraphQL operationName or `METHOD host+pathname`) so agents can fetch
    // full bodies with `--detail <key>` even after subsequent commands.
    // Captures are persisted per browser session under ~/.hub/cache/browser-network/.
    addBrowserTabOption(browser.command('network'))
        .option('--detail <key>', 'Emit full body for the entry with this key')
        .option('--all', 'Include static resources (js/css/images/telemetry)')
        .option('--raw', 'Emit full bodies for every entry (skip shape preview)')
        .option('--filter <fields>', 'Comma-separated field names; keep only entries whose body shape has ALL names as path segments')
        .option('--since <duration>', 'Only include entries from the last duration (for example: 30s, 2m)')
        .option('--until <duration>', 'Only include entries older than the duration from now')
        .option('--follow', 'Continuously print new matching entries as JSON lines', false)
        .option('--failed', 'Only include failed HTTP requests (status 0 or >= 400)', false)
        .option('--max-body <chars>', 'With --detail: cap the emitted body at N chars (0 = unlimited, default)', '0')
        .option('--ttl <ms>', 'Cache TTL in ms for --detail lookups', String(DEFAULT_TTL_MS))
        .description('Capture network requests as shape previews; retrieve full bodies by key')
        .action(browserAction(async (page, opts) => {
        const ttlMs = parsePositiveIntOption(opts.ttl, 'ttl', DEFAULT_TTL_MS);
        const hasDetail = typeof opts.detail === 'string' && opts.detail.length > 0;
        const hasFilter = typeof opts.filter === 'string';
        const sinceMs = parseDurationMs(opts.since, 'since');
        const untilMs = parseDurationMs(opts.until, 'until');
        if (sinceMs && typeof sinceMs === 'object') {
            emitNetworkError('invalid_since', sinceMs.error);
            return;
        }
        if (untilMs && typeof untilMs === 'object') {
            emitNetworkError('invalid_until', untilMs.error);
            return;
        }
        // --detail and --filter do different things (one request by key vs. narrow
        // the list by shape), don't compose, and combining them has no sensible
        // semantic. Reject up front with a structured error instead of silently
        // dropping one.
        if (hasDetail && hasFilter) {
            emitNetworkError('invalid_args', '--filter and --detail cannot be used together (one narrows a list, the other fetches a specific entry).');
            return;
        }
        let filterFields = null;
        if (hasFilter) {
            const parsed = parseFilter(opts.filter);
            if ('reason' in parsed) {
                emitNetworkError('invalid_filter', parsed.reason);
                return;
            }
            filterFields = parsed.fields;
        }
        if (hasDetail && opts.follow) {
            emitNetworkError('invalid_args', '--follow cannot be used with --detail.');
            return;
        }
        // --detail short-circuits: read from cache only, no live capture needed.
        if (hasDetail) {
            const rawMaxBody = String(opts.maxBody ?? '0');
            if (!/^\d+$/.test(rawMaxBody)) {
                emitNetworkError('invalid_max_body', `--max-body must be a non-negative integer, got "${opts.maxBody}"`);
                return;
            }
            const maxBody = Number.parseInt(rawMaxBody, 10);
            // P2-6 (batch 2): thin wrapper over the shared `network` tool —
            // same detail pipeline (observation-query.js runNetworkDetail),
            // guarded and audited through executeTool.
            const result = await runForkBrowserTool('network', {
                ...forkToolArgsFor(page),
                detail: opts.detail,
                maxBody,
                ttlMs,
            }, page);
            printObservationToolResult(result);
            return;
        }
        if (opts.follow) {
            if (!await page.startNetworkCapture?.()) {
                try {
                    await page.evaluate(NETWORK_INTERCEPTOR_JS);
                }
                catch { /* non-fatal */ }
            }
            while (true) {
                const rawItems = await captureNetworkItems(page).catch((err) => {
                    emitNetworkError('capture_failed', `Could not read network capture: ${err.message}`);
                    return [];
                });
                let items = opts.all ? rawItems : filterNetworkItems(rawItems);
                items = filterByTimeWindow(items, { sinceMs, untilMs });
                if (opts.failed)
                    items = items.filter((item) => item.status === 0 || item.status >= 400);
                const keyed = assignKeys(items);
                for (const item of keyed) {
                    console.log(JSON.stringify({
                        key: item.key,
                        timestamp: toIsoTimestamp(item.timestamp),
                        method: item.method,
                        status: item.status,
                        url: item.url,
                        ct: item.ct,
                        size: item.size,
                        ...(item.bodyTruncated ? { body_truncated: true } : {}),
                    }));
                }
                await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
            }
        }
        // P2-6 (batch 2): the fresh capture is a thin wrapper over the shared
        // `network` tool — same pipeline (observation-query.js runNetworkQuery:
        // capture → noise filter → time window → keys → cache → shape view),
        // guarded and audited through executeTool.
        const result = await runForkBrowserTool('network', {
            ...forkToolArgsFor(page),
            ...(opts.all === true ? { all: true } : {}),
            ...(opts.raw === true ? { raw: true } : {}),
            ...(filterFields ? { filter: filterFields } : {}),
            ...(opts.failed === true ? { failed: true } : {}),
            ...(sinceMs ? { sinceMs } : {}),
            ...(untilMs ? { untilMs } : {}),
        }, page);
        printObservationToolResult(result);
    }));
    // ── Init (adapter scaffolding) ──
    browser.command('init')
        .argument('<name>', 'Adapter name in site/command format (e.g. hn/top)')
        .description('Generate adapter scaffold in ~/.hub/clis/')
        .action(async (name) => {
        try {
            const parts = name.split('/');
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
                console.error('Name must be site/command format (e.g. hn/top)');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const [site, command] = parts;
            if (!/^[a-zA-Z0-9_-]+$/.test(site) || !/^[a-zA-Z0-9_-]+$/.test(command)) {
                console.error('Name parts must be alphanumeric/dash/underscore only');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const os = await import('node:os');
            const fs = await import('node:fs');
            const path = await import('node:path');
            const dir = path.join(hubUserRoot(), 'clis', site);
            const filePath = path.join(dir, `${command}.js`);
            if (fs.existsSync(filePath)) {
                console.log(`Adapter already exists: ${filePath}`);
                return;
            }
            let domain = site;
            const template = `import { cli, Strategy } from '@jackwener/opencli/registry';

cli({
  site: '${site}',
  name: '${command}',
  description: '', // TODO: describe what this command does
  access: 'read',  // TODO: 'read' for queries, 'write' for remote/account state changes
  example: 'hub ${site} ${command} -f yaml',
  domain: '${domain}',
  strategy: Strategy.PUBLIC, // TODO: PUBLIC (no auth), COOKIE (needs login), UI (DOM interaction)
  browser: false,            // TODO: set true if needs browser
  args: [
    { name: 'limit', type: 'int', default: 10, help: 'Number of items' },
  ],
  columns: [], // TODO: field names for table output (e.g. ['title', 'score', 'url'])
  func: async (kwargs) => {
    // TODO: implement data fetching
    // Prefer API calls (fetch) over browser automation
    // If you set browser: true, change this to: async (page, kwargs) => { ... }
    return [];
  },
});
`;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, template, 'utf-8');
            console.log(`Created: ${filePath}`);
            console.log('First time on this site? Run: hub browser analyze <url>');
            console.log(`Edit the file to implement your adapter, then run: hub browser verify ${name}`);
        }
        catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    });
    // ── Verify (test adapter) ──
    browser.command('verify')
        .argument('<name>', 'Adapter name in site/command format (e.g. hn/top)')
        .option('--write-fixture', 'Write a starter fixture to ~/.hub/config/sites/<site>/verify/<command>.json if none exists')
        .option('--update-fixture', 'Overwrite an existing fixture with one derived from current output')
        .option('--no-fixture', 'Ignore any fixture file for this run (no value-level validation)')
        .option('--require-fixture', 'Publish gate: fail when no fixture is in effect (user override or co-located clis/<site>/__fixtures__/verify/)', false)
        .option('--strict-memory', 'Fail (not just warn) when ~/.hub/config/sites/<site>/endpoints.json or notes.md is missing')
        .option('--seed-args <value>', 'Seed args when no fixture exists; use JSON array/object for multiple args or flags')
        .option('--trace <mode>', 'Trace capture for the adapter subprocess: off, on, retain-on-failure', 'off')
        .description('Execute an adapter and validate output; uses fixture at ~/.hub/config/sites/<site>/verify/<cmd>.json when present')
        .action(async (name, opts = {}) => {
        try {
            const parts = name.split('/');
            if (parts.length !== 2) {
                console.error('Name must be site/command format');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const [site, command] = parts;
            if (!/^[a-zA-Z0-9_-]+$/.test(site) || !/^[a-zA-Z0-9_-]+$/.test(command)) {
                console.error('Name parts must be alphanumeric/dash/underscore only');
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const { execFileSync } = await import('node:child_process');
            const { loadFixture, writeFixture, deriveFixture, validateRows, validateRowShape, fixturePath, builtinFixturePath, resolveFixture, expandFixtureArgs, parseSeedArgs } = await import('./browser/verify-fixture.js');
            const filePath = path.join(hubUserRoot(), 'clis', site, `${command}.js`);
            if (!fs.existsSync(filePath)) {
                console.error(`Adapter not found: ${filePath}`);
                console.error(`Run "hub browser init ${name}" to create it.`);
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            console.log(`🔍 Verifying ${name}...\n`);
            console.log(`  Loading: ${filePath}`);
            const useFixture = opts.fixture !== false;
            // P2-7 — resolution matrix: user override first, then the
            // co-located clis/<site>/__fixtures__/verify/<command>.json.
            const fixtureResolved = useFixture ? resolveFixture(site, command) : null;
            let fixture = fixtureResolved?.fixture ?? null;
            let fixtureWritePath = null;
            const effectiveFixturePath = () => fixtureWritePath ?? fixtureResolved?.path ?? fixturePath(site, command);
            // Build adapter args: fixture.args override the legacy --limit 3 heuristic.
            //   - object form   { "limit": 3 }            → `--limit 3`
            //   - array form    ["123", "--limit", "3"]   → verbatim (for positional subjects)
            const adapterSrc = fs.readFileSync(filePath, 'utf-8');
            const hasLimitArg = /['"]limit['"]/.test(adapterSrc);
            const seedArgs = parseSeedArgs(opts.seedArgs);
            const explicitArgs = fixture?.args ?? seedArgs;
            const cliArgs = expandFixtureArgs(explicitArgs);
            if (explicitArgs === undefined && cliArgs.length === 0 && hasLimitArg)
                cliArgs.push('--limit', '3');
            const traceArgs = opts.trace && opts.trace !== 'off' ? ['--trace', opts.trace] : [];
            const argDisplay = [...cliArgs, ...traceArgs].join(' ');
            const invocation = resolveBrowserVerifyInvocation();
            // Always request JSON so we can validate structurally.
            const execArgs = [...invocation.args, site, command, ...cliArgs, ...traceArgs, '--format', 'json'];
            let rawJson;
            try {
                rawJson = execFileSync(invocation.binary, execArgs, {
                    cwd: invocation.cwd,
                    timeout: 30000,
                    encoding: 'utf-8',
                    env: process.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    ...(invocation.shell ? { shell: true } : {}),
                });
            }
            catch (err) {
                console.log(`  Executing: hub ${site} ${command} ${argDisplay}\n`);
                const execErr = err;
                if (execErr.stdout)
                    console.log(String(execErr.stdout));
                if (execErr.stderr)
                    console.error(String(execErr.stderr).slice(0, 500));
                console.log(`\n  ✗ Adapter failed. Fix the code and try again.`);
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            console.log(`  Executing: hub ${site} ${command} ${argDisplay}\n`);
            let rows;
            try {
                rows = normalizeVerifyRows(JSON.parse(rawJson));
            }
            catch {
                console.log(rawJson);
                console.log('\n  ✗ Could not parse adapter output as JSON. Is `--format json` broken?');
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            console.log(renderVerifyPreview(rows));
            console.log(`\n  → ${rows.length} row${rows.length === 1 ? '' : 's'}`);
            const shapeFailures = validateRowShape(rows);
            if (shapeFailures.length > 0) {
                console.log(`\n  ✗ Adapter output violates row shape conventions:`);
                for (const f of shapeFailures.slice(0, 20)) {
                    const where = f.rowIndex !== undefined ? `row[${f.rowIndex}] ` : '';
                    console.log(`    - [${f.rule}] ${where}${f.detail}`);
                }
                if (shapeFailures.length > 20) {
                    console.log(`    ... and ${shapeFailures.length - 20} more failure(s)`);
                }
                console.log(`\n  Keep rows agent-native: <=12 top-level keys, nesting depth <=1, and id-shaped fields at top level.`);
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
                return;
            }
            // ── Fixture handling ───────────────────────────────────────────
            if (opts.writeFixture || opts.updateFixture) {
                if (fixture && !opts.updateFixture) {
                    if (fixtureResolved?.source === 'builtin') {
                        console.log(`\n  Builtin fixture in effect: ${fixtureResolved.path}`);
                        console.log(`  --write-fixture/--update-fixture seed a user-level override at ${fixturePath(site, command)}.`);
                    }
                    else {
                        console.log(`\n  Fixture already exists at ${fixturePath(site, command)}.`);
                        console.log(`  Use --update-fixture to overwrite.`);
                    }
                }
                else {
                    const fixtureArgs = explicitArgs !== undefined
                        ? explicitArgs
                        : (hasLimitArg ? { limit: 3 } : undefined);
                    const derived = deriveFixture(rows, fixtureArgs);
                    const p = writeFixture(site, command, derived);
                    fixtureWritePath = p;
                    console.log(`\n  ${fixture ? '↻ Updated' : '✎ Wrote'} fixture: ${p}`);
                    console.log(`  Review and hand-tune the derived expectations (add patterns / notEmpty, tighten rowCount).`);
                    fixture = derived;
                }
            }
            if (!fixture) {
                console.log(`\n  ✓ Adapter runs — but no fixture is in effect (looked at ${fixturePath(site, command)} and ${builtinFixturePath(site, command)}).`);
                console.log(`  Publish gate: seed one with --write-fixture, hand-tune it, then commit it at clis/${site}/__fixtures__/verify/${command}.json so it ships with the adapter.`);
                const memoryReport = checkSiteMemory(site);
                printSiteMemoryReport(memoryReport, opts.strictMemory);
                if (!memoryReport.ok && opts.strictMemory) {
                    process.exitCode = EXIT_CODES.GENERIC_ERROR;
                }
                if (opts.requireFixture) {
                    console.log(`\n  ✗ Publish gate (--require-fixture): no fixture in effect.`);
                    process.exitCode = EXIT_CODES.GENERIC_ERROR;
                }
                return;
            }
            const failures = validateRows(rows, fixture);
            if (failures.length === 0) {
                console.log(`\n  ✓ Adapter matches fixture (${effectiveFixturePath()}${fixtureWritePath === null && fixtureResolved?.source === 'builtin' ? ', builtin' : ''}).`);
                const memoryReport = checkSiteMemory(site);
                printSiteMemoryReport(memoryReport, opts.strictMemory);
                if (!memoryReport.ok && opts.strictMemory) {
                    process.exitCode = EXIT_CODES.GENERIC_ERROR;
                }
                return;
            }
            console.log(`\n  ✗ Adapter output does not match fixture:`);
            for (const f of failures.slice(0, 20)) {
                const where = f.rowIndex !== undefined ? `row[${f.rowIndex}] ` : '';
                console.log(`    - [${f.rule}] ${where}${f.detail}`);
            }
            if (failures.length > 20) {
                console.log(`    ... and ${failures.length - 20} more failure(s)`);
            }
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
        catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    });
    // ── Session ──
    browser.command('close').description('Release the current browser session tab lease')
        .action(browserAction(async (page) => {
        await page.closeWindow?.();
        console.log('Browser session tab lease released');
    }));
    // ── Built-in: bookmarks (Phase 4.2 — BrowserOS neo Bookmarks CDP domain) ──
    //
    // Browser-level domain exposed by the BrowserOS neo extension. These commands
    // connect a browser session named "bookmarks" (same UnifiedPage path every
    // browser command uses) and call Bookmarks.* via page.cdp().
    const bookmarksCmd = program
        .command('bookmarks')
        .description('Bookmark management — list, search, add, update, move, remove (Phase 4.2)');
    function formatBookmarkNode(node) {
        const typeLabel = node?.type === 'folder' ? '[folder]' : '[url]';
        const title = node?.title ?? '(untitled)';
        if (node?.type === 'folder')
            return `- ${typeLabel} ${title} (id: ${node.id})`;
        return `- ${typeLabel} ${title} — ${node?.url ?? ''} (id: ${node.id})`;
    }
    function formatBookmarkList(nodes) {
        if (!Array.isArray(nodes) || nodes.length === 0)
            return '(no bookmarks)';
        return nodes.map(formatBookmarkNode).join('\n');
    }
    bookmarksCmd.command('list')
        .option('--folder <folderId>', 'Only list bookmarks under this folder')
        .option('--json', 'Print a JSON envelope', false)
        .description('List bookmarks (all, or under --folder)')
        .action(browserAction(async (page, opts) => {
        const params = {};
        if (opts?.folder !== undefined && String(opts.folder).trim())
            params.folderId = String(opts.folder).trim();
        const result = await page.cdp('Bookmarks.getBookmarks', params);
        const nodes = result?.nodes ?? [];
        if (opts?.json) {
            console.log(JSON.stringify({ nodes, count: nodes.length }, null, 2));
            return;
        }
        console.log(formatBookmarkList(nodes));
    }, { session: 'bookmarks' }));
    bookmarksCmd.command('search')
        .argument('<query>', 'Search query')
        .option('--limit <n>', 'Max results', '100')
        .option('--json', 'Print a JSON envelope', false)
        .description('Search bookmarks')
        .action(browserAction(async (page, query, opts) => {
        const limit = parseIntOption(opts?.limit, 'limit', 100);
        if (limit && typeof limit === 'object' && 'error' in limit) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: limit.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.cdp('Bookmarks.searchBookmarks', {
            query: String(query),
            ...(typeof limit === 'number' && limit > 0 ? { maxResults: limit } : {}),
        });
        const results = result?.results ?? [];
        if (opts?.json) {
            console.log(JSON.stringify({ results, count: results.length }, null, 2));
            return;
        }
        if (results.length === 0) {
            console.log('(no matching bookmarks)');
            return;
        }
        console.log(formatBookmarkList(results));
    }, { session: 'bookmarks' }));
    bookmarksCmd.command('add')
        .option('--title <title>', 'Bookmark/folder title (required)')
        .option('--url <url>', 'URL for a bookmark (omit to create a folder)')
        .option('--folder', 'Create a folder instead of a URL bookmark', false)
        .option('--parent <parentId>', 'Parent folder id')
        .option('--index <n>', 'Position within the parent folder')
        .option('--json', 'Print a JSON envelope', false)
        .description('Add a bookmark (or a folder with --folder)')
        .action(browserAction(async (page, opts) => {
        const title = typeof opts?.title === 'string' && opts.title.trim() ? opts.title.trim() : undefined;
        if (!title) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: '--title is required' } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const params = { title };
        if (!opts?.folder) {
            const url = typeof opts?.url === 'string' && opts.url.trim() ? opts.url.trim() : undefined;
            if (!url) {
                console.log(JSON.stringify({
                    error: { code: 'usage_error', message: '--url is required unless --folder is used', hint: 'hub bookmarks add --title "文件夹" --folder' },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            params.url = url;
        }
        if (opts?.parent !== undefined && String(opts.parent).trim())
            params.parentId = String(opts.parent).trim();
        if (opts?.index !== undefined && opts.index !== '') {
            const index = parseIntOption(opts.index, 'index', undefined);
            if (index && typeof index === 'object' && 'error' in index) {
                console.log(JSON.stringify({ error: { code: 'usage_error', message: index.error } }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            if (typeof index === 'number')
                params.index = index;
        }
        const result = await page.cdp('Bookmarks.createBookmark', params);
        const node = result?.node;
        if (opts?.json) {
            console.log(JSON.stringify({ node }, null, 2));
            return;
        }
        console.log(`Created ${node?.type === 'folder' ? 'folder' : 'bookmark'} ${node?.id ?? ''}${node?.title ? ` (${node.title})` : ''}`);
    }, { session: 'bookmarks' }));
    bookmarksCmd.command('update')
        .argument('<id>', 'Bookmark id')
        .option('--title <title>', 'New title')
        .option('--url <url>', 'New URL')
        .option('--json', 'Print a JSON envelope', false)
        .description('Update a bookmark')
        .action(browserAction(async (page, id, opts) => {
        const params = { id: String(id) };
        if (opts?.title !== undefined && opts.title !== '')
            params.title = String(opts.title);
        if (opts?.url !== undefined && opts.url !== '')
            params.url = String(opts.url);
        if (params.title === undefined && params.url === undefined) {
            console.log(JSON.stringify({
                error: { code: 'usage_error', message: 'Pass --title and/or --url' },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.cdp('Bookmarks.updateBookmark', params);
        const node = result?.node;
        if (opts?.json) {
            console.log(JSON.stringify({ node }, null, 2));
            return;
        }
        console.log(`Updated bookmark ${id}${node?.title ? ` (${node.title})` : ''}`);
    }, { session: 'bookmarks' }));
    bookmarksCmd.command('move')
        .argument('<id>', 'Bookmark id')
        .option('--parent <parentId>', 'Destination folder id')
        .option('--index <n>', 'Position within the destination folder')
        .option('--json', 'Print a JSON envelope', false)
        .description('Move a bookmark to another folder / index')
        .action(browserAction(async (page, id, opts) => {
        const params = { id: String(id) };
        if (opts?.parent !== undefined && String(opts.parent).trim())
            params.parentId = String(opts.parent).trim();
        if (opts?.index !== undefined && opts.index !== '') {
            const index = parseIntOption(opts.index, 'index', undefined);
            if (index && typeof index === 'object' && 'error' in index) {
                console.log(JSON.stringify({ error: { code: 'usage_error', message: index.error } }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            if (typeof index === 'number')
                params.index = index;
        }
        const result = await page.cdp('Bookmarks.moveBookmark', params);
        const node = result?.node;
        if (opts?.json) {
            console.log(JSON.stringify({ node }, null, 2));
            return;
        }
        console.log(`Moved bookmark ${id}${node?.parentId ? ` to folder ${node.parentId}` : ''}`);
    }, { session: 'bookmarks' }));
    bookmarksCmd.command('remove')
        .argument('<id>', 'Bookmark id')
        .option('--json', 'Print a JSON envelope', false)
        .description('Remove a bookmark')
        .action(browserAction(async (page, id, opts) => {
        await page.cdp('Bookmarks.removeBookmark', { id: String(id) });
        if (opts?.json) {
            console.log(JSON.stringify({ removed: String(id) }, null, 2));
            return;
        }
        console.log(`Removed bookmark ${id}`);
    }, { session: 'bookmarks' }));

    // ── Built-in: history (Phase 4.3 — History CDP domain / fork history tool) ──
    const historyCmd = program
        .command('history')
        .description('Browser history — list and search (Phase 4.3)');
    function parseHistorySince(raw) {
        if (raw === undefined || raw === null || raw === '')
            return undefined;
        const str = String(raw).trim();
        const numeric = Number(str);
        const ts = str !== '' && Number.isFinite(numeric) ? numeric : Date.parse(str);
        if (!Number.isFinite(ts))
            return { error: `--since must be an ISO date (e.g. 2025-01-01) or a millisecond timestamp, got "${raw}"` };
        return ts;
    }
    function filterHistoryByDomain(entries, domain) {
        if (!domain)
            return entries;
        const d = String(domain).toLowerCase().replace(/^\./, '');
        return (entries ?? []).filter((e) => {
            try {
                const host = new URL(e.url ?? '').hostname.toLowerCase();
                return host === d || host.endsWith('.' + d);
            }
            catch {
                return false;
            }
        });
    }
    function formatHistoryEntries(entries) {
        if (!Array.isArray(entries) || entries.length === 0)
            return '(no history)';
        return entries.map((e) => {
            const dest = e.title ? `${e.title} (${e.url})` : e.url;
            const visits = e.visitCount === 1 ? 'visit' : 'visits';
            const when = e.lastVisitTime
                ? new Date(e.lastVisitTime).toISOString().replace('.000Z', 'Z')
                : 'unknown';
            return `- ${dest} — last visited ${when}; ${e.visitCount ?? 0} ${visits}; ${e.typedCount ?? 0} typed`;
        }).join('\n');
    }
    historyCmd.command('list')
        .option('--limit <n>', 'Max entries', '100')
        .option('--since <date>', 'Only entries visited at or after this ISO date / millisecond timestamp')
        .option('--domain <domain>', 'Only entries from this host/domain (e.g. github.com)')
        .option('--json', 'Print a JSON envelope', false)
        .description('List recent browser history (reuses the fork history tool)')
        .action(browserAction(async (page, opts) => {
        const limit = parseIntOption(opts?.limit, 'limit', 100);
        if (limit && typeof limit === 'object' && 'error' in limit) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: limit.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const since = parseHistorySince(opts?.since);
        if (since && typeof since === 'object' && 'error' in since) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: since.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await runForkBrowserTool('history', {
            ...(typeof limit === 'number' && limit > 0 ? { maxResults: limit } : {}),
        }, page);
        if (result.isError) {
            printForkToolResult(result, { json: opts?.json === true });
            return;
        }
        let entries = result.structuredContent?.entries ?? [];
        if (typeof since === 'number')
            entries = entries.filter((e) => Number(e.lastVisitTime ?? 0) >= since);
        entries = filterHistoryByDomain(entries, opts?.domain);
        if (opts?.json) {
            console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
            return;
        }
        console.log(formatHistoryEntries(entries));
    }, { session: 'history' }));
    historyCmd.command('search')
        .argument('<query>', 'Search query')
        .option('--limit <n>', 'Max results', '100')
        .option('--json', 'Print a JSON envelope', false)
        .description('Search browser history (History.search CDP domain)')
        .action(browserAction(async (page, query, opts) => {
        const limit = parseIntOption(opts?.limit, 'limit', 100);
        if (limit && typeof limit === 'object' && 'error' in limit) {
            console.log(JSON.stringify({ error: { code: 'usage_error', message: limit.error } }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const result = await page.cdp('History.search', {
            query: String(query),
            ...(typeof limit === 'number' && limit > 0 ? { maxResults: limit } : {}),
        });
        const entries = result?.entries ?? [];
        if (opts?.json) {
            console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
            return;
        }
        if (entries.length === 0) {
            console.log('(no matching history entries)');
            return;
        }
        console.log(formatHistoryEntries(entries));
    }, { session: 'history' }));

    // ── Built-in: replay (Phase 4.6 — claw-server-rust HTTP API) ──
    //
    // Endpoints (see apps/claw-server-rust/src/api/http/{mod,replay,sessions}.rs
    // and contracts/claw-api/paths/recordings.yaml):
    //   GET /api/v1/sessions                          -> SessionList { items }
    //   GET /api/v1/sessions/{id}/recording           -> RecordingMetadata
    //   GET /api/v1/sessions/{id}/recording/events    -> newline-delimited rrweb events
    const REPLAY_DEFAULT_BASE_URL = 'http://127.0.0.1:9200';
    function replayBaseUrl(opts = {}) {
        if (typeof opts.baseUrl === 'string' && opts.baseUrl.trim())
            return opts.baseUrl.trim().replace(/\/+$/, '');
        const envUrl = process.env.CLAW_SERVER_URL || process.env.BROWSEROS_SERVER_URL;
        if (envUrl && envUrl.trim())
            return envUrl.trim().replace(/\/+$/, '');
        const envPort = process.env.BROWSEROS_SERVER_PORT;
        if (envPort && /^\d+$/.test(envPort))
            return `http://127.0.0.1:${envPort}`;
        return REPLAY_DEFAULT_BASE_URL;
    }
    async function replayFetchJson(url, timeoutMs = 5000) {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            let detail = '';
            try {
                const body = await res.json();
                detail = body?.error?.message ?? body?.message ?? JSON.stringify(body);
            }
            catch {
                detail = await res.text().catch(() => '');
            }
            const err = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
            err.status = res.status;
            throw err;
        }
        return res.json();
    }
    async function replayFetchText(url, timeoutMs = 10000) {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            let detail = '';
            try {
                detail = await res.text();
            }
            catch { /* no body */ }
            const err = new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
            err.status = res.status;
            throw err;
        }
        return res.text();
    }
    function replayDependencyHint(baseUrl) {
        return `replay depends on the BrowserOS neo server (claw-server-rust) HTTP API at ${baseUrl}. ` +
            'Start it (e.g. `browseros-dev watch --claw`), or point this CLI at it with --base-url / CLAW_SERVER_URL / BROWSEROS_SERVER_PORT.';
    }
    function printReplayError(err, baseUrl) {
        // HTTP errors carry a status; anything else is a transport failure
        // (Bun's fetch throws name:'Error' with "Unable to connect...", Node
        // uses TypeError "fetch failed", undici ECONNREFUSED, etc.).
        const isHttpError = !!err && typeof err.status === 'number';
        if (isHttpError) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        else {
            console.error(`Error: could not reach the BrowserOS neo server at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
            console.error(replayDependencyHint(baseUrl));
        }
        process.exitCode = EXIT_CODES.SERVICE_UNAVAIL;
    }
    function replayTimeline(ndjson) {
        const lines = ndjson.split('\n').filter((l) => l.trim().length > 0);
        const counts = new Map();
        const timestamps = [];
        for (const line of lines) {
            try {
                const evt = JSON.parse(line);
                counts.set(evt.type, (counts.get(evt.type) ?? 0) + 1);
                if (typeof evt.timestamp === 'number')
                    timestamps.push(evt.timestamp);
            }
            catch { /* skip malformed lines */ }
        }
        return {
            events: lines.length,
            types: Object.fromEntries(counts),
            ...(timestamps.length
                ? { firstEventAt: Math.min(...timestamps), lastEventAt: Math.max(...timestamps) }
                : {}),
        };
    }
    const replayCmd = program
        .command('replay')
        .description('Recording replay — list, show, and export session recordings from the BrowserOS neo server (Phase 4.6)');
    replayCmd.command('list')
        .option('--limit <n>', 'Max sessions to list (and probe for recordings)', '20')
        .option('--no-recordings', 'Skip per-session recording probes (faster)')
        .option('--base-url <url>', 'BrowserOS neo server base URL (default: CLAW_SERVER_URL env or http://127.0.0.1:9200)')
        .option('--json', 'Print a JSON envelope', false)
        .description('List sessions from the BrowserOS neo server, annotated with recording presence')
        .action(async (opts) => {
        const baseUrl = replayBaseUrl(opts ?? {});
        try {
            const data = await replayFetchJson(`${baseUrl}/api/v1/sessions`);
            const all = data?.items ?? [];
            const limit = parseIntOption(opts?.limit, 'limit', 20);
            if (limit && typeof limit === 'object' && 'error' in limit) {
                console.log(JSON.stringify({ error: { code: 'usage_error', message: limit.error } }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const sessions = typeof limit === 'number' && limit >= 0 ? all.slice(0, limit) : all;
            let rows = sessions;
            if (opts?.recordings !== false) {
                const annotated = [];
                let idx = 0;
                async function worker() {
                    while (idx < sessions.length) {
                        const session = sessions[idx++];
                        try {
                            const meta = await replayFetchJson(
                                `${baseUrl}/api/v1/sessions/${encodeURIComponent(session.sessionId)}/recording`,
                                1500,
                            );
                            annotated.push({ ...session, recording: meta ?? null });
                        }
                        catch {
                            annotated.push({ ...session, recording: null });
                        }
                    }
                }
                const workers = Math.max(1, Math.min(8, sessions.length));
                await Promise.all(Array.from({ length: workers }, () => worker()));
                rows = annotated;
            }
            if (opts?.json) {
                console.log(JSON.stringify({ baseUrl, sessions: rows, count: rows.length }, null, 2));
                return;
            }
            if (rows.length === 0) {
                console.log('(no sessions — start a BrowserOS neo session first)');
                return;
            }
            for (const s of rows) {
                const when = s.startedAt ? new Date(s.startedAt).toISOString() : '?';
                const recording = s.recording
                    ? `[recording ${s.recording.sizeBytes ?? 0} bytes${s.recording.complete === false ? ', incomplete' : ''}]`
                    : (s.recording === null ? '[no recording]' : '');
                console.log(`- ${s.sessionId}  ${s.status ?? ''}  ${s.name || s.slug || ''}  started ${when}  ${recording}`.trimEnd());
            }
        }
        catch (err) {
            printReplayError(err, baseUrl);
        }
    });
    replayCmd.command('show')
        .argument('<sessionId>', 'Session id')
        .option('--timeline', 'Include the operation timeline (rrweb event types / counts)', false)
        .option('--base-url <url>', 'BrowserOS neo server base URL')
        .option('--json', 'Print a JSON envelope', false)
        .description('Show recording metadata for a session')
        .action(async (sessionId, opts) => {
        const baseUrl = replayBaseUrl(opts ?? {});
        try {
            const meta = await replayFetchJson(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/recording`);
            let timeline = undefined;
            if (opts?.timeline) {
                const ndjson = await replayFetchText(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/recording/events`);
                timeline = replayTimeline(ndjson);
            }
            if (opts?.json) {
                console.log(JSON.stringify({
                    sessionId,
                    recording: meta,
                    ...(timeline ? { timeline } : {}),
                }, null, 2));
                return;
            }
            console.log(`Session ${sessionId}`);
            console.log(`  hasData: ${meta?.hasData ?? false}`);
            console.log(`  complete: ${meta?.complete ?? false}`);
            console.log(`  sizeBytes: ${meta?.sizeBytes ?? 0}`);
            if (meta?.firstEventAt)
                console.log(`  firstEventAt: ${new Date(meta.firstEventAt).toISOString()}`);
            if (meta?.lastEventAt)
                console.log(`  lastEventAt: ${new Date(meta.lastEventAt).toISOString()}`);
            const tabs = meta?.tabs ?? [];
            console.log(`  tabs: ${tabs.length}`);
            for (const tab of tabs) {
                const segs = tab?.segments ?? [];
                const first = tab?.firstEventAt ? new Date(tab.firstEventAt).toISOString() : '?';
                const last = tab?.lastEventAt ? new Date(tab.lastEventAt).toISOString() : '?';
                console.log(`    tab ${tab.tabId} — ${tab.complete === false ? 'incomplete' : 'complete'} — ${segs.length} segment(s) — first ${first} last ${last}`);
                for (const seg of segs ?? []) {
                    console.log(`      segment ${seg.documentId ?? ''} — ${seg.eventCount ?? 0} event(s) — ${seg.sizeBytes ?? 0} bytes${seg.hasGap ? ' (gap)' : ''}`);
                }
            }
            if (timeline) {
                console.log(`  timeline: ${timeline.events} event(s)`);
                for (const [type, count] of Object.entries(timeline.types ?? {}))
                    console.log(`    ${type}: ${count}`);
            }
        }
        catch (err) {
            printReplayError(err, baseUrl);
        }
    });
    replayCmd.command('export')
        .argument('<sessionId>', 'Session id')
        .option('--format <format>', 'Export format: ndjson (raw event stream, default) or json (JSON array)', 'ndjson')
        .option('--out <path>', 'Write to a file instead of stdout')
        .option('--base-url <url>', 'BrowserOS neo server base URL')
        .option('--json', 'Print a JSON envelope with the export summary', false)
        .description('Export a session recording (rrweb events) from the BrowserOS neo server')
        .action(async (sessionId, opts) => {
        const baseUrl = replayBaseUrl(opts ?? {});
        try {
            const ndjson = await replayFetchText(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/recording/events`);
            const format = String(opts?.format ?? 'ndjson').toLowerCase();
            if (format !== 'ndjson' && format !== 'json') {
                console.log(JSON.stringify({
                    error: { code: 'usage_error', message: `--format must be "ndjson" or "json", got "${opts?.format}"` },
                }, null, 2));
                process.exitCode = EXIT_CODES.USAGE_ERROR;
                return;
            }
            const count = ndjson.split('\n').filter((l) => l.trim().length > 0).length;
            if (opts?.out !== undefined && String(opts.out).trim()) {
                const { writeFileSync, mkdirSync } = await import('node:fs');
                const { dirname, resolve } = await import('node:path');
                const target = resolve(String(opts.out).trim());
                mkdirSync(dirname(target), { recursive: true });
                if (format === 'json') {
                    const parsed = ndjson.split('\n').filter((l) => l.trim().length > 0)
                        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
                        .filter((v) => v !== null);
                    writeFileSync(target, JSON.stringify(parsed, null, 2), 'utf-8');
                }
                else {
                    writeFileSync(target, ndjson, 'utf-8');
                }
                if (opts?.json) {
                    console.log(JSON.stringify({ sessionId, format, out: target, events: count }, null, 2));
                    return;
                }
                console.log(`Exported ${count} event line(s) for ${sessionId} (${format}) to: ${target}`);
                return;
            }
            if (opts?.json) {
                console.log(JSON.stringify({ sessionId, format, events: count }, null, 2));
                return;
            }
            process.stdout.write(ndjson);
            if (!ndjson.endsWith('\n'))
                process.stdout.write('\n');
        }
        catch (err) {
            printReplayError(err, baseUrl);
        }
    });

    // ── Built-in: space (Phase 3 — task spaces, shared cookie + agent tab isolation) ──
    //
    // TaskSpaceManager lives in the unified Core (src/space/task-space-manager.ts,
    // hub-browser). These commands are thin wrappers: create/list/switch/handoff/
    // takeover/current are ledger-only (no browser needed); close needs a browser
    // gateway to close the space's tabs (uses the daemon singleton when present).
    const spaceCmd = program
        .command('space')
        .description('Task-space management — create, list, switch, close, handoff, takeover (Phase 3)');
    // P1-3: HUB_AGENT_ID is the stable ownership key (convoId). The agent
    // label mirrors it for CLI callers; daemon CommandContext wiring will
    // route owner extraction through ownerOf() (task-space-manager).
    const LOCAL_SPACE_IDENTITY = () => {
        const agentId = process.env.HUB_AGENT_ID || 'cli:local';
        return {
            agentId,
            convoId: agentId,
            displayName: 'hub local operator',
        };
    };
    async function loadSpaceManager(opts = {}) {
        const { TaskSpaceManager, defaultStoragePath } = await import('../space/task-space-manager.ts');
        return new TaskSpaceManager({
            storagePath: process.env.HUB_SPACES_FILE || defaultStoragePath(),
            ...(opts.gateway ? { gateway: opts.gateway } : {}),
        });
    }
    // ── P2-4 observability: audit log query (no browser connection) ──
    const auditCmd = program
        .command('audit')
        .description('Observability — query the audit log (P2-2 dispatch history)');
    auditCmd.command('list')
        .description('List recent audit dispatches (newest first; raw JSON rows)')
        .option('--convo <id>', 'Filter by conversation/owner id')
        .option('--session <id>', 'Filter by session id')
        .option('--tool <name>', 'Filter by tool name')
        .option('--parent <dispatchId>', 'List child rows of one run dispatch')
        .option('--limit <n>', 'Max rows (default 20)', '20')
        .option('--cursor <id>', 'Pagination: rows with id < cursor')
        .action(async (opts) => {
        const { AuditLog, resolveAuditDbPath } = await import('../audit/audit-log.ts');
        const dbPath = resolveAuditDbPath();
        if (!dbPath) {
            console.log(JSON.stringify({
                error: {
                    code: 'audit_off',
                    message: 'audit log is not active; set HUB_AUDIT_DB (or unset HUB_AUDIT=off / BUN_TEST)',
                },
            }, null, 2));
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const limit = parseInt(opts?.limit ?? '20', 10);
        const cursor = opts?.cursor !== undefined ? parseInt(opts.cursor, 10) : undefined;
        const audit = new AuditLog(dbPath);
        try {
            const rows = audit.listDispatches({
                ...(opts?.convo ? { convoId: String(opts.convo) } : {}),
                ...(opts?.session ? { sessionId: String(opts.session) } : {}),
                ...(opts?.tool ? { toolName: String(opts.tool) } : {}),
                ...(opts?.parent ? { parentDispatchId: String(opts.parent) } : {}),
                ...(Number.isFinite(limit) ? { limit } : {}),
                ...(Number.isFinite(cursor) ? { cursor } : {}),
            });
            console.log(JSON.stringify(rows, null, 2));
        }
        finally {
            audit.close();
        }
    });
    // ── P2-3 recordings: BrowserClaw recording read face (no browser
    // connection) ──
    // Streams the browser's claw extension records (rrweb) live in the
    // BrowserClaw server; these commands read that index over HTTP and export
    // self-contained replay HTML — same shared implementation the replay.*
    // MCP tools use (browser-mcp/src/tools/replay-tools.ts). Named `recording`
    // here because the legacy `replay` command family is the OpenCLI trace
    // replayer (local trace artifacts, a different data source).
    const recordingCmd = program
        .command('recording')
        .description('Observability — recorded browser replays (BrowserClaw rrweb streams)');
    function printRecordingError(outcome) {
        console.log(JSON.stringify({
            error: { code: outcome.error.code, message: outcome.error.message },
        }, null, 2));
        process.exitCode = EXIT_CODES.GENERIC_ERROR;
    }
    recordingCmd.command('list')
        .description('List recorded replay streams (newest first; raw JSON)')
        .option('--tab <id>', 'Only streams recorded on this Chrome tab id')
        .option('--from <ms>', 'Only streams whose last event is at/after this epoch-ms timestamp')
        .option('--to <ms>', 'Only streams whose first event is at/before this epoch-ms timestamp')
        .option('--limit <n>', 'Max streams (default 50)', '50')
        .action(async (opts) => {
        const { listClawStreams } = await import('../browser-mcp/src/tools/replay-tools.ts');
        const limit = parseInt(opts?.limit ?? '50', 10);
        const outcome = await listClawStreams({
            ...(opts?.tab !== undefined && Number.isFinite(parseInt(opts.tab, 10)) ? { tabId: parseInt(opts.tab, 10) } : {}),
            ...(opts?.from !== undefined && Number.isFinite(parseInt(opts.from, 10)) ? { fromMs: parseInt(opts.from, 10) } : {}),
            ...(opts?.to !== undefined && Number.isFinite(parseInt(opts.to, 10)) ? { toMs: parseInt(opts.to, 10) } : {}),
            ...(Number.isFinite(limit) ? { limit } : {}),
        });
        if (outcome.ok === false) {
            printRecordingError(outcome);
            return;
        }
        console.log(JSON.stringify({ streams: outcome.value, count: outcome.value.length }, null, 2));
    });
    recordingCmd.command('export')
        .description('Export one recorded stream as a self-contained HTML replay (open in any browser)')
        .argument('<documentId>', 'Recording document id (from recording list)')
        .option('--session <id>', 'Claw session id whose dispatch timeline to embed')
        .option('--from <ms>', 'Clip events before this epoch-ms timestamp')
        .option('--to <ms>', 'Clip events after this epoch-ms timestamp')
        .option('--out <path>', 'Output file path (default ~/.hub/replays/<docId>.html)')
        .action(async (documentId, opts) => {
        const { exportClawReplay } = await import('../browser-mcp/src/tools/replay-tools.ts');
        const outcome = await exportClawReplay({
            documentId,
            ...(opts?.session ? { sessionId: String(opts.session) } : {}),
            ...(opts?.from !== undefined && Number.isFinite(parseInt(opts.from, 10)) ? { fromMs: parseInt(opts.from, 10) } : {}),
            ...(opts?.to !== undefined && Number.isFinite(parseInt(opts.to, 10)) ? { toMs: parseInt(opts.to, 10) } : {}),
            ...(opts?.out ? { out: String(opts.out) } : {}),
        });
        if (outcome.ok === false) {
            printRecordingError(outcome);
            return;
        }
        console.log(JSON.stringify(outcome.value, null, 2));
    });
    // ── Phase 3 B: `browser` commands are space-aware ──
    //
    // The CLI and the daemon share the ledger (HUB_SPACES_FILE or the default
    // path). When the local agent has a current space:
    //   - `browser open` routes through the manager's openTab path (a fresh
    //     tab is created in the space and made active, so subsequent commands
    //     operate on it);
    //   - `browser tab list` is scoped to the current space's tabs;
    //   - `browser tab new/close` keep the ledger in sync.
    // D3 (2026-08-03): without a current space the group is closed — `open`,
    //   `tab select/close/new` are rejected with no-space, `tab list` is empty.
    async function currentSpaceForBrowser(gateway) {
        // bug 1 (D5 CLI read paths): pass the browser gateway through so the
        // manager's lazy tab-group reconcile (syncWithTabGroups) runs before
        // answering. No gateway (browser unreachable) → reconcile is a no-op
        // and behavior is unchanged.
        const manager = await loadSpaceManager(gateway ? { gateway } : {});
        const space = await manager.currentSpace(LOCAL_SPACE_IDENTITY().agentId);
        return { manager, space };
    }
    /** D3 (2026-08-03): the local agent owns no space — browser tab operations
     *  are rejected (mirrors execution.js / TaskSpaceManager no-space). */
    async function noSpaceErrorForBrowser() {
        const { SpaceGuardError } = await import('../space/task-space-manager.ts');
        return new SpaceGuardError(
            'no-space',
            `agent has no space; run 'hub space create <name>' first`,
            { hint: 'create a task space first, then operate on its tabs' },
        );
    }
    /** Open a tab inside the current space via manager.openTab. D3 — throws
     *  no-space when the agent has no current space (no legacy goto fallback). */
    async function openIntoCurrentSpace(page, url) {
        const { manager, space } = await currentSpaceForBrowser();
        if (!space) throw await noSpaceErrorForBrowser();
        const { gatewayFromPage } = await import('../space/task-space-manager.ts');
        // background:false — the space tab becomes the active tab so the next
        // browser command (state/snapshot/click/...) operates on it.
        // reuse:'exact' — ego openOrReuseTab semantics: the same URL inside the
        // current space reuses the open tab (switches to it) instead of
        // opening a duplicate; the result reports reused:true.
        const { pageId, reused } = await manager.openTabWithReuse(
            LOCAL_SPACE_IDENTITY().agentId,
            space.id,
            url,
            { background: false, reuse: 'exact' },
            gatewayFromPage(page),
        );
        return { pageId, spaceId: space.id, reused };
    }
    /** Scope a live tabs list to the current space by tab identity (bug #5: URL
     *  filtering leaked another space's same-URL tabs). D3 — without a current
     *  space the list is EMPTY (no legacy unfiltered listing). */
    async function scopeTabsToCurrentSpace(tabs, gateway) {
        const { manager, space } = await currentSpaceForBrowser(gateway);
        if (!space) return [];
        const refs = await manager.listTabs(space.id);
        // P1 (tab-list 1/N bug): pageId is a per-connection sequence number —
        // across process restarts the live list's pageId N can be a DIFFERENT
        // tab than the ledger's pageId N, so scoping by pageId alone showed a
        // random one tab (and restore even rewrote ledger urls this way).
        // Anchor on the stable targetId; a pageId hit only counts when the
        // url agrees too.
        const byTarget = new Set(refs.map((t) => t.targetId).filter(Boolean));
        const refById = new Map(refs.filter((t) => typeof t.pageId === 'number').map((t) => [t.pageId, t]));
        return tabs.filter((t) => {
            if (t.targetId && byTarget.has(t.targetId)) return true;
            const ref = refById.get(t.pageId);
            return !!ref && !!ref.url && !!t.url && ref.url === t.url;
        });
    }
    /** Reject a tab that doesn't belong to the current space (bug #4). D3 —
     *  without a current space the operation is rejected too (no legacy no-op).
     *  Mirrors the MCP guard message. */
    async function assertTabInCurrentSpace(page, targetId) {
        const { manager, space } = await currentSpaceForBrowser();
        if (!space) throw await noSpaceErrorForBrowser();
        const tabs = await page.tabs();
        const info = Array.isArray(tabs) ? tabs.find((t) => t && t.targetId === String(targetId)) : undefined;
        if (typeof info?.pageId !== 'number') {
            throw new Error(`tab ${targetId} is not in your space`);
        }
        const sid = await manager.spaceIdForPage(info.pageId);
        if (sid !== space.id) {
            throw new Error(`tab ${targetId} is not in your space`);
        }
    }
    /** P1-4: guard group membership edits (create/ungroup) — every page must
     *  belong to the current space, mirroring the MCP tab_groups guard
     *  (manager.assertPagesControllable, which also rejects no-space per D3). */
    async function assertPagesInCurrentSpace(pageIds) {
        const { manager } = await currentSpaceForBrowser();
        await manager.assertPagesControllable(LOCAL_SPACE_IDENTITY().agentId, pageIds);
    }
    /** P1-1 real-run hole (2026-08-22): `group update/close` address a group
     *  by groupId only, so the pages-based gate never fired — any agent could
     *  rename or close another space's whole group live. Space-level policy
     *  (same as assertTabInCurrentSpace, NOT assertPagesControllable): a group
     *  is the current space's visual projection (D5), so every member page
     *  must belong to the CURRENT space — same local agent's other spaces are
     *  still off-limits (real-run repro: one agent, two spaces, live rename
     *  of the other space's group sailed through the agent-level check).
     *  Unknown/empty groups fall through to the CDP call's native error. */
    async function assertGroupInCurrentSpace(page, groupId) {
        const { manager, space } = await currentSpaceForBrowser();
        if (!space) throw await noSpaceErrorForBrowser();
        const groups = await page.tabGroupList();
        const group = (groups || []).find((g) => g && g.groupId === String(groupId));
        if (!group || !Array.isArray(group.tabIds) || group.tabIds.length === 0) return;
        const tabs = await page.tabs();
        const pageIds = group.tabIds
            .map((tabId) => (tabs || []).find((t) => t && t.tabId === tabId)?.pageId)
            .filter((id) => typeof id === 'number');
        if (pageIds.length === 0) return;
        for (const pageId of pageIds) {
            const sid = await manager.spaceIdForPage(pageId);
            if (sid !== space.id) {
                const { SpaceGuardError } = await import('../space/task-space-manager.ts');
                throw new SpaceGuardError(
                    'page-not-in-space',
                    `group ${groupId} is not in your space (page ${pageId} belongs to ${sid ?? 'no space'})`,
                    { hint: 'operate on your own space\u0027s group, or hub space switch first' },
                );
            }
        }
    }
    /** Close a tab through the current space's ledger when it belongs to the space. */
    async function closeTabThroughCurrentSpace(page, targetId) {
        try {
            const { manager, space } = await currentSpaceForBrowser();
            if (!space) return false;
            const tabs = await page.tabs();
            const info = tabs.find((t) => t.targetId === targetId);
            if (typeof info?.pageId !== 'number') return false;
            const sid = await manager.spaceIdForPage(info.pageId);
            if (sid !== space.id) return false;
            const { gatewayFromPage } = await import('../space/task-space-manager.ts');
            await manager.closeTab(
                LOCAL_SPACE_IDENTITY().agentId,
                space.id,
                info.pageId,
                gatewayFromPage(page),
            );
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Space close/refresh need a browser gateway to close the space's tabs.
     * Returns `{ gateway, cleanup }`: `gateway` is undefined when no browser is
     * reachable; `cleanup` is defined only when this call created its own
     * BrowserBridge (direct-connect path) and must be awaited by the caller
     * before the process exits (bug #9 — otherwise the CDP connection keeps
     * the event loop alive and `space close`/`space refresh` hang). The
     * daemon-singleton path shares the daemon's connection and needs no
     * cleanup. Honors the __HubBrowserBridgeOverride test seam like
     * getBrowserPage().
     */
    async function spaceGatewayFromBrowser() {
        try {
            const singleton = getDaemonFactory();
            if (singleton && singleton._cdp && singleton._session) {
                const { gatewayFromPage } = await import('../space/task-space-manager.ts');
                return { gateway: gatewayFromPage(await singleton.connect()), cleanup: undefined };
            }
            const { BrowserBridge } = await import('./browser/index.js');
            const { gatewayFromPage } = await import('../space/task-space-manager.ts');
            const BridgeCtor = getBrowserBridgeOverride() ?? BrowserBridge;
            const bridge = new BridgeCtor();
            const cleanup = async () => {
                if (bridge && typeof bridge.close === 'function') {
                    try { await bridge.close(); } catch { /* best-effort */ }
                }
            };
            try {
                const page = await bridge.connect({ timeout: DEFAULT_BROWSER_CONNECT_TIMEOUT });
                return { gateway: gatewayFromPage(page), cleanup };
            }
            catch {
                // Connection failed: still hand the caller a cleanup so the
                // half-open bridge is torn down and the process can exit.
                return { gateway: undefined, cleanup };
            }
        }
        catch {
            return { gateway: undefined, cleanup: undefined };
        }
    }
    function printSpaceError(err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        if (err && typeof err === 'object' && 'code' in err && err.code === 'user-controlling') {
            console.error(`Hint: the space is currently controlled by the user. Ask the user to confirm, then run: hub space takeover <id>`);
        }
        if (err && typeof err === 'object' && 'code' in err && err.code === 'no-gateway') {
            console.error(`Hint: start the hub daemon (hub) with BROWSEROS_CDP_PORT set, or pass --keep to close only the space ledger.`);
        }
        process.exitCode = EXIT_CODES.GENERIC_ERROR;
    }
    function formatSpaceTable(spaces) {
        const rows = spaces.map((s) => [
            s.id,
            s.name,
            s.ownership,
            String(s.tabIds.length),
            s.createdAt,
        ]);
        const widths = [0, 0, 0, 0, 0];
        const header = ['ID', 'Name', 'Status', 'Tabs', 'Created'];
        for (const row of [header, ...rows]) {
            for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i], row[i].length);
        }
        const line = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join(' | ').trimEnd();
        return [line(header), rows.map(line).join('\n')].filter(Boolean).join('\n');
    }
    spaceCmd.command('create')
        .description('Create a task space and make it current; returns the space id')
        .argument('<name>', 'Task-space name, e.g. "search github issues"')
        .option('--task <taskId>', 'Optional task id the space belongs to')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (name, opts) => {
        try {
            const manager = await loadSpaceManager();
            const space = await manager.create(LOCAL_SPACE_IDENTITY().agentId, name, opts.task);
            if (opts.json) {
                console.log(JSON.stringify({ space }, null, 2));
                return;
            }
            console.log(space.id);
        }
        catch (err) { printSpaceError(err); }
    });
    spaceCmd.command('list')
        .description('List task spaces owned by the local agent (ID | Name | Status | Tabs | Created)')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (opts) => {
        let cleanup;
        try {
            // bug 1 (D5): read paths carry the browser gateway so tab-group
            // edits (拖入/拖出) reconcile into the ledger before answering.
            // No gateway (browser unreachable) → sync is a no-op (unchanged).
            const gw = await spaceGatewayFromBrowser();
            const gateway = gw?.gateway;
            cleanup = gw?.cleanup;
            const manager = await loadSpaceManager({ gateway });
            const spaces = await manager.listSpaces(LOCAL_SPACE_IDENTITY().agentId);
            if (opts.json) {
                console.log(JSON.stringify({ spaces, count: spaces.length }, null, 2));
                return;
            }
            if (spaces.length === 0) {
                console.log('(no task spaces)');
                return;
            }
            console.log(formatSpaceTable(spaces));
        }
        catch (err) { printSpaceError(err); }
        finally {
            // bug #9: a direct-connect BrowserBridge keeps the event loop alive;
            // tear it down and exit like `space close`/`space refresh`. Daemon
            // mode must never exit (the daemon process stays resident).
            if (isDaemonMode()) return;
            if (cleanup) {
                try { await cleanup(); } catch { /* best-effort */ }
                await flushAndExit(process.exitCode || 0);
            }
        }
    });
    spaceCmd.command('switch')
        .description('Switch the current task space (affects subsequent space.open_tab / tab-group coloring)')
        .argument('<id>', 'Space id')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (id, opts) => {
        let cleanup;
        try {
            // bug 1 (D5): same gateway plumbing as the other read paths so a
            // switch lands on a reconciled ledger (tab-group edits applied).
            const gw = await spaceGatewayFromBrowser();
            const gateway = gw?.gateway;
            cleanup = gw?.cleanup;
            const manager = await loadSpaceManager({ gateway });
            const space = await manager.switch(LOCAL_SPACE_IDENTITY().agentId, id);
            if (opts.json) {
                console.log(JSON.stringify({ switched: id, current: space }, null, 2));
                return;
            }
            console.log(`switched to space ${space.id} ("${space.name}")`);
        }
        catch (err) { printSpaceError(err); }
        finally {
            if (isDaemonMode()) return;
            if (cleanup) {
                try { await cleanup(); } catch { /* best-effort */ }
                await flushAndExit(process.exitCode || 0);
            }
        }
    });
    spaceCmd.command('close')
        .description('Close a task space (closes all its tabs by default; user-held spaces must be claimed first)')
        .argument('<id>', 'Space id')
        .option('--keep', 'Keep the browser tabs open; close only the space ledger', false)
        .option('--json', 'Print a JSON envelope', false)
        .action(async (id, opts) => {
        let cleanup;
        try {
            const gw = opts.keep ? undefined : await spaceGatewayFromBrowser();
            const gateway = gw?.gateway;
            cleanup = gw?.cleanup;
            const manager = await loadSpaceManager({ gateway });
            await manager.closeSpace(LOCAL_SPACE_IDENTITY().agentId, id, { keep: !!opts.keep });
            if (opts.json) {
                console.log(JSON.stringify({ closed: id, keep: !!opts.keep }, null, 2));
                return;
            }
            console.log(`closed space ${id}${opts.keep ? ' (ledger only, tabs kept open)' : ''}`);
        }
        catch (err) { printSpaceError(err); }
        finally {
            // bug #9: a direct-connect BrowserBridge keeps the event loop alive;
            // tear it down and exit like the `browser` commands do. Daemon mode
            // must never exit (the daemon process stays resident).
            if (isDaemonMode()) return;
            if (cleanup) {
                try { await cleanup(); } catch { /* best-effort */ }
                await flushAndExit(process.exitCode || 0);
            }
        }
    });
    spaceCmd.command('refresh')
        .description('Recycle every tab in a task space: close all tabs and reopen each URL in a fresh tab (space id/name/ownership preserved). Use it to refresh a long-running task mid-way, e.g. after a tab wedges (screenshot hint: tab-wedged). Default conservative: never automatic — only run this explicitly.')
        .argument('<id>', 'Space id')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (id, opts) => {
        let cleanup;
        try {
            const gw = await spaceGatewayFromBrowser();
            const gateway = gw?.gateway;
            cleanup = gw?.cleanup;
            const manager = await loadSpaceManager({ gateway });
            const result = await manager.recycleSpaceTabs(LOCAL_SPACE_IDENTITY().agentId, id, gateway);
            if (opts.json) {
                console.log(JSON.stringify({
                    spaceId: id,
                    recycled: result.recycled,
                    tabs: result.tabs,
                    ...(result.failed !== undefined ? { failed: result.failed } : {}),
                }, null, 2));
                return;
            }
            console.log(`recycled ${result.recycled} tab(s) in space ${id}`);
            for (const t of result.tabs ?? []) {
                console.log(`  ${t.url} -> page ${t.newPageId}`);
            }
        }
        catch (err) { printSpaceError(err); }
        finally {
            // bug #9: same direct-connect bridge teardown + exit as space close.
            if (isDaemonMode()) return;
            if (cleanup) {
                try { await cleanup(); } catch { /* best-effort */ }
                await flushAndExit(process.exitCode || 0);
            }
        }
    });
    spaceCmd.command('handoff')
        .description('Hand control of a task space over to the user (agent → agentDelegatedToUser); agent operations then fail with "user is controlling"')
        .argument('<id>', 'Space id')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (id, opts) => {
        try {
            const manager = await loadSpaceManager();
            const space = await manager.handOff(LOCAL_SPACE_IDENTITY().agentId, id);
            if (opts.json) {
                console.log(JSON.stringify({ space }, null, 2));
                return;
            }
            console.log(`handed off space ${space.id} ("${space.name}") to the user`);
        }
        catch (err) { printSpaceError(err); }
    });
    spaceCmd.command('takeover')
        .description('Take control of a task space back from the user (user → agent). The user typing this command IS the confirmation.')
        .argument('<id>', 'Space id')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (id, opts) => {
        try {
            const manager = await loadSpaceManager();
            const space = await manager.takeOver(LOCAL_SPACE_IDENTITY().agentId, id, { confirmed: true });
            if (opts.json) {
                console.log(JSON.stringify({ space }, null, 2));
                return;
            }
            console.log(`agent now controls space ${space.id} ("${space.name}")`);
        }
        catch (err) { printSpaceError(err); }
    });
    spaceCmd.command('current')
        .description('Show the current task space of the local agent')
        .option('--json', 'Print a JSON envelope', false)
        .action(async (opts) => {
        let cleanup;
        try {
            // bug 1 (D5): read path carries the browser gateway so raw
            // tab-group edits (拖入/拖出) reconcile into the ledger before
            // answering — `space current` tabIds stays truthful. No gateway
            // (browser unreachable) → sync is a no-op (unchanged).
            const gw = await spaceGatewayFromBrowser();
            const gateway = gw?.gateway;
            cleanup = gw?.cleanup;
            const manager = await loadSpaceManager({ gateway });
            const space = await manager.currentSpace(LOCAL_SPACE_IDENTITY().agentId);
            if (opts.json) {
                console.log(JSON.stringify({ space: space ?? null }, null, 2));
                return;
            }
            if (!space) {
                console.log('(no current space)');
                return;
            }
            console.log(`${space.id}  "${space.name}" (${space.ownership}) tabs: ${space.tabIds.length}`);
        }
        catch (err) { printSpaceError(err); }
        finally {
            if (isDaemonMode()) return;
            if (cleanup) {
                try { await cleanup(); } catch { /* best-effort */ }
                await flushAndExit(process.exitCode || 0);
            }
        }
    });
    // ── Built-in: completion ──────────────────────────────────────────
    program
        .command('completion')
        .description('Output shell completion script')
        .argument('<shell>', 'Shell type: bash, zsh, or fish')
        .action((shell) => {
        printCompletionScript(shell);
    });
    // ── Plugin management ──────────────────────────────────────────────────────
    const pluginCmd = program.command('plugin').description('Manage hub plugins');
    // Snapshot before applyRootSubcommandSummaries() rewrites .description() to a child-name listing.
    const originalPluginDescription = pluginCmd.description();
    pluginCmd
        .command('install')
        .description('Install a plugin from a git repository')
        .argument('<source>', 'Plugin source (e.g. github:user/repo)')
        .action(async (source) => {
        const { installPlugin } = await import('./plugin.js');
        const { discoverPlugins } = await import('./discovery.js');
        try {
            const result = installPlugin(source);
            await discoverPlugins();
            if (Array.isArray(result)) {
                if (result.length === 0) {
                    console.log('No plugins were installed (all skipped or incompatible).');
                }
                else {
                    console.log(`\u2705 Installed ${result.length} plugin(s) from monorepo: ${result.join(', ')}`);
                }
            }
            else {
                console.log(`\u2705 Plugin "${result}" installed successfully. Commands are ready to use.`);
            }
        }
        catch (err) {
            console.error(`Error: ${getErrorMessage(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    });
    pluginCmd
        .command('uninstall')
        .description('Uninstall a plugin')
        .argument('<name>', 'Plugin name')
        .action(async (name) => {
        const { uninstallPlugin } = await import('./plugin.js');
        try {
            uninstallPlugin(name);
            console.log(`✅ Plugin "${name}" uninstalled.`);
        }
        catch (err) {
            console.error(`Error: ${getErrorMessage(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    });
    pluginCmd
        .command('update')
        .description('Update a plugin (or all plugins) to the latest version')
        .argument('[name]', 'Plugin name (required unless --all is passed)')
        .option('--all', 'Update all installed plugins')
        .action(async (name, opts) => {
        if (!name && !opts.all) {
            console.error('Error: Please specify a plugin name or use the --all flag.');
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        if (name && opts.all) {
            console.error('Error: Cannot specify both a plugin name and --all.');
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const { updatePlugin, updateAllPlugins } = await import('./plugin.js');
        const { discoverPlugins } = await import('./discovery.js');
        if (opts.all) {
            const results = updateAllPlugins();
            if (results.length > 0) {
                await discoverPlugins();
            }
            let hasErrors = false;
            console.log('  Update Results:');
            for (const result of results) {
                if (result.success) {
                    console.log(`  ✓ ${result.name}`);
                    continue;
                }
                hasErrors = true;
                console.log(`  ✗ ${result.name} — ${String(result.error)}`);
            }
            if (results.length === 0) {
                console.log('  No plugins installed.');
                return;
            }
            console.log();
            if (hasErrors) {
                console.error('Completed with some errors.');
                process.exitCode = EXIT_CODES.GENERIC_ERROR;
            }
            else {
                console.log('✅ All plugins updated successfully.');
            }
            return;
        }
        try {
            updatePlugin(name);
            await discoverPlugins();
            console.log(`✅ Plugin "${name}" updated successfully.`);
        }
        catch (err) {
            console.error(`Error: ${getErrorMessage(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    });
    pluginCmd
        .command('list')
        .description('List installed plugins')
        .option('-f, --format <fmt>', 'Output format: table, json', 'table')
        .action(async (opts) => {
        const { listPlugins } = await import('./plugin.js');
        const plugins = listPlugins();
        if (plugins.length === 0) {
            console.log('  No plugins installed.');
            console.log('  Install one with: hub plugin install github:user/repo');
            return;
        }
        if (opts.format === 'json') {
            renderOutput(plugins, {
                fmt: 'json',
                columns: ['name', 'commands', 'source'],
                title: 'hub/plugins',
                source: 'hub plugin list',
            });
            return;
        }
        console.log();
        console.log('  Installed plugins');
        console.log();
        // Group by monorepo
        const standalone = plugins.filter((p) => !p.monorepoName);
        const monoGroups = new Map();
        for (const p of plugins) {
            if (!p.monorepoName)
                continue;
            const g = monoGroups.get(p.monorepoName) ?? [];
            g.push(p);
            monoGroups.set(p.monorepoName, g);
        }
        for (const p of standalone) {
            const version = p.version ? ` @${p.version}` : '';
            const desc = p.description ? ` — ${p.description}` : '';
            const cmds = p.commands.length > 0 ? ` (${p.commands.join(', ')})` : '';
            const src = p.source ? ` ← ${p.source}` : '';
            console.log(`  ${p.name}${version}${desc}${cmds}${src}`);
        }
        for (const [mono, group] of monoGroups) {
            console.log();
            console.log(`  📦 ${mono}` + ' (monorepo)');
            for (const p of group) {
                const version = p.version ? ` @${p.version}` : '';
                const desc = p.description ? ` — ${p.description}` : '';
                const cmds = p.commands.length > 0 ? ` (${p.commands.join(', ')})` : '';
                console.log(`    ${p.name}${version}${desc}${cmds}`);
            }
        }
        console.log();
        console.log(`  ${plugins.length} plugin(s) installed`);
        console.log();
    });
    pluginCmd
        .command('create')
        .description('Create a new plugin scaffold')
        .argument('<name>', 'Plugin name (lowercase, hyphens allowed)')
        .option('-d, --dir <path>', 'Output directory (default: ./<name>)')
        .option('--description <text>', 'Plugin description')
        .action(async (name, opts) => {
        const { createPluginScaffold } = await import('./plugin-scaffold.js');
        try {
            const result = createPluginScaffold(name, {
                dir: opts.dir,
                description: opts.description,
            });
            console.log(`✅ Plugin scaffold created at ${result.dir}`);
            console.log();
            console.log('  Files created:');
            for (const f of result.files) {
                console.log(`    ${f}`);
            }
            console.log();
            console.log('  Next steps:');
            console.log(`    cd ${result.dir}`);
            console.log(`    hub plugin install file://${result.dir}`);
            console.log(`    hub ${name} hello`);
        }
        catch (err) {
            console.error(`Error: ${getErrorMessage(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    });
    // ── Built-in: adapter management ─────────────────────────────────────────
    const adapterCmd = program.command('adapter').description('Manage CLI adapters');
    // Snapshot before applyRootSubcommandSummaries() rewrites .description() to a child-name listing.
    const originalAdapterDescription = adapterCmd.description();
    adapterCmd
        .command('status')
        .description('Show which sites have local overrides vs using official baseline')
        .action(async () => {
        const os = await import('node:os');
        const userClisDir = path.join(hubUserRoot(), 'clis');
        const builtinClisDir = BUILTIN_CLIS;
        try {
            const userEntries = await fs.promises.readdir(userClisDir, { withFileTypes: true });
            const userSites = userEntries.filter(e => e.isDirectory()).map(e => e.name).sort();
            let builtinSites = [];
            try {
                const builtinEntries = await fs.promises.readdir(builtinClisDir, { withFileTypes: true });
                builtinSites = builtinEntries.filter(e => e.isDirectory()).map(e => e.name).sort();
            }
            catch { /* no builtin dir */ }
            if (userSites.length === 0) {
                console.log('No local adapter overrides. All sites use the official baseline.');
                return;
            }
            console.log(`Local overrides in ~/.hub/clis/ (${userSites.length} sites):\n`);
            for (const site of userSites) {
                const isOfficial = builtinSites.includes(site);
                const label = isOfficial ? 'override' : 'custom';
                console.log(`  ${site} [${label}]`);
            }
            console.log(`\nOfficial baseline: ${builtinSites.length} sites in package`);
        }
        catch {
            console.log('No local adapter overrides. All sites use the official baseline.');
        }
    });
    adapterCmd
        .command('eject')
        .description('Copy an official adapter to ~/.hub/clis/ for local editing')
        .argument('<site>', 'Site name (e.g. twitter, bilibili)')
        .action(async (site) => {
        const os = await import('node:os');
        const userClisDir = path.join(hubUserRoot(), 'clis');
        const builtinSiteDir = path.join(BUILTIN_CLIS, site);
        const userSiteDir = path.join(userClisDir, site);
        try {
            await fs.promises.access(builtinSiteDir);
        }
        catch {
            console.error(`Error: Site "${site}" not found in official adapters.`);
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        try {
            await fs.promises.access(userSiteDir);
            console.error(`Site "${site}" already exists in ~/.hub/clis/. Use "hub adapter reset ${site}" first to restore official version.`);
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        catch { /* good, doesn't exist yet */ }
        fs.cpSync(builtinSiteDir, userSiteDir, { recursive: true });
        console.log(`✅ Ejected "${site}" to ~/.hub/clis/${site}/`);
        console.log('You can now edit the adapter files. Changes take effect immediately.');
        console.log('Note: Official updates to this adapter will overwrite your changes.');
    });
    adapterCmd
        .command('reset')
        .description('Remove local override and restore official adapter version')
        .argument('[site]', 'Site name (e.g. twitter, bilibili)')
        .option('--all', 'Reset all local overrides')
        .action(async (site, opts) => {
        const os = await import('node:os');
        const userClisDir = path.join(hubUserRoot(), 'clis');
        if (opts.all) {
            try {
                const userEntries = await fs.promises.readdir(userClisDir, { withFileTypes: true });
                const dirs = userEntries.filter(e => e.isDirectory());
                if (dirs.length === 0) {
                    console.log('No local sites to reset.');
                    return;
                }
                for (const dir of dirs) {
                    fs.rmSync(path.join(userClisDir, dir.name), { recursive: true, force: true });
                }
                console.log(`✅ Reset ${dirs.length} site(s). All adapters now use official baseline.`);
            }
            catch {
                console.log('No local sites to reset.');
            }
            return;
        }
        if (!site) {
            console.error('Error: Please specify a site name or use --all.');
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        const userSiteDir = path.join(userClisDir, site);
        try {
            await fs.promises.access(userSiteDir);
        }
        catch {
            console.error(`Site "${site}" has no local override.`);
            return;
        }
        const isOfficial = fs.existsSync(path.join(BUILTIN_CLIS, site));
        fs.rmSync(userSiteDir, { recursive: true, force: true });
        console.log(isOfficial
            ? `✅ Reset "${site}". Now using official baseline.`
            : `✅ Removed custom site "${site}".`);
    });
    // ── External CLIs ─────────────────────────────────────────────────────────
    const externalClis = loadExternalClis();
    const externalCmd = program
        .command('external')
        .description('Manage external CLI passthrough commands');
    externalCmd
        .command('install')
        .description('Install an external CLI')
        .argument('<name>', 'Name of the external CLI')
        .action((name) => {
        const ext = externalClis.find(e => e.name === name);
        if (!ext) {
            console.error(`External CLI '${name}' not found in registry.`);
            process.exitCode = EXIT_CODES.USAGE_ERROR;
            return;
        }
        installExternalCli(ext);
    });
    externalCmd
        .command('register')
        .description('Register an external CLI')
        .argument('<name>', 'Name of the CLI')
        .option('--binary <bin>', 'Binary name if different from name')
        .option('--install <cmd>', 'Auto-install command')
        .option('--desc <text>', 'Description')
        .action((name, opts) => {
        registerExternalCli(name, { binary: opts.binary, install: opts.install, description: opts.desc });
    });
    externalCmd
        .command('list')
        .description('List registered external CLIs')
        .option('-f, --format <fmt>', 'Output format: table, json, yaml, md, csv', 'table')
        .action((opts) => {
        const rows = loadExternalClis().map((ext) => ({
            name: ext.name,
            package: ext.package ?? '',
            binary: ext.binary,
            installed: isBinaryInstalled(ext.binary),
            description: ext.description ?? '',
            homepage: ext.homepage ?? '',
            tags: ext.tags?.join(', ') ?? '',
        }));
        renderOutput(rows, {
            fmt: opts.format,
            columns: ['name', 'package', 'binary', 'installed', 'description', 'homepage', 'tags'],
            title: 'hub/external/list',
            source: 'hub external list',
        });
    });
    function passthroughExternal(name, parsedArgs) {
        const args = parsedArgs ?? (() => {
            const idx = process.argv.indexOf(name);
            return process.argv.slice(idx + 1);
        })();
        try {
            executeExternalCli(name, args, externalClis);
        }
        catch (err) {
            console.error(`Error: ${getErrorMessage(err)}`);
            process.exitCode = EXIT_CODES.GENERIC_ERROR;
        }
    }
    for (const ext of externalClis) {
        if (program.commands.some(c => c.name() === ext.name))
            continue;
        program
            .command(ext.name)
            .description(`(External) ${ext.description || ext.name}`)
            .argument('[args...]')
            .allowUnknownOption()
            .passThroughOptions()
            .helpOption(false)
            .action((args) => passthroughExternal(ext.name, args));
    }
    // ── Antigravity serve (long-running, special case) ────────────────────────
    const antigravityCmd = program.command('antigravity').description('antigravity commands');
    antigravityCmd
        .command('serve')
        .description('Start Anthropic-compatible API proxy for Antigravity')
        .option('--port <port>', 'Server port (default: 8082)', '8082')
        .option('--timeout <seconds>', 'Maximum time to wait for a reply (default: 120s)')
        .action(async (opts) => {
        // @ts-expect-error JS adapter — no type declarations
        const { startServe } = await import('../../clis/antigravity/serve.js');
        await startServe({
            port: parseInt(opts.port, 10),
            timeout: opts.timeout ? parsePositiveIntOption(opts.timeout, '--timeout', 120) : undefined,
        });
    });
    // ── Dynamic adapter commands ──────────────────────────────────────────────
    const siteGroups = new Map();
    siteGroups.set('antigravity', antigravityCmd);
    const siteNames = registerAllCommands(program, siteGroups);
    applyRootSubcommandSummaries(program);
    // ── Help-text grouping: External CLIs / App adapters / Site adapters ──
    // Classification derives from each adapter's `domain` field — see classifyAdapter.
    // External CLIs are taken from the externalClis registry (passthrough binaries).
    const externalNames = externalClis.map(ext => ext.name);
    const externalHelpEntries = externalClis.map(ext => ({
        name: ext.name,
        label: formatExternalCliLabel(ext),
    }));
    const siteDomains = new Map();
    for (const [, cmd] of getRegistry()) {
        if (!siteDomains.has(cmd.site))
            siteDomains.set(cmd.site, cmd.domain);
    }
    const apps = [];
    const sites = [];
    for (const site of siteNames) {
        if (classifyAdapter(siteDomains.get(site)) === 'app')
            apps.push(site);
        else
            sites.push(site);
    }
    const adapterGroups = { external: externalHelpEntries, apps, sites };
    const adapterNameSet = new Set([...externalNames, ...siteNames]);
    installCommanderNamespaceStructuredHelp(browser, { globalCommand: program, description: originalBrowserDescription });
    installCommanderNamespaceStructuredHelp(authCmd, { globalCommand: program, description: 'Inspect website login status' });
    installCommanderNamespaceStructuredHelp(pluginCmd, { globalCommand: program, description: originalPluginDescription });
    installCommanderNamespaceStructuredHelp(adapterCmd, { globalCommand: program, description: originalAdapterDescription });
    program.configureHelp({
        visibleCommands: (command) => command.commands.filter(child => command !== program || !adapterNameSet.has(child.name())),
    });
    // When an ancestor command declares a leading positional via `.usage(...)`
    // (e.g. `browser` -> `<session> <command> [options]`), inject the positional
    // between that ancestor's name and the next path segment so the help Usage
    // line is accurate: `Usage: hub browser <session> click [target] [options]`
    // instead of `hub browser click [target] [options]`. Commander does NOT
    // inherit configureHelp into subcommands, so we walk the descendant tree and
    // apply the override on each.
    const ancestorAwareCommandUsage = (cmd) => {
        const ancestors = [];
        let ancestor = cmd.parent;
        while (ancestor) {
            const positional = leadingPositionalFromUsage(ancestor);
            ancestors.unshift(positional ? `${ancestor.name()} ${positional}` : ancestor.name());
            ancestor = ancestor.parent;
        }
        return [...ancestors, cmd.name(), cmd.usage()].filter(Boolean).join(' ').trim();
    };
    function applyAncestorAwareUsage(cmd) {
        cmd.configureHelp({ commandUsage: ancestorAwareCommandUsage });
        for (const sub of cmd.commands)
            applyAncestorAwareUsage(sub);
    }
    applyAncestorAwareUsage(browser);
    installStructuredHelp(program, () => rootHelpData(program, adapterGroups), () => formatRootAdapterHelpText(adapterGroups));
    // ── Unknown command fallback ──────────────────────────────────────────────
    // Security: do NOT auto-discover and register arbitrary system binaries.
    // Only explicitly registered external CLIs are allowed.
    program.on('command:*', (operands) => {
        const binary = operands[0];
        console.error(`error: unknown command '${binary}'`);
        if (isBinaryInstalled(binary)) {
            console.error(`  Tip: '${binary}' exists on your PATH. Use 'hub external register ${binary}' to add it as an external CLI.`);
        }
        program.outputHelp();
        process.exitCode = EXIT_CODES.USAGE_ERROR;
    });
    return program;
}
export function runCli(BUILTIN_CLIS, USER_CLIS) {
    createProgram(BUILTIN_CLIS, USER_CLIS).parse();
}
export { findPackageRoot };
export function resolveBrowserVerifyInvocation(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const fileExists = opts.fileExists ?? fs.existsSync;
    const readFile = opts.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf-8'));
    const projectRoot = opts.projectRoot ?? findPackageRoot(CLI_FILE, fileExists);
    for (const builtEntry of getBuiltEntryCandidates(projectRoot, readFile)) {
        if (fileExists(builtEntry)) {
            return {
                binary: process.execPath,
                args: [builtEntry],
                cwd: projectRoot,
            };
        }
    }
    const sourceEntry = path.join(projectRoot, 'src', 'main.ts');
    if (!fileExists(sourceEntry)) {
        throw new Error(`Could not find hub entrypoint under ${projectRoot}. Expected built entry from package.json or src/main.ts.`);
    }
    const localTsxBin = path.join(projectRoot, 'node_modules', '.bin', platform === 'win32' ? 'tsx.cmd' : 'tsx');
    if (fileExists(localTsxBin)) {
        return {
            binary: localTsxBin,
            args: [sourceEntry],
            cwd: projectRoot,
            ...(platform === 'win32' ? { shell: true } : {}),
        };
    }
    return {
        binary: platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['tsx', sourceEntry],
        cwd: projectRoot,
        ...(platform === 'win32' ? { shell: true } : {}),
    };
}
