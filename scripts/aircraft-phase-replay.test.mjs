import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizedToLive } from '../src/lib/flight-data.ts';
import * as arrival from '../src/lib/arrival-projection-state.ts';
import { phaseOf } from '../src/lib/aircraft-phase.ts';
import { runStages, runProjection, captured, DEST, ORIGIN, stageOf } from './phase-replays.mjs';
const dir=await mkdtemp(resolve('node_modules/.phase-replay-'));
const entry=join(dir,'entry.mjs');
await writeFile(entry,`export {currentStageOf,isFinalApproach,liveFromTracePt,liveFromAware} from ${JSON.stringify(resolve('src/lib/story.server.ts'))}; export {toTraffic} from ${JSON.stringify(resolve('src/lib/sky.ts'))}; export {TrafficList} from ${JSON.stringify(resolve('src/components/traffic-list.tsx'))};`);
await build({configFile:false,logLevel:'silent',resolve:{alias:{'@':resolve('src')}},plugins:[react()],build:{ssr:entry,outDir:join(dir,'out'),rollupOptions:{output:{entryFileNames:'replay.mjs'}}}});
const server=await import(pathToFileURL(join(dir,'out/replay.mjs')));
after(()=>rm(dir,{recursive:true,force:true}));
const runs=runStages(server,normalizedToLive);
test('departure level-off and small negative rates at 6000ft stay ride/climb',()=>{
  assert.ok(runs[0].rows.every(r=>r.stage==='ride'&&r.phase==='climb'));
  // Even an already-confirmed descent must not enter arrival near origin.
  const fixture={origin:DEST,dest:ORIGIN};
  assert.equal(stageOf(server,{lat:DEST.lat,lon:DEST.lon-.1,altFt:6000,gsKt:220,onGround:false,phase:'approach',vertFpm:-1200,phaseVertFpm:-1200},fixture),'ride');
});
test('cruise ±400fpm jitter stays ride/cruise while retaining raw readings',()=>{
  assert.ok(runs[1].rows.every(r=>r.stage==='ride'&&r.phase==='cruise'&&r.confirmedRate===null&&Math.abs(r.rawRate)===400));
});
test('sustained descent at 80nm starts arrival before the legacy distance-only gate',()=>{
  assert.equal(runs[2].arrivalMinute,0);assert.equal(runs[2].rows.find(r=>r.minute===0).phase,'descent');
});
test('sustained descent plus outer-final geometry works before the 7.5nm gate',()=>{
  assert.equal(runs[3].finalMinute,0);assert.equal(runs[3].rows.find(r=>r.minute===0).phase,'approach');
});
for(const name of ['aa662','ual2207']) test(`${name.toUpperCase()} captured fixes preserve the arrival projection versus legacy phase inputs`,()=>{
  const fixture=captured(name);
  const legacy=p=>({...normalizedToLive(p),vertFpm:null,phase:'cruise',phaseVertFpm:undefined});
  const oldServer={isFinalApproach:live=>server.isFinalApproach({...live,phaseVertFpm:undefined,phase:'cruise',vertFpm:null},fixture.destination)};
  const expected=runProjection(oldServer,legacy,arrival,fixture),actual=runProjection(server,normalizedToLive,arrival,fixture);
  assert.deepEqual(actual,expected);
  assert.ok(actual.some(p=>p.state.active));assert.ok(actual.at(-1).state.cursorNm>0);
});
test('FlightAware and trace cold starts derive the same descent from existing ≥30s tracks',()=>{
  const now=Date.now,t=Date.parse('2026-10-02T18:00:00Z')/1000;
  Date.now=()=>t*1000;
  try{
    const pt={t,lat:DEST.lat,lon:DEST.lon-.2,alt:5000,gs:180,track:90};
    const prior={...pt,t:t-40,alt:5600};
    const context={origin:ORIGIN,dest:DEST,history:[{...prior,seenAt:prior.t,altFt:prior.alt}]};
    for(const live of [server.liveFromTracePt(pt,'a00100',{},context),server.liveFromAware({origin:'MCO',dest:'ORD',ident:'TEST1',faTrack:[prior,pt]},context)]){
      assert.equal(live.phase,'approach');assert.equal(live.vertFpm,-900);assert.ok(live.phaseRateWindowSec>=30);
    }
  }finally{Date.now=now;}
});
test('traffic uses sustained geometry/rates instead of a second phase definition',()=>{
  const now=Date.now,t=Date.parse('2026-10-02T18:00:00Z');
  try{
    Date.now=()=>t;server.toTraffic({hex:'a00099',flight:'TEST99',lat:DEST.lat,lon:DEST.lon-.4,alt_baro:20600,geom_rate:-900,gs:250,seen_pos:0},DEST);
    Date.now=()=>t+40000;
    const traffic=server.toTraffic({hex:'a00099',flight:'TEST99',lat:DEST.lat,lon:DEST.lon-.36,alt_baro:20000,geom_rate:-900,gs:250,seen_pos:0},DEST);
    assert.equal(traffic.phase,'descent');assert.equal(traffic.vertFpm,-900);
    assert.equal(phaseOf({onGround:true,gsKt:10}),'taxi');assert.equal(phaseOf({onGround:true,gsKt:0}),'parked');
  }finally{Date.now=now;}
});

test('actual traffic rows keep descent/climb labels visible beside airline/type',()=>{
  const base={hex:'a00011',callsign:'TEST11',airline:'United',type:'B738',distNm:5,bearing:90,altFt:20000,gsKt:250,track:90,onGround:false,vertFpm:-900,phase:'descent'};
  const traffic=[base,{...base,hex:'a00012',callsign:'TEST12',vertFpm:1200,phase:'climb'}];
  const rows=renderToStaticMarkup(createElement(server.TrafficList,{traffic}));
  assert.match(rows,/United[^<]*Descending/);assert.match(rows,/United[^<]*Climbing/);assert.doesNotMatch(rows,/Cruise/i);

});
