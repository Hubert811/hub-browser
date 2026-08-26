/**
 * Command execution: validates args, manages browser sessions, runs commands.
 *
 * This is the single entry point for executing any CLI command. It handles:
 * 1. Argument validation and coercion
 * 2. Browser session lifecycle (if needed)
 * 3. Domain pre-navigation for cookie strategies
 * 4. Timeout enforcement
 * 5. Lazy-loading of TS modules from manifest
 * 6. Lifecycle hooks (onBeforeExecute / onAfterExecute)
 */
import { getRegistry, fullName, } from './registry.js';
import { pathToFileURL } from 'node:url';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { executePipeline } from './pipeline/index.js';
import { adapterLoadError, ArgumentError, CommandExecutionError, attachTraceReceipt, getErrorMessage } from './errors.js';
import { shouldUseBrowserSession } from './capabilityRouting.js';
import { getBrowserFactory, browserSession, runWithTimeout, DEFAULT_BROWSER_COMMAND_TIMEOUT } from './runtime.js';
import { emitHook } from './hooks.js';
import { log } from './logger.js';
import { isElectronApp } from './electron-apps.js';
import { probeCDP, resolveElectronEndpoint } from './launcher.js';
import { ObservationSession, exportObservationSession } from './observation/index.js';
import { resolveAdapterSourcePath } from './adapter-source.js';
import { hubUserRoot } from './discovery.js';
const _loadedModules = new Map();
/** Track mtime of loaded user adapter files for hot-reload. */
const _moduleMtimes = new Map();
const _userClisDir = `${hubUserRoot()}/clis/`;
function normalizeTraceMode(raw) {
    if (raw === undefined || raw === null || raw === '' || raw === 'off')
        return 'off';
    if (raw === 'on' || raw === 'retain-on-failure')
        return raw;
    throw new ArgumentError(`--trace must be one of: off, on, retain-on-failure. Received: "${String(raw)}"`);
}
export function coerceAndValidateArgs(cmdArgs, kwargs) {
    const result = { ...kwargs };
    for (const argDef of cmdArgs) {
        const val = result[argDef.name];
        if (argDef.required && (val === undefined || val === null || val === '')) {
            throw new ArgumentError(`Argument "${argDef.name}" is required.`, argDef.help ?? `Provide a value for --${argDef.name}`);
        }
        if (val !== undefined && val !== null) {
            if (argDef.type === 'int' || argDef.type === 'number') {
                const num = Number(val);
                if (Number.isNaN(num)) {
                    throw new ArgumentError(`Argument "${argDef.name}" must be a valid number. Received: "${val}"`);
                }
                result[argDef.name] = num;
            }
            else if (argDef.type === 'boolean' || argDef.type === 'bool') {
                if (typeof val === 'string') {
                    const lower = val.toLowerCase();
                    if (lower === 'true' || lower === '1')
                        result[argDef.name] = true;
                    else if (lower === 'false' || lower === '0')
                        result[argDef.name] = false;
                    else
                        throw new ArgumentError(`Argument "${argDef.name}" must be a boolean (true/false). Received: "${val}"`);
                }
                else {
                    result[argDef.name] = Boolean(val);
                }
            }
            const coercedVal = result[argDef.name];
            if (argDef.choices && argDef.choices.length > 0) {
                if (!argDef.choices.map(String).includes(String(coercedVal))) {
                    throw new ArgumentError(`Argument "${argDef.name}" must be one of: ${argDef.choices.join(', ')}. Received: "${coercedVal}"`);
                }
            }
        }
        else if (argDef.default !== undefined) {
            result[argDef.name] = argDef.default;
        }
    }
    return result;
}
async function runCommand(cmd, page, kwargs, debug) {
    const internal = cmd;
    if (internal._lazy && internal._modulePath) {
        const modulePath = internal._modulePath;
        // Hot-reload: if a user adapter's file has changed on disk, invalidate cache
        const isUserAdapter = modulePath.startsWith(_userClisDir);
        if (isUserAdapter && _loadedModules.has(modulePath)) {
            try {
                const stat = fs.statSync(modulePath);
                const prevMtime = _moduleMtimes.get(modulePath);
                if (prevMtime !== undefined && stat.mtimeMs !== prevMtime) {
                    _loadedModules.delete(modulePath);
                    _moduleMtimes.delete(modulePath);
                }
            }
            catch { /* file may have been deleted; let import below handle it */ }
        }
        if (!_loadedModules.has(modulePath)) {
            const url = pathToFileURL(modulePath).href;
            const importUrl = _moduleMtimes.has(modulePath) ? `${url}?t=${Date.now()}` : url;
            const loadPromise = import(importUrl).then(() => {
                try {
                    _moduleMtimes.set(modulePath, fs.statSync(modulePath).mtimeMs);
                }
                catch { }
            }, (err) => {
                _loadedModules.delete(modulePath);
                throw adapterLoadError(`Failed to load adapter module ${modulePath}: ${getErrorMessage(err)}`, 'Check that the adapter file exists and has no syntax errors.');
            });
            _loadedModules.set(modulePath, loadPromise);
        }
        await _loadedModules.get(modulePath);
        const updated = getRegistry().get(fullName(cmd));
        if (updated?.func) {
            return runCommandFunc(updated, page, kwargs, debug);
        }
        if (updated?.pipeline)
            return executePipeline(page, updated.pipeline, { args: kwargs, debug });
    }
    if (cmd.func)
        return runCommandFunc(cmd, page, kwargs, debug);
    if (cmd.pipeline)
        return executePipeline(page, cmd.pipeline, { args: kwargs, debug });
    throw new CommandExecutionError(`Command ${fullName(cmd)} has no func or pipeline`, 'This is likely a bug in the adapter definition. Please report this issue.');
}
function runCommandFunc(cmd, page, kwargs, debug) {
    if (cmd.browser === false)
        return cmd.func(kwargs, debug);
    if (!page) {
        throw new CommandExecutionError(`Command ${fullName(cmd)} requires a browser session but none was provided`);
    }
    return cmd.func(page, kwargs, debug);
}
function resolvePreNav(cmd) {
    if (cmd.navigateBefore === false)
        return null;
    if (typeof cmd.navigateBefore === 'string')
        return cmd.navigateBefore;
    // strategy → navigateBefore expansion already happened in normalizeCommand().
    return null;
}
function urlMatchesDomain(url, domain) {
    if (!url || !domain)
        return false;
    try {
        const hostname = new URL(url).hostname;
        return hostname === domain || hostname.endsWith(`.${domain}`);
    }
    catch {
        return false;
    }
}
function isDomainRootPreNav(preNavUrl, domain) {
    if (!domain)
        return false;
    try {
        const parsed = new URL(preNavUrl);
        const hostnameMatches = parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
        const rootPath = parsed.pathname === '' || parsed.pathname === '/';
        return hostnameMatches && rootPath && parsed.search === '' && parsed.hash === '';
    }
    catch {
        return false;
    }
}
async function shouldRunPreNav(cmd, page, siteSession, preNavUrl) {
    if (siteSession !== 'persistent' || !cmd.domain)
        return true;
    if (!isDomainRootPreNav(preNavUrl, cmd.domain))
        return true;
    const currentUrl = await page.getCurrentUrl?.().catch(() => null);
    return !urlMatchesDomain(currentUrl, cmd.domain);
}

