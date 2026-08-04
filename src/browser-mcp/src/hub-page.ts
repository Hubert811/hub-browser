/**
 * Shared re-exports for the hub-browser integration.
 *
 * This fork lives inside the @hub/browser project, so it reaches the
 * UnifiedPage implementation through relative imports instead of a package
 * dependency (the workspace root itself cannot be declared as a workspace
 * dependency of its own members).
 */
export { UnifiedPage } from '../../page.js'
export { UnifiedBrowserFactory } from '../../factory.js'
export type { IBrowserFactory } from '../../factory.js'
