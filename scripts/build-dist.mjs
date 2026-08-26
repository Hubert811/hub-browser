#!/usr/bin/env bun
/**
 * Build dist/ — a compiled-JS mirror of the hub runtime for npm publishing.
 *
 * Why: Node refuses to type-strip `.ts` files under node_modules, and a
 * globally-installed package always lives under node_modules. So the package
 * must ship plain JS. This script:
 *
 *  1. Copies the pure-JS engine fork (src/opencli-engine) to
 *     dist/opencli-engine, rewriting `.ts` relative import specifiers to `.js`.
 *  2. Transpiles every runtime `.ts` source (src/** + the three vendored
 *     @browseros packages) to `.js`, rewriting relative specifiers so plain
 *     Node ESM resolves them:
 *       - `./foo.ts`  -> `./foo.js`
 *       - `./foo`     -> `./foo.js`   (extensionless, all resolve to files)
 *       - `./foo.js`  -> unchanged
 *  3. Writes package.json files for dist/opencli-engine, dist/vendor/<pkg>,
 *     and dist/browser-mcp (exports maps rewritten .ts -> .js).
 *
 * The output tree mirrors the source tree so `import.meta.url`-based path
 * logic (findPackageRoot, PACKAGE_ROOT, version, skills, external-clis) keeps
 * working from dist/opencli-engine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const VENDOR_REL = 'vendor/browseros/packages/browseros-agent/packages';
const VENDOR = {
  'browser-core': `${VENDOR_REL}/browser-core`,
  'cdp-protocol': `${VENDOR_REL}/cdp-protocol`,
  'shared': `${VENDOR_REL}/shared`,
};

// 0. Release-manifest guard: the DEV manifest must keep `dependencies` free
//    of the vendored @browseros/* `file:` entries. They would fight the
//    workspace links bun installs for the vendored packages and flip
//    node_modules/@browseros/* onto the type-less dist (tsc breaks). The
//    PUBLISHED manifest gets them only through scripts/pack.mjs, which derives
//    them from this dev list — so there is no second manifest to drift.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const devDeps = pkg.dependencies ?? {};
  for (const name of Object.keys(devDeps)) {
    if (name.startsWith('@browseros/')) {
      console.error(
        `[build] manifest guard FAILED: "${name}" must stay OUT of dependencies (dev tree — the workspace links own @browseros/*; scripts/pack.mjs adds the published file: entries).`,
      );
      process.exit(1);
    }
  }
}

function fixSpec(spec) {
  if (spec.endsWith('.ts')) return spec.slice(0, -3) + '.js';
  if (/\.(js|mjs|cjs|json)$/.test(spec)) return spec;
  return spec + '.js';
}

const FROM_RE = /(\bfrom\s*)(['"])(\.\.?\/[^'"]+)(['"])/g;
const IMPORT_RE = /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)(['"])/g;

function rewriteSpecifiers(code) {
  return code
    .replace(FROM_RE, (m, pre, q1, spec, q2) => `${pre}${q1}${fixSpec(spec)}${q2}`)
    .replace(IMPORT_RE, (m, pre, q1, spec, q2) => `${pre}${q1}${fixSpec(spec)}${q2}`);
}

function listTsFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        walk(fp);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        out.push(fp);
      }
    }
  })(dir);
  return out;
}

function copyDir(src, dest, { rewriteTs = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      copyDir(s, d, { rewriteTs });
    } else if (rewriteTs && e.name.endsWith('.js')) {
      fs.writeFileSync(d, rewriteSpecifiers(fs.readFileSync(s, 'utf8')));
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function nodeCompat(code) {
  // Vendored browser-core backends use bun-only Bun.sleep(); plain Node has no
  // Bun global. Rewrite to a setTimeout promise so the published package runs
  // on stock Node. (Dev still runs the untouched vendor source under bun.)
  return code.replace(/Bun\.sleep\(([^()]*)\)/g, (m, arg) => `new Promise((resolve) => setTimeout(resolve, ${arg}))`);
}

function rewriteExportsToJs(pkgJson) {
  function walk(v) {
    if (typeof v === 'string') {
      return v.startsWith('./') && v.endsWith('.ts') ? v.slice(0, -3) + '.js' : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  }
  if (pkgJson.exports) pkgJson.exports = walk(pkgJson.exports);
  return pkgJson;
}

// ── clean ─────────────────────────────────────────────────────────────
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const transpiler = new Bun.Transpiler({ loader: 'ts' });

// 1. Engine fork (pure JS) — copy + rewrite .ts specifiers to .js
copyDir(path.join(root, 'src', 'opencli-engine'), path.join(dist, 'opencli-engine'), { rewriteTs: true });

// 2. TS sources -> JS (src/** and vendor three packages)
const jobs = [
  [path.join(root, 'src'), dist],
  ...Object.values(VENDOR).map((rel) => [
    path.join(root, rel, 'src'),
    path.join(dist, 'vendor', path.basename(rel), 'src'),
  ]),
];
for (const [srcDir, outDir] of jobs) {
  for (const f of listTsFiles(srcDir)) {
    const rel = path.relative(srcDir, f);
    const outFile = path.join(outDir, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const code = nodeCompat(rewriteSpecifiers(transpiler.transformSync(fs.readFileSync(f, 'utf8'))));
    fs.writeFileSync(outFile, code);
  }
}

// 3. Generated package.json files
fs.copyFileSync(
  path.join(root, 'src', 'opencli-engine', 'package.json'),
  path.join(dist, 'opencli-engine', 'package.json'),
);
for (const [pkg, rel] of Object.entries(VENDOR)) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, rel, 'package.json'), 'utf8'));
  // Strip workspace:* dependencies: in an installed tree the three vendored
  // packages are declared as file: deps of the ROOT package.json, so npm
  // hoists them all to node_modules/@browseros/* and their cross-imports
  // resolve by walking up — a leftover workspace: protocol would break the
  // install (0.2.0 release-pipeline finding: pure-install layout could not
  // resolve @browseros/shared at all).
  delete pkgJson.dependencies;
  delete pkgJson.devDependencies;
  fs.writeFileSync(
    path.join(dist, 'vendor', pkg, 'package.json'),
    JSON.stringify(rewriteExportsToJs(pkgJson), null, 2) + '\n',
  );
}
const mcpPkg = JSON.parse(fs.readFileSync(path.join(root, 'src', 'browser-mcp', 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(dist, 'browser-mcp', 'package.json'),
  JSON.stringify(rewriteExportsToJs(mcpPkg), null, 2) + '\n',
);

// 4. P2-9 — agent guide resource: `hub --llm-txt` prints the bundled
// hub-browser SKILL.md (single source with the skills system). The root
// skills/ tree is not in package.json "files", so ship the one file the
// flag needs inside dist/ (hub.mjs falls back to it when the dev tree is
// absent).
fs.mkdirSync(path.join(dist, 'skills', 'hub-browser'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'skills', 'hub-browser', 'SKILL.md'),
  path.join(dist, 'skills', 'hub-browser', 'SKILL.md'),
);

// 5. P2-3 — replay player assets: rrweb-player (UMD) + its stylesheet get
// embedded into every exported self-contained replay HTML by
// browser-mcp/src/tools/replay-tools.ts. Non-TS files never pass through
// job 2, so ship them explicitly; the module locates them relative to
// itself (dist/browser-mcp/assets), which this layout preserves.
fs.mkdirSync(path.join(dist, 'browser-mcp', 'assets'), { recursive: true });
for (const asset of ['rrweb-player.umd.min.js', 'rrweb-player.style.css']) {
  fs.copyFileSync(
    path.join(root, 'src', 'browser-mcp', 'assets', asset),
    path.join(dist, 'browser-mcp', 'assets', asset),
  );
}

// ── report ────────────────────────────────────────────────────────────
const count = (dir) => {
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else n++;
    }
  })(dir);
  return n;
};
console.log(`[build] dist/ written: ${count(dist)} files`);
console.log(`[build] engine: dist/opencli-engine (${count(path.join(dist, 'opencli-engine'))} files)`);
for (const pkg of Object.keys(VENDOR)) {
  console.log(`[build] vendor ${pkg}: dist/vendor/${pkg} (${count(path.join(dist, 'vendor', pkg))} files)`);
}
