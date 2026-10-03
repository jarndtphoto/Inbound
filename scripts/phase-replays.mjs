import { readFileSync } from 'node:fs';
import { destPoint, haversineNm } from '../src/lib/geo.ts';
export const ORIGIN = { lat: 28.4294, lon: -81.3089, elevationFt: 96 };
export const DEST = { lat: 41.9786, lon: -87.9048, elevationFt: 672 };
const firstAt = Date.parse('2026-10-02T18:00:00Z') / 1000;
const position = (at, nm, altFt, vertFpm, track = 90, gsKt = 300) => ({ provider:'adsb',flightId:null,callsign:'TEST1',hex:'a00101',registration:'N1',type:'B738',confidence:'high',
  ...destPoint(DEST,270,nm),seenAt:firstAt+at,altFt,vertFpm,track,gsKt,onGround:false });
export function scenarios() {
  return [
    { name:'departure', origin:DEST, dest:ORIGIN, fixes:Array.from({length:9},(_,i)=>({...position(i*10,6,6000+(i%2)*25,[1000,0,-400][i%3],270,220),minute:i/6})), expected:'ride' },
    { name:'cruise jitter', origin:ORIGIN, dest:DEST, fixes:Array.from({length:12},(_,i)=>({...position(i*10,220,35000+(i%2)*30,i%2?400:-400),minute:i/6})), expected:'ride' },
    // A 60s lookback is included before the first reported point. 5nm/min descent.
    { name:'80nm descent', origin:ORIGIN, dest:DEST, fixes:Array.from({length:11},(_,i)=>({...position((i-1)*60,85-i*5,21500-i*1500,-1500),minute:i-1})) },
    // Base-to-final: ~0.8nm/min radial closure at 140kt and 70deg offset.
    { name:'outer final', origin:ORIGIN, dest:DEST, fixes:Array.from({length:8},(_,i)=>({...position((i-1)*60,12.3-i*.8,6600-i*600,-600,160,140),minute:i-1})) },
  ];
}
export function stageOf(server, live, fixture) {
  return server.currentStageOf({live,origin:fixture.origin,dest:fixture.dest,remainingNm:live?haversineNm(live,fixture.dest):1000,
    ourTakeoffActual:firstAt-3600,faAirborne:true,ourLanded:false,inboundStatus:'complete',pushed:true,
    confirmedTakeoff:{unix:firstAt-3600,source:'observed_airborne'}});
}
export function runStages(server, normalize) {
  const now=Date.now;
  try { return scenarios().map(fixture=>{
    const history=[];
    const rows=fixture.fixes.map(fix=>{ Date.now=()=>fix.seenAt*1000;
      const live=normalize(fix,{origin:fixture.origin,dest:fixture.dest,history});
      const row={minute:fix.minute,phase:live.phase,stage:stageOf(server,live,fixture),rawRate:live.vertFpm,confirmedRate:live.phaseVertFpm??null};
      history.push(fix); return row;
    });
    return {name:fixture.name,rows,arrivalMinute:rows.find(r=>r.minute>=0&&['arrival','final_approach'].includes(r.stage))?.minute??null,
      finalMinute:rows.find(r=>r.minute>=0&&r.stage==='final_approach')?.minute??null};
  }); } finally {Date.now=now;}
}
export function captured(name) {
  const f=JSON.parse(readFileSync(new URL(`../src/lib/fixtures/${name}-arrival-2026-10-02.json`,import.meta.url)));
  if(name==='ual2207') {f.origin={lat:29.9844,lon:-95.3414,elevationFt:97};f.fixes=f.fixes.map(fix=>({...position(0,1,fix.altFt,null),...fix,seenAt:Date.parse(`${f.date}T${fix.time}Z`)/1000-fix.seenSec}));}
  return f;
}
export function runProjection(server,normalize,arrival,fixture) {
  let state=arrival.emptyArrivalState(); const history=[],now=Date.now;
  try {return fixture.fixes.map(fix=>{
    const at=Date.parse(`${fixture.date}T${fix.time}Z`);
    Date.now=()=>at;
    const live={...normalize(fix,{origin:fixture.origin,dest:fixture.destination,history}),seenSec:fix.seenSec,extrapolated:fix.extrapolated??false};
    const result=arrival.updateArrivalProjection(JSON.parse(JSON.stringify(state)),{live:{...live,vertFpm:fix.vertFpm??null},runway:fixture.runway,dest:fixture.destination,
      landed:false,approachEvidence:server.isFinalApproach(live,fixture.destination),now:at});
    state=result.state;history.push(fix);
    return {time:fix.time,state,reason:result.reason,remainingNm:result.pattern?.lengthNm??null};
  });}finally{Date.now=now;}
}
