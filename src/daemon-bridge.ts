/**
 * M5 — `hub --mcp` as a CLIENT of the daemon, not a second ledger authority.
 *
 * Why this exists (docs/specs/space-ledger-architecture.md, M5): the ledger's
 * authority has to be ONE process. A stdio MCP server used to be a fully
 * self-contained hub — its own TaskSpaceManager, its own browser connection —
 * so every `hub --mcp` process was a second writer, and the storage layer had
 * to carry a cross-process lock, merge-on-save and close tombstones just to
 * survive that. Those three exist ONLY because of the second writer; this
 * bridge is what lets them go.
 *
 * Shape: a **transport-level forwarder**, not an MCP implementation. Each
 * JSON-RPC line from stdin is POSTed to the daemon's Streamable-HTTP `/mcp`;
 * whatever comes back — a JSON body or an SSE stream — is written to stdout as
 * lines. A long-lived GET stream carries server-initiated messages (the
 * `notifications/space/*` events). No MCP semantics are interpreted here, so
 * this cannot drift from what the daemon actually does.
 *
 * Escape hatch: `HUB_MCP_EMBEDDED=true` keeps the old self-contained behaviour
 * (its own manager + browser connection) for anyone who needs it — that mode is
 * a second writer again, which is exactly why it is opt-in.
 */
import { execSync, spawn } from 'node:child_process'

export interface EnsureDaemonOptions {
  port: number
  /** The hub entry script to re-exec as a daemon (`__filename` in bin/hub.mjs). */
  hubBin: string
  cwd?: string
  /** How long to wait for a freshly spawned daemon to answer /health. */
  timeoutMs?: number
  /** Skip spawning; only report whether one is already up. */
  spawnIfMissing?: boolean
  /**
   * The ledger this client expects the daemon to own. `/health` reports the
   * daemon's own ledger path; a mismatch is a CONFIGURATION conflict (two
   * clients pointed at different ledgers on one port), so it is refused rather
   * than resolved by killing the other party.
   */
  ledger?: string
  /** Warning sink (defaults to stderr); used for refuse/replace explanations. */
  warn?: (message: string) => void
}

/** The identity a hub daemon reports on `/health` (older builds: `status` only). */
export interface DaemonHealth {
  status?: string
  pid?: number
  version?: string
  /** The daemon's space ledger path — absent on builds before this identity. */
  ledger?: string
}

/** `/health` body, or undefined when nothing answers / the answer is not ok. */
export async function daemonHealth(
  port: number,
  timeoutMs = 1000,
): Promise<DaemonHealth | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return undefined
    return (await res.json()) as DaemonHealth
  } catch {
    return undefined
  }
}

/**
 * SIGTERM whatever is LISTENING on `port`.
 *
 * An older hub build reports no pid, so identity alone cannot stop it; the
 * listener has to be found by port. Best-effort: a missing `lsof` or a
 * permission failure just means the caller falls through to the spawn attempt.
 */
