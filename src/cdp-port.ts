import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * CDP port resolution for the BrowserOS neo backend (decision D7, 2026-08-04).
 *
 * Resolution order (best-effort, never throws):
 *   1. BROWSEROS_CDP_PORT env var (explicit override, highest priority) —
 *      used when it parses to a valid positive port; invalid/empty is skipped.
 *   2. BrowserOS neo config.json `ports.cdp` (config dir is still BrowserClaw) —
 *      probed once and cached in-process:
 *      macOS  ~/Library/Application Support/BrowserClaw/.browseros[-dev]/config.json
 *      Win    %APPDATA%/BrowserClaw/.browseros[-dev]/config.json
 *      Linux  ~/.config/BrowserClaw/.browseros[-dev]/config.json
 *      BROWSERCLAW_DIR overrides the BrowserOS neo app-support directory on any OS.
 *      .browseros-dev (dev mode) is checked before .browseros (stable).
 *   3. Fallback: 9005 (keeps the pre-D7 default).
 *
 * The probe result is cached in a module-level variable so repeated connects
 * (MCP restore + tool calls, daemon reconnects) do not re-read the disk.
 * `_resetCdpPortCache()` exists as a test hook.
 */
export const CDP_PORT_FALLBACK = 9005

let cachedPort: number | null = null

/** Resolve the CDP port for this process. Never throws. */
export function resolveCdpPort(opts: { configPath?: string } = {}): number {
  const envPort = parsePort(process.env.BROWSEROS_CDP_PORT)
  if (envPort !== null) return envPort

  if (cachedPort !== null) return cachedPort

  cachedPort = probeConfig(opts.configPath) ?? CDP_PORT_FALLBACK
  return cachedPort
}

/** Test hook: drop the in-process probe cache. */
export function _resetCdpPortCache(): void {
  cachedPort = null
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n
  return null
}

function probeConfig(explicitConfigPath?: string): number | null {
  const candidates = explicitConfigPath ? [explicitConfigPath] : configCandidates()
  for (const configPath of candidates) {
    const port = readPortFromConfig(configPath)
    if (port !== null) return port
  }
  return null
}

function readPortFromConfig(configPath: string): number | null {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return null // missing / unreadable → silent fallback
  }
  try {
    const data = JSON.parse(raw) as { ports?: { cdp?: unknown } }
    const port = data?.ports?.cdp
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) {
      return port
    }
  } catch {
    // corrupt JSON → silent fallback
  }
  return null
}

function configCandidates(): string[] {
  const out: string[] = []
  const clawDir = process.env.BROWSERCLAW_DIR
  if (clawDir) {
    // Explicit directory override: use only this base.
    pushConfigCandidates(out, clawDir)
    return out
  }

  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) pushConfigCandidates(out, join(appData, 'BrowserClaw'))
    pushConfigCandidates(out, join(home, 'AppData', 'Roaming', 'BrowserClaw'))
  } else if (process.platform === 'darwin') {
    pushConfigCandidates(out, join(home, 'Library', 'Application Support', 'BrowserClaw'))
  } else {
    pushConfigCandidates(out, join(home, '.config', 'BrowserClaw'))
  }
  return out
}

function pushConfigCandidates(out: string[], baseDir: string): void {
  out.push(join(baseDir, '.browseros-dev', 'config.json'))
  out.push(join(baseDir, '.browseros', 'config.json'))
}
