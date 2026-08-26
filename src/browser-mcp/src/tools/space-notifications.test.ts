import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  SpaceEventBus,
  TaskSpaceManager,
} from '../../../space/task-space-manager.js'
import {
  SPACE_NOTIFICATION_METHODS,
  attachSpaceEventNotifications,
  spaceEventToNotification,
} from '../space-notifications'
import type { UnifiedPageProvider } from './framework'
import { createFakePage } from './test-helpers'

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'hub-notif-')), 'hub-spaces.json')
}

function makeManager(): TaskSpaceManager {
  return new TaskSpaceManager({
    storagePath: tempLedger(),
    events: new SpaceEventBus(),
    persist: false,
  })
}

function makeProvider(): UnifiedPageProvider {
  return { connect: async () => createFakePage() }
}

interface ReceivedNotification {
  method: string
  params?: Record<string, unknown>
}

/** Boots a real MCP client over an in-memory transport against a hub server. */
type TestServer = {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

async function connectTestClient(
  server: TestServer,
): Promise<{
  client: Client
  received: ReceivedNotification[]
  close: () => Promise<void>
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'space-notif-test', version: '0.0.1' })
  const received: ReceivedNotification[] = []
  client.fallbackNotificationHandler = (notification) => {
    received.push(notification as unknown as ReceivedNotification)
    return Promise.resolve()
  }
  await client.connect(clientTransport)
  return {
    client,
    received,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('spaceEventToNotification', () => {
  it('maps every space event type to a notifications/space/* method', () => {
    expect(SPACE_NOTIFICATION_METHODS).toEqual({
      'space.created': 'notifications/space/created',
      'space.agent_active': 'notifications/space/agent_active',
      'space.handoff_requested': 'notifications/space/handoff_requested',
      'space.interrupted': 'notifications/space/interrupted',
      'space.switched': 'notifications/space/switched',
      'space.closed': 'notifications/space/closed',
      'space.tabs_recycled': 'notifications/space/tabs_recycled',
      'tab.dragged_in': 'notifications/space/tab_dragged_in',
      'tab.dragged_out': 'notifications/space/tab_dragged_out',
    })
  })

  it('carries spaceId/name/owner/ownership/timestamp and drops undefined fields', () => {
    const notification = spaceEventToNotification({
      type: 'space.created',
      spaceId: 's-1',
      name: '搜索任务',
      owner: 'agent-a',
      ownership: 'agent',
      timestamp: 1234,
    })
    expect(notification).toEqual({
      method: 'notifications/space/created',
      params: {
        spaceId: 's-1',
        name: '搜索任务',
        owner: 'agent-a',
        ownership: 'agent',
        timestamp: 1234,
      },
    })

    const sparse = spaceEventToNotification({
      type: 'space.closed',
      spaceId: 's-2',
      timestamp: 5,
    })
    expect(sparse).toEqual({
      method: 'notifications/space/closed',
      params: { spaceId: 's-2', timestamp: 5 },
    })
  })
})

describe('space.* MCP notifications (Phase 7)', () => {
  it('pushes a notification per manager transition with method + params', async () => {
    const manager = makeManager()
    const { createBrowserMcpServer } = await import('../mcp-server.ts')
    const server = createBrowserMcpServer({
      name: 'hub-browser',
      title: 'hub-browser MCP',
      version: '0.1.0',
      browser: makeProvider(),
      spaces: manager,
      spaceEvents: manager.events,
    })
    const { received, close } = await connectTestClient(server)

    const a = await manager.create('agent-a', '搜索任务', 'task-1')
    await manager.handOff('agent-a', a.id)
    await manager.confirmUserControl('agent-a', a.id)
    await manager.takeOver('agent-a', a.id, { confirmed: true })
    const b = await manager.create('agent-a', '第二个空间')
    await manager.switch('agent-a', b.id)
    await manager.closeSpace('agent-a', b.id, { keep: true })

    expect(received.map((n) => n.method)).toEqual([
      'notifications/space/created',
      'notifications/space/handoff_requested',
      'notifications/space/interrupted',
      'notifications/space/agent_active',
      'notifications/space/created',
      'notifications/space/switched',
      'notifications/space/closed',
    ])

    expect(received[0]).toMatchObject({
      params: {
        spaceId: a.id,
        name: '搜索任务',
        owner: 'agent-a',
        ownership: 'agent',
      },
    })
    expect(typeof received[0].params?.timestamp).toBe('number')

    expect(received[1].params).toMatchObject({ spaceId: a.id, ownership: 'agentDelegatedToUser' })
    expect(received[2].params).toMatchObject({ spaceId: a.id, ownership: 'user' })
    expect(received[3].params).toMatchObject({ spaceId: a.id, ownership: 'agent' })
    expect(received[4].params).toMatchObject({ spaceId: b.id, name: '第二个空间' })
    expect(received[5].params).toMatchObject({ spaceId: b.id, ownership: 'agent' })
    expect(received[6].params).toMatchObject({ spaceId: b.id, ownership: 'agent' })

    await close()
  })

  it('emits nothing when no event source is attached (backwards compatible)', async () => {
    const manager = makeManager()
    const { createBrowserMcpServer } = await import('../mcp-server.ts')
    const server = createBrowserMcpServer({
      name: 'hub-browser',
      title: 'hub-browser MCP',
      version: '0.1.0',
      browser: makeProvider(),
      spaces: manager, // manager present, but no spaceEvents → no push
    })
    const { received, close } = await connectTestClient(server)

    const space = await manager.create('agent-a', 'quiet')
    await manager.switch('agent-a', space.id)
    await manager.closeSpace('agent-a', space.id, { keep: true })

    expect(received).toEqual([])
    await close()
  })

  it('never throws when the server has no transport (push is fire-and-forget)', async () => {
    const manager = makeManager()
    const { createBrowserMcpServer } = await import('../mcp-server.ts')
    const server = createBrowserMcpServer({
      name: 'hub-browser',
      title: 'hub-browser MCP',
      version: '0.1.0',
      browser: makeProvider(),
      spaces: manager,
      spaceEvents: manager.events,
    })
    // No server.connect(...) — notifications must be swallowed, not thrown.
    const space = await manager.create('agent-a', 'no-transport')
    await manager.handOff('agent-a', space.id)
    await manager.takeOver('agent-a', space.id, { confirmed: true })
    expect(space.id).toBeTruthy()
    await server.close()
  })

  it('calls the onSpaceEvent observer and survives observer errors', async () => {
    const manager = makeManager()
    const { createBrowserMcpServer } = await import('../mcp-server.ts')
    const seen: string[] = []
    const server = createBrowserMcpServer({
      name: 'hub-browser',
      title: 'hub-browser MCP',
      version: '0.1.0',
      browser: makeProvider(),
      spaces: manager,
      spaceEvents: manager.events,
      onSpaceEvent: (event) => {
        seen.push(`${event.type}:${event.spaceId}`)
        if (event.type === 'space.created') throw new Error('observer boom')
      },
    })
    const { close } = await connectTestClient(server)

    const space = await manager.create('agent-a', 'observed')
    await manager.closeSpace('agent-a', space.id, { keep: true })
    expect(seen).toEqual([
      `space.created:${space.id}`,
      `space.closed:${space.id}`,
    ])
    await close()
  })

  it('unsubscribe stops future pushes', async () => {
    const bus = new SpaceEventBus()
    const manager = new TaskSpaceManager({
      storagePath: tempLedger(),
      events: bus,
      persist: false,
    })
    // Manual wiring on a raw server — createBrowserMcpServer wiring owns its
    // own subscription, so this exercises attachSpaceEventNotifications.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const server = new McpServer({ name: 'raw', version: '0.0.1' })
    const unsub = attachSpaceEventNotifications(server, bus)
    const { received, close } = await connectTestClient(server)

    const space = await manager.create('agent-a', 'first')
    expect(received).toHaveLength(1)
    received.length = 0

    unsub()
    await manager.closeSpace('agent-a', space.id, { keep: true })
    expect(received).toEqual([])
    await close()
  })
})
