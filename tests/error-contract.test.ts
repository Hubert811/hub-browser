/**
 * P1-4 (phase C) — the structured error contract across the unified gate,
 * plus the centralized process-global contract (runtime-globals.js).
 *
 * Error contract: structured errors — TargetError, the CliError family (both
 * the TS copy in opencli/errors.ts and the plain-JS engine copy in
 * opencli-engine/errors.js), SpaceGuardError — keep {code, message, hint,
 * ...meta} when they cross the executeTool boundary, the run tool route, and
 * the audit sink. Node system errors (errno/syscall markers) are NOT contract
 * members and stay text-only.
 *
 * runtime-globals: one documented owner for the platform's five process
 * globals; accessors read/write the same raw keys so raw-key test installs
 * (the bridge-override seam) keep working unchanged. The CLI fork bridges'
 * passthrough of the real code (vs the legacy 'tool_error' blanket) is
 * covered by the fork-gate test in space-browser-tab-guard.test.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { AuditLog, setAuditSink } from '../src/audit/audit-log.ts'
import {
  TaskSpaceManager,
  SpaceGuardError,
  type SpaceIdentity,
  type SpaceTabGateway,
  type TabLike,
} from '../src/space/task-space-manager.ts'
import {
  executeTool,
  defineTool,
  structuredErrorFields,
} from '../src/browser-mcp/src/tools/framework.ts'
import type { ToolContext } from '../src/browser-mcp/src/tools/framework.ts'
import { run } from '../src/browser-mcp/src/tools/run.ts'
import { snapshot } from '../src/browser-mcp/src/tools/snapshot.ts'
import {
  createFakePage,
  makeContext,
} from '../src/browser-mcp/src/tools/test-helpers.ts'
import { TargetError } from '../src/opencli/target-errors.js'
import { BrowserConnectError } from '../src/opencli/errors.js'
import { ArgumentError } from '../src/opencli-engine/errors.js'
import {
  getBrowserBridgeOverride,
  getDaemonFactory,
  isDaemonMode,
  setDaemonFactory,
  setDaemonMode,
} from '../src/opencli-engine/runtime-globals.js'

const AGENT: SpaceIdentity = {
  agentId: 'mcp:claude-code',
  convoId: 'mcp:claude-code:error-contract',
  displayName: 'claude-code',
}

function textOf(result: { content?: unknown } | undefined): string {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
}

/** A tool whose handler throws the given value — the contract test vehicle. */
function throwingTool(error: unknown) {
  return defineTool({
    name: 'thrower',
    description: 'throws the given error (test-only)',
    input: z.object({ page: z.number().int() }).strict(),
    handler: async () => {
      throw error
    },
  })
}

describe('P1-4 phase C: structured error contract at the executeTool gate', () => {
  it('TargetError keeps code/hint/candidates/matches_n through the gate', async () => {
    const tool = throwingTool(
      new TargetError({
        code: 'stale_ref',
        message: 'Ref e12 points to a different element',
        hint: 'Take a fresh snapshot and use the new ref',
        candidates: ['e13', 'e14'],
        matches_n: 3,
      }),
    )
    const result = await executeTool(
      tool,
      { page: 1 },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    // Text keeps the pre-contract shape (message-first, "failed:" head).
    const text = textOf(result)
    expect(text).toContain('thrower failed:')
    expect(text).toContain('points to a different element')
    const sc = result?.structuredContent as Record<string, unknown>
    expect(sc.code).toBe('stale_ref')
    expect(sc.message).toBe('Ref e12 points to a different element')
    expect(sc.hint).toBe('Take a fresh snapshot and use the new ref')
    expect(sc.candidates).toEqual(['e13', 'e14'])
    expect(sc.matches_n).toBe(3)
  })

  it('CliError family (TS copy) keeps code/hint/exitCode', async () => {
    const tool = throwingTool(
      new BrowserConnectError(
        'CDP not connected',
        'Start the browser and retry',
        'daemon-not-running',
      ),
    )
    const result = await executeTool(
      tool,
      { page: 1 },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    const sc = result?.structuredContent as Record<string, unknown>
    expect(sc.code).toBe('BROWSER_CONNECT')
    expect(sc.hint).toBe('Start the browser and retry')
    expect(sc.exitCode).toBe(69)
  })

  it('CliError family (plain-JS engine copy) crosses by shape, not instanceof', async () => {
    // The engine copy is a different class than opencli/errors.ts — the gate
    // must recognize it structurally (name + exitCode), the way two module
    // copies coexist in mixed src/dist layouts.
    const tool = throwingTool(new ArgumentError('"q" is required'))
    const result = await executeTool(
      tool,
      { page: 1 },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    const sc = result?.structuredContent as Record<string, unknown>
    expect(sc.code).toBe('ARGUMENT')
    expect(sc.exitCode).toBe(2)
    expect(sc.message).toBe('"q" is required')
  })

  it('Node system errors are not contract members (text-only failure)', async () => {
    const nodeErr = Object.assign(
      new Error("ENOENT: no such file or directory, open '/tmp/x'"),
      { code: 'ENOENT', errno: -2, syscall: 'open', path: '/tmp/x' },
    )
    const tool = throwingTool(nodeErr)
    const result = await executeTool(
      tool,
      { page: 1 },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    expect(result?.structuredContent).toBeUndefined()
    expect(structuredErrorFields(nodeErr)).toBeUndefined()
  })

  it('guard rejections carry the contract on structuredContent', async () => {
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'ec-guard-')), 's.json'),
      persist: false,
    })
    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    // No space for the agent → D3 guard rejection inside executeTool.
    const result = await executeTool(snapshot, { page: 9 }, ctx)
    expect(result?.isError).toBe(true)
    const sc = result?.structuredContent as Record<string, unknown>
    expect(sc.code).toBe('no-space')
    expect(typeof sc.message).toBe('string')
  })

  it('handler-failure audit rows lead with the platform code', async () => {
    const audit = new AuditLog(
      join(mkdtempSync(join(tmpdir(), 'ec-audit-')), 'audit.db'),
    )
    setAuditSink(audit)
    try {
      const tool = throwingTool(
        new TargetError({
          code: 'not_found',
          message: 'Ref e12 not found',
          hint: 'Re-snapshot',
        }),
      )
      const result = await executeTool(
        tool,
        { page: 1 },
        makeContext(createFakePage()),
      )
      expect(result?.isError).toBe(true)
      const rows = audit.listDispatches({ toolName: 'thrower' })
      expect(rows).toHaveLength(1)
      expect(rows[0].ok).toBe(0)
      expect(rows[0].error).toBe('[not_found] Ref e12 not found')
      const meta = JSON.parse(rows[0].result_meta!)
      expect(meta.structuredKeys).toContain('code')
    } finally {
      setAuditSink(undefined)
    }
  })

  it('structuredErrorFields carries SpaceGuardError meta (spaceId/hint)', () => {
    const err = new SpaceGuardError('user-controlling', 'user is controlling', {
      spaceId: 's1',
      hint: 'claim it back',
    })
    const fields = structuredErrorFields(err)
    expect(fields?.code).toBe('user-controlling')
    expect(fields?.spaceId).toBe('s1')
    expect(fields?.hint).toBe('claim it back')
  })
})

