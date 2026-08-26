/**
 * D7 (2026-08-04): CDP port auto-detection from BrowserOS neo config.
 *
 * Resolution order: BROWSEROS_CDP_PORT env (explicit override) → BrowserOS neo
 * config.json `ports.cdp` (probed once, cached in-process) → fallback 9005.
 * All probes are best-effort and silent: missing/corrupt configs fall back.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CDP_PORT_FALLBACK,
  CLAW_SERVER_PORT_FALLBACK,
  _resetCdpPortCache,
  _resetClawServerPortCache,
  resolveCdpPort,
  resolveClawServerPort,
} from '../src/cdp-port.ts'

const tmpDir = mkdtempSync(join(tmpdir(), 'cdp-port-test-'))

beforeEach(() => {
  delete process.env.BROWSEROS_CDP_PORT
  delete process.env.BROWSERCLAW_DIR
  delete process.env.HUB_CLAW_SERVER_PORT
  _resetCdpPortCache()
  _resetClawServerPortCache()
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveCdpPort — BROWSEROS_CDP_PORT env override', () => {
  it('uses the env var when set (config is not read)', () => {
    process.env.BROWSEROS_CDP_PORT = '1234'
    // A config that would otherwise win must be ignored.
    const configPath = join(tmpDir, 'override-config.json')
    writeFileSync(configPath, JSON.stringify({ ports: { cdp: 9110 } }))
    expect(resolveCdpPort({ configPath })).toBe(1234)
  })

  it('env var wins over an already-cached probe value', () => {
    const configPath = join(tmpDir, 'cache-config.json')
    writeFileSync(configPath, JSON.stringify({ ports: { cdp: 9110 } }))
    expect(resolveCdpPort({ configPath })).toBe(9110)
    process.env.BROWSEROS_CDP_PORT = '7777'
    expect(resolveCdpPort()).toBe(7777)
  })

  it('empty/invalid env values are skipped (fall through to probe/fallback)', () => {
    process.env.BROWSEROS_CDP_PORT = ''
    expect(resolveCdpPort({ configPath: join(tmpDir, 'does-not-exist.json') }))
      .toBe(CDP_PORT_FALLBACK)
    process.env.BROWSEROS_CDP_PORT = 'not-a-number'
    expect(resolveCdpPort({ configPath: join(tmpDir, 'does-not-exist.json') }))
      .toBe(CDP_PORT_FALLBACK)
  })
})

describe('resolveCdpPort — BrowserOS neo config probe', () => {
  it('returns ports.cdp from an injected config when env is unset', () => {
    const configPath = join(tmpDir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ ports: { cdp: 9110, proxy: 9010, server: 9210 } }),
    )
    expect(resolveCdpPort({ configPath })).toBe(9110)
  })

  it('honors BROWSERCLAW_DIR (dev and stable variants) on any OS', () => {
    process.env.BROWSERCLAW_DIR = join(tmpDir, 'claw-dir')
    mkdirSync(join(process.env.BROWSERCLAW_DIR, '.browseros'), { recursive: true })
    mkdirSync(join(process.env.BROWSERCLAW_DIR, '.browseros-dev'), { recursive: true })
    writeFileSync(
      join(process.env.BROWSERCLAW_DIR, '.browseros', 'config.json'),
      JSON.stringify({ ports: { cdp: 9222 } }),
    )
    expect(resolveCdpPort()).toBe(9222)

    _resetCdpPortCache()
    writeFileSync(
      join(process.env.BROWSERCLAW_DIR, '.browseros-dev', 'config.json'),
      JSON.stringify({ ports: { cdp: 9333 } }),
    )
    expect(resolveCdpPort()).toBe(9333) // dev variant wins over stable
  })

  it('does not throw when the config file is missing', () => {
    expect(resolveCdpPort({ configPath: join(tmpDir, 'missing.json') }))
      .toBe(CDP_PORT_FALLBACK)
  })

  it('falls back to 9005 on corrupt JSON', () => {
    const configPath = join(tmpDir, 'corrupt.json')
    writeFileSync(configPath, '{ this is not valid json')
    expect(resolveCdpPort({ configPath })).toBe(CDP_PORT_FALLBACK)
  })

  it('falls back to 9005 when ports.cdp is absent or not a positive integer', () => {
    const cases: unknown[] = [
      { ports: {} },
      { ports: { cdp: '9110' } },
      { ports: { cdp: 0 } },
      { ports: { cdp: -1 } },
      { ports: { cdp: 70000 } },
      { other: 'no ports at all' },
    ]
    cases.forEach((body, i) => {
      const configPath = join(tmpDir, `invalid-${i}.json`)
      writeFileSync(configPath, JSON.stringify(body))
      expect(resolveCdpPort({ configPath }), `case ${i}`).toBe(CDP_PORT_FALLBACK)
    })
  })
})

describe('resolveCdpPort — in-process caching', () => {
  it('caches the probe result and refreshes after _resetCdpPortCache', () => {
    const configPath = join(tmpDir, 'cacheable.json')
    writeFileSync(configPath, JSON.stringify({ ports: { cdp: 9110 } }))
    expect(resolveCdpPort({ configPath })).toBe(9110)

    // Change the config on disk: same process must still return the cached value.
    writeFileSync(configPath, JSON.stringify({ ports: { cdp: 9222 } }))
    expect(resolveCdpPort({ configPath })).toBe(9110)

    // Test hook: cache reset → fresh probe picks up the new value.
    _resetCdpPortCache()
    expect(resolveCdpPort({ configPath })).toBe(9222)
  })

  it('caches the fallback too (no repeated disk reads)', () => {
    const configPath = join(tmpDir, 'never-exists.json')
    expect(resolveCdpPort({ configPath })).toBe(CDP_PORT_FALLBACK)
    expect(resolveCdpPort({ configPath })).toBe(CDP_PORT_FALLBACK)
  })
})

describe('resolveClawServerPort — config drift follows ports.server', () => {
  // Found 2026-08-26: the claw server silently rebinds off 9210 when the
  // port is taken; consumers that hard-coded 9210 (claw-reporter,
  // replay-tools) went dark for the whole drift window.
  it('reads ports.server from the BrowserOS config', () => {
    const configPath = join(tmpDir, 'claw-server.json')
    writeFileSync(configPath, JSON.stringify({ ports: { cdp: 9110, server: 9211 } }))
    expect(resolveClawServerPort({ configPath })).toBe(9211)
  })

  it('HUB_CLAW_SERVER_PORT env overrides the config', () => {
    process.env.HUB_CLAW_SERVER_PORT = '9299'
    const configPath = join(tmpDir, 'claw-ignored.json')
    writeFileSync(configPath, JSON.stringify({ ports: { server: 9211 } }))
    expect(resolveClawServerPort({ configPath })).toBe(9299)
  })

  it('falls back to 9210 when the config has no ports.server', () => {
    const configPath = join(tmpDir, 'claw-absent.json')
    writeFileSync(configPath, JSON.stringify({ ports: { cdp: 9110 } }))
    expect(resolveClawServerPort({ configPath })).toBe(CLAW_SERVER_PORT_FALLBACK)
  })

  it('missing config file falls back silently', () => {
    expect(resolveClawServerPort({ configPath: join(tmpDir, 'nope.json') }))
      .toBe(CLAW_SERVER_PORT_FALLBACK)
  })

  it('caches the probe; reset hook re-reads', () => {
    const configPath = join(tmpDir, 'claw-cache.json')
    writeFileSync(configPath, JSON.stringify({ ports: { server: 9211 } }))
    expect(resolveClawServerPort({ configPath })).toBe(9211)
    writeFileSync(configPath, JSON.stringify({ ports: { server: 9212 } }))
    expect(resolveClawServerPort({ configPath })).toBe(9211)
    _resetClawServerPortCache()
    expect(resolveClawServerPort({ configPath })).toBe(9212)
  })
})
