/**
 * P2-7 — the adapter.* MCP tool family:
 *  - adapter.run: registry lookup + the real executeCommand chain (validated
 *    through a non-browser probe command — browser commands need a live CDP
 *    face, their D3 guard path is already covered by the CLI/daemon suites);
 *  - unknown site/command error faces with suggestions;
 *  - the static maintenance tools (validate / convention_audit / verify)
 *    against the real clis tree.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { executeTool } from '../src/browser-mcp/src/tools/framework.ts'
import {
  adapter_convention_audit,
  adapter_run,
  adapter_validate,
  adapter_verify,
} from '../src/browser-mcp/src/tools/adapter-tools.ts'
import { createFakePage, makeContext } from '../src/browser-mcp/src/tools/test-helpers.ts'
import { getRegistry, registerCommand } from '../src/opencli-engine/registry.js'

const PROBE_SITE = '_probe-adapter-tools'

// A non-browser command: the full executeCommand chain (validation, hooks,
// timeout policy) minus the browser session, which needs a live CDP face.
registerCommand({
  site: PROBE_SITE,
  name: 'echo',
  access: 'read',
  browser: false,
  description: 'probe',
  args: [{ name: 'q', required: true }],
  func: async (kwargs: Record<string, unknown>) => [{ echo: kwargs.q }],
} as never)

afterAll(() => {
  for (const key of [...getRegistry().keys()]) {
    if (key.startsWith(`${PROBE_SITE}/`)) getRegistry().delete(key)
  }
})

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ''
}

describe('adapter.run (P2-7 MCP execution face)', () => {
  it('runs a non-browser adapter command through the executeCommand chain', async () => {
    const result = await executeTool(
      adapter_run,
      { site: PROBE_SITE, command: 'echo', args: { q: 'hello hub' } },
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const text = textOf(result)
    expect(text).toContain('"echo": "hello hub"')
    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent
    expect(structured).toMatchObject({
      site: PROBE_SITE,
      command: 'echo',
      rowCount: 1,
      truncated: false,
    })
  })

  it('carries the caller identity without breaking the open-world default', async () => {
    // identity present → ownerOf travels via opts.agentId (the MCP face's
    // per-caller key); non-browser commands never touch the binding, this
    // pins that the pass-through does not derail execution.
    const ctx = {
      ...makeContext(createFakePage()),
      identity: { agentId: 'mcp:probe', convoId: 'mcp:probe:c1', displayName: 'probe' },
    }
    const result = await executeTool(
      adapter_run,
      { site: PROBE_SITE, command: 'echo', args: { q: 'with identity' } },
      ctx,
    )
    expect(result?.isError).not.toBe(true)
    expect(textOf(result)).toContain('with identity')
  })

  it('reports invalid arguments as an instructive error', async () => {
    const result = await executeTool(
      adapter_run,
      { site: PROBE_SITE, command: 'echo', args: {} },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('invalid arguments')
    expect(textOf(result)).toContain('"q" is required')
  })

  it('suggests commands when the site exists but the command does not', async () => {
    const result = await executeTool(
      adapter_run,
      { site: PROBE_SITE, command: 'nope' },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain(`unknown command '${PROBE_SITE}/nope'`)
    expect(textOf(result)).toContain('echo')
  })

  it('suggests similar sites for an unknown site', async () => {
    const result = await executeTool(
      adapter_run,
      { site: 'github-x', command: 'issues' },
      makeContext(createFakePage()),
    )
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain("unknown site 'github-x'")
    // discovery ran (real clis tree), so the fuzzy matcher has material
    expect(textOf(result)).toContain('github')
  })
})

describe('adapter maintenance tools (P2-7 static face)', () => {
  it('adapter.validate covers the discovered registry', async () => {
    const result = await executeTool(
      adapter_validate,
      {},
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const structured = (result as { structuredContent?: { ok?: boolean; commands?: number } })
      .structuredContent
    expect(structured?.ok).toBe(true)
    expect((structured?.commands ?? 0)).toBeGreaterThan(100)
  })

  it('adapter.validate can target one site', async () => {
    const result = await executeTool(
      adapter_validate,
      { target: PROBE_SITE },
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const structured = (result as { structuredContent?: { commands?: number; target?: string } })
      .structuredContent
    expect(structured?.commands).toBe(1)
    expect(structured?.target).toBe(PROBE_SITE)
  })

  it('adapter.convention_audit reports the repo conventions', async () => {
    const result = await executeTool(
      adapter_convention_audit,
      {},
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const structured = (result as { structuredContent?: { ok?: boolean } }).structuredContent
    expect(typeof structured?.ok).toBe('boolean')
  })

  it('adapter.verify without smoke equals the validation gate', async () => {
    const result = await executeTool(
      adapter_verify,
      { target: PROBE_SITE },
      makeContext(createFakePage()),
    )
    expect(result?.isError).not.toBe(true)
    const structured = (result as { structuredContent?: { ok?: boolean } }).structuredContent
    expect(structured?.ok).toBe(true)
  })
})
