import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Worker script each concurrent process runs: N rounds of create + (every other
 * round) close against the shared ledger, through a manager that must CLAIM the
 * ledger before it may write.
 */
function workerScript(): string {
  return `
import { TaskSpaceManager } from ${JSON.stringify(path.join(REPO_ROOT, 'src/space/task-space-manager.ts'))}
const [ledger, worker, roundsRaw] = process.argv.slice(2)
const rounds = Number(roundsRaw)
const m = new TaskSpaceManager({ storagePath: ledger, persist: true })
for (let i = 0; i < rounds; i++) {
  const owner = \`w\${worker}-s\${i}\`
  const s = await m.create(owner, \`worker-\${worker}-space-\${i}\`)
  if (i % 2 === 0) await m.closeSpace(owner, s.id, { keep: true })
}
m.dispose()
process.stderr.write('WORKER-DONE ' + worker + '\\n')
`
}

function runWorker(scriptPath: string, ledger: string, worker: string, rounds: number) {
  const child = spawn('bun', [scriptPath, ledger, worker, String(rounds)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

describe('ledger authority (M5 — one writer by construction)', () => {
  it('two processes racing the same ledger: exactly ONE may write it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-race-'))
    const ledger = path.join(dir, 'hub-spaces.json')
    const scriptPath = path.join(dir, 'worker.ts')
    fs.writeFileSync(scriptPath, workerScript(), 'utf-8')

    const rounds = 25
    const [a, b] = await Promise.all([
      runWorker(scriptPath, ledger, 'a', rounds),
      runWorker(scriptPath, ledger, 'b', rounds),
    ])
    // Both processes exit cleanly: the loser is not crashed, it is READ-ONLY
    // (and says so), because two writers is the thing M5 removed.
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)

    const losers = [a, b].filter((w) => w.stderr.includes('read-only for this process'))
    const winners = [a, b].filter((w) => !w.stderr.includes('read-only for this process'))
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)

    // The ledger parses, holds ONLY the winner's spaces (the loser's never
    // landed — it was read-only), and leaves no lock/tmp/authority debris.
    const final = JSON.parse(fs.readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, { owner: string }>
    }
    const winnerId = /WORKER-DONE (\w+)/.exec(winners[0].stderr)?.[1]
    expect(winnerId).toBeTruthy()
    const owners = new Set(Object.values(final.spaces).map((s) => s.owner))
    expect(owners.size).toBeGreaterThan(0)
    for (const owner of owners) {
      expect(owner.startsWith(`w${winnerId}-`)).toBe(true)
    }
    const debris = fs
      .readdirSync(dir)
      .filter((f) => f !== 'hub-spaces.json' && f !== 'worker.ts')
    expect(debris).toEqual([])
  }, 60_000)
})
