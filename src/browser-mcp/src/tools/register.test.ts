import { describe, expect, it } from 'bun:test'
import { registerBrowserTools } from '../register'
import type { UnifiedPageProvider } from './framework'
import { BROWSER_TOOLS, SPACE_TOOLS } from './registry'
import { AUDIT_TOOLS } from './audit-tools'
import { REPLAY_TOOLS } from './replay-tools'
import { ADAPTER_TOOLS } from './adapter-tools'
import { PAGE_INFO_TOOLS } from './page-info'
import { OBSERVATION_TOOLS } from './observation-tools'
import { DISCOVERY_TOOLS } from './discovery-tools'
import { PROBE_TOOLS } from './inspect'
import { createFakePage, textOf } from './test-helpers'

type RegisteredHandler = (
  args: Record<string, unknown>,
  extra?: { signal?: AbortSignal },
) => Promise<{
  content: unknown
  isError?: boolean
  structuredContent?: unknown
}>

function createFakeServer() {
  const handlers = new Map<string, RegisteredHandler>()
  const configs = new Map<
    string,
    {
      description: string
      inputSchema?: unknown
      outputSchema?: unknown
      annotations?: unknown
    }
  >()

  return {
    handlers,
    configs,
    server: {
      registerTool(
        name: string,
        config: {
          description: string
          inputSchema?: unknown
          outputSchema?: unknown
          annotations?: unknown
        },
        handler: RegisteredHandler,
      ) {
        configs.set(name, config)
        handlers.set(name, handler)
      },
    },
  }
}

/** Page stub that supports the tabs-new flow: newTab -> targetId, tabs -> pageId. */
function tabsPage(newTabImpl?: (url?: string) => Promise<string | undefined>) {
  return createFakePage({
    newTab: (newTabImpl ?? (async () => 'target-42')) as never,
    tabs: (async () => [
      {
        pageId: 42,
        targetId: 'target-42',
        url: 'about:blank',
        title: 'New tab',
      },
    ]) as never,
  })
}

function providerFor(page: ReturnType<typeof tabsPage>): UnifiedPageProvider {
  return {
    connect: async () => page,
  }
}

