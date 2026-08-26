/**
 * P1-3 — session-scoped identity (convoId) tests.
 *
 * SpaceIdentity splits into two layers:
 *   - convoId  — the ownership key (stable per conversation)
 *   - agentId  — the client label (display/aggregation only)
 *
 * The headline guarantee: two MCP server processes with the same client name
 * (e.g. two Claude Code windows, both "mcp:claude-code") resolve distinct
 * convoIds and therefore own disjoint space sets — the bug-#3
 * identity-collapse class of issues.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskSpaceManager,
  ownerOf,
  type SpaceIdentity,
} from '../../../space/task-space-manager.ts'
import { makeMcpSessionIdentityResolver } from './register'
import { executeTool } from './framework'
import { SPACE_TOOLS } from './registry'
import { createFakePage, makeContext } from './test-helpers'

function tool(name: string) {
  return SPACE_TOOLS.find((t) => t.name === name)!
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

/** Minimal McpServer fake exposing getClientVersion at the SDK layer. */
function fakeMcpServer(clientInfo?: { name: string }) {
  return {
    server: clientInfo ? { getClientVersion: () => clientInfo } : {},
  } as never
}

const envStack: Array<string | undefined> = []

function withEnvAgentId(value: string | undefined) {
  envStack.push(process.env.HUB_AGENT_ID)
  if (value === undefined) delete process.env.HUB_AGENT_ID
  else process.env.HUB_AGENT_ID = value
}

afterEach(() => {
  const saved = envStack.pop()
  if (saved === undefined) delete process.env.HUB_AGENT_ID
  else process.env.HUB_AGENT_ID = saved
})

// ─── ownerOf ────────────────────────────────────────────────────────

describe('ownerOf (ownership key extraction)', () => {
  it('falls back to agentId when convoId is unset (legacy identities/ledgers)', () => {
    expect(ownerOf({ agentId: 'cli:local' })).toBe('cli:local')
  })

  it('prefers convoId as the ownership key', () => {
    expect(
      ownerOf({ agentId: 'mcp:claude-code', convoId: 'mcp:claude-code:abc' }),
    ).toBe('mcp:claude-code:abc')
  })
})

// ─── session identity resolver ──────────────────────────────────────

describe('makeMcpSessionIdentityResolver', () => {
  it('explicit $HUB_AGENT_ID is both the label and the ownership key', () => {
    withEnvAgentId('my-stable-agent')
    const resolve = makeMcpSessionIdentityResolver(fakeMcpServer({ name: 'ignored' }))
    expect(resolve()).toEqual({
      agentId: 'my-stable-agent',
      convoId: 'my-stable-agent',
      displayName: 'my-stable-agent',
    })
  })

  it('clientInfo identity keeps the mcp:<name> label and gains a unique convoId', () => {
    withEnvAgentId(undefined)
    const resolve = makeMcpSessionIdentityResolver(
      fakeMcpServer({ name: 'claude-code' }),
    )
    const id = resolve()!
    expect(id.agentId).toBe('mcp:claude-code')
    expect(id.convoId).toMatch(/^mcp:claude-code:[a-z0-9]{8}$/)
    expect(id.convoId).not.toBe(id.agentId)
  })

  it('the convoId is stable across calls within one server session', () => {
    withEnvAgentId(undefined)
    const resolve = makeMcpSessionIdentityResolver(
      fakeMcpServer({ name: 'claude-code' }),
    )
    const first = resolve()!
    const second = resolve()!
    const third = resolve()!
    expect(second.convoId).toBe(first.convoId)
    expect(third.convoId).toBe(first.convoId)
  })

  it('two sessions with the same client name get distinct convoIds (isolation)', () => {
    withEnvAgentId(undefined)
    const resolveA = makeMcpSessionIdentityResolver(
      fakeMcpServer({ name: 'claude-code' }),
    )
    const resolveB = makeMcpSessionIdentityResolver(
      fakeMcpServer({ name: 'claude-code' }),
    )
    const a = resolveA()!
    const b = resolveB()!
    // Same agent label...
    expect(a.agentId).toBe(b.agentId)
    // ...but disjoint ownership keys.
    expect(a.convoId).not.toBe(b.convoId)
  })

  it('returns undefined without env or clientInfo (open-world behavior)', () => {
    withEnvAgentId(undefined)
    const resolve = makeMcpSessionIdentityResolver(fakeMcpServer(undefined))
    expect(resolve()).toBeUndefined()
  })
})

// ─── ownership isolation end-to-end (space tools) ───────────────────

describe('same-name agents with distinct convoIds own disjoint spaces', () => {
  it('session 2 cannot see session 1 spaces and vice versa', async () => {
    const page = createFakePage()
    const manager = new TaskSpaceManager({
      storagePath: join(mkdtempSync(join(tmpdir(), 'p13-identity-')), 's.json'),
      persist: false,
    })

    const session1: SpaceIdentity = {
      agentId: 'mcp:claude-code',
      convoId: 'mcp:claude-code:aaaa1111',
      displayName: 'claude-code',
    }
    const session2: SpaceIdentity = {
      agentId: 'mcp:claude-code',
      convoId: 'mcp:claude-code:bbbb2222',
      displayName: 'claude-code',
    }

    const ctx1 = { ...makeContext(page), identity: session1, spaces: manager }
    const ctx2 = { ...makeContext(page), identity: session2, spaces: manager }

    // Session 1 creates a space.
    await executeTool(tool('space.create'), { name: 'session-one-work' }, ctx1)

    // Session 2 sees no spaces.
    const list2 = textOf(
      await executeTool(tool('space.list'), {}, ctx2),
    )
    expect(list2).toContain('(no task spaces)')

    // Session 1 still sees its space.
    const list1 = textOf(
      await executeTool(tool('space.list'), {}, ctx1),
    )
    expect(list1).toContain('session-one-work')

    // Session 2 creates its own; the two spaces are independent.
    await executeTool(tool('space.create'), { name: 'session-two-work' }, ctx2)
    const list2After = textOf(
      await executeTool(tool('space.list'), {}, ctx2),
    )
    expect(list2After).toContain('session-two-work')
    expect(list2After).not.toContain('session-one-work')
  })
})
