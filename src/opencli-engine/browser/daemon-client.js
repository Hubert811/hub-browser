// hub-browser stub: daemon client removed (uses UnifiedBrowserFactory directly)
export function setDaemonCommandTimeoutSeconds(seconds) { /* no-op */ }
export class BrowserCommandError extends Error { constructor(message) { super(message); this.name = 'BrowserCommandError'; } }
export { fetchDaemonStatus, getDaemonHealth, requestDaemonShutdown } from './daemon-transport.js';
export async function sendCommand(action, params = {}) { throw new Error('sendCommand not available in hub-browser'); }
export async function sendCommandFull(action, params = {}) { throw new Error('sendCommandFull not available in hub-browser'); }
export async function bindTab(session, opts = {}) { throw new Error('bindTab not available in hub-browser'); }
