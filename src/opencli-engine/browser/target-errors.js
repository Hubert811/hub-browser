// Re-export from the TypeScript source (src/opencli/target-errors.ts)
// so that cli.js's `instanceof TargetError` matches the class thrown by base-page.ts.
// Before this fix, two independent TargetError class definitions existed
// (JS in opencli-engine/browser/ and TS in opencli/), causing instanceof
// to always return false in browserAction's catch block.
export { TargetError } from '../../opencli/target-errors.ts';
