import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const R = '/Applications/BrowserOS neo.app/Contents/Resources/BrowserClawServer/default/resources/hub'
const URL = 'https://quickbi.zkh360.com/product/view.htm?module=dashboard&productId=f18a4a2a0e4a4405bba9166f871744be&workspaceView=false&menuId=r38j71h2p08'
const transport = new StdioClientTransport({
  command: R + '/bin/bun-runtime', args: [R + '/bin/hub.mjs', '--mcp'],
  env: { ...process.env, HUB_AGENT_ID: 'qbi-r4', HUB_SPACES_FILE: '/tmp/qbi-r4-spaces.json', HUB_SPACE_REAP: 'off', HUB_AUDIT: 'off', BROWSEROS_CDP_PORT: '9110' },
})
const client = new Client({ name: 'qbi-r4e', version: '1.0.0' })
await client.connect(transport)
const call = (n, a) => client.callTool({ name: n, arguments: a })
const textOf = (r) => (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
await call('space.create', { name: 'qbi-r4e' })
const open = await call('space.open_tab', { url: URL })
let pageId = open?.structuredContent?.pageId ?? open?.structuredContent?.page?.pageId
if (typeof pageId !== 'number') pageId = Number(textOf(await call('tabs', { action: 'list' })).match(/\[(\d+)\]/)?.[1])
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2000))
  if (/no change/i.test(textOf(await call('diff', { page: pageId })))) break
}
// probe interactivity signals on the filter fields (in the iframe)
const probe = await call('evaluate', {
  page: pageId, frame: 1,
  code: `// find the label for 清单类型 and inspect its associated field wrapper
const labels=[...document.querySelectorAll('[class*="label"],label,span,div')].filter(e=>/^(清单类型|行状态|集团客户名称)$/.test((e.textContent||'').trim())&&(e.offsetWidth||e.offsetHeight));
const out=[];
for(const l of labels.slice(0,3)){
  // climb to the clickable field widget near this label
  let f=l.parentElement;
  for(let k=0;k<4&&f;k++){
    const s=getComputedStyle(f);
    if(s.cursor==='pointer'||f.onclick||f.getAttribute('tabindex'))break;
    f=f.parentElement;
  }
  out.push({
    label:(l.textContent||'').trim(),
    fieldTag:f?.tagName, fieldCls:(f?.className||'').toString().slice(0,50),
    cursor:f?getComputedStyle(f).cursor:'?',
    onclick:!!f?.onclick, onclickAttr:!!f?.getAttribute('onclick'),
    tabindex:f?.getAttribute('tabindex')
  });
}
// also: how many elements in the iframe doc have cursor:pointer at all?
let ptr=0; for(const el of document.querySelectorAll('*')){ if(getComputedStyle(el).cursor==='pointer') ptr++; }
return JSON.stringify({samples:out, cursorPointerTotal:ptr})`,
})
const pr = textOf(probe)
console.log(pr.slice(pr.indexOf('{'), pr.lastIndexOf('}') + 1).replace(/\\n/g, ' '))
try { await Promise.race([call('space.close', {}), new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 20000))]) } catch { }
await client.close()
