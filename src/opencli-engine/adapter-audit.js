/**
 * Adapter command audit (F17 companion fix).
 *
 * Adapter commands are the agent's heaviest browser activity, yet they
 * bypassed every audit surface: cmd.func(page) drives IPage primitives
 * straight over CDP with no hook, so neither hub's local SQLite audit nor the
 * BrowserClaw cockpit timeline saw them. This module lands, per adapter
 * command:
 *
 *   - one command-level parent dispatch — local SQLite + claw dual-write,
 *     the same row shape executeTool produces (redacted args, duration,
 *     error/guard, tab attribution);
 *   - per-primitive child rows — SQLite only, linked via parent_dispatch_id,
 *     mirroring the run tool's InnerCallHook record model (run.ts). Children
 *     stay off the claw feed: a heavy command issues hundreds of evaluates
 *     and would drown the cockpit timeline.
 *
 * Everything here is best-effort: no path may throw into the command, and a
 * disabled audit sink / claw reporter simply produces no rows.
 */
import { randomUUID } from 'node:crypto';

import { fullName } from './registry.js';
import { redactValue } from './observation/redaction.js';

/** Child-row ceiling per command — pathological adapters must not flood the
 * audit DB; the overflow lands as a `capped` marker on the parent row. */
const MAX_CHILD_ROWS = 500;

function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps a page so every method call records one primitive child row via
 * `onPrimitive({tool, ok, durationMs, error})`. Non-function properties
 * (getters like page.session, data fields) pass through untouched, and the
 * proxy keeps the target as the receiver so getters still read the real page.
 */
export function wrapPageForAudit(page, onPrimitive) {
    return new Proxy(page, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof prop !== 'string' || typeof value !== 'function') return value;
            // Meta props stay unwrapped: `await proxy` probes `then`, and
            // constructor access must keep working for identity checks.
            if (prop === 'then' || prop === 'constructor') return value;
            return (...args) => {
                const started = Date.now();
                const record = (ok, error) => {
                    try {
                        onPrimitive({
                            tool: prop,
                            ok,
                            durationMs: Date.now() - started,
                            ...(error !== undefined && { error: errorText(error).slice(0, 200) }),
                        });
                    } catch {
                        // Audit must never break the primitive call.
                    }
                };
                try {
                    const out = value.apply(target, args);
                    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
                        return out.then(
                            (result) => {
                                record(true);
                                return result;
                            },
                            (err) => {
                                record(false, err);
                                throw err;
                            },
                        );
                    }
                    record(true);
                    return out;
                } catch (err) {
                    record(false, err);
                    throw err;
                }
            };
        },
    });
}

/**
 * Audit context for one adapter command execution. `finish` must be called
 * exactly once on every exit path (success, command failure, guard
 * rejection, pre-nav failure); `end` closes the process's claw session for
 * direct-CLI invocations (daemon/MCP processes keep their session open).
 */
export function makeAdapterAudit({ cmd, kwargs, agentId, source }) {
    const dispatchId = randomUUID();
    const startedAt = Date.now();
    let finished = false;
    let childCount = 0;
    let childRows = 0;
    let childTotalMs = 0;
    let childCapped = false;
    // Serialize child-row writes onto one chain so finish() can await them.
    let pendingChildren = Promise.resolve();

    function onPrimitive(rec) {
        childCount += 1;
        childTotalMs += rec.durationMs;
        if (childRows >= MAX_CHILD_ROWS) {
            childCapped = true;
            return;
        }
        childRows += 1;
        pendingChildren = pendingChildren.then(async () => {
            const { getAuditSink } = await import('../audit/audit-log.ts');
            getAuditSink().recordDispatch({
                parentDispatchId: dispatchId,
                convoId: agentId,
                agentLabel: agentId,
                source,
                toolName: `page.${rec.tool}`,
                durationMs: rec.durationMs,
                ok: rec.ok,
                ...(rec.error !== undefined && { error: rec.error }),
            });
        });
    }

    /** Tab/url attribution for the parent row, mirroring framework.ts's
     * dispatchTab lookup (tabs() entries: pageId/tabId/targetId/url/title). */
    async function resolveTabContext(page, binding) {
        if (binding?.pageId === undefined || typeof page?.tabs !== 'function') return {};
        try {
            const tabs = await page.tabs();
            const info = (Array.isArray(tabs) ? tabs : []).find(
                (tab) => tab && tab.pageId === binding.pageId,
            );
            if (info === undefined) return {};
            return {
                ...(typeof info.tabId === 'number' && { tabId: info.tabId }),
                ...(typeof info.targetId === 'string' && { targetId: info.targetId }),
                ...(typeof info.url === 'string' && { url: info.url }),
                ...(typeof info.title === 'string' && { title: info.title }),
            };
        } catch {
            return {};
        }
    }

    async function finish({ error, page, binding, pageId }) {
        if (finished) return;
        finished = true;
        try {
            await pendingChildren.catch(() => {});
            const durationMs = Date.now() - startedAt;
            const isError = error !== undefined;
            const redactedArgs = redactValue(kwargs ?? {}, { maxStringLength: 2048 });
            const tabContext = await resolveTabContext(page, binding);
            const resolvedPageId = binding?.pageId ?? pageId;
            const guardCode = await guardCodeOf(error);

            const { getAuditSink } = await import('../audit/audit-log.ts');
            getAuditSink().recordDispatch({
                dispatchId,
                convoId: agentId,
                agentLabel: agentId,
                source,
                toolName: fullName(cmd),
                ...(resolvedPageId !== undefined && { pageId: resolvedPageId }),
                args: redactedArgs,
                resultMeta: {
                    isError,
                    primitives: {
                        count: childCount,
                        totalMs: Math.round(childTotalMs),
                        ...(childCapped && { capped: true }),
                    },
                },
                durationMs,
                ok: !isError,
                ...(isError && { error: errorText(error).slice(0, 200) }),
                createdAt: startedAt,
            });

            const { clawHarnessReporter } = await import('../browser-mcp/src/tools/claw-reporter.ts');
            clawHarnessReporter.reportDispatch({
                owner: agentId,
                agentId,
                agentLabel: agentId,
                toolName: fullName(cmd),
                ...(resolvedPageId !== undefined && { pageId: resolvedPageId }),
                ...tabContext,
                args: redactedArgs,
                isError,
                ...(isError && { errorHead: errorText(error).slice(0, 200) }),
                ...(guardCode !== undefined && { guard: guardCode }),
                durationMs,
                createdAt: startedAt,
            });
        } catch {
            // Audit is best-effort; never surface into the command result.
        }
    }

    /** Close this process's claw sessions (direct-CLI invocations only —
     * the daemon/MCP own their session until process exit). Fire-and-forget:
     * a pending fetch keeps the CLI event loop alive until it settles. */
    function end() {
        void (async () => {
            try {
                const { clawHarnessReporter } = await import('../browser-mcp/src/tools/claw-reporter.ts');
                await clawHarnessReporter.endAllSessions('closed');
            } catch {
                // Best-effort; claw's orphan cleanup is the backstop.
            }
        })();
    }

    return {
        dispatchId,
        wrapPage: (page) => wrapPageForAudit(page, onPrimitive),
        finish,
        end,
    };
}

/** Guard code when the command died to a space guard rejection (D3 no-space,
 * etc.) — the claw row stays searchable by platform error code. */
async function guardCodeOf(error) {
    if (error === undefined) return undefined;
    try {
        const { SpaceGuardError } = await import('../space/task-space-manager.ts');
        return error instanceof SpaceGuardError ? error.code : undefined;
    } catch {
        return undefined;
    }
}
