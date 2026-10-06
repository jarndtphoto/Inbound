import { test } from "node:test";
import assert from "node:assert/strict";
import { clearArrivalAtisMemoryCache, expectedArrivalRunway, loadArrivalAtis } from "./arrival-runway.server.ts";
test('five-minute airport cache coalesces calls and rejects stale/failed bulletins',async()=>{
 const store={loadAtis:async()=>[],saveAtis:async()=>{}}; clearArrivalAtisMemoryCache();
 const load=(icao:string)=>loadArrivalAtis(icao,store);
 const saved=globalThis.fetch; let calls=0;
 const date=new Date(), hhmm=String(date.getUTCHours()).padStart(2,'0')+String(date.getUTCMinutes()).padStart(2,'0');
 globalThis.fetch=async (url)=>{
  calls++;
  const airport=String(url).split('/').at(-1);
  return new Response(JSON.stringify([{airport,type:'combined',datis:`ATIS ${hhmm}Z. LDG RWY 10C.`,updatedAt:airport==='KOLD'?'2000-01-01T00:00:00Z':date.toISOString()}]));
 };
 try{
  const [a,b]=await Promise.all([load('KNEW'),load('KNEW')]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.length,1);
  assert.deepEqual(await load('KOLD'),[]);
  globalThis.fetch=async()=>{throw Error('offline');};assert.deepEqual(await load('KERR'),[]);
  assert.deepEqual(await load('../x'),[]);
 }finally{globalThis.fetch=saved;}
});


test("AA2343 SAN to ORD replay keeps east-flow west threshold despite reciprocal provider hint", async () => {
  clearArrivalAtisMemoryCache();
  const store = {
    loadAtis: async () => [{ airport: "KORD", type: "combined", datis: "ARR EXP VECTORS ILS RWY 9L APCH, ILS RWY 10C APCH, VISUAL APCH RWY 10R.", time: "1728Z" }],
    saveAtis: async () => {},
  };
  const selected = await expectedArrivalRunway("KORD", {
    aircraft: { lat: 41.86, lon: -88.22 },
    providerRunway: "27L",
    actualLanding: false,
    windDir: 270,
    windKt: 8,
  }, store);

  assert.ok(selected);
  assert.equal(selected!.runway, "10R");
  assert.equal(selected!.heading, 90);
  assert.ok(Math.abs(selected!.threshold.lat - 41.95719909667969) < 1e-7);
  assert.ok(Math.abs(selected!.threshold.lon - -87.92790222167969) < 1e-7, "10R east-flow uses the west threshold");
});

test("ORD west-flow replay keeps west-flow east threshold despite reciprocal provider hint", async () => {
  clearArrivalAtisMemoryCache();
  const store = {
    loadAtis: async () => [{ airport: "KORD", type: "combined", datis: "ARR EXP VECTORS ILS RWY 27L APCH, ILS RWY 28R APCH.", time: "1728Z" }],
    saveAtis: async () => {},
  };
  const selected = await expectedArrivalRunway("KORD", {
    aircraft: { lat: 41.98, lon: -87.55 },
    providerRunway: "10R",
    actualLanding: false,
  }, store);

  assert.ok(selected);
  assert.equal(selected!.runway, "27L");
  assert.equal(selected!.heading, 270);
  assert.ok(Math.abs(selected!.threshold.lat - 41.98389816) < 1e-7);
  assert.ok(Math.abs(selected!.threshold.lon - -87.88905334) < 1e-7, "27L west-flow uses the east threshold");
  assert.equal(selected!.source, "ATIS");
});

test("confirmed actual provider runway can still override ATIS", async () => {
  clearArrivalAtisMemoryCache();
  const store = {
    loadAtis: async () => [{ airport: "KORD", type: "combined", datis: "LDG RWY 10C.", time: "1728Z" }],
    saveAtis: async () => {},
  };
  const selected = await expectedArrivalRunway("KORD", {
    aircraft: { lat: 41.98, lon: -87.85 },
    providerRunway: "27L",
    actualLanding: true,
  }, store);

  assert.equal(selected?.runway, "27L");
  assert.equal(selected?.source, "provider");
  assert.equal(selected?.heading, 270);
});
