import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFr24Flight, createFr24Cycle, normalizeFr24Position } from '../src/lib/fr24.server.ts';
import { createFr24Guard, setFr24GuardForTests } from '../src/lib/fr24-budget.server.ts';
import { createFr24PreviewSessionGuard, setFr24PreviewSessionGuardForTests } from '../src/lib/fr24-preview-session.server.ts';

async function setup(fn) {
 const env={...process.env}, original=globalThis.fetch;
 Object.assign(process.env,{VERCEL_ENV:'preview',FR24_PREVIEW_MODE:'fr24-only',FR24_PREVIEW_ENABLED:'1',FR24_API_TOKEN:'fixture-secret',FR24_PREVIEW_SESSION_ID:'fixture-one',FR24_PREVIEW_CREDIT_CAP:'16',FR24_PREVIEW_EXPIRES_AT:'2099-01-01T00:00:00Z'});
 let attempts=0, spent=0, stopped=false, daily=0, dispatch=true, dailyAllowed=true; const calls=[], keys=[];
 setFr24PreviewSessionGuardForTests({status:async()=>({blocked:stopped||spent>=16,state:stopped?'stopped_402':'budget_exhausted'}),reserve:async(max)=>{if(stopped||spent+max>16)return null;attempts++;spent+=max;return {reservationId:String(attempts),sessionId:'fixture-one',maximum:max}},finish:async(_r,d)=>{if(d.statusCode===402)stopped=true},canDispatch:async()=>dispatch});
 setFr24GuardForTests({cached:async(key)=>{keys.push(key);return null},acquire:async()=>true,release:async()=>{},store:async()=>{},usage:async()=>null,reserve:async()=>dailyAllowed?{day:'fixture',maximum:8,cap:16}:null,finish:async()=>{daily++}});
 globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return Response.json({data:[{callsign:'UAL1036',timestamp:Date.now()/1000,lat:41.98,lon:-87.9,alt:0,reg:'N1',orig_iata:'ORD',dest_iata:'RSW'}]})};
 try {await fn({calls,keys,get attempts(){return attempts},get spent(){return spent},get daily(){return daily},denyDispatch:()=>{dispatch=false},denyDaily:()=>{dailyAllowed=false},setResponse:(r)=>{globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return r()}}})}
 finally {globalThis.fetch=original; for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);setFr24GuardForTests(createFr24Guard());setFr24PreviewSessionGuardForTests(createFr24PreviewSessionGuard())}
}
test('Preview caps all requests across independent cycles and namespaces cache',()=>setup(async h=>{
 for(let i=0;i<2;i++) assert.ok(await loadFr24Flight('UAL1036',undefined,createFr24Cycle('UA1036')));
 await assert.rejects(loadFr24Flight('UAL1036',undefined,createFr24Cycle('UA1036')),/FR24_PREVIEW/);
 assert.equal(h.calls.length,2);assert.equal(h.spent,16);assert.ok(h.keys.every(k=>k.startsWith('preview:fixture-one:')));
 assert.ok(h.calls.every(c=>c.opts.redirect==='error'&&c.url.endsWith('limit=1')));
}));
test('402 consumes allowance once and permanently blocks later cycles',()=>setup(async h=>{
 h.setResponse(()=>Response.json({code:'PAYMENT_REQUIRED',message:'fixture-secret'},{status:402}));
 await assert.rejects(loadFr24Flight('UAL1036'),/402/); await assert.rejects(loadFr24Flight('UAL1036'),/stopped_402/);
 assert.equal(h.calls.length,1);assert.equal(h.attempts,1);assert.equal(h.spent,8);
}));
test('daily budget and expired dispatch both prevent network',()=>setup(async h=>{
 h.denyDaily();await assert.rejects(loadFr24Flight('UAL1036'),/BUDGET/);assert.equal(h.calls.length,0);
}));
test('expired reservation after daily SQL prevents dispatch',()=>setup(async h=>{
 h.denyDispatch();await assert.rejects(loadFr24Flight('UAL1036'),/PREVIEW_BLOCKED/);assert.equal(h.calls.length,0);
}));
test('Preview rejects invented observation timestamp and invalid coordinates',()=>setup(async()=>{
 assert.equal(normalizeFr24Position({lat:41,lon:-87,alt:0}),null);
 assert.equal(normalizeFr24Position({lat:91,lon:-87,timestamp:Date.now()/1000}),null);
}));
test('FR24-only mode closes free live and trace acquisition before cache or SQL',()=>setup(async()=>{
 const { createAdsbAcquirer } = await import('../src/lib/adsb-acquisition.server.ts');
 const store=new Proxy({}, {get(){throw Error('must not access free-provider cache')}});
 const acquire=createAdsbAcquirer(store,{fetch:async()=>{throw Error('must not fetch')}});
 for(const [provider,url] of [['fi','https://opendata.adsb.fi/api/v2/hex/a12345'],['trace-fi','https://globe.adsb.fi/data/traces/45/trace_recent_a12345.json']]) {
  const result=await acquire({provider,url});assert.equal(result.data,null);assert.equal(result.status,'unavailable');
 }
}));
