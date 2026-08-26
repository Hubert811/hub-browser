// Diagnose the iframe-stitch chain on the live QuickBI page, link by link:
//   [1] does getFullAXTree see the iframe node (with children)?
//   [2] does DOM.describeNode resolve iframe -> child frameId?
//   [3] does getFullAXTree({frameId}) return the child frame's AX nodes?
import { UnifiedBrowserFactory } from '../src/factory.ts'

const port = Number(process.env.BROWSEROS_CDP_PORT ?? '9110')
const factory = new UnifiedBrowserFactory()

// find the quickbi pageId from the live page list
let page: any = null
{
  const probe: any = await factory.connect({ port })
  const bs0 = probe._browserSession
  const list = await bs0.pages.list()
  const entries = list.pages ?? list
  console.log('pages:', (Array.isArray(entries) ? entries : []).map((p: any) => `${p.pageId}:${String(p.url).slice(0, 60)}`).join(' | '))
  const hit = (Array.isArray(entries) ? entries : []).find((p: any) => /quickbi/.test(String(p.url)))
  if (!hit) { console.log('no quickbi page open'); process.exit(1) }
  page = await factory.connect({ port, pageId: hit.pageId })
  console.log(`using pageId=${hit.pageId}`)
}

const bs = page._browserSession
const { session: pageSession } = await bs.pages.getSession(page.pageId)

// [1] main AX tree
const ax = await pageSession.Accessibility.getFullAXTree({})
const nodes = ax.nodes ?? []
console.log(`[1] main AX tree: ${nodes.length} nodes`)
const iframeNodes = nodes.filter((n: any) => String(n.role?.value).toLowerCase().includes('iframe'))
console.log(`    iframe-role nodes: ${iframeNodes.length}`)
for (const n of iframeNodes.slice(0, 3)) {
  console.log(`    - role=${n.role?.value} backendNodeId=${n.backendDOMNodeId} childIds=${n.childIds?.length ?? 0} name=${String(n.name?.value ?? '').slice(0, 30)}`)
}

// [2] describeNode on each iframe
for (const n of iframeNodes.slice(0, 3)) {
  try {
    const described = await pageSession.DOM.describeNode({ backendNodeId: n.backendDOMNodeId, depth: 1 })
    const node = described.node as any
    const childFrameId = node?.contentDocument?.frameId ?? node?.frameId
    console.log(`[2] describeNode(${n.backendDOMNodeId}): nodeName=${node?.nodeName} frameId=${node?.frameId ?? '-'} contentDoc.frameId=${node?.contentDocument?.frameId ?? '-'} children=${node?.children?.length ?? 0}`)
    if (!childFrameId) { console.log('    -> no childFrameId: stitch dies at link 2'); continue }

    // [3] child frame's AX tree
    try {
      const childAx = await pageSession.Accessibility.getFullAXTree({ frameId: childFrameId })
      const childNodes = childAx.nodes ?? []
      console.log(`[3] getFullAXTree(frameId=${childFrameId.slice(0, 12)}…): ${childNodes.length} nodes`)
      if (childNodes.length > 0) {
        console.log('    first roles:', childNodes.slice(0, 6).map((m: any) => `${m.role?.value}:${String(m.name?.value ?? '').slice(0, 12)}`).join(', '))
      } else {
        console.log('    -> EMPTY child tree: stitch dies at link 3 (Chrome AX lazy-load or no content)')
      }
    } catch (e: any) {
      console.log(`[3] getFullAXTree(frameId) FAILED: ${String(e?.message ?? e).slice(0, 140)}`)
    }
  } catch (e: any) {
    console.log(`[2] describeNode FAILED: ${String(e?.message ?? e).slice(0, 140)}`)
  }
}



// [4] run the REAL Observer.snapshot() — does the vendored stitch work?
console.log('[4] calling Observer.snapshot()...')
const observer = bs.observe(page.pageId)
const snapText = await Promise.race([
  observer.snapshot(),
  new Promise((_, rej) => setTimeout(() => rej(new Error('snapshot timeout 30s')), 30000)),
]).catch((e) => { console.log('[4] snapshot FAILED:', String(e?.message ?? e).slice(0, 300)); process.exit(1) })
const snapLines = snapText.text.split('\n')
console.log(`[4] Observer.snapshot(): ${snapLines.length} lines`)
const iframeLine = snapLines.findIndex(l => l.trim() === '- iframe' || l.trim().startsWith('- iframe'))
console.log(`    '- iframe' line at index ${iframeLine}`)
if (iframeLine >= 0) {
  console.log('    content after iframe line (first 12):')
  for (const l of snapLines.slice(iframeLine + 1, iframeLine + 13)) console.log(`      ${l.slice(0, 90)}`)
}
process.exit(0)
