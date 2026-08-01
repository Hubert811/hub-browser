#!/usr/bin/env node
/**
 * Apply hub-browser patches to OpenCLI's node_modules.
 * 
 * Patches OpenCLI's runtime.js to add OPENCLI_BROWSER=claw support,
 * so getBrowserFactory returns UnifiedBrowserFactory when env var is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const targets = [
  {
    file: 'node_modules/@jackwener/opencli/dist/src/runtime.js',
    find: 'export function getBrowserFactory(site) {\n    if (site && isElectronApp(site))',
    replace: 'export function getBrowserFactory(site) {\n    // hub-browser patch: use UnifiedBrowserFactory when OPENCLI_BROWSER=claw\n    if (process.env.OPENCLI_BROWSER === \'claw\') {\n        return globalThis.__HubBrowserFactory ?? BrowserBridge;\n    }\n    if (site && isElectronApp(site))',
  },
];

let applied = 0;
for (const t of targets) {
  const fullPath = path.join(root, t.file);
  if (!fs.existsSync(fullPath)) {
    console.log(`[patches] skip (not found): ${t.file}`);
    continue;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  if (content.includes('hub-browser patch')) {
    console.log(`[patches] already applied: ${t.file}`);
    continue;
  }
  if (!content.includes(t.find)) {
    console.error(`[patches] pattern not found: ${t.file}`);
    continue;
  }
  const patched = content.replace(t.find, t.replace);
  fs.writeFileSync(fullPath, patched, 'utf8');
  console.log(`[patches] applied: ${t.file}`);
  applied++;
}
console.log(`[patches] done (${applied} applied)`);
