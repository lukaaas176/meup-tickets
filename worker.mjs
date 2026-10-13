/** Optional, separately deployed Cloudflare Worker. Do not put credentials in this file.
 * Required variables: PRETIX_BASE_URL, ALLOWED_TARGETS, SCANNER_ORIGIN
 * Required secrets: PRETIX_TOKEN, SCANNER_KEY (32+ random characters)
 * This is a narrowly scoped voucher-expiry bridge, not an arbitrary proxy.
 */
const EXPIRY='2000-01-01T00:00:00Z';
const VERSION='2026-10-13-redirect-fix-1';

// Only fixed diagnostic categories leave this function. Never return or log raw
// exception messages: they can contain voucher URLs, codes or credentials.
function upstreamException(error) {
 const name=String(error?.name||'');
 const message=String(error?.message||'');
 if(name==='TimeoutError'||name==='AbortError')
  return ['UPSTREAM_TIMEOUT','The pretix request timed out.',504];
 if(/invalid redirect value/i.test(message))
  return ['INVALID_REDIRECT_MODE','The Worker used an unsupported redirect mode. Deploy the corrected worker.mjs.',502];
 if(/\b1042\b|same[- ]zone|same[- ]account/i.test(message))
  return ['UPSTREAM_ROUTING','Cloudflare rejected the upstream route. Check PRETIX_BASE_URL and Worker routing.',502];
 if(/certificate|\bTLS\b|\bSSL\b/i.test(message))
  return ['UPSTREAM_TLS','The upstream TLS connection failed. Check the pretix server hostname and certificate.',502];
 if(/\bDNS\b|name resolution|resolve.*host|ENOTFOUND|EAI_AGAIN/i.test(message))
  return ['UPSTREAM_DNS','The upstream hostname could not be resolved. Check PRETIX_BASE_URL.',502];
 return ['UPSTREAM_EXCEPTION','The upstream request or response failed. Check the pretix server and its availability.',502];
}

