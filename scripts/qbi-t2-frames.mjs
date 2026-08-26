// T2 — probe the dashboard iframe: what does `frames` see, can evaluate
// reach inside, and does the AX/DOM unit coverage hold there?
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime',
  args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_SPACES_FILE: '/tmp/qbi-t1-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-frames', version: '1.0.0' })
await client.connect(transport)
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')

// reuse the space from T1: find the page
const tabs = await call('tabs', { action: 'list' })
const tabText = textOf(tabs)
console.log('--- tabs ---')
console.log(tabText.slice(0, 600))
const m = tabText.match(/"pageId"\s*:\s*(\d+)/)
const pageId = m ? Number(m[1]) : 1

// 1. frames — cross-origin iframe targets
const frames = await call('frames', { page: pageId })
console.log('--- frames ---')
console.log(textOf(frames).slice(0, 800))

// 2. evaluate INSIDE the iframe (index 0) — what is actually rendered there?
for (const fi of [0, 1]) {
  try {
    const ev = await call('evaluate', {
      page: pageId,
      frame: fi,
      code: `const t = document.title || '(no title)';
const body = document.body ? document.body.innerText.slice(0, 400) : '(no body)';
const canvases = document.querySelectorAll('canvas').length;
const inputs = document.querySelectorAll('input,select,button').length;
return JSON.stringify({url: location.href.slice(0, 120), title: t, canvases, inputs, bodyHead: body.replace(/\\n/g, ' | ').slice(0, 300)})`,
    })
    console.log(`--- evaluate frame[${fi}] ---`)
    console.log(textOf(ev).slice(0, 500))
  } catch (e) {
    console.log(`frame[${fi}] evaluate error: ${String(e).slice(0, 200)}`)
  }
}

await client.close()
console.log('DONE')
process.exit(0)
