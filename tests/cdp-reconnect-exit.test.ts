/**
 * #13 — MCP process must survive CDP reconnect exhaustion.
 *
 * The vendored CdpBackend defaults to `exitOnReconnectFailure: true`
 * (process.exit on reconnect exhaustion). That is right for the daemon /
 * one-shot CLI, wrong for `hub --mcp`: exiting turns a connection outage
 * into the death of the whole agent MCP session.
 *
 * These tests pin both halves of the fix:
 *   1. resolveExitOnReconnectFailure() detection matrix (factory wiring)
 *   2. Actual reconnect-exhaustion behavior against a fake CDP server:
 *      false → process stays alive (no process.exit), true → process.exit
 *      is invoked with the vendor exit code (spied, not executed).
 *
 * No real browser needed: a Bun.serve instance serves /json/version and a
 * WebSocket endpoint, then gets stopped to trigger the reconnect loop.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { CdpBackend } from '@browseros/browser-core'
import { CDP_LIMITS } from '@browseros/shared/constants/limits'
import { TIMEOUTS } from '@browseros/shared/constants/timeouts'
import { resolveExitOnReconnectFailure } from '../src/factory.ts'

// ─── helpers ────────────────────────────────────────────────────────

type FakeCdp = {
  port: number
  stop: () => Promise<void>
}

async function startFakeCdpServer(): Promise<FakeCdp> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      if (req.url.endsWith('/json/version')) {
        return Response.json({
          Browser: 'FakeCDP/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
        })
      }
      // Everything else is the browser-level WebSocket endpoint.
      if (srv.upgrade(req)) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open() {},
      message() {},
      close() {},
    },
  })
  return {
    port: server.port,
    stop: async () => {
      server.stop(true) // stop listener + kill active connections
    },
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Stubs reconnect pacing + process.exit for one exhaustion scenario. */
function withFastReconnect() {
  const saved = {
    retries: CDP_LIMITS.RECONNECT_MAX_RETRIES,
    delay: TIMEOUTS.CDP_RECONNECT_DELAY,
    exit: process.exit,
  }
  const exitCalls: number[] = []
  CDP_LIMITS.RECONNECT_MAX_RETRIES = 1
  TIMEOUTS.CDP_RECONNECT_DELAY = 50
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0)
  }) as typeof process.exit
  return {
    exitCalls,
    restore() {
      CDP_LIMITS.RECONNECT_MAX_RETRIES = saved.retries
      TIMEOUTS.CDP_RECONNECT_DELAY = saved.delay
      process.exit = saved.exit
    },
  }
}

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

// ─── 1. detection matrix ────────────────────────────────────────────

describe('#13 resolveExitOnReconnectFailure (factory wiring)', () => {
  it('defaults to exit-on-failure (daemon / CLI keep vendor default)', () => {
    withEnv({ HUB_MCP: undefined })
    const argvHasMcp = process.argv.includes('--mcp')
    if (!argvHasMcp) {
      expect(resolveExitOnReconnectFailure()).toBe(true)
    }
  })

  it('returns false when HUB_MCP=true (MCP server must survive)', () => {
    withEnv({ HUB_MCP: 'true' })
    expect(resolveExitOnReconnectFailure()).toBe(false)
  })

  it('returns false when --mcp is in argv', () => {
    withEnv({ HUB_MCP: undefined })
    const argvHadMcp = process.argv.includes('--mcp')
    if (!argvHadMcp) process.argv.push('--mcp')
    try {
      expect(resolveExitOnReconnectFailure()).toBe(false)
    } finally {
      if (!argvHadMcp) process.argv.pop()
    }
  })
})

// ─── 2. reconnect exhaustion behavior ───────────────────────────────

describe('#13 CdpBackend reconnect exhaustion', () => {
  it('exitOnReconnectFailure:false keeps the process alive', async () => {
    const fake = await startFakeCdpServer()
    const stub = withFastReconnect()
    const cdp = new CdpBackend({
      port: fake.port,
      exitOnReconnectFailure: false,
    })
    try {
      await cdp.connect()
      expect((cdp as any).exitOnReconnectFailure).toBe(false)

      // Kill the server → ws closes → reconnect loop → exhausted.
      await fake.stop()
      await waitFor(
        () =>
          (cdp as any).reconnecting === false && (cdp as any).connected === false,
      )

      // The process is alive by definition (we are still running), and
      // process.exit was never invoked.
      expect(stub.exitCalls).toEqual([])
      expect((cdp as any).connected).toBe(false)
    } finally {
      stub.restore()
      await cdp.disconnect().catch(() => {})
    }
  })

  it('exitOnReconnectFailure:true exits with the vendor exit code', async () => {
    const fake = await startFakeCdpServer()
    const stub = withFastReconnect()
    const cdp = new CdpBackend({
      port: fake.port,
      exitOnReconnectFailure: true,
    })
    try {
      await cdp.connect()

      await fake.stop()
      await waitFor(() => stub.exitCalls.length > 0)

      expect(stub.exitCalls.length).toBe(1)
      expect(stub.exitCalls[0]).toBeGreaterThan(0) // EXIT_CODES.GENERAL_ERROR
    } finally {
      stub.restore()
      await cdp.disconnect().catch(() => {})
    }
  })
})
