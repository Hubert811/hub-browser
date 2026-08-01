// hub-browser stub: profile routing removed (BrowserClaw manages contexts)
export const DEFAULT_CONTEXT_ID = 'default';
export function normalizeContextId(value) { return value || DEFAULT_CONTEXT_ID; }
export function emptyProfileConfig() { return { profiles: {}, defaultProfile: null }; }
export function loadProfileConfig() { return emptyProfileConfig(); }
export function saveProfileConfig(config) { /* no-op */ }
export function resolveProfileSelection(profile) { return null; }
export function profileRouteParams(selection) { return {}; }
export function resolveProfileContextId(profile) { return null; }
export function aliasForContextId(config, contextId) { return null; }
export function renameProfile(contextId, alias) { /* no-op */ }
export function setDefaultProfile(profile) { /* no-op */ }