describe('registerBrowserTools', () => {
  it('registers the shared browser tool surface', () => {
    const fake = createFakeServer()
    const page = createFakePage()

    registerBrowserTools(fake.server as never, providerFor(page as never))

    expect([...fake.handlers.keys()]).toEqual(
      [...BROWSER_TOOLS, ...SPACE_TOOLS, ...AUDIT_TOOLS, ...REPLAY_TOOLS, ...ADAPTER_TOOLS, ...PAGE_INFO_TOOLS, ...OBSERVATION_TOOLS, ...DISCOVERY_TOOLS, ...PROBE_TOOLS].map((tool) => tool.name),
    )
    expect(fake.configs.get('tabs')?.inputSchema).toBeDefined()
    expect(
      Object.keys(
        fake.configs.get('tabs')?.inputSchema as Record<string, unknown>,
      ).sort(),
    ).toEqual(['action', 'background', 'page', 'url', 'view'])
    expect(
      Object.keys(
        fake.configs.get('windows')?.inputSchema as Record<string, unknown>,
      ).sort(),
    ).toEqual(['action', 'windowId'])
    expect(fake.configs.get('snapshot')?.annotations).toEqual({
      title: 'Snapshot accessibility tree',
      readOnlyHint: true,
    })
    expect(fake.configs.get('tabs')?.outputSchema).toBeUndefined()
    expect(fake.configs.get('run')?.outputSchema).toBeDefined()
  })

  it('preserves structured results when the option is omitted', async () => {
    const fake = createFakeServer()
    const page = tabsPage()

    registerBrowserTools(fake.server as never, providerFor(page))

    const result = await fake.handlers.get('tabs')?.({ action: 'new' })

    expect(result?.structuredContent).toEqual({ page: 42 })
    expect(result).toHaveProperty('structuredContent')
  })

  it('omits ordinary structured results when explicitly disabled', async () => {
    const fake = createFakeServer()
    const debugLogs: Array<{
      message: string
      meta?: Record<string, unknown>
    }> = []
    const page = tabsPage()

    registerBrowserTools(
      fake.server as never,
      providerFor(page),
      {},
      {
        includeStructuredContent: false,
        logger: {
          debug: (message, meta) => debugLogs.push({ message, meta }),
        },
      },
    )

    const result = await fake.handlers.get('tabs')?.({ action: 'new' })

    expect(result).not.toHaveProperty('structuredContent')
    expect(debugLogs.at(-1)).toEqual({
      message: 'MCP browser tool completed',
      meta: expect.objectContaining({ hasStructuredContent: false }),
    })
  })

  it('keeps schema-declared run structured in both modes', async () => {
    for (const includeStructuredContent of [undefined, false]) {
      const fake = createFakeServer()
      const page = tabsPage()

      registerBrowserTools(
        fake.server as never,
        providerFor(page),
        {},
        { includeStructuredContent },
      )

      const result = await fake.handlers.get('run')?.({ code: 'return 42' })

      expect(result?.structuredContent).toEqual({
        ok: true,
        value: 42,
        logs: [],
      })
    }
  })

  it('logs sampled registration and records failed tool executions', async () => {
    const fake = createFakeServer()
    const debugLogs: Array<{
      message: string
      meta?: Record<string, unknown>
    }> = []
    const infoLogs: Array<{ message: string; meta?: Record<string, unknown> }> =
      []
    const events: Array<Record<string, unknown>> = []
    const page = tabsPage(async () => {
      throw new Error('tab creation failed')
    })

    registerBrowserTools(
      fake.server as never,
      providerFor(page),
      {},
      {
        logger: {
          debug: (message, meta) => debugLogs.push({ message, meta }),
          info: (message, meta) => infoLogs.push({ message, meta }),
        },
        onToolExecuted: (event) => events.push(event),
        shouldLogToolRegistration: () => true,
        source: 'unit-test',
      },
    )

    const result = await fake.handlers.get('tabs')?.({
      action: 'new',
      url: 'https://example.com',
    })

    expect(infoLogs).toEqual([
      {
        message: 'Registered browser MCP tools',
        meta: expect.objectContaining({
          count: BROWSER_TOOLS.length + SPACE_TOOLS.length + AUDIT_TOOLS.length + REPLAY_TOOLS.length + ADAPTER_TOOLS.length + PAGE_INFO_TOOLS.length + OBSERVATION_TOOLS.length + DISCOVERY_TOOLS.length + PROBE_TOOLS.length,
          source: 'unit-test',
        }),
      },
      {
        message: 'MCP browser tool returned error',
        meta: expect.objectContaining({
          toolName: 'tabs',
          source: 'unit-test',
          errorSummary: expect.objectContaining({
            contentCount: expect.any(Number),
            textBlockCount: expect.any(Number),
            textLength: expect.any(Number),
            lineCount: expect.any(Number),
          }),
        }),
      },
    ])
    expect(JSON.stringify(infoLogs)).not.toContain('tab creation failed')
    expect(debugLogs.map((log) => log.message)).toEqual([
      'MCP browser tool started',
      'MCP browser tool completed',
    ])
    expect(debugLogs[0]?.meta).toEqual(
      expect.objectContaining({
        toolName: 'tabs',
        source: 'unit-test',
        args: expect.objectContaining({
          action: 'new',
          urlOrigin: 'https://example.com',
        }),
      }),
    )
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('tab creation failed')
    expect(events).toEqual([
      expect.objectContaining({
        tool_name: 'tabs',
        success: false,
        source: 'unit-test',
      }),
    ])
    expect(events[0]?.duration_ms).toEqual(expect.any(Number))
  })

  it('fires lifecycle callbacks around browser tool execution', async () => {
    const fake = createFakeServer()
    let resolveNewTab: ((value: string) => void) | undefined
    const starts: Array<Record<string, unknown>> = []
    const ends: Array<Record<string, unknown>> = []
    const page = tabsPage(
      () =>
        new Promise<string>((resolve) => {
          resolveNewTab = resolve
        }),
    )

    registerBrowserTools(
      fake.server as never,
      providerFor(page),
      {},
      {
        onToolExecutionStart: (event) => starts.push(event),
        onToolExecutionEnd: (event) => ends.push(event),
        source: 'unit-test',
      },
    )

    const run = fake.handlers.get('tabs')?.({
      action: 'new',
      url: 'https://example.com',
    })
    // p18 made the pre-newTab pipeline async (identity resolve + audit +
    // guard await), so one microtask no longer reaches page.newTab — drain
    // microtasks until the pending newTab executor has captured its resolver,
    // otherwise resolveNewTab?.() is a no-op and `await run` hangs forever.
    for (let i = 0; i < 200 && resolveNewTab === undefined; i++) {
      await Promise.resolve()
    }

    expect(starts).toEqual([{ tool_name: 'tabs', source: 'unit-test' }])
    expect(ends).toEqual([])

    resolveNewTab?.('target-42')
    await run

    expect(ends).toEqual([{ tool_name: 'tabs', source: 'unit-test' }])
  })
})
