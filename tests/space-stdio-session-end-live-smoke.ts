/**
 * Live smoke for the stdio session-end sweep — the lifecycle path that decides
 * whether a dying agent process leaves orphan spaces and tabs behind.
 *
 * Documented semantics (bin/hub.mjs):
 *   - NO HUB_AGENT_ID → the identity is session-scoped, so the process's spaces
 *     die with it (HUB_SESSION_END_SPACES=close by default: tabs closed AND the
 *     ledger evicted);
 *   - WITH a stable HUB_AGENT_ID → spaces span sessions BY DESIGN and must
 *     survive the process.
 *
 * Both halves matter: the first stops orphans, the second is the whole point of
 * a stable identity. Neither had real-machine coverage.
 *
 * Self-contained: temp ledger, its own tabs; closes everything and checks the
 * browser is back to its baseline.
 *
 * Run:
 *   bun tests/space-stdio-session-end-live-smoke.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import { resolveCdpPort } from '../src/cdp-port'

const cdpPort = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())
const HUB_BIN = join(process.cwd(), 'bin', 'hub.mjs')

interface WindowRow {
  windowId: number
}

async function main(): Promise<void> {
  console.log(`[space-stdio-end-live] CDP ${cdpPort}`)
  const cdp = new CdpBackend({ port: cdpPort })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const listWindows = async (): Promise<WindowRow[]> =>
    (((await session.cdpJson('Browser.getWindows', '{}')) as {
      windows?: WindowRow[]
    })?.windows ?? []) as WindowRow[]
  const listTargets = async (): Promise<Array<{ id: string; url: string }>> => {
    const all = (await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    ).json()) as Array<{ id: string; type: string; url: string }>
    return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }))
  }

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  const baselineWindows = (await listWindows()).map((w) => w.windowId)
  const baselineTargets = new Set((await listTargets()).map((t) => t.id))
  const root = mkdtempSync(join(tmpdir(), 'stdio-end-live-'))

  /** One stdio MCP session: create a space with a tab, then end stdin. */
  async function runSession(
    label: string,
    env: Record<string, string>,
  ): Promise<{ spaceId: string; ledger: string; exited: boolean }> {
    const ledger = join(root, `ledger-${label}.json`)
    const child: ChildProcess = spawn(process.execPath, [HUB_BIN, '--mcp'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_SPACES_FILE: ledger,
        BROWSEROS_DIR: root,
        BROWSEROS_CDP_PORT: String(cdpPort),
        HUB_SPACE_REAP: 'off',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    const pending = new Map<number, (msg: Record<string, unknown>) => void>()
    let buffer = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const id = msg.id
        if (typeof id === 'number' && pending.has(id)) {
          pending.get(id)!(msg)
          pending.delete(id)
        }
      }
    })
    let nextId = 1
    const rpc = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`rpc timeout: ${method}`))
        }, 20000)
        pending.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    }
    const callTool = async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const msg = await rpc('tools/call', { name, arguments: args })
      return ((msg.result ?? {}) as { structuredContent?: Record<string, unknown> })
        .structuredContent ?? {}
    }

    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `stdio-end-${label}`, version: '1' },
    })
    child.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    )
    const created = await callTool('space.create', { name: `end-${label}` })
    const spaceId = String((created.space as { id?: string } | undefined)?.id ?? '')
    await callTool('space.open_tab', { url: `https://example.com/?end=${label}` })
    await new Promise((r) => setTimeout(r, 700))

    // End the session the way a client disconnect does.
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        resolve(false)
      }, 12000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
      child.stdin!.end()
    })
    await new Promise((r) => setTimeout(r, 1200))
    return { spaceId, ledger, exited }
  }

  const readSpaces = async (ledger: string): Promise<string[]> => {
    const fs = await import('node:fs')
    try {
      const raw = JSON.parse(fs.readFileSync(ledger, 'utf-8')) as {
        spaces?: Record<string, { name: string }>
      }
      return Object.values(raw.spaces ?? {}).map((s) => s.name)
    } catch {
      return []
    }
  }
  const liveEndTabs = async (label: string): Promise<number> =>
    (await listTargets()).filter((t) => t.url.includes(`end=${label}`)).length

  const sessions: string[] = []
  try {
    // ── 1. session-scoped identity: the space must die with the process ──
    const scoped = await runSession('scoped', { HUB_SESSION_END_SPACES: 'close' })
    sessions.push(scoped.spaceId)
    record(
      'session-scoped: the process exited on stdin end',
      scoped.exited,
      `exited=${scoped.exited}`,
    )
    record(
      'session-scoped: its space tab was closed with the process',
      (await liveEndTabs('scoped')) === 0,
      `tabs=${await liveEndTabs('scoped')}`,
    )
    record(
      'session-scoped: the ledger no longer holds the space',
      !(await readSpaces(scoped.ledger)).includes('end-scoped'),
      `spaces=${JSON.stringify(await readSpaces(scoped.ledger))}`,
    )

    // ── 2. stable HUB_AGENT_ID: the space must SURVIVE the process ──
    const stable = await runSession('stable', { HUB_AGENT_ID: 'stdio-stable-probe' })
    sessions.push(stable.spaceId)
    record(
      'stable identity: the process exited on stdin end',
      stable.exited,
      `exited=${stable.exited}`,
    )
    record(
      'stable identity: its tab SURVIVES (spaces span sessions by design)',
      (await liveEndTabs('stable')) === 1,
      `tabs=${await liveEndTabs('stable')}`,
    )
    record(
      'stable identity: the ledger still holds the space',
      (await readSpaces(stable.ledger)).includes('end-stable'),
      `spaces=${JSON.stringify(await readSpaces(stable.ledger))}`,
    )
  } finally {
    // Clean up whatever survived (case 2 by design) plus anything unexpected.
    for (const t of await listTargets()) {
      if (!baselineTargets.has(t.id)) {
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${t.id}`).catch(() => {})
      }
    }
    await new Promise((r) => setTimeout(r, 700))
    for (const w of await listWindows()) {
      if (!baselineWindows.includes(w.windowId)) {
        try {
          await session.cdpJson(
            'Browser.closeWindow',
            JSON.stringify({ windowId: w.windowId }),
          )
        } catch {
          /* already gone */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
    record(
      'cleanup: browser is back to its baseline windows',
      (await listWindows()).length === baselineWindows.length,
      `windows=${(await listWindows()).length} (baseline ${baselineWindows.length})`,
    )
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(
      `space stdio session-end live failures: ${failed.map((f) => f.name).join(', ')}`,
    )
  }
  console.log(`PASS: space stdio session-end live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error(
    'SPACE STDIO SESSION-END LIVE SMOKE FAILED:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
