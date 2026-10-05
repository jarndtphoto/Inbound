import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivalRunways, pickArrivalRunway, runwayThreshold, runwayBearing, type RunwayEnd } from "./arrival-runway.ts";
import { arrivalPattern, canProjectArrival } from "./arrival-pattern.ts";
import { destPoint, haversineNm } from "./geo.ts";
import { passengerEtaMin } from "./flight-data.ts";
const ends: RunwayEnd[] = [
 {ident:'09L',lat:42.0028,lon:-87.9267,heading:90},
 {ident:'10C',lat:41.9657,lon:-87.9315,heading:90},
 {ident:'10R',lat:41.9572,lon:-87.9279,heading:90},
 {ident:'28C',lat:41.9657,lon:-87.8918,heading:270}
];
const atis = (text:string,type='combined')=>[{airport:'KORD',type,datis:text}];
test('ATIS arrival lists, approach assignments, combined LDG/DEP and no bulletin',()=>{
 assert.deepEqual(arrivalRunways('LDG RWY 10C, 10R. DEP RWY 9L.'),['10C','10R']);
 assert.deepEqual(arrivalRunways('EXPECT ILS RWY 9L'),['9L']);
 assert.deepEqual(arrivalRunways('LDG/DEP RWYS 22L, 22R.'),['22L','22R']);
 assert.deepEqual(arrivalRunways('LDG RWY 10C AND DEP RWY 9L'),['10C']);
 assert.deepEqual(arrivalRunways('ARR EXP VECTORS ILS RWY 9L APCH, ILS RWY 10C APCH, VISUAL APCH RWY 10R. DEPS EXP RWYS 9C, 10L. RWY 4L, 22R CLSD.'),['9L','10C','10R']);
 assert.deepEqual(arrivalRunways('DEP RWY 9L. RWY 10C CLOSED.'),[]);
 assert.deepEqual(arrivalRunways(null),[]);
});
test('multiple arrival runways choose the aircraft side and remain stable between polls',()=>{
 const first=pickArrivalRunway({ends,atis:atis('LDG RWY 9L, 10C, 10R'),aircraft:{lat:42.04,lon:-88.2}})!;
 assert.equal(first.runway,'9L');assert.equal(first.estimated,true);
 const next=pickArrivalRunway({ends,atis:atis('LDG RWY 9L, 10C, 10R'),aircraft:{lat:41.98,lon:-88.2},previous:first})!;
 assert.equal(next.runway,'9L');
 const removed=pickArrivalRunway({ends,atis:atis('LDG RWY 10C, 10R'),aircraft:{lat:41.96,lon:-88.2},previous:first})!;
 assert.equal(removed.runway,'10R');
});
test('provider fallback, confirmed actual priority, wind fallback, calm/variable/unknown states',()=>{
 assert.equal(pickArrivalRunway({ends,providerRunway:'10C'})?.source,'provider');
 assert.equal(pickArrivalRunway({ends,atis:atis('LDG RWY 9L'),providerRunway:'10C',actualLanding:true})?.runway,'10C');
 assert.equal(pickArrivalRunway({ends,atis:atis('DEPG RWY 9L','dep'),windDir:270,windKt:10})?.runway,'28C');
 assert.equal(pickArrivalRunway({ends,windDir:90,windKt:1}),null);
 assert.equal(pickArrivalRunway({ends,windDir:NaN,windKt:10}),null);
 assert.equal(pickArrivalRunway({ends}),null);
});
const runway=pickArrivalRunway({ends,providerRunway:'10C'})!;
test('aligned aircraft passes FAF and ends exactly at threshold without a loop',()=>{
 const here={...destPoint(runway.threshold,270,18),track:90};
 const p=arrivalPattern(here,runway);assert.equal(p.kind,'straight-in');
 assert.deepEqual(p.points.at(-1),runway.threshold);assert.ok(Math.abs(p.lengthNm-18)<.05);
 assert.ok(p.points.some(c=>haversineNm(c,destPoint(runway.threshold,270,9))<.001));
 const inside=arrivalPattern({...destPoint(runway.threshold,270,3),track:90},runway);
 assert.ok(inside.lengthNm<3.1); // Never flies back out to the FAF.
});
for(const [name,bearing,track] of [['opposite side',90,90],['side',0,180]] as const)test(name+' produces downwind, a smoothed base, and a longer path',()=>{
 const here={...destPoint(runway.threshold,bearing,12),track};const p=arrivalPattern(here,runway);
 assert.equal(p.kind,'downwind-base');assert.deepEqual(p.points[0],here);assert.deepEqual(p.points.at(-1),runway.threshold);
 assert.ok(p.lengthNm>haversineNm(here,runway.threshold)+5);
 assert.ok(p.points.length>24);assert.ok(p.points.some(c=>haversineNm(c,destPoint(runway.threshold,270,9))<.001));
 assert.ok(Math.abs(runwayBearing(p.points.at(-2)!,p.points.at(-1)!)-90)<2);
 const eta=passengerEtaMin({remainingNm:p.lengthNm,directToDestNm:12,gsKt:160,providerEtaMin:1});
 assert.ok(eta>12/160*60+1); // The final-approach ETA uses the pattern, not direct distance.
});
test('patterns require a fresh descending/approach fix near destination, never ground or landed',()=>{
 const live={...destPoint(runway.threshold,90,12),seenSec:10,phase:'approach',onGround:false};
 assert.equal(canProjectArrival(live,runway.threshold,false),true);
 assert.equal(canProjectArrival({...live,onGround:true},runway.threshold,false),false);
 assert.equal(canProjectArrival(live,runway.threshold,true),false);
 assert.equal(canProjectArrival({...live,seenSec:120},runway.threshold,false),false);
 assert.equal(canProjectArrival({...live,phase:'cruise'},runway.threshold,false),false);
 assert.equal(canProjectArrival({...live,...destPoint(runway.threshold,90,70)},runway.threshold,false),false);
});
test('displaced landing threshold is moved forward along the true runway heading',()=>{
 const end={...ends[1],displacedFt:6076.12};assert.ok(Math.abs(haversineNm(end,runwayThreshold(end))-1)<.001);
});


