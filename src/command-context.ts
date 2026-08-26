/**
 * P1-3 (part 2) — explicit CommandContext for daemon /command execution.
 *
 * The daemon used to isolate per-command state by mutating process.env
 * (HUB_AGENT_ID / HUB_SPACES_FILE, bug #3) and monkey-patching
 * console.log/error/warn/info + process.stdout/stderr.write inline in
 * handleDaemonCommand. This module turns that into one explicit,
 * scoped mechanism:
 *
 *   - identity: the effective SpaceIdentity of the command (convoId =
 *     HUB_AGENT_ID, mirroring LOCAL_SPACE_IDENTITY in cli.js), available
 *     for audit without touching globals.
 *   - output: a per-command capture sink ({ stdout, stderr } buffers).
 *   - startedAt: when the command started (audit timeline).
 *
 * runWithCommandContext installs the capture + env binding for the
 * duration of one command and always restores them (finally), so the
 * daemon's serialized command queue can never leak a caller's identity
 * into the next command.
 *
 * P2-2 hook: the audit layer will subscribe to context completion here
 * (identity + output + duration + exitCode) instead of relying on globals.
 *
 * NOTE: while capture is process-global (console is), /command runs stay
 * serialized — one CommandContext at a time. True concurrency needs the
 * process-unification track (P3-4).
 */
import type { SpaceIdentity } from './space/task-space-manager.js'

export interface CommandOutput {
  stdout: Buffer[]
  stderr: Buffer[]
}

export interface CommandContext {
  /** Effective identity of the command caller (convoId = HUB_AGENT_ID). */
  identity: SpaceIdentity
  /** Ledger path override for this command, when provided. */
  spacesFile: string | undefined
  /** Captured output buffers (filled by runWithCommandContext). */
  output: CommandOutput
  /** Wall-clock start of the command (ms epoch). */
  startedAt: number
}

export interface CommandEnvInput {
  HUB_AGENT_ID?: string
  HUB_SPACES_FILE?: string
}

/** Effective per-command identity, mirroring cli.js LOCAL_SPACE_IDENTITY. */
export function commandIdentityFromEnv(env: CommandEnvInput): SpaceIdentity {
  const agentId = env.HUB_AGENT_ID || 'cli:local'
  return { agentId, convoId: agentId, displayName: 'hub daemon command' }
}

/**
 * Builds an explicit CommandContext from the per-command env payload the
 * CLI forwards to the daemon (/command body.env).
 */
export function createCommandContext(env: CommandEnvInput = {}): CommandContext {
  return {
    identity: commandIdentityFromEnv(env),
    spacesFile: env.HUB_SPACES_FILE,
    output: { stdout: [], stderr: [] },
    startedAt: Date.now(),
  }
}

/**
 * Runs `fn` with the command's capture + env binding installed; always
 * restores them. Returns fn's result. The context's output buffers collect
 * everything the command writes via console.* and process.stdout/stderr.
 */
export async function runWithCommandContext<T>(
  ctx: CommandContext,
  fn: () => Promise<T>,
): Promise<T> {
  const { output } = ctx

  const origLog = console.log
  const origError = console.error
  const origWarn = console.warn
  const origInfo = console.info
  const origWrite = process.stdout.write.bind(process.stdout)
  const origErrWrite = process.stderr.write.bind(process.stderr)

  console.log = (...a: unknown[]) => {
    output.stdout.push(Buffer.from(a.join(' ') + '\n'))
  }
  console.error = (...a: unknown[]) => {
    output.stderr.push(Buffer.from(a.join(' ') + '\n'))
  }
  console.warn = (...a: unknown[]) => {
    output.stderr.push(Buffer.from(a.join(' ') + '\n'))
  }
  console.info = (...a: unknown[]) => {
    output.stdout.push(Buffer.from(a.join(' ') + '\n'))
  }
  process.stdout.write = (chunk: Uint8Array | string) => {
    output.stdout.push(Buffer.from(chunk))
    return true
  }
  process.stderr.write = (chunk: Uint8Array | string) => {
    output.stderr.push(Buffer.from(chunk))
    return true
  }

  // Bridge layer: cli.js's LOCAL_SPACE_IDENTITY still reads process.env, so
  // bind the caller's values for the duration of this command (bug #3).
  const savedEnv = {
    HUB_AGENT_ID: process.env.HUB_AGENT_ID,
    HUB_SPACES_FILE: process.env.HUB_SPACES_FILE,
  }
  if (ctx.identity.agentId !== 'cli:local') {
    process.env.HUB_AGENT_ID = ctx.identity.agentId
  }
  if (ctx.spacesFile !== undefined) {
    process.env.HUB_SPACES_FILE = ctx.spacesFile
  }

  const restore = () => {
    if (savedEnv.HUB_AGENT_ID === undefined) delete process.env.HUB_AGENT_ID
    else process.env.HUB_AGENT_ID = savedEnv.HUB_AGENT_ID
    if (savedEnv.HUB_SPACES_FILE === undefined) delete process.env.HUB_SPACES_FILE
    else process.env.HUB_SPACES_FILE = savedEnv.HUB_SPACES_FILE
    console.log = origLog
    console.error = origError
    console.warn = origWarn
    console.info = origInfo
    process.stdout.write = origWrite
    process.stderr.write = origErrWrite
  }

  try {
    return await fn()
  } finally {
    restore()
  }
}
