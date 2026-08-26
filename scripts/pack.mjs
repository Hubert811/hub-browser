#!/usr/bin/env node
/**
 * hub release packer — `npm pack` + published-manifest substitution.
 *
 * Why this exists: one package.json must serve two worlds.
 *
 *  - DEV tree: the vendored @browseros/* packages are WORKSPACE members, so
 *    `bun install` links node_modules/@browseros/* at the typed vendor sources
 *    (tsc depends on that). Declaring them as file: dependencies here would
 *    fight those workspace links and flip them onto the type-less dist.
 *  - PUBLISHED tree: a plain `npm i <tarball>` must resolve @browseros/* even
 *    when install scripts are blocked (e.g. npm's allowScripts config), so the
 *    vendored packages ride along as file: dependencies pointing inside the
 *    package (dist/vendor/*), and npm hoists them into node_modules.
 *
 * publishConfig.dependencies does NOT solve this on modern npm: npm 12 (and 7+)
 * flattens publishConfig strictly as npmrc *config* (registry/access/tag) and
 * never substitutes manifest fields — verified against npm's own source
 * (lib/commands/publish.js). So this script owns the substitution:
 *
 *   1. `npm pack --ignore-scripts` — tarball content identical to a vanilla
 *      pack (files filtering, auto-included README/LICENSE, all npm's rules).
 *   2. unpack → dependencies := dev dependencies + the three vendored file:
 *      entries (derived, never hand-maintained — no second manifest to drift)
 *      → repack deterministically.
 *   3. fail loudly when dist/ is missing/stale (run build-dist first).
 *
 * The dev-manifest guard lives in build-dist.mjs (dev dependencies must stay
 * free of @browseros/*); pack.mjs re-checks it before substituting.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Vendored packages shipped as file: deps in the PUBLISHED manifest only. */
const VENDORED_FILE_DEPS = {
  '@browseros/browser-core': 'file:./dist/vendor/browser-core',
  '@browseros/cdp-protocol': 'file:./dist/vendor/cdp-protocol',
  '@browseros/shared': 'file:./dist/vendor/shared',
  // The adapter runtime contract: every clis/<site>/<cmd>.js imports
  // '@jackwener/opencli/{registry,errors}'. In the dev tree the postinstall
  // shim symlinks node_modules/@jackwener/opencli at dist/opencli-engine
  // (which carries its own @jackwener/opencli manifest); a plain
  // `npm i <tarball>` with scripts blocked never runs that shim, so the
  // engine ships as a fourth file: dep — without it every adapter load
  // fails with ADAPTER_LOAD in a clean install (found by the P3-6
  // bun-compile spike's tarball-layout smoke).
  '@jackwener/opencli': 'file:./dist/opencli-engine',
};

function die(message) {
  console.error(`[pack] ${message}`);
  process.exit(1);
}

// dist/ must exist and look built — pack.mjs deliberately does not build.
if (!fs.existsSync(path.join(root, 'dist', 'opencli-engine', 'package.json'))) {
  die('dist/ is missing or stale — run `bun scripts/build-dist.mjs` first.');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const devDeps = pkg.dependencies ?? {};
for (const name of Object.keys(devDeps)) {
  if (name.startsWith('@browseros/')) {
    die(
      `"${name}" must stay OUT of dev dependencies (the workspace links own ` +
        '@browseros/* in the dev tree); pack.mjs adds the published file: entries.',
    );
  }
}
const publishedDeps = { ...devDeps, ...VENDORED_FILE_DEPS };

const tarName = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
const tarball = path.join(root, tarName);

// 1. Vanilla pack — content exactly what npm would produce.
const pack = spawnSync('npm', ['pack', '--ignore-scripts'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});
if (pack.status !== 0) die('npm pack failed.');
if (!fs.existsSync(tarball)) die(`expected tarball ${tarName} was not produced.`);

// 2. Unpack → substitute the manifest → repack.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pack-'));
try {
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', staging]);
  if (extract.status !== 0) die('tar extract failed.');

  const manifestPath = path.join(staging, 'package', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = publishedDeps;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const repacked = `${tarball}.new`;
  const repack = spawnSync('tar', ['-czf', repacked, '-C', staging, 'package']);
  if (repack.status !== 0) die('tar repack failed.');
  fs.rmSync(tarball);
  fs.renameSync(repacked, tarball);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

// 3. Report.
const entries = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
const fileCount = entries.status === 0 ? entries.stdout.trim().split('\n').length : 0;
const shasum = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
console.log(`[pack] ${tarName} — ${fileCount} files`);
console.log(
  `[pack] published dependencies: ${Object.keys(publishedDeps).length} ` +
    `(${Object.keys(VENDORED_FILE_DEPS).length} vendored file: entries substituted)`,
);
console.log(`[pack] shasum-256: ${shasum}`);
