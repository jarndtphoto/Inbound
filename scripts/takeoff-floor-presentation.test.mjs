import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { applyTakeoffFloor } from '../src/lib/confirmed-takeoff.ts';
import { displayStage, flightAirborne, liveFix, elapsedFlight } from '../src/lib/flight-presentation.ts';
import { resumeFromStory, readFlightResume } from '../src/lib/flight-resume.ts';

const now = 1790983661;
const confirmation = { source: 'provider_actual', at: 1790957520, confirmedAt: now - 10 };
const key = 'leg:v1:UAL219|2026-10-02|ORD|HNL';
const resume = { version: 1, callsign: 'UAL219', ident: 'UAL219', confirmedAt: now * 1000,
  originIcao: 'KORD', destIcao: 'PHNL', originIata: 'ORD', destIata: 'HNL',
  gateOut: { scheduled: 1790952900, estimated: null, actual: 1790955180 },
  takeoff: { scheduled: 1790954700, estimated: null, actual: null },
  landing: { scheduled: 1790986200, estimated: null, actual: null },
  gateIn: { scheduled: 1790987280, estimated: null, actual: null }, waypoints: [], departureStage: 'taxi' };
const story = { stateKey: key, confirmedTakeoff: confirmation, fetchedAt: now * 1000, callsign: 'UAL219', iata: 'UA219', query: 'UA219',
  origin: { iata: 'ORD', icao: 'KORD', lat: 41.9786, lon: -87.9048, tz: 'America/Chicago' },
  dest: { iata: 'HNL', icao: 'PHNL', lat: 21.3187, lon: -157.9225, tz: 'Pacific/Honolulu' },
  currentStage: 'taxi', live: false, aircraft: null, times: { airborne: false },
  providers: { chosenPosition: 'fallback', chosenPositionAgeSec: null }, resume,
  stages: Object.fromEntries(['inbound', 'origin_gate', 'push', 'taxi', 'ride', 'arrival', 'final_approach', 'taxi_in', 'gate'].map(id => [id, { state: id === 'taxi' ? 'now' : 'next' }])) };

test('wrappers and display retain the floor with missing, expired, or conflicting surface fixes, no provider requests', async () => {
  const dir = await mkdtemp(resolve('node_modules/.takeoff-wrappers-'));
  const realFetch = globalThis.fetch, realNow = Date.now;
  try {
    await build({ configFile: false, logLevel: 'silent', build: { ssr: resolve('src/lib/story.ts'), outDir: dir,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    const wrappers = await import(pathToFileURL(join(dir, 'story.mjs')).href);
    Date.now = () => now * 1000; globalThis.fetch = () => { throw Error('floor must not fetch'); };
    for (const age of [null, 3, 180]) for (const stage of ['inbound', 'origin_gate', 'push', 'taxi', 'Takeoff roll']) {
      const input = { ...story, currentStage: stage, aircraft: age == null ? null : { ...story.origin, onGround: true, gsKt: 0, altFt: 680 },
        providers: { ...story.providers, chosenPositionAgeSec: age } };
      for (const fn of [wrappers.applyFr24GroundExperiment, wrappers.preserveDepartureProgress, wrappers.preferFreshAirborneState]) {
        const result = fn(input);
        assert.equal(result.currentStage, 'ride'); assert.equal(result.times.airborne, true);
        assert.equal(result.times.takeoffUnix, confirmation.at); assert.equal(displayStage(result), 'ride'); assert.equal(flightAirborne(result), true);
        assert.equal(result.aircraft, input.aircraft); assert.equal(result.providers.chosenPositionAgeSec, age);
      }
      assert.equal(displayStage(input), 'ride'); assert.equal(flightAirborne(input), true);
    }
    const gap = applyTakeoffFloor(story);
    assert.equal(liveFix(gap), false); assert.equal(elapsedFlight(gap).estimated, false);
    assert.equal(gap.stages.ride.state, 'now'); assert.equal(gap.stages.taxi.state, 'done');
    for (const stage of ['arrival', 'final_approach', 'taxi_in', 'gate']) {
      const result = wrappers.preserveDepartureProgress({ ...story, currentStage: stage });
      assert.equal(result.currentStage, stage); assert.equal(flightAirborne(result), !['taxi_in', 'gate'].includes(stage));
    }
  } finally { globalThis.fetch = realFetch; Date.now = realNow; await rm(dir, { recursive: true, force: true }); }
});

test('resume preserves confirmed actual without upgrading estimates, strips ground checkpoint, validates exact date/route key', () => {
  const parsed = resumeFromStory(story, 'UA219', now * 1000);
  assert.equal(parsed.stateKey, key); assert.equal(parsed.confirmedTakeoff.at, confirmation.at);
  assert.equal(parsed.takeoff.actual, confirmation.at); assert.equal(parsed.departureStage, null);
  const observed = resumeFromStory({ ...story, confirmedTakeoff: { ...confirmation, source: 'observed_airborne', at: null } }, 'UA219', now * 1000);
  assert.equal(observed.takeoff.actual, null); assert.equal(observed.confirmedTakeoff.at, null);
  for (const stateKey of ['leg:v1:UAL219|2026-10-03|ORD|HNL', 'leg:v1:UAL219|2026-10-02|ORD|LAX', 123])
    assert.equal(readFlightResume({ ...parsed, stateKey }, 'UA219', now * 1000).confirmedTakeoff, null);
  assert.equal(readFlightResume(parsed, 'UA219', (now + 3 * 3600) * 1000), undefined, 'device expiration does not replace durable floor');
});

test('previous server evidence carries only the same dated key through a DB outage response', () => {
  const missing = { ...story, confirmedTakeoff: null };
  assert.equal(applyTakeoffFloor(missing, story).currentStage, 'ride');
  for (const stateKey of ['leg:v1:UAL219|2026-10-03|ORD|HNL', 'leg:v1:UAL219|2026-10-02|ORD|LAX'])
    assert.equal(applyTakeoffFloor({ ...missing, stateKey }, story).currentStage, 'taxi');
  assert.equal(applyTakeoffFloor(missing).currentStage, 'taxi', 'cold start with no readable proof remains explicitly unconfirmed');
});
