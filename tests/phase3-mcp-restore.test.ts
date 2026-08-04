/**
 * Phase 3 A — `hub --mcp` auto-restore wiring.
 *
 * Failure path (no live CDP in the unit suite): the MCP server must start and
 * serve space.* tools even when the startup restore cannot reach the browser —
 * restore failures are caught and logged, never allowed to drag startup down.
 * The success path (real Chrome) is covered by tests/phase3-space-live-smoke.ts.
 */
import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TaskSpaceManager } from '../src/space/task-space-manager.ts'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

async function seedLedger(): Promise<{ ledger: string; spaceId: string }> {
  const ledger = join(
    fs.mkdtempSync(join(os.tmpdir(), 'mcp-restore-')),
    'hub-spaces.json',
  )
  // Fake gateway only to record the tab in the ledger; it is never reached
  // because the MCP subprocess cannot connect to a browser on port 9.
  const fakeGateway = {
    newTab: async () => 500,
    closeTab: async () => {},
    listTabs: async () => [{ pageId: 500, targetId: 'target-x', url: 'https://seed.example' }],
  }
  const manager = new TaskSpaceManager({
    storagePath: ledger,
    gateway: fakeGateway,
    persist: true,
  })
  const space = await manager.create('mcp-restore-test', 'seed-space')
  // Pending (not-yet-restored) tab — the exact state a daemon/MCP start must
  // reconcile via restore().
  await manager.openTab('mcp-restore-test', space.id, 'https://seed.example')
  manager.dispose()
  return { ledger, spaceId: space.id }
}

describe('hub --mcp startup restore (Phase 3 A)', () => {
  it('server starts and serves space tools even when startup restore cannot connect', async () => {
    const { ledger } = await seedLedger()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['bin/hub.mjs', '--mcp'],
      cwd: projectRoot,
      env: {
        ...process.env,
        BROWSEROS_CDP_PORT: '9', // unreachable → restore must fail softly
        HUB_AGENT_ID: 'mcp-restore-test',
        HUB_SPACES_FILE: ledger,
      },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'phase3-restore-fail', version: '0.0.1' })
    await client.connect(transport)

    const listed = await client.callTool({ name: 'space.list', arguments: {} })
    expect(listed.isError).toBeFalsy()
    const count = (listed.structuredContent as { count?: number } | undefined)?.count
    expect(count).toBe(1)

    const current = await client.callTool({ name: 'space.current', arguments: {} })
    expect(current.isError).toBeFalsy()

    await client.close()
  })
})
