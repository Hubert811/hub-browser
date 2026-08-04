import { describe, expect, it } from 'bun:test'
import { BROWSER_MCP_INSTRUCTIONS } from './mcp-prompt'
import { createBrowserMcpServer } from './mcp-server'
import { BROWSER_TOOLS, SPACE_TOOLS } from './tools/registry'
import { createFakePage, textOf } from './tools/test-helpers'
import type { UnifiedPageProvider } from './tools/framework'

type RegisteredTool = {
  description: string
  handler: (
    args: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<{
    content: unknown
    isError?: boolean
    structuredContent?: unknown
  }>
}

type InspectableBrowserMcpServer = {
  _registeredTools: Record<string, RegisteredTool>
  server: {
    _capabilities: Record<string, unknown>
    _instructions?: string
    _requestHandlers: Map<
      string,
      (
        request: Record<string, unknown>,
        extra: Record<string, unknown>,
      ) => Promise<unknown> | unknown
    >
  }
}

function inspect(server: unknown) {
  return server as InspectableBrowserMcpServer
}

describe('createBrowserMcpServer', () => {
  it('creates a browser-only MCP server with the shared tool catalogue', () => {
    const server = inspect(
      createBrowserMcpServer({
        name: 'browseros_mcp',
        title: 'BrowserOS MCP server',
        version: '1.2.3',
        browser: {
          connect: async () => createFakePage(),
        } as UnifiedPageProvider,
      }),
    )

    expect(Object.keys(server._registeredTools)).toEqual(
      [...BROWSER_TOOLS, ...SPACE_TOOLS].map((tool) => tool.name),
    )
    expect(server.server._capabilities).toEqual({
      logging: {},
      tools: { listChanged: true },
    })
    expect(server.server._instructions).toBe(BROWSER_MCP_INSTRUCTIONS)
    expect(server.server._requestHandlers.has('logging/setLevel')).toBe(true)
  })

  it('passes defaults and registration hooks through to browser tools', async () => {
    const opened: Array<{ url?: string }> = []
    const events: Array<Record<string, unknown>> = []
    const page = createFakePage({
      newTab: (async (url?: string) => {
        opened.push({ url })
        return 'target-42'
      }) as never,
      tabs: (async () => [
        {
          pageId: 42,
          targetId: 'target-42',
          url: 'about:blank',
          title: 'New tab',
        },
      ]) as never,
    })
    const provider: UnifiedPageProvider = {
      connect: async () => page,
    }

    const server = inspect(
      createBrowserMcpServer({
        name: 'browseros_mcp',
        title: 'BrowserOS MCP server',
        version: '1.2.3',
        browser: provider,
        defaultWindowId: 7,
        defaultTabGroupId: 'group-a',
        instructions: 'custom browser instructions',
        registration: {
          source: 'unit-test',
          onToolExecuted: (event) => events.push(event),
        },
      }),
    )

    const result = await server._registeredTools.tabs.handler({
      action: 'new',
      url: 'https://example.com',
    })

    expect(server.server._instructions).toBe('custom browser instructions')
    expect(result?.isError).toBeFalsy()
    expect(result?.structuredContent).toEqual({ page: 42 })
    expect(opened).toEqual([{ url: 'https://example.com' }])
    expect(events).toEqual([
      expect.objectContaining({
        tool_name: 'tabs',
      }),
    ])
    expect(events[0]?.duration_ms).toEqual(expect.any(Number))
    expect(textOf(result)).toContain('opened page 42')
  })

  it('surfaces tool failures as error results', async () => {
    const page = createFakePage({
      tabs: (async () => {
        throw new Error('tab list failed')
      }) as never,
    })
    const server = inspect(
      createBrowserMcpServer({
        name: 'browseros_mcp',
        title: 'BrowserOS MCP server',
        version: '1.2.3',
        browser: { connect: async () => page },
      }),
    )

    const result = await server._registeredTools.tabs.handler({
      action: 'list',
    })

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('tab list failed')
  })
})

describe('createBrowserMcpServer legacy browserSession binding', () => {
  /** Minimal vendored-BrowserSession-shaped fake (pages.list + protocol). */
  function fakeSession() {
    return {
      pages: {
        list: async () => [
          { pageId: 7, targetId: 't7', url: 'https://example.com/7', title: 'Page 7', isActive: true },
        ],
        getSession: async () => ({
          session: {
            Runtime: {
              evaluate: async () => ({ result: { value: '<html><body>hi</body></html>' } }),
              enable: async () => {},
            },
          },
          sessionId: 's7',
        }),
        getInfo: (pageId: number) =>
          pageId === 7 ? { pageId: 7, targetId: 't7', url: 'https://example.com/7', title: 'Page 7' } : undefined,
      },
      protocol: { onSessionEvent: () => () => {} },
      dispose: async () => {},
    }
  }

  it('accepts the vendored browserSession binding and runs browser tools', async () => {
    const server = inspect(
      createBrowserMcpServer({
        name: 'browseros_mcp',
        title: 'BrowserOS MCP server',
        version: '1.2.3',
        browserSession: fakeSession() as never,
      }),
    )

    // full fork surface: 17 browser + 13 space tools
    expect(Object.keys(server._registeredTools)).toEqual(
      [...BROWSER_TOOLS, ...SPACE_TOOLS].map((tool) => tool.name),
    )

    const tabsHandler = server._registeredTools['tabs'].handler
    const result = await tabsHandler({ action: 'list' })
    expect(result.isError).toBeFalsy()
    const text = JSON.stringify(result.content)
    expect(text).toContain('Page 7')
  })

  it('throws when neither browser nor browserSession is provided', () => {
    expect(() =>
      createBrowserMcpServer({
        name: 'x',
        title: 'x',
        version: '1',
      } as never),
    ).toThrow(/browser/)
  })
})
