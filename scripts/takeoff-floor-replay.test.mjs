import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

test('UA219 actual takeoff survives provider-ID to FlightStats fallback to provider-ID, cold start and >2h gap', async () => {
  const dir = await mkdtemp(resolve('node_modules/.takeoff-replay-'));
  const realFetch = globalThis.fetch, realNow = Date.now;
  const keys = ['FR24_API_TOKEN', 'FLIGHTAWARE_AEROAPI_KEY'];
  const env = keys.map(k => process.env[k]);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ua219-provider-handoff.json', import.meta.url)));
  let now = fixture.firstAtUnix * 1000, mode = 'aware', instance = 0;
  const requests = [];
  try {
    keys.forEach(k => delete process.env[k]);
    Date.now = () => now;
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com') return mode === 'aware'
        ? new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: fixture.flightawareRecord } })};`)
        : new Response(null, { status: 402 });
      if (/flightstats/.test(url.hostname)) return url.searchParams.get('date') === '2' && url.searchParams.get('month') === '10'
        ? new Response(fixture.flightstatsHtml) : new Response(null, { status: 404 });
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname) && !url.pathname.includes('trace_')) return Response.json({ ac: [] });
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
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    keys.forEach((k, i) => env[i] == null ? delete process.env[k] : process.env[k] = env[i]);
    await rm(dir, { recursive: true, force: true });
  }
});
