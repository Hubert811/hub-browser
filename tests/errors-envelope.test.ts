/**
 * bug 4 — toEnvelope must preserve SpaceGuardError codes (e.g. 'no-space')
 * instead of collapsing them to 'UNKNOWN' (SpaceGuardError is not a CliError).
 */
import { describe, expect, it } from 'bun:test'
import {
  CliError,
  EXIT_CODES,
  toEnvelope,
} from '../src/opencli-engine/errors.js'
import { SpaceGuardError } from '../src/space/task-space-manager.ts'

describe('toEnvelope — structured error envelope (bug 4)', () => {
  it('CliError branch is unchanged (code / message / hint→help / exitCode)', () => {
    const err = new CliError(
      'AUTH_REQUIRED',
      'login needed',
      'run hub auth login',
      EXIT_CODES.NOPERM,
    )
    const env = toEnvelope(err)
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('AUTH_REQUIRED')
    expect(env.error.message).toBe('login needed')
    expect(env.error.help).toBe('run hub auth login')
    expect(env.error.exitCode).toBe(EXIT_CODES.NOPERM)
    expect(env.error.hint).toBeUndefined()
  })

  it('SpaceGuardError keeps its code (no-space) instead of UNKNOWN', () => {
    const err = new SpaceGuardError(
      'no-space',
      "agent has no space; run 'hub space create <name>' first",
      { hint: 'create a task space first, then re-run the adapter command' },
    )
    const env = toEnvelope(err)
    expect(env.ok).toBe(false)
    expect(env.error.code).toBe('no-space')
    expect(env.error.message).toContain("agent has no space")
    expect(env.error.hint).toBe('create a task space first, then re-run the adapter command')
    expect(env.error.exitCode).toBe(EXIT_CODES.GENERIC_ERROR)
  })

  it('SpaceGuardError without a hint still renders (hint omitted)', () => {
    const env = toEnvelope(new SpaceGuardError('user-controlling', 'user holds the space'))
    expect(env.error.code).toBe('user-controlling')
    expect(env.error.message).toBe('user holds the space')
    expect(env.error.hint).toBeUndefined()
    expect(env.error.exitCode).toBe(EXIT_CODES.GENERIC_ERROR)
  })

  it('plain errors still map to UNKNOWN', () => {
    const env = toEnvelope(new Error('boom'))
    expect(env.error.code).toBe('UNKNOWN')
    expect(env.error.exitCode).toBe(EXIT_CODES.GENERIC_ERROR)
  })

  it('structural fallback: a foreign SpaceGuardError copy is recognized by name+code', () => {
    // Simulates an error thrown from another module-graph copy of
    // task-space-manager (instanceof across copies can be false).
    class ForeignSpaceGuardError extends Error {
      code: string
      hint?: string
      constructor(code: string, message: string, hint?: string) {
        super(message)
        this.name = 'SpaceGuardError'
        this.code = code
        if (hint !== undefined) this.hint = hint
      }
    }
    const env = toEnvelope(
      new ForeignSpaceGuardError('no-space', 'no space here', 'create one'),
    )
    expect(env.error.code).toBe('no-space')
    expect(env.error.hint).toBe('create one')
  })
})
