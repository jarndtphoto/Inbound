import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';

test('cold airborne and at-gate polls save route state only when changed, once per poll', async () => {
  const dir = await mkdtemp(resolve('node_modules/.route-write-replay-'));
  const realFetch = globalThis.fetch, realNow = Date.now, realInfo = console.info;
  const keys = ['FR24_API_TOKEN', 'FLIGHTAWARE_AEROAPI_KEY', 'DATABASE_URL'];
  const env = keys.map(k => process.env[k]);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ua219-provider-handoff.json', import.meta.url)));
  let record = structuredClone(fixture.flightawareRecord), now = fixture.firstAtUnix * 1000, instance = 0;
  let surface = false, tally = null, requests = 0;
  const evidence = [], wps = [[-87.9048,41.9786],[-110,42],[-130,36],[-145,29],[-157.9225,21.3187]];
  let pg, query;
  try {
    keys.forEach(k => delete process.env[k]); Date.now = () => now;
    console.info = () => {};
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests++;
      if (url.hostname === 'www.flightaware.com')
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      if (/flightstats/.test(url.hostname)) return new Response(null, {status:404});
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname))
        return Response.json(url.pathname.includes('trace_') ? { timestamp:now/1000, trace:[] }
          : {ac:surface ? [{hex:'a21900',flight:'UAL219',r:'N219UA',lat:41.9786,lon:-87.9048,alt_baro:'ground',gs:0,track:0,seen:1,seen_pos:1}] : []});
      if (url.hostname === 'aviationweather.gov') return Response.json(url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : {features:[]});
      if (url.hostname === 'external-api.faa.gov') return Response.json({Status:[]});
      if (url.hostname === 'api.adsbdb.com') return Response.json({response:{flightroute:null}});
      throw Error('Unexpected provider: ' + url);
    };
    const entry = join(dir,'entry.ts');
    await writeFile(entry, `export { loadFlightStory } from ${JSON.stringify(resolve('src/lib/story.server.ts'))};\nexport { getSql } from ${JSON.stringify(resolve('src/lib/db.ts'))};\n`);
    await build({configFile:false,logLevel:'silent',build:{ssr:entry,outDir:join(dir,'bundle'),rollupOptions:{output:{entryFileNames:'story.mjs'}}}});
    const cold = () => import(pathToFileURL(join(dir,'bundle/story.mjs')).href + '?cold=' + ++instance);
    await (await cold()).getSql();
    pg = await globalThis.__pgliteInstance__;
    query = pg.query.bind(pg);
    pg.query = async (sql, values, ...rest) => {
      const isRoute = /\bflight_route_state\b/i.test(sql);
      const start = performance.now();
      const result = await query(sql, values, ...rest);
      if (isRoute && tally) {
        tally.dbMs += performance.now() - start;
        if (/^\s*select/i.test(sql)) tally.reads++;
        if (/^\s*insert/i.test(sql)) { tally.attempts++; tally.writes += result.rows.length; }
      }
      return result;
    };
    const clear = () => pg.exec('truncate flight_route_state, flight_phase_state, arrival_projection_state');
    const poll = async (label, i) => {
      tally = {poll:i + 1,reads:0,attempts:0,writes:0,dbMs:0};
      const start = performance.now();
      const story = await (await cold()).loadFlightStory('UA219',{fresh:true});
      const result = {...tally,storyMs:performance.now()-start,stage:story.currentStage};
      tally = null;
      assert.equal(story.schedule.status,'current');
      evidence.push({case:label,...result});
      return story;
    };
    record.waypoints = wps;
    const anchors = [[-87.9048,41.9786],[-100,41],[-110,40],[-125,36],[-140,30],record.coord];
    const coords = anchors.slice(1).flatMap((end,leg) => Array.from({length:20},(_,j) => anchors[leg].map((v,k) => v + (end[k]-v)*j/20))).concat([record.coord]);
    record.track = coords.map((coord,i,all) => ({coord,timestamp:record.takeoffTimes.actual+60+i*((now/1000-1)-record.takeoffTimes.actual-60)/(all.length-1),alt:i?36000:1500,gs:462,heading:237}));
    await clear();
    for (let i = 0; i < 10; i++) {
      if (i) {
        now += 30_000; record.coord = [record.coord[0]-.05,record.coord[1]-.025];
        record.track.push({coord:record.coord,timestamp:now/1000-1,alt:36000,gs:462,heading:237});
      }
      const story = await poll('airborne',i);
      assert.equal(story.currentStage,'ride'); assert.equal(story.route.progressSource,'observed');
      if (!process.env.ROUTE_WRITE_BASELINE) assert.equal(evidence.at(-1).writes,1,'trace plus new observation are one CAS write');
    }
    // A same-fix repeat and a coverage gap change no route facts.
    const held = await poll('unchanged airborne',0);
    if (!process.env.ROUTE_WRITE_BASELINE) assert.equal(evidence.at(-1).writes,0);
    record.coord=null; record.track=[]; now+=120_000;
    const gap = await poll('airborne gap',0);
    assert.equal(gap.route.progress,held.route.progress);
    if (!process.env.ROUTE_WRITE_BASELINE) assert.equal(evidence.at(-1).writes,0);
    record = structuredClone(fixture.flightawareRecord); record.waypoints=wps;
    now = record.gateDepartureTimes.scheduled*1000-600_000; surface=true;
    record.flightStatus='scheduled'; record.coord=record.origin.coord;
    record.altitude=650; record.groundspeed=0;
    record.gateDepartureTimes.actual=null; record.takeoffTimes.actual=null;
    // Provider track can contain history even while the current aircraft is
    // parked. It must not be appended to shared pre-departure route memory.
    record.track=coords.map((coord,i,all) => ({coord,timestamp:now/1000-600+(i*(590/(all.length-1))),alt:36000,gs:462,heading:237}));
    await clear();
    for (let i = 0; i < 10; i++) {
      const story = await poll('at gate',i);
      assert.equal(story.aircraft.onGround,true);
      assert.equal(story.confirmedTakeoff,null);
      if (!process.env.ROUTE_WRITE_BASELINE) {
        assert.equal(evidence.at(-1).writes,i===0?1:0,'filed plan writes once; unchanged at-gate polls write nothing');
        const stored = (await query('select state from flight_route_state where land_key=$1',[story.stateKey])).rows[0].state;
        assert.deepEqual(stored.track,[]); assert.equal(stored.lastObserved,null);
      }
      now += 30_000;
    }
    record.waypoints=[]; await clear();
    for (let i = 0; i < 10; i++) {
      await poll('at gate, no filed plan',i); now+=30_000;
      if (!process.env.ROUTE_WRITE_BASELINE) assert.equal(evidence.at(-1).writes,0,'an empty route memory creates no row');
    }
    if (process.env.ROUTE_WRITE_REPORT) await writeFile(process.env.ROUTE_WRITE_REPORT,JSON.stringify({fixture:fixture.description,backend:'PGLite; mocked providers; cold story instances; wall clocks exclude bundle/migration initialization',requests,cases:evidence},null,2));
  } finally {
    if (pg && query) pg.query=query;
    globalThis.fetch=realFetch; Date.now=realNow; console.info=realInfo;
    keys.forEach((k,i)=>env[i]==null?delete process.env[k]:process.env[k]=env[i]);
    await rm(dir,{recursive:true,force:true});
  }
});
