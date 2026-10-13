import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';
const env={PRETIX_BASE_URL:'https://pretix.example',SCANNER_ORIGIN:'https://scanner.example',ALLOWED_TARGETS:'org/main,org/second',PRETIX_TOKEN:'NOT_A_REAL_TOKEN',SCANNER_KEY:'MOCK_KEY_WITH_MORE_THAN_32_CHARACTERS'};
const req=(path='/meta',body=null,overrides={})=>new Request('https://bridge.example'+path,{method:body?'POST':'GET',headers:{Origin:env.SCANNER_ORIGIN,Authorization:'Bearer '+env.SCANNER_KEY,...(body?{'Content-Type':'application/json'}:{}),...overrides.headers},...(body?{body:JSON.stringify(body)}:{}),...Object.fromEntries(Object.entries(overrides).filter(([k])=>k!=='headers'))});
test('bridge metadata contains no secrets',async()=>{const r=await worker.fetch(req(),env);assert.equal(r.status,200);const s=await r.text();assert.ok(!s.includes(env.PRETIX_TOKEN));assert.ok(!s.includes(env.SCANNER_KEY));assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.SCANNER_ORIGIN);});
test('bridge rejects wrong origin even with valid key',async()=>assert.equal((await worker.fetch(req('/meta',null,{headers:{Origin:'https://evil.example'}}),env)).status,403));
test('bridge rejects missing or wrong key',async()=>{for(const Authorization of ['','Bearer nope'])assert.equal((await worker.fetch(req('/meta',null,{headers:{Authorization}}),env)).status,401);});
test('bridge allows preflight without authentication',async()=>{const r=await worker.fetch(req('/voucher',null,{method:'OPTIONS',headers:{Authorization:'','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}}),env);assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.SCANNER_ORIGIN);});
test('bridge rejects unsafe preflight',async()=>assert.equal((await worker.fetch(req('/voucher',null,{method:'OPTIONS',headers:{'Access-Control-Request-Method':'DELETE'}}),env)).status,403));
test('bridge fails closed when unconfigured',async()=>assert.equal((await worker.fetch(req(),{})).status,503));
test('bridge rejects event outside allowlist',async()=>assert.equal((await worker.fetch(req('/voucher',{op:'expire',target:'org/private',id:1}),env)).status,403));
test('bridge rejects arbitrary operation',async()=>assert.equal((await worker.fetch(req('/voucher',{op:'delete',target:'org/main',id:1}),env)).status,403));
test('bridge rejects arbitrary request destination',async()=>assert.equal((await worker.fetch(req('/voucher',{op:'expire',target:'org/main',id:1,url:'https://evil.example'}),env)).status,400));
test('bridge rejects arbitrary fields on update',async()=>assert.equal((await worker.fetch(req('/voucher',{op:'expire',target:'org/main',id:1,valid_until:null}),env)).status,400));
test('bridge rejects traversal and negative IDs',async()=>{for(const id of [-1,0,'../orders',1.5])assert.equal((await worker.fetch(req('/voucher',{op:'expire',target:'org/main',id}),env)).status,400);});
test('bridge rejects oversized payload',async()=>assert.equal((await worker.fetch(req('/voucher',{op:'lookup',target:'org/main',code:'a'.repeat(5000)}),env)).status,400));
test('bridge rejects client query string',async()=>assert.equal((await worker.fetch(req('/meta?url=evil'),env)).status,400));
test('bridge fixed update reaches only configured API with server token',async()=>{
 const original=globalThis.fetch;let seen;globalThis.fetch=async(url,init)=>{seen={url,init};return new Response('{"id":1}');};
 try{const r=await worker.fetch(req('/voucher',{op:'expire',target:'org/main',id:1}),env);assert.equal(r.status,200);assert.equal(seen.url,'https://pretix.example/api/v1/organizers/org/events/main/vouchers/1/');assert.equal(seen.init.method,'PATCH');assert.equal(seen.init.redirect,'manual');assert.equal(seen.init.headers.Authorization,'Token '+env.PRETIX_TOKEN);assert.deepEqual(JSON.parse(seen.init.body),{valid_until:'2000-01-01T00:00:00Z'});}finally{globalThis.fetch=original;}
});
test('bridge lookup encodes exact code',async()=>{const original=globalThis.fetch;let url;globalThis.fetch=async(u)=>{url=u;return new Response('{"count":0,"results":[]}');};try{await worker.fetch(req('/voucher',{op:'lookup',target:'org/main',code:'A+B.'}),env);assert.equal(new URL(url).searchParams.get('code'),'A+B.');}finally{globalThis.fetch=original;}});
test('bridge never sends upstream error text to browser',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>new Response('secret upstream debug',{status:403});try{const r=await worker.fetch(req('/voucher',{op:'read',target:'org/main',id:1}),env);assert.equal(r.status,403);assert.ok(!(await r.text()).includes('secret upstream'));}finally{globalThis.fetch=original;}});