// ── Space binding for adapter commands (修复 3: bug #1/#2/#6) ──────────────
//
// Adapter commands (`hub <site> <command>`) used to run against the shared
// browser's *active tab* with no space attribution:
//   - bug #1: they could navigate another agent's space tab (no ownership);
//   - bug #2: tabs they opened had no owner, so `space close` could not clean
//     them up (residual tabs);
//   - bug #6: their tab was invisible/not operable for the owning agent's
//     space/MCP tools.
// The binding below routes the command onto a tab attributed to the local
// agent's current space via TaskSpaceManager.openTabWithReuse — the same
// path `browser <session> open` uses.
//
// D3 (2026-08-03): space is a HARD precondition. When the agent owns no space
// the command is rejected with a SpaceGuardError('no-space') and never runs
// (no legacy active-tab fallback). Only non-precondition failures (manager
// load / gateway / openTab) keep the best-effort fallback to the original
// page so a flaky browser never crashes the CLI.

/** Current pageId of a unified page handle (`session` = "page-<id>"), else undefined. */
function pageIdOf(page) {
    if (page && typeof page.session === 'string' && /^page-\d+$/.test(page.session)) {
        return Number(page.session.slice('page-'.length));
    }
    return undefined;
}

/**
 * Best-effort DNS-domain check for adapter `cmd.domain` values. Rejects
 * values that are already full URLs, contain whitespace or host-illegal
 * characters (e.g. the comma-separated multi-domain edge case), or have no
 * dot (localhost / local app slugs) — those fall through to the current-URL
 * fallback instead of producing an invalid `https://…` target.
 */
