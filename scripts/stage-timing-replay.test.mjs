import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
      if(id===resolve('src/components/filed-app.tsx')) return code+'\nexport {FlightHead, TimesStrip, FlightStatusProgress, RouteMap, Fr24AccessStoppedNotice, PreviewProviderStatus};\nexport {preserveDepartureProgress, preferFreshAirborneState} from "@/lib/story";';
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
function markup(Component, story, props = {}, now = story.fetchedAt) {
  const realNow=Date.now;Date.now=()=>now;
  try{return renderToStaticMarkup(h(QueryClientProvider,{client:new QueryClient()},h(Component,{story,...props})));}finally{Date.now=realNow;}
}

test('taxiing movement and a taxi hold use the same direct Taxiing out label',async()=>{
  const base=polishStory();
  for(const gsKt of [0,15]) {
    const story={...base,currentStage:'taxi',confirmedTakeoff:null,
      aircraft:{...base.aircraft,...base.origin,onGround:true,gsKt},times:{...base.times,airborne:false,takeoffKind:null,takeoffUnix:null}};
    const html=markup(ui.FlightHead,story);
    assert.match(html,/>Taxiing out</);assert.doesNotMatch(html,/Heading to runway|Holding short/);
  }
  assert.doesNotMatch(await readFile(resolve('src/routes/index.tsx'),'utf8'),/MutationObserver|createTreeWalker/);
});

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

test('held final-approach progress beats an older saved-resume landing ETA',()=>{
  const base=polishStory(), now=base.fetchedAt;
  const held={...base,live:false,currentStage:'final_approach',aircraft:null,
    providers:{...base.providers,chosenPositionAgeSec:120,etaMin:11,providerEta:{flightaware:now/1000+11*60,fr24:null},scheduleSource:'saved_resume'},
    route:{...base.route,progressSource:'last_known',progressObservedAt:now-30_000,remainingNm:.14,etaMin:1.5},
    times:{...base.times,landKind:'estimated',landUnix:now/1000+11*60}};
  const view=remainingFlight(held,now);
  assert.equal(view.minutes,1.5);assert.equal(view.estimated,true);
  assert.notEqual(view.minutes,11,'saved fallback ETA cannot replace held near-touchdown ETA');
});

test('Map and Overview render one shared remaining time with identical boundary rounding',()=>{
  const base=polishStory();
  const qa={...base,providers:{...base.providers,etaMin:441},route:{...base.route,etaMin:451}};
  const shared=remainingFlight(qa,base.fetchedAt);
  assert.equal(shared.text,'7h 21m');
  const overview=markup(ui.TimesStrip,qa,{remaining:shared});
  const map=markup(ui.RouteMap,qa,{fixedViewport:true,remaining:shared});
  assert.match(overview,/>7h 21m</);assert.match(map,/Remaining [^<]* · 7h 21m/);
  assert.doesNotMatch(map,/7h 31m/);

  for(const [minutes,expected] of [[59.49,'59m'],[59.5,'1h'],[60.49,'1h'],[60.5,'1h 1m']]) {
    const input={...base,providers:{...base.providers,etaMin:minutes},route:{...base.route,etaMin:minutes+10}};
    const view=remainingFlight(input,base.fetchedAt);
    assert.equal(view.text,expected);
    assert.match(markup(ui.TimesStrip,input,{remaining:view}),new RegExp(`>${expected}<`));
    assert.match(markup(ui.RouteMap,input,{fixedViewport:true,remaining:view}),new RegExp(`· ${expected}<`));
  }

  const crossing={...base,providers:{...base.providers,etaMin:60.99},route:{...base.route,etaMin:470}};
  const afterThirtySeconds=remainingFlight(crossing,base.fetchedAt+30_000);
  assert.equal(afterThirtySeconds.text,'1h');
  assert.match(markup(ui.TimesStrip,crossing,{remaining:afterThirtySeconds},base.fetchedAt+30_000),/>1h</);
  assert.match(markup(ui.RouteMap,crossing,{fixedViewport:true,remaining:afterThirtySeconds},base.fetchedAt+30_000),/· 1h</);
});

