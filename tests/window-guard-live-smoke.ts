/**
 * Live check for the P7-H H5 window guard, against a real browser.
 *
 * What only a live browser can prove: the guard's verdicts are computed from
 * REAL window/tab state (which window holds the user's tabs, which window the
 * agent just created and claimed).
 *
 * Safety net: `windowClose`/`windowActivate` are wrapped so that a guard BUG
 * cannot close the user's window during this probe — a leak-through shows up as
 * a failed assertion, never as a closed window. The probe only really closes the
 * window it created itself, and closes the space it opened at the end.
 *
 * Run:
 *   bun tests/window-guard-live-smoke.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpBackend } from '@browseros/browser-core/backends/cdp'
import { BrowserSession } from '@browseros/browser-core'
import {
  TaskSpaceManager,
  gatewayFromPage,
  type SpaceIdentity,
} from '../src/space/task-space-manager'
import { BROWSER_TOOLS } from '@browseros/browser-mcp/registry'
import {
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  executeTool,
} from '@browseros/browser-mcp/tools/framework'
import { pageFromSession } from '@browseros/browser-mcp/tools/session-adapter'
import { resolveCdpPort } from '../src/cdp-port'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? resolveCdpPort())

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter(
      (c): c is { type: 'text'; text: string } =>
        c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
}

function tool(name: string): ToolDefinition {
  const def = BROWSER_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

async function main(): Promise<void> {
  console.log(`[window-guard-live] CDP ${port}`)
  const cdp = new CdpBackend({ port })
  await cdp.connect()
  const session = new BrowserSession(cdp as never)
  const active = (await session.pages.list()) as unknown as Array<{
    pageId: number
    isActive?: boolean
  }>
  const pageId = active.find((p) => p.isActive)?.pageId ?? active[0]?.pageId
  if (typeof pageId !== 'number') throw new Error('no page to bind')
  const real = pageFromSession(session, pageId)

  const results: Array<{ name: string; pass: boolean; detail: string }> = []
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? '✅' : '❌'} ${name}: ${detail.slice(0, 240)}`)
  }

  const owner = 'window-guard-live'
  const identity: SpaceIdentity = { agentId: owner }
  const manager = new TaskSpaceManager({
    storagePath: join(mkdtempSync(join(tmpdir(), 'wguard-live-')), 's.json'),
    gateway: gatewayFromPage(real as never),
    persist: false,
  })
  const space = await manager.create(owner, 'h5-live-probe')
  const agentTab = (await manager.openTab(owner, space.id, 'about:blank')) as number

  const realClose = real.windowClose.bind(real)
  const closed: number[] = []
  const activated: number[] = []
  let userWindow = -1
  let createdWindow = -1

  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    windowClose: async (windowId: number) => {
      if (windowId === userWindow) {
        throw new Error(`SAFETY NET: refused to close the user's window ${windowId}`)
      }
      closed.push(windowId)
      return realClose(windowId)
    },
    windowActivate: async (windowId: number) => {
      if (windowId === userWindow) {
        throw new Error(`SAFETY NET: refused to activate the user's window ${windowId}`)
      }
      activated.push(windowId)
      return real.windowActivate(windowId)
    },
  }) as typeof real

  const ctx: ToolContext = {
    page: wrapped,
    pageFor: async () => wrapped,
    identity,
    spaces: manager,
  }

  try {
    const tabs = (await real.tabs()) as unknown as Array<{
      pageId: number
      windowId?: number
    }>
    userWindow = tabs.find((t) => t.pageId === agentTab)?.windowId ?? -1
    record(
      'setup: agent tab lives in the shared (user) window',
      userWindow > 0,
      `agentTab=${agentTab} windowId=${userWindow}`,
    )

    const refused = await executeTool(
      tool('windows'),
      { action: 'close', windowId: userWindow },
      ctx,
    )
    record(
      'guard: the user window cannot be closed by the agent',
      refused.isError === true && textOf(refused).includes('is not yours'),
      textOf(refused).split('\n').slice(0, 2).join(' / '),
    )
    record(
      'guard: the refusal happened BEFORE any CDP close',
      closed.length === 0,
      `close calls=[${closed.join(',')}]`,
    )

    const activatedRes = await executeTool(
      tool('windows'),
      { action: 'activate', windowId: userWindow },
      ctx,
    )
    record(
      'guard: activate is refused on the same rule',
      activatedRes.isError === true && textOf(activatedRes).includes('is not yours'),
      textOf(activatedRes).split('\n').slice(0, 1).join(''),
    )

    const created = await executeTool(tool('windows'), { action: 'create' }, ctx)
    const win = (created.structuredContent as { window?: { windowId?: number } })?.window
    createdWindow = win?.windowId ?? -1
    record(
      'create: a new window is opened for the agent',
      created.isError !== true && createdWindow > 0,
      `windowId=${createdWindow}`,
    )

    const freshTabs = (await real.tabs()) as unknown as Array<{
      pageId: number
      windowId?: number
    }>
    const fresh = freshTabs.find((t) => t.windowId === createdWindow)
    const ownerSpace =
      fresh && typeof fresh.pageId === 'number'
        ? await manager.spaceIdForPage(fresh.pageId)
        : undefined
    record(
      'create: its first tab is claimed by the current space (so the window is closable)',
      !!fresh && ownerSpace === space.id,
      `tab=${fresh?.pageId ?? '?'} spaceId=${String(ownerSpace)}`,
    )

    const closedRes = await executeTool(
      tool('windows'),
      { action: 'close', windowId: createdWindow },
      ctx,
    )
    record(
      'guard: the agent CAN close the window it created',
      closedRes.isError !== true && closed.includes(createdWindow),
      `closed=[${closed.join(',')}] ${textOf(closedRes).split('\n')[0] ?? ''}`,
    )
    createdWindow = -1
  } finally {
    if (createdWindow > 0) {
      await realClose(createdWindow).catch(() => {})
    }
    await manager.closeSpace(owner, space.id, { keep: false }).catch(() => {})
    await session.dispose?.()
    await cdp.disconnect()
  }

  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    throw new Error(`window guard live failures: ${failed.map((f) => f.name).join(', ')}`)
  }
  console.log(`PASS: window guard live smoke (${results.length}/${results.length})`)
}

main().catch((err) => {
  console.error('WINDOW GUARD LIVE SMOKE FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
