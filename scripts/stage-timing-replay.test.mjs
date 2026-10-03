import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { polishStory } from './fixtures/presentation-polish.mjs';
import { statusProgressIndex, stageStepId } from '../src/lib/flight-stage.ts';
import { flightAirborne, elapsedFlight, flownDistance, remainingFlight } from '../src/lib/flight-presentation.ts';

let directory, ui;
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.stage-timing-replay-'));
  await build({ configFile:false, logLevel:'silent', resolve:{alias:{'@':resolve('src')}},
    plugins:[{name:'test-stage-timing',enforce:'pre',transform(code,id){
      if(id===resolve('src/components/filed-app.tsx')) return code+'\nexport {FlightHead, TimesStrip, FlightStatusProgress};\nexport {preserveDepartureProgress, preferFreshAirborneState} from "@/lib/story";';
    }},react()],build:{ssr:resolve('src/components/filed-app.tsx'),outDir:directory,rollupOptions:{output:{entryFileNames:'ui.mjs'}}} });
  ui=await import(pathToFileURL(join(directory,'ui.mjs')).href);
});

test('observed airborne without a clock shows approximate elapsed and nonzero distance, keeping actual Takeoff empty',()=>{
  const base=polishStory(), input={...base,
    confirmedTakeoff:{source:'observed_airborne',at:null,confirmedAt:base.fetchedAt/1000-120},
    times:{...base.times,takeoff:null,takeoffUnix:null,takeoffKind:null},
    route:{...base.route,flownNm:0},aircraft:{...base.aircraft,lat:42.06,lon:-87.95}};
  assert.equal(elapsedFlight(input).minutes,2);assert.equal(elapsedFlight(input).approximate,true);
  assert(flownDistance(input).nm>1);assert.equal(flownDistance(input).source,'position');
  const html=markup(ui.TimesStrip,input);assert.match(html,/Approx\. 2m/);assert.doesNotMatch(html,/Approx\. 0 miles/);
  assert.equal(input.times.takeoffUnix,null);assert.equal(input.times.takeoffKind,null);
  const tracked={...input,route:{...input.route,observedFlownNm:7}};
  assert.deepEqual(flownDistance(tracked),{nm:7,source:'track'});
  const gap={...tracked,live:false,aircraft:null};assert.equal(elapsedFlight(gap).minutes,2);
  assert.equal(flownDistance(gap).nm,7);
  assert.equal(flownDistance({...gap,route:{...gap.route,observedFlownNm:null}}),null);
  assert.equal(elapsedFlight({...input,stateKey:null}),null,'unvalidated device evidence supplies no approximate clock');
  assert.equal(elapsedFlight({...input,times:{...input.times,takeoffUnix:base.fetchedAt/1000-300,takeoffKind:'actual'}}).estimated,false);
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
function markup(Component, story) {
  const realNow=Date.now;Date.now=()=>story.fetchedAt;
  try{return renderToStaticMarkup(h(QueryClientProvider,{client:new QueryClient()},h(Component,{story})));}finally{Date.now=realNow;}
}

test('UA219 oceanic gap retains a provider ETA and labels it estimated, never a reset route ETA',()=>{
  const base=polishStory(), now=base.fetchedAt;
  const gap={...base,live:false,aircraft:null,
    providers:{chosenPositionAgeSec:600,providerEta:{flightaware:now/1000+44*60,fr24:null}},
    route:{...base.route,etaMin:500}};
  assert.equal(remainingFlight(gap,now).minutes,44);assert.equal(remainingFlight(gap,now).estimated,true);
  const html=markup(ui.TimesStrip,gap);
  assert.match(html,/>44m</);assert.match(html,/Estimated · No live position · last seen 10 min ago/);
  assert.doesNotMatch(html,/Updating…|Live position is stale/);
  const server={...gap,providers:{chosenPositionAgeSec:null,etaMin:38},times:{...gap.times,landUnix:null}};
  assert.equal(remainingFlight(server,now+60_000).minutes,37);
  assert.match(markup(ui.TimesStrip,server),/Estimated · No live position/);
  const unavailable={...server,providers:{},route:{...server.route,etaMin:NaN}};
  assert.equal(remainingFlight(unavailable,now).minutes,null);assert.match(markup(ui.TimesStrip,unavailable),/Updating…/);
});

test('DL4820 surface takeoff roll activates Taxi, then confirmed airborne activates Flight without a takeoff clock',()=>{
  const base=polishStory(), origin={...base.origin,iata:'MDW',icao:'KMDW',lat:41.7868,lon:-87.7522};
  const input={...base,query:'DL4820',iata:'DL4820',callsign:'DAL4820',airline:'Delta',origin,
    currentStage:'taxi',confirmedTakeoff:null,stateKey:'leg:v1:DAL4820|2026-10-03|MDW|MSP',
    aircraft:{...base.aircraft,...origin,onGround:true,altFt:620,gsKt:70},
    times:{...base.times,takeoff:null,takeoffUnix:null,takeoffKind:null,airborne:false}};
  const roll=ui.preserveDepartureProgress(input);
  assert.equal(roll.currentStage,'takeoff_roll'); assert.equal(flightAirborne(roll),false);
  assert.equal(statusProgressIndex(roll.currentStage),2); assert.equal(stageStepId(roll.currentStage),'taxi');
  assert.match(markup(ui.FlightHead,roll),/>Takeoff roll</);
  assert.match(markup(ui.FlightStatusProgress,roll),/Flight progress: Taxi/);
  const airborne=ui.preferFreshAirborneState({...roll,aircraft:{...roll.aircraft,onGround:false,altFt:2000,gsKt:180},
    confirmedTakeoff:{source:'observed_airborne',at:null,confirmedAt:base.fetchedAt/1000}});
  assert.equal(airborne.currentStage,'ride');assert.equal(flightAirborne(airborne),true);
  assert.equal(statusProgressIndex(airborne.currentStage),3);
  assert.equal(airborne.times.takeoffUnix,null);assert.notEqual(airborne.times.takeoffKind,'actual');
});
