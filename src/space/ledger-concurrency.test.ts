import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Worker script each concurrent process runs: N rounds of create + (every
 * other round) close-with-tombstone against the shared ledger. Every round
 * exercises the locked read-merge-write save path.
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

describe('ledger concurrency (P1-7, real cross-process)', () => {
  it('two processes racing create/close keep the ledger conserved and intact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-race-'))
    const ledger = path.join(dir, 'hub-spaces.json')
    const scriptPath = path.join(dir, 'worker.ts')
    fs.writeFileSync(scriptPath, workerScript(), 'utf-8')

    const rounds = 25
    const [a, b] = await Promise.all([
      runWorker(scriptPath, ledger, 'a', rounds),
      runWorker(scriptPath, ledger, 'b', rounds),
    ])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)

    // The ledger parses (no torn write) and no lock/tmp debris is left behind.
    const final = JSON.parse(fs.readFileSync(ledger, 'utf-8')) as {
      spaces: Record<string, unknown>
      deletedSpaces: string[]
    }
    const debris = fs.readdirSync(dir).filter((f) => f !== 'hub-spaces.json' && f !== 'worker.ts')
    expect(debris).toEqual([])

    // Conservation: every created space is either alive or tombstoned, and
    // the two sets are disjoint — close tombstones were never lost to a
    // concurrent merge, and no closed space was resurrected.
    const alive = new Set(Object.keys(final.spaces))
    const dead = new Set(final.deletedSpaces ?? [])
    const total = 2 * rounds
    expect(alive.size + dead.size).toBe(total)
    for (const id of dead) expect(alive.has(id)).toBe(false)
  }, 60_000)
})