function origin(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!u.hostname.includes('.')||/[\[\]\\\s]/.test(value))throw Error('Invalid origin');return u.origin;}
function target(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(value))throw Error('Invalid target');return value;}
async function equalSecret(a,b){const enc=new TextEncoder();const [ha,hb]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(a)),crypto.subtle.digest('SHA-256',enc.encode(b))]);const x=new Uint8Array(ha),y=new Uint8Array(hb);let n=0;for(let i=0;i<x.length;i++)n|=x[i]^y[i];return n===0;}
function settings(env){const base=origin(env.PRETIX_BASE_URL),scanner=origin(env.SCANNER_ORIGIN);const targets=[...new Set(String(env.ALLOWED_TARGETS||'').split(/[\r\n,]+/).map(s=>s.trim()).filter(Boolean).map(target))];if(!targets.length||targets.length>20||typeof env.PRETIX_TOKEN!=='string'||!env.PRETIX_TOKEN||/\s/.test(env.PRETIX_TOKEN)||typeof env.SCANNER_KEY!=='string'||env.SCANNER_KEY.length<32||env.SCANNER_KEY.length>512||/\s/.test(env.SCANNER_KEY))throw Error('Incomplete configuration');return {base,scanner,targets};}
function json(data,status=200,cors=''){
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
 if(cors)headers['Access-Control-Allow-Origin']=cors;
 return new Response(JSON.stringify(data),{status,headers});
}
async function bodyText(request,max){
 if(Number(request.headers.get('Content-Length')||0)>max)throw Error('Request too large');
 const stream=request.body?.getReader();if(!stream)return '';const chunks=[];let size=0;
 try{while(true){const {done,value}=await stream.read();if(done)break;size+=value.byteLength;if(size>max){await stream.cancel();throw Error('Request too large');}chunks.push(value);}}
 finally{stream.releaseLock();}
 const merged=new Uint8Array(size);let offset=0;for(const c of chunks){merged.set(c,offset);offset+=c.byteLength;}return new TextDecoder().decode(merged);
}
export default {
 async fetch(request,env){
  let cfg;try{cfg=settings(env);}catch{return json({error:'Bridge is not configured. Check its variables and secrets.'},503);}
  const from=request.headers.get('Origin');
  if(from!==cfg.scanner)return json({error:'Origin not allowed.'},403);
  const cors=cfg.scanner;
  let u;try{u=new URL(request.url);}catch{return json({error:'Bad request.'},400,cors);}
  if(request.method==='OPTIONS'){
   const method=request.headers.get('Access-Control-Request-Method');const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
   if(!['GET','POST'].includes(method)||requested.some(h=>!['authorization','content-type','accept'].includes(h)))return json({error:'Preflight rejected.'},403,cors);
   return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, Accept','Access-Control-Max-Age':'600','Vary':'Origin','Cache-Control':'no-store'}});
  }
  const auth=request.headers.get('Authorization')||'';
  if(!auth.startsWith('Bearer ')||auth.length>520||!await equalSecret(auth.slice(7),env.SCANNER_KEY))return json({error:'Authentication required.'},401,cors);
  if(u.search||u.hash)return json({error:'Query parameters are not supported.'},400,cors);
  if(u.pathname==='/meta'&&request.method==='GET')return json({base:cfg.base,targets:cfg.targets,version:VERSION},200,cors);
  if(u.pathname!=='/voucher')return json({error:'Not found.'},404,cors);
  if(request.method!=='POST')return json({error:'Method not allowed.'},405,cors);
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||''))return json({error:'JSON required.'},415,cors);
  let b;try{b=JSON.parse(await bodyText(request,4096));}catch{return json({error:'Invalid or oversized JSON body.'},400,cors);}
  if(!b||typeof b!=='object'||Array.isArray(b)||!['lookup','read','expire'].includes(b.op)||!cfg.targets.includes(b.target))return json({error:'Operation or event not allowed.'},403,cors);
  const keys=b.op==='lookup'?['op','target','code']:['op','target','id'];
  if(Object.keys(b).some(k=>!keys.includes(k))||Object.keys(b).length!==keys.length)return json({error:'Unexpected fields.'},400,cors);
  if(b.op==='lookup'&&(typeof b.code!=='string'||!/^[A-Za-z0-9._+\-]{1,255}$/.test(b.code)))return json({error:'Invalid voucher code.'},400,cors);
  if(b.op!=='lookup'&&(!Number.isSafeInteger(b.id)||b.id<1))return json({error:'Invalid voucher ID.'},400,cors);
  const [org,event]=b.target.split('/');let url=cfg.base+`/api/v1/organizers/${encodeURIComponent(org)}/events/${encodeURIComponent(event)}/vouchers/`;
  if(b.op==='lookup')url+='?code='+encodeURIComponent(b.code);else url+=b.id+'/';
  // Cloudflare workerd rejects redirect: 'error'. 'manual' is supported;
  // reject redirects explicitly below instead of following them with the token.
  const headers={Accept:'application/json',Authorization:`Token ${env.PRETIX_TOKEN}`};
  const init={method:b.op==='expire'?'PATCH':'GET',headers,redirect:'manual'};
  if(b.op==='expire'){headers['Content-Type']='application/json';init.body=JSON.stringify({valid_until:EXPIRY});}

  function fail(diagnostic,message,status=502,details={}) {
   const requestId=crypto.randomUUID();
   const data={
    error:message+(b.op==='expire'?' An update may have succeeded; rescan in review mode to verify.':''),
    diagnostic,request_id:requestId,operation:b.op,
    update_uncertain:b.op==='expire',...details
   };
   // No headers, raw exceptions, response bodies, voucher codes, IDs or URLs.
   console.error({event:'pretix_bridge_error',version:VERSION,diagnostic,
    request_id:requestId,operation:b.op,http_status:status,...details});
   return json(data,status,cors);
  }

  try{
   init.signal=AbortSignal.timeout(15000);
   const response=await fetch(url,init);
   if(response.status>=300&&response.status<400){
    if(response.body)await response.body.cancel();
    return fail('UPSTREAM_REDIRECT',
     'The pretix API address returned a redirect. Set PRETIX_BASE_URL to the canonical API origin; redirects are not followed.',
     502,{upstream_status:response.status});
   }
   if(!response.ok){
    if(response.body)await response.body.cancel();
    return fail('UPSTREAM_HTTP',`pretix returned HTTP ${response.status}.`,
     response.status>=400&&response.status<=599?response.status:502,
     {status:response.status,upstream_status:response.status});
   }
   const text=await bodyText(response,2000000);
   let data;
   try{data=JSON.parse(text);}catch{
    return fail('UPSTREAM_INVALID_JSON',
     'The upstream response was not valid JSON. Check that PRETIX_BASE_URL is the pretix API server, not a landing page.',
     502,{upstream_status:response.status});
   }
   return json(data,200,cors);
  }catch(error){
   const [diagnostic,message,status]=upstreamException(error);
   return fail(diagnostic,message,status);
  }
 }
};
