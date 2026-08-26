#!/usr/bin/env node
/**
 * P3-6 (T1 甲-1) — build the self-contained hub distribution directory that
 * ships inside a BrowserOS fork version dir (resources/hub/).
 *
 * Layout produced (verified end-to-end by the 2026-08-26 bun-compile spike):
 *
 *   <out>/
 *   ├── bin/bun-runtime   # platform bun binary (self-contained JS runtime)
 *   ├── bin/hub.mjs       # CLI entry (same file as the npm package's bin)
 *   ├── dist/ clis/ skills/ package.json …   # release tarball payload
 *   └── node_modules/     # `npm install --omit=dev` output (preinstalled)
 *
 * The rust server's hub_provision module copies nothing from this layout —
 * it writes a ~/.hub/bin wrapper pointing INTO the version dir, so the
 * browser and hub upgrade together (T1's whole point).
 *
 * Usage: bun scripts/pack-fork.mjs [--out <dir>] [--bun <path-to-bun>]
 *   --out defaults to ./hub-dist
 *   --bun defaults to the bun running this script (must match the target
 *   platform of the browser build you will ship).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = path.resolve(arg('out', path.join(root, 'hub-dist')));
const bunSource = arg('bun', process.execPath);
// Tarball name follows the package version (produced by `bun run release`);
// read it from package.json instead of hardcoding, so version bumps don't
// silently break this script.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tarball = path.join(root, `hub-browser-${pkgVersion}.tgz`);

function die(message) {
  console.error(`[pack-fork] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(tarball)) die(`hub-browser-${pkgVersion}.tgz not found — run \`bun run release\` first.`);
try {
  fs.accessSync(bunSource, fs.constants.X_OK);
} catch {
  die(`bun binary not executable: ${bunSource}`);
}

// ── 1. fresh output dir ──────────────────────────────────────────────────
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── 2. unpack the release tarball (pack.mjs output, 15-dep manifest) ────
const tar = spawnSync('tar', ['xzf', tarball, '-C', outDir, '--strip-components=1'], {
  stdio: 'inherit',
});
if (tar.status !== 0) die('tar extract failed.');

// ── 3. preinstall runtime deps (the installing machine never runs npm) ──
const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-fork-cache-'));
const npm = spawnSync(
  'npm',
  [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    npmCache,
    '--loglevel=error',
  ],
  { cwd: outDir, stdio: 'inherit', env: { ...process.env, npm_config_cache: npmCache } },
);
fs.rmSync(npmCache, { recursive: true, force: true });
if (npm.status !== 0) die('npm install failed.');

// ── 4. vendored bun runtime (spike-proven: the layout self-bootstraps) ──
fs.copyFileSync(bunSource, path.join(outDir, 'bin', 'bun-runtime'));
fs.chmodSync(path.join(outDir, 'bin', 'bun-runtime'), 0o755);

// ── 5. sanity: the entry must run from inside the layout ────────────────
const probe = spawnSync(
  path.join(outDir, 'bin', 'bun-runtime'),
  [path.join(outDir, 'bin', 'hub.mjs'), '--version'],
  { encoding: 'utf8' },
);
if (probe.status !== 0) die(`self-boot probe failed:\n${probe.stderr}`);

// ── 6. report ────────────────────────────────────────────────────────────
const du = spawnSync('du', ['-sh', outDir], { encoding: 'utf8' });
console.log(`[pack-fork] hub distribution → ${outDir}`);
if (du.status === 0) console.log(`[pack-fork] size: ${du.stdout.trim()}`);
console.log(`[pack-fork] probe: hub --version → ${probe.stdout.trim()}`);
