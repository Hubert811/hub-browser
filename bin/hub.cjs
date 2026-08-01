#!/usr/bin/env node
// hub-browser CLI entry point
// Monkey-patches OpenCLI's getBrowserFactory to use UnifiedBrowserFactory
// then delegates to OpenCLI's CLI with all arguments forwarded.

const { createRequire } = require('node:module');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.OPENCLI_BROWSER = 'claw';

// Try to patch getBrowserFactory in OpenCLI's runtime module
try {
  const opencliRequire = createRequire(__filename);
  const opencliPkg = opencliRequire('@jackwener/opencli/package.json');
  const opencliDir = path.dirname(opencliRequire.resolve('@jackwener/opencli/package.json'));
  const runtimePath = path.join(opencliDir, opencliPkg.main ? path.dirname(opencliPkg.main) : 'dist', 'runtime.js');
  
  const runtime = opencliRequire(runtimePath);
  if (runtime.getBrowserFactory) {
    const original = runtime.getBrowserFactory;
    runtime.getBrowserFactory = function(site) {
      if (process.env.OPENCLI_BROWSER === 'claw') {
        try {
          return require('../dist/factory.js').UnifiedBrowserFactory;
        } catch {
          // dist not built yet, try src
          return require('../src/factory.ts').UnifiedBrowserFactory;
        }
      }
      return original.call(this, site);
    };
    console.error('[hub] Patched getBrowserFactory to use UnifiedBrowserFactory');
  }
} catch (e) {
  // If patching fails, just run opencli with env var set
  console.error('[hub] Could not patch getBrowserFactory:', e.message);
}

// Run opencli CLI with all arguments forwarded
const args = process.argv.slice(2);
const child = spawn('npx', ['opencli', ...args], {
  stdio: 'inherit',
  env: { ...process.env, OPENCLI_BROWSER: 'claw' },
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
