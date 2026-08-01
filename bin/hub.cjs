#!/usr/bin/env node
// hub-browser CLI entry point
// Monkey-patches OpenCLI's getBrowserFactory to use UnifiedBrowserFactory
// then delegates to OpenCLI's CLI with all arguments forwarded.

const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.OPENCLI_BROWSER = 'claw';

function resolveRuntimePath(opencliDir, opencliPkg) {
  const candidates = [
    path.join(opencliDir, 'dist', 'src', 'runtime.js'),
    path.join(opencliDir, 'dist', 'runtime.js'),
    path.join(opencliDir, opencliPkg.main ? path.dirname(opencliPkg.main) : 'dist', 'runtime.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Try to patch getBrowserFactory in OpenCLI's runtime module
try {
  const opencliRequire = createRequire(__filename);
  // OpenCLI exports 不暴露 ./package.json，用 require.resolve 获取入口路径再向上找目录
  const entryPath = opencliRequire.resolve('@jackwener/opencli');
  let opencliDir = path.dirname(entryPath);
  // 向上找到包含 package.json 的目录
  while (opencliDir !== '/' && !fs.existsSync(path.join(opencliDir, 'package.json'))) {
    opencliDir = path.dirname(opencliDir);
  }
  const opencliPkg = JSON.parse(fs.readFileSync(path.join(opencliDir, 'package.json'), 'utf8'));

  const runtimePath = resolveRuntimePath(opencliDir, opencliPkg);
  if (!runtimePath) {
    console.error('[hub] Could not find runtime.js in OpenCLI. Patch skipped.');
  } else {
    const runtime = opencliRequire(runtimePath);
    if (typeof runtime.getBrowserFactory !== 'function') {
      console.error('[hub] getBrowserFactory not found in runtime. Patch skipped.');
    } else {
      const original = runtime.getBrowserFactory;
      runtime.getBrowserFactory = function(site) {
        if (process.env.OPENCLI_BROWSER === 'claw') {
          try {
            return require('../dist/factory.js').UnifiedBrowserFactory;
          } catch (e) {
            console.error('[hub] Failed to load UnifiedBrowserFactory. Please run "npm run build" first.');
            throw e;
          }
        }
        return original.call(this, site);
      };
      console.error('[hub] Patched getBrowserFactory to use UnifiedBrowserFactory');
    }
  }
} catch (e) {
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
