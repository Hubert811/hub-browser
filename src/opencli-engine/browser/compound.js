/**
 * Re-export from the TypeScript source (src/opencli/compound.ts) —
 * single source of truth. The old JS copy was a de-typed duplicate;
 * build-dist.mjs rewrites the specifier to dist/opencli/compound.js for
 * the published package, and bun resolves the `.ts` directly in dev.
 */
export * from '../../opencli/compound.ts';
