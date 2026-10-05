import { freezeTestClock } from './helpers/test-clock.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { canonicalLegIdentity } from '../src/lib/flight-identity.ts';

test('fixture audit and FR24-only push/taxi survive actual cold story instances and schedule promotion', async () => {
  const directory = await mkdtemp(resolve('node_modules/.identity-replay-'));
  const envKeys = ['DATABASE_URL', 'FR24_API_TOKEN', 'FR24_ENABLE_TRACKS', 'FR24_ENABLE_SUMMARY', 'FLIGHTAWARE_AEROAPI_KEY'];
  const oldEnv = envKeys.map(key => process.env[key]);
  const realFetch = globalThis.fetch;
  let restoreClock;
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ua219-provider-handoff.json', import.meta.url)));
  const fr24 = JSON.parse(readFileSync(new URL('./fixtures/ua219-fr24-only.json', import.meta.url)));
  let now = fr24.nowUnix * 1000, raw = structuredClone(fr24.data[0]), awareRecord = null, instance = 0;
  const requests = [];
  try {
    delete process.env.DATABASE_URL;
    process.env.FR24_API_TOKEN = 'fixture-only-no-network';
    delete process.env.FR24_ENABLE_TRACKS; delete process.env.FR24_ENABLE_SUMMARY; delete process.env.FLIGHTAWARE_AEROAPI_KEY;
    restoreClock = freezeTestClock(() => now);
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com') return awareRecord
        ? new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: awareRecord } })};`) : new Response(null, { status: 402 });
      if (/flightstats/.test(url.hostname)) return new Response(null, { status: 402 });
      if (url.hostname === 'fr24api.flightradar24.com') {
        assert.equal(url.pathname, '/api/live/flight-positions/full', 'no track/summary/new provider requests');
        return Response.json({ data: [{ ...raw, timestamp: now / 1000 }] });
      }
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname) && !url.pathname.includes('trace_')) return Response.json({ ac: [] });
      if (url.pathname.includes('trace_')) return Response.json({ timestamp: now / 1000, trace: [] });
      if (url.hostname === 'aviationweather.gov') return Response.json(url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : { features: [] });
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw Error('Unexpected upstream in fixture: ' + url);
    };
    await build({ configFile: false, logLevel: 'silent', build: { ssr: resolve('src/lib/story.server.ts'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    const cold = () => import(pathToFileURL(join(directory, 'story.mjs')).href + '?instance=' + ++instance);
    let server = await cold();
    await globalThis.__pgBootstrapPromise__;
    const pg = await globalThis.__pgliteInstance__;
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    const context = { requested: 'UA219', origin: { iata: 'ORD' }, destination: { iata: 'HNL' } };

    // Audit real parser outputs, not hand-written schedule-shaped substitutes.
    awareRecord = fixture.flightawareRecord;
    const fa = await server.fetchAwarePage('https://www.flightaware.com/live/flight/UAL219', 'UAL219', false, 'manual');
    const stats = server.parseFlightStatsPublicSchedule(fixture.flightstatsHtml, 'UAL219', '2026-10-02');
    assert.equal(canonicalLegIdentity(fa, context).key, 'leg:v1:UAL219|2026-10-02|ORD|HNL');
    assert.equal(canonicalLegIdentity(stats, context).key, 'leg:v1:UAL219|2026-10-02|ORD|HNL');
    awareRecord = null; server = await cold();
    const parked = await server.loadFlightStory('UA219', { fresh: true });
    const fallbackKey = 'leg:unvalidated:UAL219|ORD|HNL|2026-10-02';
    assert.equal(parked.providers.canonicalKey, null);
    assert.equal(parked.providers.canonicalKeyFailure, 'missing_scheduled');
    assert.equal(parked.providers.flightStateKey, fallbackKey);
    now += 10_000; raw.lon += 0.0012; raw.gspeed = 4;
    const pushed = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(pushed.currentStage, 'push'); assert.equal(pushed.times.pushed, true);
    now += 10_000; raw.lon += 0.0020; raw.gspeed = 15; server = await cold();
    const taxi = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(taxi.currentStage, 'taxi'); assert.equal(taxi.times.pushUnix, pushed.times.pushUnix);
    now += 10_000; raw.gspeed = 0; server = await cold();
    const held = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(held.currentStage, 'taxi'); assert.equal(held.times.pushUnix, pushed.times.pushUnix);
    const rows = (await pg.query('select * from flight_phase_state where land_key=$1', [fallbackKey])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].push_unix, pushed.times.pushUnix); assert(rows[0].taxi_out_at > 0);

    // Schedule appears on the same ident/route/UTC date. Still no takeoff fact.
    awareRecord = structuredClone(fixture.flightawareRecord);
    awareRecord.flightStatus = 'scheduled'; awareRecord.gateDepartureTimes.actual = null;
    awareRecord.takeoffTimes.actual = null; awareRecord.track = []; delete awareRecord.coord;
    now += 10_000; server = await cold();
    const promoted = await server.loadFlightStory('UA219', { fresh: true });
    assert.equal(promoted.providers.flightStateKey, 'leg:v1:UAL219|2026-10-02|ORD|HNL');
    assert.equal(promoted.providers.canonicalKeyFailure, null);
    assert.equal(promoted.currentStage, 'taxi'); assert.equal(promoted.times.pushUnix, pushed.times.pushUnix);
    const canonicalRows = (await pg.query('select * from flight_phase_state where land_key=$1', [promoted.providers.flightStateKey])).rows;
    assert.equal(canonicalRows.length, 1); assert(canonicalRows[0].taxi_out_at > 0);
    assert.equal((await pg.query('select * from flight_phase_state where land_key=$1', [fallbackKey])).rows.length, 1, 'fallback retained');
    assert.equal(requests.filter(url => url.includes('fr24api.flightradar24.com')).length, 5, 'one existing live lookup per story poll');
  } finally {
    globalThis.fetch = realFetch; restoreClock?.();
    envKeys.forEach((key, i) => oldEnv[i] == null ? delete process.env[key] : process.env[key] = oldEnv[i]);
    await rm(directory, { recursive: true, force: true });
  }
});
