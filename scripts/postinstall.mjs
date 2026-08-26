#!/usr/bin/env node
/**
 * Postinstall: create in-package node_modules symlinks so bare imports resolve
 * at runtime in BOTH layouts:
 *
 *   dev (workspace, no dist):   node_modules/@jackwener/opencli -> src/opencli-engine
 *                               node_modules/@browseros/*       -> vendor source dirs
 *   published (dist present):   node_modules/@jackwener/opencli -> dist/opencli-engine
 *                               node_modules/@browseros/*       -> dist/vendor/* (compiled JS)
 *
 * The published package is a plain `npm i -g @hub/browser` install, so npm no
 * longer creates workspace links. The @browseros/* packages and the
 * @jackwener/opencli engine root are self-vendored (not on the registry), so
 * we point node_modules entries at the copies inside the package. The symlink
 * target is a package root (has package.json), so Node resolves subpath
 * exports (e.g. @browseros/browser-core/core/snapshot/diff) normally.
 *
 * Windows uses junctions (no admin privileges needed for dir symlinks).
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd(); // npm lifecycle scripts run with cwd = package root

function prefer(primary, fallback) {
  return fs.existsSync(path.join(primary, 'package.json')) ? primary : fallback;
}

// Engine link: prefer DIST when present. A dev tree with a built dist/ must
// serve node consumers the compiled JS — adapters resolve
// '@jackwener/opencli' through this node_modules link, and under node the
// src tree is unrunnable (TS sources + extensionless imports; node does no
// extension probing). Bun runs either tree, so dist-first breaks nothing for
// bun; a pure-source dev tree (no dist) falls back to src as before.
const engineRoot = prefer(
  path.join(root, 'dist', 'opencli-engine'),
  path.join(root, 'src', 'opencli-engine'),
);

const vendorRoot = path.join(root, 'vendor', 'browseros', 'packages', 'browseros-agent', 'packages');
const vendorTargets = {
  '@browseros/browser-core': prefer(
    path.join(vendorRoot, 'browser-core'),
    path.join(root, 'dist', 'vendor', 'browser-core'),
  ),
  '@browseros/cdp-protocol': prefer(
    path.join(vendorRoot, 'cdp-protocol'),
    path.join(root, 'dist', 'vendor', 'cdp-protocol'),
  ),
  '@browseros/shared': prefer(
    path.join(vendorRoot, 'shared'),
    path.join(root, 'dist', 'vendor', 'shared'),
  ),
};

const mcpRoot = prefer(
  path.join(root, 'src', 'browser-mcp'),
  path.join(root, 'dist', 'browser-mcp'),
);

function link(pkgName, target) {
  if (!target || !fs.existsSync(target)) return;
  const linkPath = path.join(root, 'node_modules', ...pkgName.split('/'));
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      fs.rmSync(linkPath, { recursive: true, force: true });
    } catch { /* not present */ }
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    console.log(`[postinstall] ${pkgName} -> ${path.relative(root, target)}`);
  } catch (err) {
    console.warn(`[postinstall] warning: could not link ${pkgName}: ${err?.message ?? String(err)}`);
  }
}

link('@jackwener/opencli', engineRoot);
for (const [name, target] of Object.entries(vendorTargets)) link(name, target);
link('@browseros/browser-mcp', mcpRoot);
