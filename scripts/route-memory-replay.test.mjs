import { freezeTestClock } from './helpers/test-clock.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('UA219 durable filed/track geometry and oceanic progress survive provider handoff, cold instances, reroute and recovery', async t => {
  const dir = await mkdtemp(resolve('node_modules/.route-memory-replay-'));
  const realFetch = globalThis.fetch;
  let restoreClock;
  const keys = ['DATABASE_URL', 'FR24_API_TOKEN', 'FLIGHTAWARE_AEROAPI_KEY'], env = keys.map(k => process.env[k]);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ua219-provider-handoff.json', import.meta.url)));
  let now = fixture.firstAtUnix * 1000, mode = 'aware', instance = 0;
  const record = structuredClone(fixture.flightawareRecord);
  const wps = [[-87.9048,41.9786],[-110,42],[-130,36],[-145,29],[-157.9225,21.3187]];
  record.waypoints = wps;
  const anchors = [[-87.9048,41.9786],[-100,41],[-110,40],[-125,36],[-140,30],record.coord];
  const coords = anchors.slice(1).flatMap((end, leg) => Array.from({length:20},(_,j) =>
    anchors[leg].map((value,k) => value + (end[k]-value)*j/20))).concat([record.coord]);
  record.track = coords.map((coord, i, all) => ({
    coord, timestamp: record.takeoffTimes.actual + 60 + i * ((now / 1000 - 1) - record.takeoffTimes.actual - 60) / (all.length - 1),
    alt: i ? 36000 : 1500, gs: 462, heading: 237,
  }));
  const requests = [], evidence = [];
  try {
    keys.forEach(k => delete process.env[k]); restoreClock = freezeTestClock(() => now);
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com') return mode === 'aware'
        ? new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`)
        : new Response(null, { status: 402 });
      if (/flightstats/.test(url.hostname)) return mode === 'stats' && url.searchParams.get('date') === '2' && url.searchParams.get('month') === '10'
        ? new Response(fixture.flightstatsHtml) : new Response(null, { status: 404 });
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname)) return Response.json(url.pathname.includes('trace_') ? { timestamp: now / 1000, trace: [] }
        : { ac: mode === 'outage' ? [{hex:'a21900',flight:'UAL219',r:'N219UA',lat:23,lon:-155,alt_baro:30000,gs:450,track:237,seen:1,seen_pos:1}] : [] });
      if (url.hostname === 'aviationweather.gov') return Response.json(url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : { features: [] });
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw Error('Unexpected provider: ' + url);
    };
    await build({ configFile:false, logLevel:'silent', build:{ ssr:resolve('src/lib/story.server.ts'), outDir:dir,
      rollupOptions:{ output:{ entryFileNames:'story.mjs' } } } });
    await build({ configFile:false, logLevel:'silent', resolve:{ alias:{'@':resolve('src')} }, plugins:[react()],
      build:{ ssr:resolve('src/components/route-map.tsx'), outDir:join(dir,'ui'), rollupOptions:{ output:{entryFileNames:'map.mjs'} } } });
    const ui = await import(pathToFileURL(join(dir,'ui/map.mjs')).href);
    const cold = () => import(pathToFileURL(join(dir,'story.mjs')).href + '?cold=' + ++instance);
    const first = await (await cold()).loadFlightStory('UA219', { fresh:true });
    const pg = await globalThis.__pgliteInstance__;
    assert.equal(first.currentStage, 'ride'); assert.equal(first.route.source, 'track');
    assert.equal(first.route.progressSource, 'observed'); assert(first.route.progress > .5);
    const key = first.stateKey;
    const stored = (await pg.query('select state from flight_route_state where land_key=$1',[key])).rows[0].state;
    assert(stored.filed.waypoints.length >= 4); assert(stored.track.length >= 2);
    const snapshot = s => ({ stage:s.currentStage, source:s.route.source, progress:s.route.progress,
      progressSource:s.route.progressSource, observedAt:s.route.progressObservedAt, observedNm:s.route.observedFlownNm,
      aircraft:s.aircraft ? {lat:s.aircraft.lat,lon:s.aircraft.lon} : null, fingerprint:s.route.filedRouteFingerprint });
    evidence.push({case:'observed Pacific fix + filed spine',...snapshot(first)});
    mode = 'stats'; now += 120_000;
    const gap = await (await cold()).loadFlightStory('UA219', {fresh:true});
    assert.equal(gap.stateKey,key); assert.equal(gap.currentStage,'ride'); assert.equal(gap.aircraft,null);
    assert.equal(gap.route.source,'track'); assert.equal(gap.route.progressSource,'last_known');
    assert.equal(gap.route.progress,first.route.progress); assert.equal(gap.route.progressObservedAt,first.route.progressObservedAt);
    assert.equal(gap.route.observedFlownNm,first.route.observedFlownNm); assert.equal(gap.route.remainingNm,first.route.remainingNm);
    const map = renderToStaticMarkup(createElement(ui.RouteMap,{story:gap}));
    assert.match(map,/Last known progress/); assert.match(map,/data-route-stroke="flown"/); assert.doesNotMatch(map,/data-map-aircraft/);
    evidence.push({case:'cold FlightStats oceanic gap',...snapshot(gap)});
    now += 2 * 3600_000;
    const longGap = await (await cold()).loadFlightStory('UA219',{fresh:true});
    assert.equal(longGap.route.progress,first.route.progress); assert.equal(longGap.route.progressObservedAt,first.route.progressObservedAt);
    assert.equal(longGap.aircraft,null); evidence.push({case:'two-hour cold gap',...snapshot(longGap)});
    mode = 'aware'; record.waypoints = []; record.track = []; record.coord = null; record.altitude = null; record.groundspeed = null;
    const direct = await (await cold()).loadFlightStory('UA219',{fresh:true});
    assert.equal(direct.route.filedRouteFingerprint,first.route.filedRouteFingerprint); assert.equal(direct.route.progress,first.route.progress);
    evidence.push({case:'provider ID returns, direct-only poll',...snapshot(direct)});
    record.waypoints = wps;
    const back = await (await cold()).loadFlightStory('UA219',{fresh:true});
    assert.equal(back.route.filedRouteFingerprint,first.route.filedRouteFingerprint);
    record.waypoints = [[-87.9048,41.9786],[-108,43],[-128,37],[-145,29],[-157.9225,21.3187]];
    now += 10_000;
    const reroute = await (await cold()).loadFlightStory('UA219',{fresh:true});
    assert.notEqual(reroute.route.filedRouteFingerprint,first.route.filedRouteFingerprint);
    assert.equal(reroute.route.observedFlownNm,first.route.observedFlownNm);
    evidence.push({case:'validated reroute',...snapshot(reroute)});
    now += 10_000; record.coord = [-155,23]; record.altitude = 30000; record.groundspeed = 450;
    record.track = [{coord:record.coord,timestamp:now/1000-1,alt:30000,gs:450,heading:237}];
    const recovered = await (await cold()).loadFlightStory('UA219',{fresh:true});
    assert.equal(recovered.route.progressSource,'observed'); assert(recovered.route.progress > first.route.progress);
    assert(recovered.aircraft); evidence.push({case:'fresh fix recovery',...snapshot(recovered)});
    assert.equal((await pg.query('select * from flight_route_state')).rows.length,1,'one dated-leg row across all handoffs');
    assert(!requests.some(u=>/fr24api|aeroapi/.test(u)), 'no new provider APIs');
    // Saved device context may read a matching row, never write shared state.
    const version = (await pg.query('select version from flight_route_state where land_key=$1',[key])).rows[0].version;
    mode = 'outage'; now += 10_000;
    const device = await (await cold()).loadFlightStory('UA219',{fresh:true,resume:recovered.resume});
    assert.equal(device.schedule.status,'saved');
    assert.equal((await pg.query('select version from flight_route_state where land_key=$1',[key])).rows[0].version,version);
    // Synthetic ORD approach replay uses only the existing ATIS/route stores.
    // Its one-poll gap must apply the held plan in the actual story response.
    mode='aware';
    record.origin={iata:'MCO',icao:'KMCO',TZ:':America/New_York',coord:[-81.3089,28.4294]};
    record.destination={iata:'ORD',icao:'KORD',TZ:':America/Chicago',coord:[-87.9048,41.9786]};
    record.gateDepartureTimes={scheduled:now/1000-8000,actual:now/1000-7200};
    record.takeoffTimes={scheduled:now/1000-7500,actual:now/1000-7000};
    record.landingTimes={scheduled:now/1000+1800,estimated:now/1000+1800,actual:null};
    record.gateArrivalTimes={scheduled:now/1000+2100};
    record.coord=[-88.199775,41.877462]; record.altitude=4000; record.groundspeed=210; record.heading=267.67;
    // #67 intentionally waits for real approach evidence before drawing the
    // runway pattern. Give this persistence replay a sustained descent so it
    // exercises buildStory with an active arrival projection.
    record.track=[
      {coord:[-88.18,41.87],timestamp:now/1000-61,alt:5000,gs:215,heading:267.67},
      {coord:record.coord,timestamp:now/1000-1,alt:4000,gs:210,heading:267.67},
    ];
    record.waypoints=[record.origin.coord,[-85,35],[-88,41.2],record.coord,record.destination.coord];
    await pg.query('insert into arrival_atis_cache(airport,entries,fetched_at) values ($1,$2::jsonb,$3) on conflict(airport) do update set entries=excluded.entries,fetched_at=excluded.fetched_at',
      ['KORD',JSON.stringify([{airport:'KORD',type:'combined',datis:'LDG RWY 10R.'}]),now]);
    let approach;
    await t.test('buildStory completes with an active arrival projection', async () => {
      approach=await (await cold()).loadFlightStory('UA219',{fresh:true});
      assert.equal(approach.route.arrivalPatternKind,'downwind-base'); assert.equal(approach.route.arrivalProjectionStale,false);
      assert.equal(approach.route.source,'filed'); assert(approach.route.progress>.9,'filed-only plan retains its past reference geometry');
    });
    record.coord=null; record.track=[]; record.waypoints=[]; record.altitude=null; record.groundspeed=null; now+=30_000;
    const info=console.info, projectionLogs=[];
    console.info=(...args)=>{ if(args[0]==='[arrival-projection]') projectionLogs.push(args[1]); info(...args); };
    let approachGap;
    try { approachGap=await (await cold()).loadFlightStory('UA219',{fresh:true}); } finally { console.info=info; }
    assert.equal(approachGap.aircraft,null); assert.equal(approachGap.route.arrivalPatternKind,'downwind-base');
    assert.equal(approachGap.route.arrivalProjectionStale,true); assert.equal(approachGap.route.progress,approach.route.progress);
    assert.equal(approachGap.route.progressObservedAt,approach.route.progressObservedAt);
    assert.equal(approachGap.route.source,'filed'); assert.equal(approachGap.route.filedRouteFingerprint,approach.route.filedRouteFingerprint);
    assert(projectionLogs.some(log=>log.reason==='held-no-reliable-fix' && log.applied && log.geometrySource==='last_known_fix'
      && log.displayPointCount>2 && log.stateKey===approach.stateKey));
    const heldMap=renderToStaticMarkup(createElement(ui.RouteMap,{story:approachGap}));
    assert.match(heldMap,/Approach plan · stale/); assert.doesNotMatch(heldMap,/data-map-aircraft/);
    evidence.push({case:'cold ORD approach position gap',...snapshot(approachGap),projectionLog:projectionLogs.at(-1)});
    if (process.env.ROUTE_REPLAY_REPORT) await writeFile(process.env.ROUTE_REPLAY_REPORT,JSON.stringify({fixture:fixture.description,cases:evidence,requests:requests.length},null,2));
    if (process.env.ROUTE_REPLAY_STORIES) await writeFile(process.env.ROUTE_REPLAY_STORIES,JSON.stringify({first,gap,recovered,approach,approachGap},null,2));
  } finally {
    globalThis.fetch=realFetch; restoreClock?.();
    keys.forEach((k,i)=>env[i]==null?delete process.env[k]:process.env[k]=env[i]);
    await rm(dir,{recursive:true,force:true});
  }
});
