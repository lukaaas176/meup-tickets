import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../worker.mjs';

// These are Node tests with a mocked fetch, NOT an execution of workerd.
// The redirect guard mirrors workerd's Request::tryParseRedirect() and
// Request::constructor() so Node's broader redirect support cannot mask the bug.
const env={
 PRETIX_BASE_URL:'https://pretix.example',
 SCANNER_ORIGIN:'https://scanner.example',
 ALLOWED_TARGETS:'org/main',
 PRETIX_TOKEN:'FAKE_SECRET_PRETIX_TOKEN_NOT_FOR_USE',
 SCANNER_KEY:'FAKE_SCANNER_SECRET_LONGER_THAN_32_CHARACTERS'
};
const body={op:'lookup',target:'org/main',code:'COUPON-PRIVATE-123.'};
function req(b=body) {
 return new Request('https://bridge.example/voucher',{
  method:'POST',headers:{Origin:env.SCANNER_ORIGIN,
   Authorization:'Bearer '+env.SCANNER_KEY,'Content-Type':'application/json'},
  body:JSON.stringify(b)
 });
}
async function mockRun(fetcher,run) {
 const oldFetch=globalThis.fetch,oldLog=console.error,logs=[];
 globalThis.fetch=fetcher;
 console.error=(...args)=>logs.push(args);
 try{return await run(logs);}finally{globalThis.fetch=oldFetch;console.error=oldLog;}
}

test('metadata identifies the corrected version',async()=>{
 const r=await worker.fetch(new Request('https://bridge.example/meta',{
  headers:{Origin:env.SCANNER_ORIGIN,Authorization:'Bearer '+env.SCANNER_KEY}
 }),env);
 assert.equal((await r.json()).version,'2026-10-13-redirect-fix-1');
});

test('workerd-style guard rejects old redirect option before sending, accepts corrected option',async()=>{
 const source=await readFile(new URL('../worker.mjs',import.meta.url),'utf8');
 assert.ok(source.includes("headers,redirect:'manual'"));
 const badSource=source.replace("headers,redirect:'manual'","headers,redirect:'error'");
 const oldVariant=(await import('data:text/javascript;base64,'+Buffer.from(badSource).toString('base64'))).default;
 let sent=0;
 await mockRun(async(url,init)=>{
  if(!['manual','follow'].includes(init.redirect))
   throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
  sent++;
  return Response.json({count:0,results:[],next:null});
 },async()=>{
  const broken=await oldVariant.fetch(req(),env);
  assert.equal(broken.status,502);
  assert.equal((await broken.json()).diagnostic,'INVALID_REDIRECT_MODE');
  assert.equal(sent,0);
  const fixed=await worker.fetch(req(),env);
  assert.equal(fixed.status,200);
  assert.equal(sent,1);
 });
});

for(const status of [301,302,303,307,308]) {
 test(`redirect ${status} is explicitly rejected with no follow-up request or credential leak`,async()=>{
  let calls=0;
  const destination='https://other.example/secret/'+body.code+'?token='+env.PRETIX_TOKEN;
  await mockRun(async(url,init)=>{
   calls++;
   assert.equal(init.redirect,'manual');
   return new Response('private redirect body',{status,headers:{Location:destination}});
  },async logs=>{
   const r=await worker.fetch(req(),env);
   const text=await r.text(),data=JSON.parse(text);
   assert.equal(r.status,502);
   assert.equal(data.diagnostic,'UPSTREAM_REDIRECT');
   assert.equal(data.upstream_status,status);
   assert.equal(data.update_uncertain,false);
   assert.equal(calls,1);
   assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.SCANNER_ORIGIN);
   const combined=text+JSON.stringify(logs);
   for(const secret of [env.PRETIX_TOKEN,env.SCANNER_KEY,body.code,destination,'private redirect body'])
    assert.ok(!combined.includes(secret));
   assert.match(data.request_id,/^[0-9a-f-]{36}$/);
  });
 });
}

