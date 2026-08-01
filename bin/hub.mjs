#!/usr/bin/env node
/**
 * hub-browser CLI entry point.
 *
 * OpenCLI's runtime.js has been patched (via postinstall) to check
 * OPENCLI_BROWSER=claw and return globalThis.__HubBrowserFactory.
 * This script sets that global before importing OpenCLI's main.js.
 *
 * No monkey-patching, no child process spawn, no prototype hacking.
 * The patched runtime.js does: if (env=claw) return globalThis.__HubBrowserFactory
 * We just set the global and import the CLI — that's it.
 */

process.env.OPENCLI_BROWSER = 'claw';

// Set the factory class that OpenCLI's patched runtime.js will use
const { UnifiedBrowserFactory } = await import('../src/factory.ts');
globalThis.__HubBrowserFactory = UnifiedBrowserFactory;

// Run OpenCLI CLI directly — no child process
await import('@jackwener/opencli');
