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

/**
 * Claw-server HTTP port fallback (the pre-drift default). The real port is
 * read from config.json `ports.server` — the server binds 9210 by default but
 * silently rebinds when the port is taken, and that drift is invisible to
 * consumers that hard-code 9210 (the P2-3 cockpit feed broke exactly this way).
 */
export const CLAW_SERVER_PORT_FALLBACK = 9210

let cachedPort: number | null = null
let cachedClawServerPort: number | null = null

/** Resolve the CDP port for this process. Never throws. */
export function resolveCdpPort(opts: { configPath?: string } = {}): number {
  const envPort = parsePort(process.env.BROWSEROS_CDP_PORT)
  if (envPort !== null) return envPort

  if (cachedPort === null) {
    cachedPort = probeConfig('cdp', opts.configPath) ?? CDP_PORT_FALLBACK
  }
  return cachedPort
}

/** Test hook: drop the in-process probe cache. */
export function _resetCdpPortCache(): void {
  cachedPort = null
}

/**
 * Resolve the BrowserClaw server's HTTP port (harness API / cockpit feed).
 * Same resolution shape as the CDP port: env override → config.json
 * `ports.server` → fallback 9210. Probed once and cached in-process.
 */
export function resolveClawServerPort(opts: { configPath?: string } = {}): number {
  const envPort = parsePort(process.env.HUB_CLAW_SERVER_PORT)
  if (envPort !== null) return envPort

  if (cachedClawServerPort === null) {
    cachedClawServerPort = probeConfig('server', opts.configPath) ?? CLAW_SERVER_PORT_FALLBACK
  }
  return cachedClawServerPort
}

/** Test hook: drop the in-process claw-server port cache. */
export function _resetClawServerPortCache(): void {
  cachedClawServerPort = null
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n
  return null
}

function probeConfig(field: 'cdp' | 'server', explicitConfigPath?: string): number | null {
  const candidates = explicitConfigPath ? [explicitConfigPath] : configCandidates()
  for (const configPath of candidates) {
    const port = readPortFromConfig(configPath, field)
    if (port !== null) return port
  }
  return null
}

function readPortFromConfig(configPath: string, field: 'cdp' | 'server'): number | null {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return null // missing / unreadable → silent fallback
  }
  try {
    const data = JSON.parse(raw) as { ports?: Record<string, unknown> }
    const port = data?.ports?.[field]
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