function isDnsDomainName(domain) {
    if (typeof domain !== 'string' || !domain)
        return false;
    const d = domain.trim();
    if (!d || /\s/.test(d))
        return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(d))
        return false;
    if (/[^a-z0-9.\u00a1-\uffff-]/i.test(d))
        return false;
    const host = d.split('/')[0].split(':')[0];
    return host.includes('.') && host.length > 1 && !host.startsWith('.') && !host.endsWith('.');
}

/**
 * Resolve the URL an adapter command should be bound to inside the current
 * space. Priority (best-effort; null → caller skips space binding):
 *   1. cmd.navigateBefore (a concrete URL string after strategy expansion)
 *   2. `https://<cmd.domain>` when the domain is a real DNS domain
 *   3. the page's current URL
 */
async function resolveSpaceTargetUrl(cmd, page) {
    const preNavUrl = resolvePreNav(cmd);
    if (preNavUrl)
        return preNavUrl;
    if (isDnsDomainName(cmd.domain))
        return `https://${cmd.domain}`;
    try {
        const currentUrl = await page?.getCurrentUrl?.();
        if (typeof currentUrl === 'string' && currentUrl)
            return currentUrl;
    }
    catch { /* best-effort */ }
    return null;
}

/**
 * 修复 3 + D3 — bind an adapter command to the local agent's current space.
 *
 * When the agent has a current space, the command's target URL is opened (or
 * reused) inside the space through TaskSpaceManager.openTabWithReuse and the
 * returned page handle is used for the adapter logic.
 *
 * D3 (2026-08-03): when the agent owns NO space this throws a
 * SpaceGuardError('no-space') — the command must not run (callers surface the
 * error with a non-zero exit). The catch block distinguishes the explicit
 * no-space rejection (rethrow) from genuine infrastructure failures (manager
 * load / gateway / openTab) which keep the best-effort fallback to the
 * original page.
 *
 * `manager` / `storagePath` are injectable for tests; production callers pass
 * neither (the manager is created from HUB_SPACES_FILE or the default ledger
 * path — same rule cli.js uses).
 *
 * @returns {{ page: object, space?: object, bound: boolean }}
 *   page  — page handle to run the adapter command on (equals the input page
 *           on infra-failure fallback paths; may be a fresh handle bound to
 *           the space tab when the resolved pageId differs from the input page)
 *   space — current SpaceInfo when one was found (undefined otherwise)
 *   bound — true when the command was routed onto a space-attributed tab
 * @throws {SpaceGuardError} code 'no-space' when the agent owns no space.
 */
