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


test("non-actual provider reciprocal cannot override ORD east-flow ATIS", async () => {
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
  assert.match(selected!.runway, /^(9|10)/);
  assert.equal(selected!.heading, 90);
  assert.ok(selected!.threshold.lon < -87.91, "east-flow arrivals use the west threshold");
});

test("AA2343 ORD east-flow replay keeps the east runway end, threshold, and course", async () => {
  clearArrivalAtisMemoryCache();
  const store = {
    loadAtis: async () => [{
      airport: "KORD",
      type: "combined",
      datis: "ARR EXP VECTORS ILS RWY 9L APCH, ILS RWY 10C APCH, VISUAL APCH RWY 10R.",
      time: "1728Z",
    }],
    saveAtis: async () => {},
  };
  const selected = await expectedArrivalRunway("KORD", {
    aircraft: { lat: 41.86, lon: -88.22 },
    providerRunway: "27L",
    actualLanding: false,
  }, store);

  assert.ok(selected);
  assert.equal(selected.runway, "10R");
  assert.deepEqual(selected.threshold, { lat: 41.95719909667969, lon: -87.92790222167969 });
  assert.equal(selected.heading, 90);
  assert.equal(selected.source, "ATIS");
});

test("ORD west-flow replay keeps the west runway end, threshold, and course", async () => {
  clearArrivalAtisMemoryCache();
  const store = {
    loadAtis: async () => [{
      airport: "KORD",
      type: "combined",
      datis: "ARR EXP VECTORS ILS RWY 27L APCH, ILS RWY 28R APCH.",
      time: "1728Z",
    }],
    saveAtis: async () => {},
  };
  const selected = await expectedArrivalRunway("KORD", {
    aircraft: { lat: 41.98, lon: -87.55 },
    providerRunway: "10R",
    actualLanding: false,
  }, store);

  assert.ok(selected);
  assert.equal(selected.runway, "27L");
  assert.deepEqual(selected.threshold, { lat: 41.98389816, lon: -87.88905334 });
  assert.equal(selected.heading, 270);
  assert.equal(selected.source, "ATIS");
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