test('invalid JSON has a distinct diagnosis and never exposes the upstream page',async()=>{
 await mockRun(async()=>new Response('<html>PRIVATE DEBUG '+env.PRETIX_TOKEN+'</html>'),async logs=>{
  const r=await worker.fetch(req(),env);
  const text=await r.text();
  assert.equal(r.status,502);
  assert.equal(JSON.parse(text).diagnostic,'UPSTREAM_INVALID_JSON');
  assert.ok(!(text+JSON.stringify(logs)).includes('PRIVATE DEBUG'));
  assert.ok(!(text+JSON.stringify(logs)).includes(env.PRETIX_TOKEN));
 });
});

test('upstream HTTP statuses remain distinct from Worker exceptions',async()=>{
 for(const status of [401,403,404,429,500,502,503]) {
  await mockRun(async()=>new Response('upstream secret',{status}),async logs=>{
   const r=await worker.fetch(req(),env),text=await r.text(),data=JSON.parse(text);
   assert.equal(r.status,status);
   assert.equal(data.diagnostic,'UPSTREAM_HTTP');
   assert.equal(data.upstream_status,status);
   assert.ok(!(text+JSON.stringify(logs)).includes('upstream secret'));
  });
 }
});

for(const [error,diagnostic,status] of [
 [new DOMException('private details','TimeoutError'),'UPSTREAM_TIMEOUT',504],
 [new Error('DNS lookup failed'),'UPSTREAM_DNS',502],
 [new Error('TLS certificate failure'),'UPSTREAM_TLS',502],
 [new Error('error 1042 same-zone worker'),'UPSTREAM_ROUTING',502],
 [new TypeError('internal runtime failure'),'UPSTREAM_EXCEPTION',502]
]) {
 test(`classifies ${diagnostic} without exposing raw exception text`,async()=>{
  const raw=error.message;
  await mockRun(async()=>{throw error;},async logs=>{
   const r=await worker.fetch(req(),env),text=await r.text(),data=JSON.parse(text);
   assert.equal(r.status,status);
   assert.equal(data.diagnostic,diagnostic);
   assert.equal(data.update_uncertain,false);
   assert.ok(!(text+JSON.stringify(logs)).includes(raw));
  });
 });
}

test('exceptions containing secrets, codes and arbitrary objects are not logged verbatim',async()=>{
 const privateText=[env.PRETIX_TOKEN,env.SCANNER_KEY,body.code].join(' ');
 for(const error of [new Error(privateText),{name:privateText,message:privateText},privateText]) {
  await mockRun(async()=>{throw error;},async logs=>{
   const r=await worker.fetch(req(),env),combined=await r.text()+JSON.stringify(logs);
   for(const secret of [env.PRETIX_TOKEN,env.SCANNER_KEY,body.code])assert.ok(!combined.includes(secret));
  });
 }
});

test('an unconfirmed expiry warns of possible change and never retries automatically',async()=>{
 let calls=0;
 await mockRun(async(url,init)=>{
  calls++;
  assert.equal(init.method,'PATCH');
  assert.equal(init.redirect,'manual');
  assert.deepEqual(JSON.parse(init.body),{valid_until:'2000-01-01T00:00:00Z'});
  throw new TypeError('connection interrupted');
 },async()=>{
  const r=await worker.fetch(req({op:'expire',target:'org/main',id:15}),env);
  const data=await r.json();
  assert.equal(r.status,502);
  assert.equal(data.update_uncertain,true);
  assert.match(data.error,/rescan in review mode/);
  assert.equal(calls,1);
 });
});

test('response size limit still rejects oversized data',async()=>{
 await mockRun(async()=>new Response('private upstream data',{
  headers:{'Content-Length':'2000001'}
 }),async()=>{
  const r=await worker.fetch(req(),env);
  assert.equal(r.status,502);
  assert.equal((await r.json()).diagnostic,'UPSTREAM_EXCEPTION');
 });
});
