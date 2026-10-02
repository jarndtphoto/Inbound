import { test } from "node:test";
import assert from "node:assert/strict";
import { loadArrivalAtis } from "./arrival-runway.server.ts";
test('five-minute airport cache coalesces calls and rejects stale/failed bulletins',async()=>{
 const saved=globalThis.fetch; let calls=0;
 const date=new Date(), hhmm=String(date.getUTCHours()).padStart(2,'0')+String(date.getUTCMinutes()).padStart(2,'0');
 globalThis.fetch=async (url)=>{
  calls++;
  const airport=String(url).split('/').at(-1);
  return new Response(JSON.stringify([{airport,type:'combined',datis:`ATIS ${hhmm}Z. LDG RWY 10C.`,updatedAt:airport==='KOLD'?'2000-01-01T00:00:00Z':date.toISOString()}]));
 };
 try{
  const [a,b]=await Promise.all([loadArrivalAtis('KNEW'),loadArrivalAtis('KNEW')]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.length,1);
  assert.deepEqual(await loadArrivalAtis('KOLD'),[]);
  globalThis.fetch=async()=>{throw Error('offline');};assert.deepEqual(await loadArrivalAtis('KERR'),[]);
  assert.deepEqual(await loadArrivalAtis('../x'),[]);
 }finally{globalThis.fetch=saved;}
});
