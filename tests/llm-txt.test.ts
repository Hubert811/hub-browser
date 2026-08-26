/**
 * P2-9 — `hub --llm-txt`: the agent self-description entry.
 *
 * One command prints an authoritative, version-consistent guide: the bundled
 * hub-browser SKILL.md (single source with the skills system) plus a tool
 * surface enumerated live from the installed build's own modules — the
 * enumeration cannot drift from what `hub --mcp` registers.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { BROWSER_TOOLS, SPACE_TOOLS,
  PAGE_INFO_TOOLS,
  OBSERVATION_TOOLS,
  DISCOVERY_TOOLS,
  PROBE_TOOLS,
} from '../src/browser-mcp/src/tools/registry.ts'
import { AUDIT_TOOLS } from '../src/browser-mcp/src/tools/audit-tools.ts'
import { ADAPTER_TOOLS } from '../src/browser-mcp/src/tools/adapter-tools.ts'
import { REPLAY_TOOLS } from '../src/browser-mcp/src/tools/replay-tools.ts'

const REPO_ROOT = process.cwd()
const HUB_BIN = join(REPO_ROOT, 'bin', 'hub.mjs')

function runLlmTxt(): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HUB_BIN, '--llm-txt'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HUB_AUDIT: 'off' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

describe('hub --llm-txt (P2-9)', () => {
  it('prints the guide from the installed build and exits 0', async () => {
    const { code, stdout } = await runLlmTxt()
    expect(code).toBe(0)
    expect(stdout).toContain('# hub-browser agent guide (hub --llm-txt)')

    // Version-consistency: the printed version is this build's package.json.
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string }
    expect(stdout).toContain(`hub-browser ${pkg.version}`)
  })

  it('enumerates the live MCP tool surface — every registered tool listed', async () => {
    const { stdout } = await runLlmTxt()
    // Every family hub.mjs's llm-txt enumerates — the P2-6 release-drift
    // lesson: a new family mounted in register.ts must land here too (and in
    // hub.mjs), or the self-description under-reports.
    const expected = [
      ...BROWSER_TOOLS, ...SPACE_TOOLS, ...AUDIT_TOOLS, ...REPLAY_TOOLS, ...ADAPTER_TOOLS,
      ...PAGE_INFO_TOOLS, ...OBSERVATION_TOOLS, ...DISCOVERY_TOOLS, ...PROBE_TOOLS,
    ]
    expect(stdout).toContain(`## MCP tool surface (${expected.length} tools)`)
    // Every tool name is listed (the newest families prove no drift).
    for (const tool of expected) {
      expect(stdout).toContain(`- ${tool.name}:`)
    }
    expect(stdout).toContain('- adapter.run:')
    expect(stdout).toContain('- audit.query:')
    expect(stdout).toContain('- replay.list:')
  })

  it('appends the bundled SKILL.md guide (single source with skills/)', async () => {
    const { stdout } = await runLlmTxt()
    // Identifiable lines from skills/hub-browser/SKILL.md.
    expect(stdout).toContain('name: hub-browser')
    expect(stdout).toContain('space.create <name>')
    expect(stdout).toContain('no-space')
  })
})
