import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { displayStage, flightAirborne, liveFix, elapsedFlight } from '../src/lib/flight-presentation.ts';
import { applyTakeoffFloor } from '../src/lib/confirmed-takeoff.ts';
import { nextStep } from '../src/lib/traveler.ts';
import { composeBrief } from '../src/lib/brief-copy.ts';

test('UA219 actual takeoff survives provider-ID to FlightStats fallback to provider-ID, cold start and >2h gap', async () => {
  const dir = await mkdtemp(resolve('node_modules/.takeoff-replay-'));
  const realFetch = globalThis.fetch, realNow = Date.now;
  const keys = ['FR24_API_TOKEN', 'FLIGHTAWARE_AEROAPI_KEY'];
  const env = keys.map(k => process.env[k]);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ua219-provider-handoff.json', import.meta.url)));
  let now = fixture.firstAtUnix * 1000, mode = 'aware', instance = 0, record = fixture.flightawareRecord, surface = null;
  const requests = [];
  try {
    keys.forEach(k => delete process.env[k]);
    const uiDir = join(dir, 'ui');
    await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
      plugins: [{ name: 'test-ui-exports', enforce: 'pre', transform(code, id) {
        if (id === resolve('src/components/filed-app.tsx')) return code + '\nexport { FlightHead, TimesStrip, rideFacts, RouteMap };\nexport { applyFr24GroundExperiment, preserveDepartureProgress, preferFreshAirborneState } from \"@/lib/story\";';
      } }, react()], build: { ssr: resolve('src/components/filed-app.tsx'), outDir: uiDir,
        rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
    const ui = await import(pathToFileURL(join(uiDir, 'ui.mjs')).href);

    Date.now = () => now;
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com') return mode === 'aware'
        ? new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`)
        : new Response(null, { status: 402 });
      if (/flightstats/.test(url.hostname)) return mode !== 'outage' && url.searchParams.get('date') === '2' && url.searchParams.get('month') === '10'
        ? new Response(fixture.flightstatsHtml) : new Response(null, { status: 404 });
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname) && !url.pathname.includes('trace_')) return Response.json({ ac: surface ? [surface] : mode === 'outage'
        ? [{ flight: 'UAL219', r: 'N219UA', hex: 'a21900', lat: 41.9786, lon: -87.9048, alt_baro: 'ground', gs: 0, seen: 1, seen_pos: 1 }] : [] });
      if (url.pathname.includes('trace_')) return Response.json({ timestamp: now / 1000, trace: [] });
      if (url.hostname === 'aviationweather.gov') return Response.json(url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : { features: [] });
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw Error('Unexpected provider: ' + url);
    };
    await build({ configFile: false, logLevel: 'silent', build: { ssr: resolve('src/lib/story.server.ts'), outDir: dir,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    const cold = () => import(pathToFileURL(join(dir, 'story.mjs')).href + '?instance=' + ++instance);
    let server = await cold(); await globalThis.__pgBootstrapPromise__;
    const pg = await globalThis.__pgliteInstance__;
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    const first = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(first.currentStage, 'ride'); assert.equal(first.confirmedTakeoff.source, 'provider_actual');
    const key = first.stateKey;
    mode = 'stats'; now = fixture.nextAtUnix * 1000; server = await cold();
    const second = await server.loadFlightStory('UA219', { fresh: true, resume: first.resume });
    for (const story of [second, await (await cold()).loadFlightStory('UA219', { fresh: true })]) {
      assert.equal(story.stateKey, key); assert.equal(story.currentStage, 'ride'); assert.equal(story.times.airborne, true);
      assert.equal(story.times.takeoffUnix, fixture.flightawareRecord.takeoffTimes.actual);
      assert.equal(story.times.takeoffKind, 'actual'); assert.equal(story.resume.takeoff.actual, story.times.takeoffUnix);
      assert.equal(story.aircraft, null); assert.equal(story.providers.chosenPosition, 'fallback');
      assert.equal(story.providers.chosenPositionAgeSec, null); assert.equal(story.takeoffFloorApplied, true);
    }
    now += 3 * 3600_000; server = await cold();
    const longGap = await server.loadFlightStory('UA219', { fresh: true, resume: first.resume });
    assert.equal(longGap.currentStage, 'ride'); assert.equal(longGap.stateKey, key);
    assert.equal(longGap.times.takeoffUnix, first.times.takeoffUnix);
    mode = 'aware'; server = await cold();
    const back = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(back.stateKey, key); assert.equal(back.currentStage, 'ride');
    const rows = (await pg.query('select land_key, confirmed_takeoff from flight_phase_state')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].confirmed_takeoff.time, first.times.takeoffUnix);
    assert(!requests.some(u => /fr24api|aeroapi/.test(u)), 'floor introduces no provider APIs');

    // Passenger UI uses the actual components and rideFacts mapping. Expose
    // private render targets only inside this test build, without app exports.
    const head = renderToStaticMarkup(createElement(ui.FlightHead, { story: longGap, fetching: false, refreshing: false, onRefresh() {} }));
    const timing = renderToStaticMarkup(createElement(ui.TimesStrip, { story: longGap }));
    const map = renderToStaticMarkup(createElement(ui.RouteMap, { story: longGap }));
    assert.match(map, /<svg/); assert.doesNotMatch(map, /data-map-aircraft/);
    const wrapperRequestCount = requests.length;
    for (const wrap of [ui.applyFr24GroundExperiment, ui.preserveDepartureProgress, ui.preferFreshAirborneState]) {
      const wrapped = wrap(second); assert.equal(wrapped.currentStage, 'ride');
      assert.equal(wrapped.times.takeoffUnix, first.times.takeoffUnix); assert.equal(wrapped.aircraft, null);
    }
    assert.equal(requests.length, wrapperRequestCount, 'wrappers do not request providers to enforce the floor');
    assert.match(head, />In flight</); assert.doesNotMatch(head.match(/<h2[^>]*>[\s\S]*?<\/h2>/)[0], /Taxiing out|Pushback|Heading to runway/);
    assert.match(timing, /Flown/); assert.doesNotMatch(timing, /Waiting for a new estimate/);
    assert.equal(displayStage(second), 'ride'); assert.equal(flightAirborne(second), true);
    assert.equal(liveFix(second), false, 'Map must not show a fabricated aircraft');
    assert.equal(elapsedFlight(second).estimated, false);
    assert.doesNotMatch(JSON.stringify(nextStep(second, second.fetchedAt)), /heading toward the runway|Heading to runway/i);
    const beforeBrief = composeBrief(ui.rideFacts(first, 'UA219', 'ride'));
    const afterBrief = composeBrief(ui.rideFacts(second, 'UA219', 'ride'), beforeBrief);
    assert(afterBrief.log.some(x => /Took off/.test(x.text)));
    assert(!afterBrief.log.filter(x => !beforeBrief.log.some(old => old.text === x.text)).some(x => /Taxiing out|Pushback|Heading to runway/i.test(x.text)));

    // DB failure: a warm instance retains server-validated evidence, a cold
    // instance without readable/current proof cannot guess. Client continuity
    // can use its prior server response for exactly the same dated key.
    mode = 'stats'; now += 10_000;
    const realQuery = pg.query;
    pg.query = async function(sql, values) {
      if (/flight_phase_state/.test(sql)) throw Error('fixture DB unavailable');
      return realQuery.call(this, sql, values);
    };
    try {
      const warmFailed = await server.loadFlightStory('UA219', { fresh: true });
      assert.equal(warmFailed.currentStage, 'ride'); assert.notEqual(warmFailed.providers.phaseStatePersistence, 'ok');
      const coldFailed = await (await cold()).loadFlightStory('UA219', { fresh: true });
      assert.equal(coldFailed.confirmedTakeoff, null); assert.notEqual(coldFailed.currentStage, 'ride');
      assert.notEqual(coldFailed.providers.phaseStatePersistence, 'ok');
      assert.equal(applyTakeoffFloor(coldFailed, first).currentStage, 'ride');
      // A validated provider fact still protects a response if its DB write fails.
      mode = 'aware';
      const writeFailed = await (await cold()).loadFlightStory('UA219', { fresh: true });
      assert.equal(writeFailed.currentStage, 'ride'); assert.equal(writeFailed.providers.phaseStatePersistence, 'write_failed');
    } finally { pg.query = realQuery; }

    // Observed airborne proof stores a null actual time. It survives another
    // cold instance / partial provider response without fabricating a clock.
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    now = fixture.firstAtUnix * 1000; mode = 'aware'; record = structuredClone(fixture.flightawareRecord);
    record.takeoffTimes.actual = null; record.track[0].timestamp = now / 1000 - 1;
    const observed = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(observed.confirmedTakeoff.source, 'observed_airborne'); assert.equal(observed.confirmedTakeoff.at, null);
    mode = 'stats'; now += 10_000;
    const observedGap = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(observedGap.currentStage, 'ride'); assert.equal(observedGap.times.airborne, true);
    assert.equal(observedGap.times.takeoffUnix, null); assert.equal(observedGap.times.takeoffKind, null);
    assert.equal(observedGap.aircraft, null); assert.equal(observedGap.providers.chosenPositionAgeSec, null);

    // A provider-only latch is provisional for ten minutes. A later fresh
    // matched surface fix revokes it durably and in the previous client/resume.
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    now = fixture.firstAtUnix * 1000; mode = 'aware'; record = structuredClone(fixture.flightawareRecord);
    record.coord = null; record.track = []; record.altitude = null; record.groundspeed = null;
    record.gateDepartureTimes.actual = now / 1000 - 300;
    record.takeoffTimes.actual = now / 1000 - 30;
    server = await cold();
    const providerOnly = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(providerOnly.confirmedTakeoff.source, 'provider_actual');
    assert.equal(providerOnly.currentStage, 'ride'); assert.equal(providerOnly.aircraft, null);
    surface = { flight: 'UAL219', r: 'N219UA', hex: 'a21900', lat: 41.9786, lon: -87.9048,
      alt_baro: 'ground', gs: 14, seen: 1, seen_pos: 1 };
    now += 10_000;
    const revoked = await (await cold()).loadFlightStory('UA219', { fresh: true, resume: providerOnly.resume });
    assert.equal(revoked.currentStage, 'taxi'); assert.equal(revoked.times.airborne, false);
    assert.equal(revoked.confirmedTakeoff, null); assert.notEqual(revoked.times.takeoffKind, 'actual');
    assert.equal(revoked.selectedStageReason, 'provider_takeoff_contradicted_by_surface');
    assert.equal(revoked.resume.takeoff.actual, null);
    assert.equal(applyTakeoffFloor(revoked, providerOnly).currentStage, 'taxi');
    for (const wrap of [ui.applyFr24GroundExperiment, ui.preserveDepartureProgress, ui.preferFreshAirborneState])
      assert.equal(wrap(revoked, providerOnly.resume).currentStage, 'taxi');
    assert.equal(displayStage(revoked), 'taxi'); assert.equal(flightAirborne(revoked), false);
    surface = null; now += 10_000;
    const rejectedGap = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(rejectedGap.confirmedTakeoff, null); assert.equal(rejectedGap.currentStage, 'taxi');
    assert.equal(rejectedGap.times.airborne, false); assert.notEqual(rejectedGap.times.takeoffKind, 'actual');
    assert.equal((await pg.query('select confirmed_takeoff from flight_phase_state')).rows[0].confirmed_takeoff.revocations[0].time,
      providerOnly.confirmedTakeoff.at);

    // Actual airborne observation remains permanent, even after a provider
    // clock upgrade followed by a fresh origin surface fix in that early window.
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    record = structuredClone(fixture.flightawareRecord); record.takeoffTimes.actual = null;
    record.track[0].timestamp = now / 1000 - 1;
    const physical = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(physical.confirmedTakeoff.source, 'observed_airborne');
    record.coord = null; record.track = []; record.altitude = null; record.groundspeed = null;
    record.takeoffTimes.actual = now / 1000 - 30;
    const upgraded = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(upgraded.confirmedTakeoff.source, 'provider_actual');
    assert.equal(upgraded.confirmedTakeoff.observedAt, physical.confirmedTakeoff.confirmedAt);
    surface = { flight: 'UAL219', r: 'N219UA', hex: 'a21900', lat: 41.9786, lon: -87.9048,
      alt_baro: 'ground', gs: 14, seen: 1, seen_pos: 1 };
    const permanentObserved = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(permanentObserved.currentStage, 'ride'); assert.equal(permanentObserved.times.airborne, true);
    assert.equal(permanentObserved.confirmedTakeoff.observedAt, physical.confirmedTakeoff.confirmedAt);

    // An uncontradicted provider-only latch is permanent after ten minutes.
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    surface = null; record.takeoffTimes.actual = now / 1000 - 601;
    const permanentProvider = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(permanentProvider.confirmedTakeoff.source, 'provider_actual');
    surface = { flight: 'UAL219', r: 'N219UA', hex: 'a21900', lat: 41.9786, lon: -87.9048,
      alt_baro: 'ground', gs: 14, seen: 1, seen_pos: 1 };
    const lateSurface = await (await cold()).loadFlightStory('UA219', { fresh: true });
    assert.equal(lateSurface.currentStage, 'ride'); assert.equal(lateSurface.times.airborne, true);
    assert.equal(lateSurface.confirmedTakeoff.at, permanentProvider.confirmedTakeoff.at);
    surface = null; mode = 'stats';

    // An arbitrary device claim never becomes a shared durable confirmation.
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    const forged = { ...first.resume, confirmedAt: now, stateKey: key,
      confirmedTakeoff: first.confirmedTakeoff, takeoff: { ...first.resume.takeoff, actual: first.times.takeoffUnix } };
    const untrusted = await (await cold()).loadFlightStory('UA219', { fresh: true, resume: forged });
    assert.equal(untrusted.confirmedTakeoff, null); assert.notEqual(untrusted.currentStage, 'ride');
    assert((await pg.query('select confirmed_takeoff from flight_phase_state')).rows.every(row => row.confirmed_takeoff == null));
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    mode = 'outage';
    const deviceOnly = await (await cold()).loadFlightStory('UA219', { fresh: true, resume: forged });
    assert.equal(deviceOnly.schedule.status, 'saved'); assert.equal(deviceOnly.confirmedTakeoff, null);
    assert.equal(deviceOnly.times.airborne, false); assert.equal(deviceOnly.takeoffFloorApplied, false);
    assert.equal((await pg.query('select land_key from flight_phase_state')).rows.length, 0, 'device-only resume never writes shared rows');

    // Server classifier precedence / floor and arrival / go-around checks.
    const stageArgs = { live: null, origin: first.origin, dest: first.dest, remainingNm: 100,
      pushed: true, taxiOutLatched: true, inboundStatus: 'complete' };
    assert.equal(server.currentStageOf({ ...stageArgs, faAirborne: true }), 'ride');
    assert.equal(server.currentStageOf({ ...stageArgs, ourTakeoffActual: first.times.takeoffUnix }), 'ride');
    const confirmedTakeoff = { source: 'provider_actual', time: first.times.takeoffUnix, confirmedAt: now / 1000 };
    assert.equal(server.currentStageOf({ ...stageArgs, confirmedTakeoff }), 'ride');
    assert.equal(server.currentStageOf({ ...stageArgs, confirmedTakeoff, ourLanded: true }), 'taxi_in');
    assert.equal(server.currentStageOf({ ...stageArgs, confirmedTakeoff, gateInActual: now / 1000 }), 'gate');
    assert.equal(server.currentStageOf({ ...stageArgs, confirmedTakeoff, live: { lat: 25, lon: -154, altFt: 35000, gsKt: 450, onGround: false } }), 'ride');
    // Unconfirmed estimated/overdue clocks, Departed status and aborted roll
    // remain ground eligible; none of those is a confirmation field.
    assert.equal(server.currentStageOf(stageArgs), 'taxi');
    assert(!requests.some(u => /fr24api|aeroapi/.test(u)));

  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    keys.forEach((k, i) => env[i] == null ? delete process.env[k] : process.env[k] = env[i]);
    await rm(dir, { recursive: true, force: true });
  }
});
