// hub-browser stub: daemon transport removed (no daemon process)
export async function requestDaemon(pathname, init) { throw new Error('daemon not available in hub-browser'); }
export async function fetchDaemonStatus(opts) { return null; }
export async function getDaemonHealth(opts) { return null; }
export async function requestDaemonShutdown(opts) { /* no-op */ }
