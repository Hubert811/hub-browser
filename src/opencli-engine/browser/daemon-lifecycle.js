// hub-browser stub: daemon lifecycle removed
export function resolveDaemonLaunchSpec() { return null; }
export function spawnDaemonProcess() { return null; }
export async function waitForDaemonStop(timeoutMs) { /* no-op */ }
export async function waitForDaemonStatus(timeoutMs) { return null; }
export const daemonLifecycleHooks = { onSpawn: [], onExit: [] };
export async function restartDaemon(opts = {}) { /* no-op */ }
export async function ensureBrowserBridgeReady(opts = {}) { return { spawnedProcess: null }; }
export const DEFAULT_DAEMON_PORT = 0;
