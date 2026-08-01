#!/usr/bin/env node
/**
 * hub-browser CLI entry point.
 *
 * Imports the locally-vendored OpenCLI engine (src/opencli-engine/main.js).
 * No npm dependency, no postinstall patching, no globalThis hacks.
 */

process.env.OPENCLI_BROWSER = 'claw';

// Run the locally-vendored OpenCLI CLI engine
await import('../src/opencli-engine/main.js');