test("ORD east flow from the southwest finishes eastbound at the west threshold", () => {
 const selected = pickArrivalRunway({
  ends,
  atis: atis("ARR EXP VECTORS ILS RWY 9L APCH, ILS RWY 10C APCH, VISUAL APCH RWY 10R."),
  aircraft: { lat: 41.86, lon: -88.22 },
  providerRunway: "27L",
  actualLanding: false,
 })!;
 assert.match(selected.runway, /^(9|10)/);
 assert.equal(selected.heading, 90);
 assert.ok(selected.threshold.lon < -87.91);
 const aircraft = { ...destPoint(selected.threshold, 250, 14), track: 90 };
 const pattern = arrivalPattern(aircraft, selected);
 assert.deepEqual(pattern.points.at(-1), selected.threshold);
 assert.ok(pattern.points.at(-2)!.lon < selected.threshold.lon, "final segment starts west of the threshold");
 assert.ok(Math.abs(runwayBearing(pattern.points.at(-2)!, pattern.points.at(-1)!)-90)<2);
});

test("ORD west flow finishes westbound at the east threshold", () => {
 const selected = pickArrivalRunway({
  ends,
  atis: atis("LDG RWY 27L, 28C."),
  aircraft: { lat: 41.98, lon: -87.6 },
 })!;
 assert.match(selected.runway, /^(27|28)/);
 assert.equal(selected.heading, 270);
 assert.ok(selected.threshold.lon > -87.91);
 const aircraft = { ...destPoint(selected.threshold, 70, 14), track: 270 };
 const pattern = arrivalPattern(aircraft, selected);
 assert.deepEqual(pattern.points.at(-1), selected.threshold);
 assert.ok(pattern.points.at(-2)!.lon > selected.threshold.lon, "final segment starts east of the threshold");
 assert.ok(Math.abs(runwayBearing(pattern.points.at(-2)!, pattern.points.at(-1)!)-270)<2);
});

test("MCO south flow finishes on the north threshold without a reciprocal reversal", () => {
 const mco = [
  {ident:"18R",lat:28.448299407958984,lon:-81.3270034790039,heading:179},
  {ident:"36L",lat:28.415300369262695,lon:-81.32659912109375,heading:359},
 ];
 const selected = pickArrivalRunway({ ends: mco, atis: atis("LDG RWY 18R."), aircraft: { lat: 28.7, lon: -81.38 } })!;
 const aircraft = { ...destPoint(selected.threshold, 350, 16), track: 179 };
 const pattern = arrivalPattern(aircraft, selected);
 assert.equal(selected.runway, "18R");
 assert.deepEqual(pattern.points.at(-1), selected.threshold);
 assert.ok(pattern.points.at(-2)!.lat > selected.threshold.lat, "final segment starts north of the threshold");
 assert.ok(Math.abs(runwayBearing(pattern.points.at(-2)!, pattern.points.at(-1)!)-179)<2);
});
