/**
 * Process-global env scoping for tests.
 *
 * Every test file shares ONE bun process, so a test that sets `process.env.X`
 * and walks away is not causing local damage — it is changing the environment
 * of whichever file runs next. That used to be invisible; with the ledger
 * authority (M5) it turned into a hard failure: an unrelated file's daemon
 * inherited a leaked `HUB_SPACES_FILE`, found the path owned by a live holder,
 * and correctly refused to start.
 *
 * Usage:
 *   const env = scopeEnv(['HUB_SPACES_FILE', 'BROWSEROS_DIR', 'HUB_AGENT_ID'])
 *   ...
 *   afterEach(() => env.restore())
 */
export interface EnvScope {
  restore(): void
}

export function scopeEnv(keys: readonly string[]): EnvScope {
  const saved = new Map<string, string | undefined>()
  for (const key of keys) saved.set(key, process.env[key])
  let restored = false
  return {
    restore(): void {
      // Idempotent: a test may restore in its own finally AND via afterEach.
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restored = true
      void restored
    },
  }
}