function stopListener(port: number): boolean {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: 'utf-8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (pids.length === 0) return false
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM')
      } catch {
        // already gone / not ours to signal
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Make sure a daemon serving `port` is one THIS client can use, spawning one if
 * needed.
 *
 * Measured on the real machine before the identity check existed: a new
 * `hub --mcp` bridged to an older build that answered `{"status":"ok"}`, ran the
 * old command implementations, and landed its `space.create` in the OLD
 * daemon's ledger while its own HUB_SPACES_FILE was never created. Silent
 * misdirection. Three outcomes are therefore pinned:
 *   - same ledger + identity  → reuse;
 *   - different ledger        → REFUSE (configuration conflict; killing the
 *                               other party would just make two clients fight
 *                               over the port);
 *   - no identity             → an older hub build → replace it.
 * The spawned daemon inherits this process's env, which is what carries
 * HUB_SPACES_FILE / BROWSEROS_CDP_PORT / HUB_SESSION_END_SPACES into it — i.e.
 * the client's configuration decides the authority's.
 */
export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<boolean> {
  const warn = opts.warn ?? ((message: string) => process.stderr.write(message))
  const existing = await daemonHealth(opts.port)
  if (existing) {
    const expected = opts.ledger
    if (
      existing.ledger !== undefined &&
      expected !== undefined &&
      existing.ledger !== expected
    ) {
      warn(
        `[hub] the daemon on port ${opts.port} owns a different space ledger:\n` +
          `[hub]   daemon: ${existing.ledger}\n` +
          `[hub]   client: ${expected}\n` +
          `[hub] stop it, or point HUB_DAEMON_PORT at a free port for this ledger.\n`,
      )
      return false
    }
    if (existing.version === undefined) {
      warn(
        `[hub] replacing an older hub daemon on port ${opts.port}` +
          `${existing.pid !== undefined ? ` (pid ${existing.pid})` : ''}: ` +
          `it predates daemon identity and would serve stale behaviour.\n`,
      )
      stopListener(opts.port)
      const gone = Date.now() + 5000
      while (Date.now() < gone && (await daemonHealth(opts.port, 300))) {
        await new Promise((r) => setTimeout(r, 150))
      }
    } else {
      return true
    }
  }
  if (opts.spawnIfMissing === false) return false
  try {
    const proc = spawn(process.execPath, [opts.hubBin], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HUB_DAEMON: 'true' },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    })
    proc.unref()
  } catch {
    return false
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 10000)
  while (Date.now() < deadline) {
    if (await daemonHealth(opts.port, 1000)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

export interface StdioBridgeOptions {
  daemonPort: number
  /** Identity to forward to the daemon as `x-hub-agent-id`. */
  agentId?: string
}

/** Write one line to stdout, waiting for drain when the pipe is full. */
function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.write(line + '\n')) {
      resolve()
      return
    }
    process.stdout.once('drain', () => resolve())
  })
}

/** Split an SSE body into its JSON-RPC payloads. */
function ssePayloads(text: string): string[] {
  const out: string[] = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload) out.push(payload)
    }
  }
  return out
}

/**
 * Run the stdio↔daemon bridge until stdin ends. Resolves when the session is
 * over; never returns while the client is still connected.
 */
export async function runStdioBridge(opts: StdioBridgeOptions): Promise<void> {
  const base = `http://127.0.0.1:${opts.daemonPort}/mcp`
  let sessionId = ''
  let closed = false

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(opts.agentId ? { 'x-hub-agent-id': opts.agentId } : {}),
  })

  /** Forward one client→server message; emit whatever comes back. */
  const forward = async (raw: string): Promise<void> => {
    let res: Response
    try {
      res = await fetch(base, { method: 'POST', headers: headers(), body: raw })
    } catch (err) {
      process.stderr.write(
        `[hub-mcp] daemon request failed: ${(err as Error)?.message ?? String(err)}\n`,
      )
      return
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    if (!text) return // notifications get a body-less 202
    const contentType = res.headers.get('content-type') ?? ''
    const payloads = contentType.includes('text/event-stream')
      ? ssePayloads(text)
      : [text.trim()]
    for (const payload of payloads) {
      if (payload) await writeLine(payload)
    }
  }

  /**
   * The server-initiated channel. Opened once the session exists; every message
   * it carries (space-event notifications) goes straight to stdout.
   */
  const openServerStream = async (): Promise<void> => {
    try {
      const res = await fetch(base, { method: 'GET', headers: headers() })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload) await writeLine(payload)
          }
        }
      }
    } catch {
      // The daemon went away (or the stream was aborted): stdin will end too.
    }
  }

  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (sessionId) {
      try {
        await fetch(base, { method: 'DELETE', headers: headers() })
      } catch {
        // best-effort: the daemon's own teardown is the backstop
      }
    }
  }

  await new Promise<void>((resolve) => {
    let buffer = ''
    let serverStreamStarted = false
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        void (async () => {
          await forward(line)
          // The server-initiated channel needs a session id, which only exists
          // after the initialize response.
          if (!serverStreamStarted && sessionId) {
            serverStreamStarted = true
            void openServerStream()
          }
        })()
      }
    })
    process.stdin.on('end', () => resolve())
    process.stdin.on('close', () => resolve())
    process.stdin.resume()
  })

  await cleanup()
}