export async function bindAdapterPageToSpace({ page, browser, cdpEndpoint, cmd, agentId, storagePath, manager }) {
    try {
        const { TaskSpaceManager, SpaceGuardError, gatewayFromPage, defaultStoragePath } = await import('../space/task-space-manager.ts');
        const gateway = gatewayFromPage(page);
        const mgr = manager ?? new TaskSpaceManager({
            storagePath: storagePath ?? (process.env.HUB_SPACES_FILE || defaultStoragePath()),
            gateway,
        });
        const space = await mgr.currentSpace(agentId);
        if (!space) {
            // D3: space is a hard precondition for adapter commands. Reject
            // instead of falling back to the legacy active tab.
            throw new SpaceGuardError(
                'no-space',
                `agent has no space; run 'hub space create <name>' first`,
                { hint: 'create a task space first, then re-run the adapter command' },
            );
        }
        const targetUrl = await resolveSpaceTargetUrl(cmd, page);
        if (targetUrl === null)
            return { page, space, bound: false, pageId: undefined, manager: mgr, agentId };
        const { pageId } = await mgr.openTabWithReuse(
            agentId,
            space.id,
            targetUrl,
            { background: false, reuse: 'exact' },
            gateway,
        );
        // The page handle normally already follows the gateway's newTab /
        // selectTab (UnifiedPage self-rebinds). When the resolved pageId
        // differs (e.g. a gateway that resolves page ids via listTabs, or a
        // failed activation), bind a fresh handle to the space tab. Reusing
        // the same browser instance keeps the underlying CDP session
        // untouched — no second connection in daemon or direct mode.
        if (typeof pageId === 'number' && pageId !== pageIdOf(page)) {
            const boundPage = await browser.connect({ pageId, cdpEndpoint });
            return { page: boundPage, space, bound: true, pageId, manager: mgr, agentId };
        }
        return { page, space, bound: true, pageId, manager: mgr, agentId };
    }
    catch (err) {
        // D3: an explicit "no space" is a hard precondition — never fall back.
        // Only infrastructure failures (manager load / gateway / openTab) keep
        // the best-effort fallback to the original page.
        if (isNoSpaceGuardError(err)) throw err;
        log.warn(`[space] adapter command space-bind failed for ${fullName(cmd)}, falling back to legacy active-tab behavior: ${getErrorMessage(err)}`);
        return { page, space: undefined, bound: false, pageId: undefined, manager: undefined, agentId };
    }
}

/**
 * D3 marker: SpaceGuardError with code 'no-space'. Structural check (name +
 * code) so it works even when the caught value comes from another copy of the
 * task-space-manager module.
 */
function isNoSpaceGuardError(err) {
    return err instanceof Error && err.name === 'SpaceGuardError' && err.code === 'no-space';
}

/**
 * Read the (possibly rebound) page handle's current URL, best-effort — same
 * source as collectObservationEvidence (authoritative getCurrentUrl
 * round-trip first, active-page object fallback for page handles that carry
 * a url field directly). Never throws.
 */
async function readBoundPageUrl(page) {
    try {
        const url = await page?.getCurrentUrl?.().catch(() => null);
        if (typeof url === 'string' && url)
            return url;
        const active = page?.getActivePage?.();
        if (active && typeof active === 'object' && typeof active.url === 'string' && active.url)
            return active.url;
    }
    catch { /* best-effort */ }
    return null;
}

/**
 * bug #7 — after an adapter command navigated a space-bound tab, sync the
 * ledger URL to what the browser actually shows (TaskSpaceManager
 * .updateTabUrl). Strictly best-effort: no binding / unreadable URL → no-op
 * returning false; manager failure → log.warn and swallow. Never throws and
 * never touches the ledger when the command did not run inside a space.
 */
