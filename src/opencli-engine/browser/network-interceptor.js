/**
 * Injected page-side network interceptor.
 *
 * Used when the session-level capture channel (CDP/extension) is unavailable.
 * It captures fetch/XHR response bodies while matching the CDP path's
 * truncation contract: bodies above the per-entry cap are stored as a string
 * prefix with `bodyTruncated: true` and `bodyFullSize` set.
 *
 * O5: a total byte budget (default 32MB, aligned with the CDP sidecar store)
 * bounds the buffer; the oldest entries are evicted first once it is exceeded.
 * Byte accounting uses a parallel Map keyed by entry object, so parsed-JSON
 * bodies (whose string form is gone) still count and evict correctly.
 * `networkInterceptorJs()` builds the script with a custom budget for tests.
 *
 * Keep this script dependency-free; it executes in the target page context.
 */
const TOTAL_BUDGET_DEFAULT = 32 * 1024 * 1024;

export function networkInterceptorJs(totalBudget = totalBudgetDefault()) {
  const M = 200;
  const B = 1048576;
  const T = totalBudget;
  return `(function(){if(window.__opencli_net)return;window.__opencli_net=[];var acc=new Map(),bytes=0;var M=${M},B=${B},T=${T},F=window.fetch;function trim(){while(bytes>T&&window.__opencli_net.length>0){var old=window.__opencli_net.shift();var c=acc.get(old)||0;bytes-=c;acc.delete(old)}}function capture(url,method,status,text,ct){if(window.__opencli_net.length>=M)return;var full=text?text.length:0,trunc=full>B,stored=trunc?text.slice(0,B):text,body=null;if(stored){if(trunc){body=stored}else{try{body=JSON.parse(stored)}catch(e){body=stored}}}var e={url:url,method:method||'GET',status:status,size:full,ct:ct,body:body,timestamp:Date.now()};if(trunc){e.bodyTruncated=true;e.bodyFullSize=full}acc.set(e,stored?stored.length:0);bytes+=stored?stored.length:0;window.__opencli_net.push(e);trim()}window.fetch=async function(){var r=await F.apply(this,arguments);try{var ct=r.headers.get('content-type')||'';if(ct.includes('json')||ct.includes('text')){var c=r.clone(),t=await c.text();capture(r.url||(arguments[0]&&arguments[0].url)||String(arguments[0]),(arguments[1]&&arguments[1].method)||'GET',r.status,t,ct)}}catch(e){}return r};var X=XMLHttpRequest.prototype,O=X.open,S=X.send;X.open=function(m,u){this._om=m;this._ou=u;return O.apply(this,arguments)};X.send=function(){var x=this;x.addEventListener('load',function(){try{var ct=x.getResponseHeader('content-type')||'';if(ct.includes('json')||ct.includes('text')){capture(x._ou,x._om||'GET',x.status,x.responseText||'',ct)}}catch(e){}});return S.apply(this,arguments)}})()`;
}

function totalBudgetDefault() {
  const raw = Number(process.env.HUB_NETWORK_BODY_STORE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : TOTAL_BUDGET_DEFAULT;
}

export const NETWORK_INTERCEPTOR_JS = networkInterceptorJs();
