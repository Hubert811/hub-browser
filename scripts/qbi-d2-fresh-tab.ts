// Decisive test: fresh tab -> wait -> raw Observer.snapshot() (no warm-up).
// If this returns a stitched tree, the vendored layer is fine and the bug is
// in the hub MCP path; if empty iframe, it's a timing/AX-lazy-load issue.
import { UnifiedBrowserFactory } from '../src/factory.ts'

const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')
const factory = new UnifiedBrowserFactory()
const probe: any = await factory.connect({ port })
const bs = probe._browserSession

// fresh page via the pages registry (Target.createTarget path)
const pageId = await bs.pages.newPage(URL)
console.log(`fresh pageId=${pageId}, waiting 8s...`)
await new Promise(r => setTimeout(r, 8000))

const observer = bs.observe(pageId)
const snap = await observer.snapshot()
const lines = snap.text.split('\n')
const iframeIdx = lines.findIndex(l => l.trim().startsWith('- iframe'))
console.log(`snapshot: ${lines.length} lines; iframe line at ${iframeIdx}`)
console.log('after iframe (first 8):')
for (const l of lines.slice(iframeIdx + 1, iframeIdx + 9)) console.log(`  ${l.slice(0, 88)}`)
if (iframeIdx >= 0 && (iframeIdx === lines.length - 1 || !lines[iframeIdx + 1].trim())) {
  console.log('=> EMPTY iframe on fresh tab (timing/AX issue)')
} else if (iframeIdx >= 0) {
  console.log('=> STITCHED on fresh tab (vendored layer fine; bug is in hub MCP path)')
}
// cleanup
await bs.pages.close(pageId).catch(() => {})
process.exit(0)