export async function syncBoundTabUrl(binding, page) {
    if (!binding || binding.bound !== true || !binding.space ||
        typeof binding.pageId !== 'number' || !binding.manager) {
        return false;
    }
    const pageUrl = await readBoundPageUrl(page);
    if (!pageUrl)
        return false;
    try {
        return await binding.manager.updateTabUrl(
            binding.agentId,
            binding.space.id,
            binding.pageId,
            pageUrl,
        );
    }
    catch (err) {
        log.warn(`[space] ledger URL sync failed after adapter navigation (space ${binding.space.id}, page ${binding.pageId}): ${getErrorMessage(err)}`);
        return false;
    }
}

export async function executeCommand(cmd, rawKwargs, debug = false, opts = {}) {
    let kwargs;
    try {
        kwargs = opts.prepared ? rawKwargs : prepareCommandArgs(cmd, rawKwargs);
    }
    catch (err) {
        if (err instanceof ArgumentError)
            throw err;
        throw new ArgumentError(getErrorMessage(err));
    }
    const userTimeoutSec = readUserTimeoutSeconds(cmd, kwargs);
    const traceMode = normalizeTraceMode(opts.trace);
    const hookCtx = {
        command: fullName(cmd),
        args: kwargs,
        startedAt: Date.now(),
    };
    await emitHook('onBeforeExecute', hookCtx);
    let result;
    try {
        if (shouldUseBrowserSession(cmd)) {
            const electron = isElectronApp(cmd.site);
            let cdpEndpoint;
            if (electron) {
                // Electron apps: respect manual endpoint override, then try auto-detect
                const manualEndpoint = process.env.OPENCLI_CDP_ENDPOINT;
                if (manualEndpoint) {
                    const port = Number(new URL(manualEndpoint).port);
                    if (!await probeCDP(port)) {
                        throw new CommandExecutionError(`CDP not reachable at ${manualEndpoint}`, 'Check that the app is running with --remote-debugging-port and the endpoint is correct.');
                    }
                    cdpEndpoint = manualEndpoint;
                }
                else {
                    cdpEndpoint = await resolveElectronEndpoint(cmd.site);
                }
            }
            const BrowserFactory = getBrowserFactory(cmd.site);
            const internal = cmd;
            const siteSession = resolveSiteSession(cmd, opts.siteSession);
            const session = resolveAdapterBrowserSession(cmd, siteSession);
            const keepTab = resolveKeepTab(siteSession, opts.keepTab);
            const windowMode = resolveBrowserWindowMode(cmd.defaultWindowMode ?? 'background', opts.windowMode);
            result = await browserSession(BrowserFactory, async (page, browser) => {
                // 修复 3 + D3: bind the adapter command onto the local agent's
                // current space tab. D3: when the agent owns no space this
                // throws SpaceGuardError('no-space') and the command is
                // rejected (exit non-zero) — no legacy active-tab fallback.
                // Other failures keep the best-effort original-page fallback.
                // Must happen before any navigation / command execution.
                // The binding result is kept for the bug #7 URL sync below.
                // P2-7 (adapter.run MCP face): opts.agentId lets a
                // long-lived caller (the MCP server process) pass the
                // per-caller ownership key explicitly. The env fallback keeps
                // the CLI/daemon behavior byte-identical (HUB_AGENT_ID is
                // per-process there, so env is correct for them but would
                // collapse identities in a shared MCP process).
                const agentId = opts.agentId ?? (process.env.HUB_AGENT_ID || 'cli:local');
                const binding = await bindAdapterPageToSpace({
                    page,
                    browser,
                    cdpEndpoint,
                    cmd,
                    agentId,
                });
                page = binding.page;
                const observation = traceMode === 'off'
                    ? null
                    : new ObservationSession({
                        scope: {
                            session,
                            target: page.getActivePage?.(),
                            site: cmd.site,
                            command: fullName(cmd),
                            adapterSourcePath: resolveAdapterSourcePath(internal),
                        },
                    });
                if (observation) {
                    observation.record({
                        stream: 'action',
                        name: 'command',
                        phase: 'start',
                        data: { args: kwargs },
                    });
                    await page.startNetworkCapture?.().catch(() => false);
                }
                const preNavUrl = resolvePreNav(cmd);
                if (preNavUrl && await shouldRunPreNav(cmd, page, siteSession, preNavUrl)) {
                    observation?.record({
                        stream: 'action',
                        name: 'pre_navigate',
                        phase: 'start',
                        data: { url: preNavUrl },
                    });
                    // Navigate directly — the extension's handleNavigate already has a fast-path
                    // that skips navigation if the tab is already at the target URL.
                    // This avoids an extra exec round-trip (getCurrentUrl) on first command and
                    // lets the extension create the automation window with the target URL directly
                    // instead of about:blank.
                    try {
                        await page.goto(preNavUrl);
                        observation?.record({
                            stream: 'action',
                            name: 'pre_navigate',
                            phase: 'end',
                            data: { url: preNavUrl },
                        });
                    }
                    catch (err) {
                        observation?.record({
                            stream: 'action',
                            name: 'pre_navigate',
                            phase: 'error',
                            data: { url: preNavUrl, error: err instanceof Error ? err.message : String(err) },
                        });
                        const wrapped = new CommandExecutionError(`Pre-navigation to ${preNavUrl} failed: ${err instanceof Error ? err.message : err}`, 'Check that the site is reachable and the browser extension is running.');
                        if (observation && (traceMode === 'on' || traceMode === 'retain-on-failure')) {
                            observation.record({
                                stream: 'error',
                                message: wrapped.message,
                                stack: wrapped.stack,
                                code: wrapped.code,
                                hint: wrapped.hint,
                            });
                            await collectObservationEvidence(observation, page).catch(() => { });
                            exportTraceArtifact(observation, 'failure', wrapped, opts.onTraceExport);
                        }
                        throw wrapped;
                    }
                }
                try {
                    const browserTimeout = userTimeoutSec !== null
                        ? userTimeoutSec + RUNTIME_TIMEOUT_PADDING_SECONDS
                        : DEFAULT_BROWSER_COMMAND_TIMEOUT;
                    const result = await runWithTimeout(runCommand(cmd, page, kwargs, debug), {
                        timeout: browserTimeout,
                        label: fullName(cmd),
                    });
                    observation?.record({
                        stream: 'action',
                        name: 'command',
                        phase: 'end',
                    });
                    if (observation && traceMode === 'on') {
                        await collectObservationEvidence(observation, page).catch(() => { });
                        exportTraceArtifact(observation, 'success', undefined, opts.onTraceExport);
                    }
                    // bug #7: the adapter command may have navigated the bound
                    // space tab — sync the ledger URL to the browser's actual
                    // URL (best-effort, only when this command ran inside a
                    // space; failure only warns and never affects the result).
                    await syncBoundTabUrl(binding, page).catch(() => { });
                    // Adapter commands are one-shot — release the current tab lease immediately
                    // instead of waiting for the 30s idle timeout. The automation container
                    // window stays open for reuse.
                    if (!keepTab)
                        await page.closeWindow?.().catch(() => { });
                    return result;
                }
                catch (err) {
                    if (observation) {
                        observation.record({
                            stream: 'action',
                            name: 'command',
                            phase: 'error',
                            data: { error: err instanceof Error ? err.message : String(err) },
                        });
                        observation.record({
                            stream: 'error',
                            message: err instanceof Error ? err.message : String(err),
                            stack: err instanceof Error ? err.stack : undefined,
                        });
                        if (traceMode === 'on' || traceMode === 'retain-on-failure') {
                            await collectObservationEvidence(observation, page).catch(() => { });
                            exportTraceArtifact(observation, 'failure', err, opts.onTraceExport);
                        }
                    }
                    // bug #7 (catch path): even when the adapter command FAILED
                    // it may already have navigated the bound space tab — sync
                    // the ledger URL to the browser's actual URL so exact-reuse
                    // matching sees the true URL instead of the stale ledger
                    // value (which caused duplicate tabs on a retry). Strictly
                    // best-effort: syncBoundTabUrl never throws (failure only
                    // warns), and must never mask the original error — the
                    // .catch below is belt-and-braces only.
                    await syncBoundTabUrl(binding, page).catch(() => { });
                    // Release the tab lease on failure too — without this, the lease lingers
                    // until the extension's idle timer fires (unreliable on Windows where
                    // MV3 service workers may be suspended before setTimeout triggers).
                    if (!keepTab)
                        await page.closeWindow?.().catch(() => { });
                    throw err;
                }
            }, { session, cdpEndpoint, windowMode, surface: 'adapter', siteSession });
        }
        else {
            // Non-browser commands: enforce a timeout only when the command exposes
            // a `--timeout` arg (and the resolved value is positive). Without that
            // arg there is no meaningful default — non-browser cmds are diverse
            // enough that a hard cap would do more harm than good.
            if (userTimeoutSec !== null) {
                const ceiling = userTimeoutSec + RUNTIME_TIMEOUT_PADDING_SECONDS;
                result = await runWithTimeout(runCommand(cmd, null, kwargs, debug), {
                    timeout: ceiling,
                    label: fullName(cmd),
                    hint: `Pass a higher --timeout value (currently ${userTimeoutSec}s)`,
                });
            }
            else {
                result = await runCommand(cmd, null, kwargs, debug);
            }
        }
    }
    catch (err) {
        hookCtx.error = err;
        hookCtx.finishedAt = Date.now();
        await emitHook('onAfterExecute', hookCtx);
        throw err;
    }
    hookCtx.finishedAt = Date.now();
    await emitHook('onAfterExecute', hookCtx, result);
    return result;
}
async function collectObservationEvidence(session, page) {
    const target = page.getActivePage?.() ?? session.scope.target;
    const [url, snapshot, networkEntries, consoleMessages, screenshot] = await Promise.all([
        page.getCurrentUrl?.().catch(() => null) ?? Promise.resolve(null),
        page.snapshot().catch(() => undefined),
        page.readNetworkCapture?.().catch(() => []) ?? Promise.resolve([]),
        page.consoleMessages('all').catch(() => []),
        page.screenshot({ format: 'png' }).catch(() => undefined),
    ]);
    if (snapshot !== undefined || url !== undefined) {
        session.record({ stream: 'state', url, target, snapshot, label: 'final' });
    }
    for (const entry of Array.isArray(networkEntries) ? networkEntries : []) {
        const record = entry;
        session.record({
            stream: 'network',
            url: String(record.url ?? ''),
            method: typeof record.method === 'string' ? record.method : undefined,
            status: typeof record.responseStatus === 'number' ? record.responseStatus : undefined,
            contentType: typeof record.responseContentType === 'string' ? record.responseContentType : undefined,
            size: typeof record.responseBodyFullSize === 'number' ? record.responseBodyFullSize : undefined,
            requestHeaders: record.requestHeaders,
            responseHeaders: record.responseHeaders,
            requestBody: record.requestBodyPreview,
            responseBody: record.responsePreview,
            ts: typeof record.timestamp === 'number' ? record.timestamp : undefined,
        });
    }
    for (const message of Array.isArray(consoleMessages) ? consoleMessages : []) {
        if (message && typeof message === 'object') {
            const record = message;
            session.record({
                stream: 'console',
                level: String(record.type ?? record.level ?? 'log'),
                text: String(record.text ?? record.message ?? ''),
                ts: typeof record.timestamp === 'number' ? record.timestamp : undefined,
            });
        }
        else {
            session.record({ stream: 'console', level: 'log', text: String(message) });
        }
    }
    if (typeof screenshot === 'string' && screenshot) {
        session.record({ stream: 'screenshot', format: 'png', data: screenshot, label: 'final' });
    }
}
function exportTraceArtifact(session, status, error, onTraceExport) {
    try {
        const trace = exportObservationSession(session, { error, status });
        if (status === 'failure' && error !== undefined) {
            attachTraceReceipt(error, trace.receipt);
        }
        else {
            process.stderr.write(`OpenCLI trace artifact: ${trace.dir}\n`);
        }
        try {
            onTraceExport?.(trace);
        }
        catch (err) {
            log.warn(`[trace] Trace export callback failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return trace;
    }
    catch (err) {
        log.warn(`[trace] Failed to export trace artifact: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}
export function prepareCommandArgs(cmd, rawKwargs) {
    const kwargs = coerceAndValidateArgs(cmd.args, rawKwargs);
    cmd.validateArgs?.(kwargs);
    return kwargs;
}
/**
 * Runtime ceiling padding (seconds) added on top of the user's `--timeout`.
 * The adapter's polling loop typically uses the full user value; the padding
 * gives us room for the adapter to return + closeWindow + trace export before
 * the runtime kills the Promise.
 */
const RUNTIME_TIMEOUT_PADDING_SECONDS = 30;
function normalizeSiteSession(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    if (raw === 'ephemeral' || raw === 'persistent')
        return raw;
    throw new ArgumentError(`--site-session must be one of: ephemeral, persistent. Received: "${String(raw)}"`);
}
function resolveSiteSession(cmd, rawOption) {
    return normalizeSiteSession(rawOption) ?? cmd.siteSession ?? 'ephemeral';
}
function resolveAdapterBrowserSession(cmd, siteSession) {
    if (siteSession === 'persistent')
        return `site:${cmd.site}`;
    return `site:${cmd.site}:${crypto.randomUUID()}`;
}
function normalizeBooleanOption(name, raw) {
    if (raw === undefined || raw === '')
        return null;
    if (raw === 'true')
        return true;
    if (raw === 'false')
        return false;
    throw new ArgumentError(`${name} must be one of: true, false. Received: "${String(raw)}"`);
}
function resolveKeepTab(siteSession, rawOption) {
    if (siteSession === 'persistent')
        return true;
    return normalizeBooleanOption('--keep-tab', rawOption) ?? false;
}
function normalizeWindowMode(name, raw) {
    if (raw === undefined || raw === '')
        return null;
    if (raw === 'foreground' || raw === 'background')
        return raw;
    throw new ArgumentError(`${name} must be one of: foreground, background. Received: "${String(raw)}"`);
}
function resolveBrowserWindowMode(defaultMode = 'background', rawOption) {
    return normalizeWindowMode('--window', rawOption)
        ?? normalizeWindowMode('OPENCLI_WINDOW', process.env.OPENCLI_WINDOW)
        ?? defaultMode;
}
/**
 * Resolve the user-controllable `--timeout` arg, in seconds.
 *
 * Convention: a command opts into runtime-enforced timeouts by declaring an
 * arg named `timeout`. The arg's `default` flows through `prepareCommandArgs`
 * into `kwargs.timeout`, so by the time runtime enforcement runs, the value
 * is the merged user-supplied-or-default seconds.
 *
 * Returns the parsed positive integer (seconds), or null if the command does
 * not expose a `timeout` arg. Declaring `timeout` opts into runtime timeout
 * enforcement, so invalid values must fail upfront instead of silently
 * disabling the runtime ceiling.
 */
function readUserTimeoutSeconds(cmd, kwargs) {
    if (!cmd.args.some(a => a.name === 'timeout'))
        return null;
    const raw = kwargs.timeout;
    if (raw === undefined || raw === null || raw === '') {
        throw new ArgumentError(`Argument "timeout" must be a positive integer. Received: "${String(raw)}"`);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ArgumentError(`Argument "timeout" must be a positive integer. Received: "${String(raw)}"`);
    }
    return parsed;
}
