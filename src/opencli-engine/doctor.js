// hub-browser stub: doctor removed (no daemon/BrowserBridge to diagnose)
export async function checkConnectivity(opts) { return { daemon: false, extension: false }; }
export async function runBrowserDoctor(opts = {}) { return { connectivity: await checkConnectivity() }; }
export function renderBrowserDoctorReport(report) { return 'hub-browser: doctor not available (no daemon)'; }
