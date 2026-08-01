#!/usr/bin/env node
/**
 * hub-browser CLI entry point (ESM).
 * Patches BrowserBridge.connect in-process, then runs OpenCLI CLI directly.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.OPENCLI_BROWSER = 'claw';

const require0 = createRequire(import.meta.url);

// Resolve OpenCLI root directory
let opencliDir;
try {
  const entryPath = require0.resolve('@jackwener/opencli');
  opencliDir = path.dirname(entryPath);
  while (opencliDir !== '/' && !fs.existsSync(path.join(opencliDir, 'package.json'))) {
    opencliDir = path.dirname(opencliDir);
  }
} catch (e) {
  console.error('[hub] Cannot resolve @jackwener/opencli:', e.message);
  process.exit(1);
}
const opencliSrc = path.join(opencliDir, 'dist', 'src');
const fileUrl = (p) => pathToFileURL(p).href;

// ── Step 1: Patch BrowserBridge.prototype.connect ──
// browserSession() does: new BrowserFactory() + browser.connect(opts) → page
// We patch BrowserBridge.connect to delegate to UnifiedBrowserFactory.
try {
  const { BrowserBridge } = await import(fileUrl(path.join(opencliSrc, 'browser', 'index.js')));
  
  BrowserBridge.prototype.connect = async function(opts = {}) {
    if (process.env.OPENCLI_BROWSER === 'claw') {
      const { UnifiedBrowserFactory } = await import(fileUrl(path.join(process.cwd(), 'src', 'factory.ts')));
      const factory = new UnifiedBrowserFactory();
      return factory.connect({
        cdpEndpoint: opts.cdpEndpoint,
        pageId: opts.pageId,
        session: opts.session,
      });
    }
    // Fallback to original (shouldn't reach here when OPENCLI_BROWSER=claw)
    throw new Error('[hub] OPENCLI_BROWSER=claw but no UnifiedBrowserFactory available');
  };
  console.error('[hub] Patched BrowserBridge.connect → UnifiedBrowserFactory');
} catch (e) {
  console.error('[hub] Could not patch BrowserBridge:', e.message);
}

// ── Step 2: Run OpenCLI CLI in-process (no child process) ──
try {
  await import(fileUrl(path.join(opencliSrc, 'main.js')));
} catch (e) {
  console.error('[hub] Failed to run OpenCLI:', e.message);
  process.exit(1);
}