test('Map keeps the shared remaining time during a last-known gap and omits untrusted reset distance',()=>{
  const base=polishStory(), shared={minutes:44,text:'44m',estimated:true,gapNote:'No live position'};
  const gap={...base,live:false,aircraft:null,route:{...base.route,progressSource:'last_known',progressObservedAt:base.fetchedAt-10*60_000,remainingNm:3500}};
  const lastKnown=markup(ui.RouteMap,gap,{fixedViewport:true,remaining:shared});
  assert.match(lastKnown,/Last known progress · 10 min ago · Remaining [^<]* · 44m estimated/);

  const unknown={...gap,route:{...gap.route,progressSource:'unknown'}};
  const noProgress=markup(ui.RouteMap,unknown,{fixedViewport:true,remaining:shared});
  assert.match(noProgress,/Remaining 44m estimated/);
  assert.doesNotMatch(noProgress,/miles/);

  const staleObserved={...base,live:true,aircraft:{...base.aircraft,seenSec:600},providers:{...base.providers,chosenPositionAgeSec:600},route:{...base.route,progressSource:'observed',remainingNm:3300}};
  const staleView=remainingFlight(staleObserved,base.fetchedAt);
  const staleMap=markup(ui.RouteMap,staleObserved,{fixedViewport:true,remaining:staleView});
  assert.match(staleMap,new RegExp(`Remaining ${staleView.text} estimated`));
  assert.doesNotMatch(staleMap,/miles/);

  const taxiIn={...gap,currentStage:'taxi_in',arrivalStatus:'taxi_in',route:{...gap.route,progressSource:'landed',remainingNm:0}};
  assert.match(markup(ui.RouteMap,taxiIn,{fixedViewport:true,remaining:{...shared,minutes:1,text:'1m'}}),/>Landed</);
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

test('WN768 14:46 pre-takeoff evidence gap leaves all physical stages unconfirmed', () => {
  const base = polishStory();
  const fetchedAt = Date.parse('2026-10-07T14:46:08.733Z');
  const story = { ...base, stateKey: 'leg:v1:SWA768|2026-10-07|MDW|BNA', fetchedAt,
    query: 'WN768', callsign: 'SWA768', iata: 'WN768', airline: 'Southwest', currentStage: 'origin_gate',
    live: false, aircraft: null, confirmedTakeoff: null,
    origin: { ...base.origin, iata: 'MDW', icao: 'KMDW', lat: 41.7868, lon: -87.7522 },
    dest: { ...base.dest, iata: 'BNA', icao: 'KBNA', lat: 36.1263, lon: -86.6774 },
    providers: { chosenPositionAgeSec: null, chosenPosition: null },
    times: { ...base.times, pushed: false, airborne: false, pushUnix: 1791383400,
      pushKind: 'estimated', pushSource: null, takeoffUnix: null, takeoffKind: null },
    resume: { ...base.resume, departureStage: null, detectedPushUnix: null, detectedTaxiUnix: null,
      gateOut: { scheduled: 1791383400, estimated: 1791383400, actual: null },
      takeoff: { scheduled: null, estimated: null, actual: null } },
  };
  const headline = markup(ui.FlightHead, story);
  assert.match(headline, /Ground position unavailable/);
  assert.doesNotMatch(headline, />At the gate<|>Taxiing out</);
  const progress = markup(ui.FlightStatusProgress, story);
  assert.match(progress, /Flight progress: movement not confirmed/);
  assert.match(progress, /data-progress-state="unknown"/);
  assert.doesNotMatch(progress, /progress-current|bg-accent/);
  assert.equal(statusProgressIndex(story.currentStage), 0);
  const pushed = { ...story, currentStage: 'push', times: { ...story.times, pushed: true,
    pushKind: 'actual', pushSource: 'provider_actual' } };
  const confirmedProgress = markup(ui.FlightStatusProgress, pushed);
  assert.match(confirmedProgress, /data-progress-state="confirmed"/);
  assert.match(confirmedProgress, /Flight progress: Pushback/);
  assert.match(confirmedProgress, /progress-current/);
});

test('FR24-only observation never claims gate or taxi status from one stationary fix',()=>{
 for(const currentStage of ['origin_gate','taxi_in']) {
  const story={...polishStory(),currentStage,providers:{previewMode:'fr24-only',chosenPosition:'fr24'},aircraft:{...polishStory().aircraft,onGround:true,gsKt:0}};
  const html=markup(ui.FlightHead,story);
  assert.match(html,/Reported on the ground/);assert.doesNotMatch(html,/At the gate|Taxiing in|data-progress-current/);
 }
});

test('terminal FR24 HTTP402 explains account resolution without loading or retry prompts', async()=>{
  const html=renderToStaticMarkup(h(ui.Fr24AccessStoppedNotice,{onHome:()=>{}}));
  assert.match(html,/HTTP 402/);assert.match(html,/account or API access issue must be resolved/);
  assert.match(html,/no further paid requests or automatic retries/);assert.match(html,/No aircraft coverage was established/);
  assert.doesNotMatch(html,/We’ll try again shortly|Still looking|Try again<|Loading/);
  const source=await readFile(resolve('src/components/filed-app.tsx'),'utf8');
  assert.match(source,/!fr24AccessStopped && !story && !storyQ.isError[^\n]*<Skeleton/);
  assert.match(source,/!fr24AccessStopped && \(storyQ.isError \|\| storyQ.failureCount > 0\)/);
});

test('Production-source Preview reports stopped FR24 while retaining active fallback sources',()=>{
 const session={mode:'production-parity',state:'stopped_402',creditsConsumed:8,creditCap:400,attempts:1,attemptCap:50,lastStatusCode:402,expiresAt:null};
 const html=renderToStaticMarkup(h(ui.PreviewProviderStatus,{mode:'production-parity',session,providers:{chosenPosition:'adsb',scheduleSource:'flightaware_public'}}));
 assert.match(html,/Production-source Preview/);assert.match(html,/8 \/ 400 credits reserved/);
 assert.match(html,/Other configured sources and fallbacks remain active/);assert.match(html,/Position source: ADS-B/);
 assert.match(html,/Schedule source: FlightAware public/);assert.match(html,/HTTP 402/);
 assert.doesNotMatch(html,/This test session has stopped|Actual FR24 observations only/);
 const story={...polishStory(),currentStage:'taxi',providers:{previewMode:'production-parity',chosenPosition:'adsb'},aircraft:{...polishStory().aircraft,onGround:true,gsKt:15}};
 assert.match(markup(ui.FlightHead,story),/>Taxiing out</,'ordinary source-backed stage presentation remains enabled');
});