describe('P1-4 phase C: run tool route propagates the contract', () => {
  function createFakeGateway(): { tabs: TabLike[]; gateway: SpaceTabGateway } {
    let nextPageId = 1
    const tabs: TabLike[] = []
    return {
      tabs,
      gateway: {
        newTab: async (url) => {
          const pageId = nextPageId++
          const targetId = `target-${pageId}`
          tabs.push({ pageId, targetId, url })
          return targetId
        },
        closeTab: async (target) => {
          const idx = tabs.findIndex(
            (t) => t.pageId === target || t.targetId === String(target),
          )
          if (idx >= 0) tabs.splice(idx, 1)
        },
        listTabs: async () => [...tabs],
      },
    }
  }

  it('guard rejection through browser.tool() surfaces [code] + err.code', async () => {
    const fake = createFakeGateway()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'ec-run-')), 's.json'),
      gateway: fake.gateway,
      persist: false,
    })
    const space = await manager.create(AGENT.convoId, 'ec-work')
    const foreign = await manager.create('other-agent', 'ec-foreign')
    // Own tab FIRST: the run guard validates the default/active page (the
    // fake context page is page 1) — it must pass so the rejection under
    // test is the one inside browser.tool('read', {page: foreignTab}).
    await manager.openTab(AGENT.convoId, space.id, 'https://own.example')
    const foreignTab = await manager.openTab(
      'other-agent',
      foreign.id,
      'https://foreign.example',
    )

    const ctx: ToolContext = {
      ...makeContext(createFakePage()),
      identity: AGENT,
      spaces: manager,
    }
    const result = await executeTool(
      run,
      {
        code: `try { await browser.tool('read', { page: ${foreignTab} }); return 'unreachable' } catch (e) { return { code: e.code, msg: e.message } }`,
        timeout: 8000,
      },
      ctx,
    )
    expect(result?.isError).not.toBe(true)
    const value = (result?.structuredContent as { value?: { code?: string; msg?: string } })
      .value
    expect(value?.code).toBe('page-not-in-space')
    expect(value?.msg).toContain('[page-not-in-space]')
    expect(value?.msg).toContain('not in your space')
  })
})

describe('P1-4 phase C: runtime-globals contract (centralized accessors)', () => {
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    delete g.__HubDaemonMode
    delete g.__HubBrowserFactory
    delete g.__HubBrowserBridgeOverride
  })

  it('daemon mode roundtrips through the accessor', () => {
    setDaemonMode()
    expect(isDaemonMode()).toBe(true)
  })

  it('daemon factory publishes and reads back', () => {
    const factory = { _cdp: {}, _session: {} }
    setDaemonFactory(factory)
    expect(getDaemonFactory()).toBe(factory)
  })

  it('raw-key installs stay visible through accessors (test-seam compat)', () => {
    // Existing test files install the fake bridge on the raw key; the
    // production accessor must read the same key.
    class FakeBridge {}
    ;(globalThis as Record<string, unknown>).__HubBrowserBridgeOverride =
      FakeBridge
    expect(getBrowserBridgeOverride()).toBe(FakeBridge)
  })
})
