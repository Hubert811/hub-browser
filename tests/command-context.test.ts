/**
 * P1-3 part 2 — CommandContext tests (explicit per-command isolation for
 * the daemon /command executor).
 *
 * Pins the contract that replaced the inline monkey-patch in
 * handleDaemonCommand:
 *   - createCommandContext maps the forwarded env payload to an explicit
 *     identity (convoId = HUB_AGENT_ID, mirroring cli.js) + ledger override
 *   - runWithCommandContext captures console.* + stdout/stderr writes into
 *     the context, bridges the per-command env, and ALWAYS restores both —
 *     including on thrown errors
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  commandIdentityFromEnv,
  createCommandContext,
  runWithCommandContext,
} from '../src/command-context.ts'

const envStack: Array<Record<string, string | undefined>> = []

function withEnv(patch: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  envStack.push(saved)
}

afterEach(() => {
  while (envStack.length) {
    const saved = envStack.pop()!
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

describe('createCommandContext', () => {
  it('maps forwarded HUB_AGENT_ID to an explicit identity (convoId = agentId)', () => {
    const ctx = createCommandContext({
      HUB_AGENT_ID: 'agent-42',
      HUB_SPACES_FILE: '/tmp/ledger.json',
    })
    expect(ctx.identity).toEqual({
      agentId: 'agent-42',
      convoId: 'agent-42',
      displayName: 'hub daemon command',
    })
    expect(ctx.spacesFile).toBe('/tmp/ledger.json')
    expect(ctx.output).toEqual({ stdout: [], stderr: [] })
    expect(typeof ctx.startedAt).toBe('number')
  })

  it('defaults to the cli:local identity without env (mirrors LOCAL_SPACE_IDENTITY)', () => {
    const ctx = createCommandContext({})
    expect(commandIdentityFromEnv({})).toEqual({
      agentId: 'cli:local',
      convoId: 'cli:local',
      displayName: 'hub daemon command',
    })
    expect(ctx.spacesFile).toBeUndefined()
  })
})

describe('runWithCommandContext', () => {
  it('captures console output into the context buffers', async () => {
    const ctx = createCommandContext({})
    await runWithCommandContext(ctx, async () => {
      console.log('to stdout')
      console.info('also stdout')
      console.warn('to stderr')
      console.error('also stderr')
    })
    expect(Buffer.concat(ctx.output.stdout).toString()).toBe(
      'to stdout\nalso stdout\n',
    )
    expect(Buffer.concat(ctx.output.stderr).toString()).toBe(
      'to stderr\nalso stderr\n',
    )
  })

  it('captures raw process.stdout/stderr writes', async () => {
    const ctx = createCommandContext({})
    await runWithCommandContext(ctx, async () => {
      process.stdout.write('raw-out')
      process.stderr.write('raw-err')
    })
    expect(Buffer.concat(ctx.output.stdout).toString()).toBe('raw-out')
    expect(Buffer.concat(ctx.output.stderr).toString()).toBe('raw-err')
  })

  it('restores console and stdout/stderr after the command completes', async () => {
    const ctx = createCommandContext({})
    const logBefore = console.log
    await runWithCommandContext(ctx, async () => {})
    expect(console.log).toBe(logBefore)
    // process.stdout.write is re-bound on every access under Bun, so its
    // restoration is verified behaviorally: post-restore writes do not
    // leak into the context buffers.
    console.log('after restore')
    expect(ctx.output.stdout).toHaveLength(0)
  })

  it('bridges the per-command identity env and restores the daemon value', async () => {
    withEnv({ HUB_AGENT_ID: undefined })
    const ctx = createCommandContext({ HUB_AGENT_ID: 'agent-42' })
    let seen: string | undefined
    await runWithCommandContext(ctx, async () => {
      seen = process.env.HUB_AGENT_ID
    })
    expect(seen).toBe('agent-42')
    // Restored: the caller's identity does not leak past the command.
    expect(process.env.HUB_AGENT_ID).toBeUndefined()
  })

  it('does not touch env for the default cli:local identity', async () => {
    withEnv({ HUB_AGENT_ID: undefined })
    const ctx = createCommandContext({})
    let seen: string | undefined
    await runWithCommandContext(ctx, async () => {
      seen = process.env.HUB_AGENT_ID
    })
    expect(seen).toBeUndefined()
  })

  it('restores everything even when the command throws', async () => {
    withEnv({ HUB_AGENT_ID: 'daemon-owner' })
    const ctx = createCommandContext({ HUB_AGENT_ID: 'agent-42' })
    const logBefore = console.log
    await expect(
      runWithCommandContext(ctx, async () => {
        console.log('partial output')
        throw new Error('command crashed')
      }),
    ).rejects.toThrow('command crashed')
    expect(console.log).toBe(logBefore)
    expect(process.env.HUB_AGENT_ID).toBe('daemon-owner')
    expect(Buffer.concat(ctx.output.stdout).toString()).toBe('partial output\n')
  })
})
