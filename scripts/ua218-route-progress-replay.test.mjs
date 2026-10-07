import { acquisitionFixture } from "./helpers/acquisition-fixture.mjs";
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
import { haversineNm, polylineLengthNm } from '../src/lib/geo.ts';
import { routeWeatherSegments } from '../src/lib/route-weather-segments.ts';
import { flownDistance } from '../src/lib/flight-presentation.ts';
import { routeProgress } from '../src/lib/route-memory.ts';

test('UA218 Production prefix drops the previous HNL arrival, persists the current sector and stops gray geometry at the real aircraft', async () => {
  const dir = await mkdtemp(resolve('node_modules/.ua218-route-progress-replay-'));
  const realFetch = globalThis.fetch, realNow = Date.now;
  const envKeys = ['DATABASE_URL', 'FR24_API_TOKEN', 'FLIGHTAWARE_AEROAPI_KEY'];
  const env = envKeys.map(key => process.env[key]);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ua218-route-memory.json', import.meta.url)));
  const record = structuredClone(fixture.flightawareRecord);
  let now = fixture.firstPollAtMs, instance = 0, traceMode = 'none';
  const requests = [], evidence = [];
  try {
    envKeys.forEach(key => delete process.env[key]);
    Date.now = () => now;
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com')
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      if (/flightstats/.test(url.hostname)) return new Response(null, { status: 404 });
      if (['globe.theairtraffic.com', 'globe.adsb.fi', 'globe.airplanes.live'].includes(url.hostname)
        && url.pathname.includes('trace_')) {
        const points = traceMode === 'whole_day' ? fixture.legacyRouteState.track
          : traceMode === 'previous_only' ? fixture.legacyRouteState.track.slice(0, fixture.expected.previousSectorPointCount) : [];
        // Saved coordinates and times are exact. Altitude/speed/heading are
        // reconstructed classification inputs: the previous arrival's final
        // two samples are surface fixes, then the actual departure has four
        // airborne samples. No provider trace is being fetched here.
        return Response.json({ timestamp: 0, trace: points.map((point, index) => {
          const priorSurface = index === 108 || index === 109;
          const currentSector = point.seenAt >= fixture.actualTakeoffUnix * 1000;
          return [point.seenAt / 1000, point.lat, point.lon,
            priorSurface ? 'ground' : currentSector ? 1150 : 10000,
            priorSurface ? 0 : currentSector ? 195 : 330, currentSector ? 140 : 220];
        }) });
      }
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname))
        return Response.json(url.pathname.includes('trace_') ? { timestamp: now / 1000, trace: [] } : { ac: [] });
      if (url.hostname === 'aviationweather.gov')
        return Response.json(url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : { features: [] });
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw Error('Unexpected mocked provider: ' + url);
    };
    await build({ configFile: false, logLevel: 'silent', plugins: [acquisitionFixture(), { name: 'test-ua218-route-db', enforce: 'pre', transform(code, id) {
      if (id === resolve('src/lib/story.server.ts')) return code + '\nexport { getSql } from "./db.ts";';
    } }], build: { ssr: resolve('src/lib/story.server.ts'), outDir: dir,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } }, plugins: [react()],
      build: { ssr: resolve('src/components/route-map.tsx'), outDir: join(dir, 'ui'),
        rollupOptions: { output: { entryFileNames: 'map.mjs' } } } });
    const ui = await import(pathToFileURL(join(dir, 'ui/map.mjs')).href);
    const cold = () => import(pathToFileURL(join(dir, 'story.mjs')).href + '?cold=' + ++instance);
    const bootstrap = await cold(), sql = await bootstrap.getSql();
    const pg = await globalThis.__pgliteInstance__;
    assert(pg, 'this replay uses local PGlite only');
    await sql.query('insert into flight_route_state(land_key,state,version) values($1,$2::jsonb,$3)',
      [fixture.stateKey, JSON.stringify(fixture.legacyRouteState), fixture.provenance.exportedVersion]);
    await sql.query('insert into flight_phase_state(land_key,confirmed_takeoff,version) values($1,$2::jsonb,1)',
      [fixture.stateKey, JSON.stringify(fixture.phaseConfirmation)]);
    assert.equal(fixture.legacyRouteState.track.length, 114);
    assert.equal(fixture.legacyRouteState.filed.waypoints.length, 117);
    assert(Math.abs(polylineLengthNm(fixture.legacyRouteState.track) * 1.150779 - 155.184472) < .001,
      'saved prefix reproduces the original contaminated distance');

    const snapshot = story => ({ stage: story.currentStage, key: story.stateKey, source: story.route.source,
      progress: story.route.progress, progressSource: story.route.progressSource,
      observedAt: story.route.progressObservedAt, observedFlownNm: story.route.observedFlownNm,
      displayedFlownNm: flownDistance(story)?.nm ?? null, remainingNm: story.route.remainingNm,
      aircraft: story.aircraft ? { lat: story.aircraft.lat, lon: story.aircraft.lon, altFt: story.aircraft.altFt, gsKt: story.aircraft.gsKt } : null });
    const stored = async () => (await pg.query('select state,version from flight_route_state where land_key=$1', [fixture.stateKey])).rows[0];
    const checkTrack = state => {
      assert.equal(state.trackNotBeforeMs, fixture.actualTakeoffUnix * 1000, 'real current-leg departure bound is durable');
      assert(state.track.length >= 2);
      const actualPoints = fixture.legacyRouteState.track.filter(point => point.seenAt >= state.trackNotBeforeMs);
      for (const point of state.track) {
        assert(point.seenAt >= state.trackNotBeforeMs, 'no previous-sector timestamp remains');
        assert(actualPoints.some(saved => saved.lat === point.lat && saved.lon === point.lon), 'only exact saved current-leg observations remain');
      }
    };
    const checkMapBoundary = (story, anchor) => {
      const past = routeWeatherSegments(story.route.samples, story.route.progress).filter(segment => segment.past);
      assert(past.length, 'the flown path is shown');
      for (const segment of past) for (const point of segment.points)
        assert(point.frac <= story.route.progress + 1e-12, 'gray geometry cannot extend into the future');
      const endpoint = past.at(-1).points.at(-1);
      assert(haversineNm(endpoint, anchor) < 1e-5, 'gray geometry ends at the exact real aircraft observation');
      assert.match(renderToStaticMarkup(createElement(ui.RouteMap, { story })), /data-route-stroke="flown"/);
    };

    const first = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(first.stateKey, fixture.stateKey); assert.equal(first.currentStage, 'ride');
    assert(first.live); assert.equal(first.aircraft.altFt, 1150); assert.equal(first.aircraft.gsKt, 195);
    assert(first.route.observedFlownNm > 1 && first.route.observedFlownNm < 5);
    assert(Math.abs(first.route.observedFlownNm * 1.150779 - fixture.expected.currentTrackMiles) < .02);
    checkTrack((await stored()).state); checkMapBoundary(first, first.aircraft);
    evidence.push({ case: 'saved legacy row repaired on first cold poll', ...snapshot(first) });

    now += 10_000;
    const second = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(second.stateKey, first.stateKey); assert.equal(second.route.observedFlownNm, first.route.observedFlownNm);
    checkTrack((await stored()).state); checkMapBoundary(second, second.aircraft);
    evidence.push({ case: 'second cold poll retains only current sector', ...snapshot(second) });

    record.coord = null; record.track = []; record.altitude = null; record.groundspeed = null;
    now += 120_000;
    const gap = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(gap.aircraft, null); assert.equal(gap.currentStage, 'ride');
    assert.equal(gap.route.progressSource, 'last_known'); assert.equal(gap.route.progress, second.route.progress);
    assert.equal(gap.route.progressObservedAt, second.route.progressObservedAt);
    assert.equal(gap.route.observedFlownNm, second.route.observedFlownNm);
    assert.equal(gap.route.remainingNm, second.route.remainingNm);
    checkTrack((await stored()).state); checkMapBoundary(gap, second.aircraft);
    const gapMap = renderToStaticMarkup(createElement(ui.RouteMap, { story: gap }));
    assert.match(gapMap, /Last known progress/); assert.doesNotMatch(gapMap, /data-map-aircraft/);
    evidence.push({ case: 'cold gap retains distance and exact gray boundary', ...snapshot(gap) });

    const gapVersion = (await stored()).version;
    now += 30_000;
    const repeatGap = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(repeatGap.route.progress, gap.route.progress);
    assert.equal(repeatGap.route.progressObservedAt, gap.route.progressObservedAt);
    assert.equal(repeatGap.route.observedFlownNm, gap.route.observedFlownNm);
    assert.equal((await stored()).version, gapVersion, 'unchanged gap does not rewrite the repaired route');
    checkTrack((await stored()).state); checkMapBoundary(repeatGap, second.aircraft);
    evidence.push({ case: 'second cold gap preserves repair without a DB write', ...snapshot(repeatGap) });

    // Separate branch of the replay: retain the real filed plan and confirmed
    // departure, but begin with no observation track. Planned geometry must
    // never be reported as miles already flown.
    await sql.query('delete from flight_route_state where land_key=$1', [fixture.stateKey]);
    Object.assign(record, structuredClone(fixture.flightawareRecord));
    now = fixture.firstPollAtMs;
    const filedOnly = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(filedOnly.stateKey, fixture.stateKey); assert.equal(filedOnly.currentStage, 'ride');
    const estimate = flownDistance(filedOnly);
    assert(estimate && estimate.source === 'position');
    assert(estimate.nm * 1.150779 > 2 && estimate.nm * 1.150779 < 3, 'filed-only Flown uses origin-to-real-fix distance, not planned prefix');
    assert(filedOnly.route.observedFlownNm == null, 'one fix is not an observation track');
    checkMapBoundary(filedOnly, filedOnly.aircraft);
    assert.equal((await stored()).state.filed.waypoints.length, 117);
    assert.equal((await stored()).state.trackNotBeforeMs, fixture.actualTakeoffUnix * 1000);
    evidence.push({ case: 'filed-only departure keeps flown approximate from real origin-to-fix geometry', ...snapshot(filedOnly) });

    await sql.query('delete from flight_route_state where land_key=$1', [fixture.stateKey]);
    traceMode = 'whole_day'; now += 1000;
    const wholeDay = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(wholeDay.stateKey, fixture.stateKey); assert.equal(wholeDay.currentStage, 'ride');
    assert(wholeDay.route.observedFlownNm > 1 && wholeDay.route.observedFlownNm < 5,
      'a short newly airborne sector is retained without falling back to the previous arrival');
    assert(Math.abs(wholeDay.route.observedFlownNm * 1.150779 - fixture.expected.currentTrackMiles) < .02);
    checkTrack((await stored()).state); checkMapBoundary(wholeDay, wholeDay.aircraft);
    evidence.push({ case: 'whole-day trace selects the short four-point departure only', ...snapshot(wholeDay) });

    await sql.query('delete from flight_route_state where land_key=$1', [fixture.stateKey]);
    traceMode = 'previous_only'; now += 1000;
    const previousOnly = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(previousOnly.stateKey, fixture.stateKey); assert.equal(previousOnly.currentStage, 'ride');
    assert(previousOnly.route.observedFlownNm == null, 'a prior-sector-only trace is not treated as the new flight track');
    assert(flownDistance(previousOnly).nm * 1.150779 < 3);
    const previousOnlyState = (await stored()).state;
    assert.equal(previousOnlyState.trackNotBeforeMs, fixture.actualTakeoffUnix * 1000);
    assert.equal(previousOnlyState.track.length, 1, 'only the real current fix is saved; no previous-sector points persist');
    assert.equal(previousOnlyState.track[0].lat, fixture.flightawareRecord.coord[1]);
    assert.equal(previousOnlyState.track[0].lon, fixture.flightawareRecord.coord[0]);
    assert(previousOnlyState.track[0].seenAt >= fixture.actualTakeoffUnix * 1000);
    checkMapBoundary(previousOnly, previousOnly.aircraft);
    evidence.push({ case: 'previous-arrival-only trace is rejected while current fix remains approximate', ...snapshot(previousOnly) });

    // A cold server may first see the legacy row during a coverage gap. Its
    // existing real anchor must survive sanitization, and its old progress
    // must be recomputed over the repaired current sector without a new fix.
    await sql.query('delete from flight_route_state where land_key=$1', [fixture.stateKey]);
    const boundedLegacy = { ...structuredClone(fixture.legacyRouteState), trackNotBeforeMs: fixture.actualTakeoffUnix * 1000 };
    await sql.query('insert into flight_route_state(land_key,state,version) values($1,$2::jsonb,1)',
      [fixture.stateKey, JSON.stringify(boundedLegacy)]);
    traceMode = 'none'; record.coord = null; record.track = []; record.altitude = null; record.groundspeed = null;
    now = fixture.firstPollAtMs + 120_000;
    const gapFirst = await (await cold()).loadFlightStory('UA218', { fresh: true });
    assert.equal(gapFirst.stateKey, fixture.stateKey); assert.equal(gapFirst.currentStage, 'ride');
    assert.equal(gapFirst.aircraft, null); assert.equal(gapFirst.route.progressSource, 'last_known');
    assert.equal(gapFirst.route.progressObservedAt, fixture.snapshotAtMs, 'repair retains the actual old observation timestamp');
    assert(Math.abs(gapFirst.route.observedFlownNm * 1.150779 - fixture.expected.currentTrackMiles) < .02);
    checkTrack((await stored()).state); checkMapBoundary(gapFirst, fixture.legacyRouteState.track.at(-1));
    assert.doesNotMatch(renderToStaticMarkup(createElement(ui.RouteMap, { story: gapFirst })), /data-map-aircraft/);
    evidence.push({ case: 'first cold read during a gap repairs legacy progress and preserves real anchor time', ...snapshot(gapFirst) });
    assert(!requests.some(url => /fr24api|aeroapi/.test(url)), 'no paid API paths even in the mocked replay');
    // Synthetic geometry guard, separate from the saved Production cases:
    // gaining a second point after a cold midflight join must not discard the
    // approximate origin connector and reset observed progress to the start.
    const origin = { lat: 21.3187, lon: -157.9225 }, dest = { lat: 41.9786, lon: -87.9048 };
    const firstFix = { lat: 36, lon: -140, seenAt: now }, nextFix = { lat: 36.1, lon: -139.8, seenAt: now + 30_000 };
    const joinedProgress = fix => routeProgress(bootstrap.canonicalLiveDisplayPath({
      origin, dest, filedPath: fixture.legacyRouteState.filed.waypoints,
      flownTrack: fix === firstFix ? [firstFix] : [firstFix, nextFix], live: fix,
    }), null, fix, true, false).progress;
    assert(joinedProgress(firstFix) > .1);
    assert(joinedProgress(nextFix) >= joinedProgress(firstFix) * .95, 'a second partial-track point cannot reset progress');
    if (process.env.UA218_REPLAY_REPORT) await writeFile(process.env.UA218_REPLAY_REPORT,
      JSON.stringify({ fixture: fixture.description, expected: fixture.expected, cases: evidence, mockedRequests: requests.length, realProviderRequests: 0 }, null, 2));
    if (process.env.UA218_REPLAY_STORIES) await writeFile(process.env.UA218_REPLAY_STORIES,
      JSON.stringify({ first, second, gap, repeatGap, filedOnly, wholeDay, previousOnly, gapFirst }, null, 2));
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    envKeys.forEach((key, index) => env[index] == null ? delete process.env[key] : process.env[key] = env[index]);
    await rm(dir, { recursive: true, force: true });
  }
});
