import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { choosePosition, normalizedToLive } from '../src/lib/flight-data.ts';

test('fresh airborne fusion stays airborne through departure wrappers without provider calls', async () => {
  const directory = await mkdtemp(resolve('node_modules/.fr24-fusion-test-'));
  const realNow = Date.now, realFetch = globalThis.fetch;
  try {
    await build({ configFile: false, logLevel: 'silent', build: {
      ssr: resolve('src/lib/story.ts'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } },
    } });
    const { applyFr24GroundExperiment, preserveDepartureProgress, preferFreshAirborneState } =
      await import(pathToFileURL(join(directory, 'story.mjs')).href);
    Date.now = () => 10_000_000;
    globalThis.fetch = () => { throw new Error('Fusion must not fetch'); };
    const identity = { flightId: null, callsign: 'SWA1111', registration: 'N12345', hex: 'a12345', type: 'B738', track: 310, confidence: 'high' };
    const stale = { ...identity, provider: 'fr24', lat: 41.7868, lon: -87.7522, altFt: 0, gsKt: 0, onGround: true, seenAt: 9950 };
    const airborne = { ...identity, provider: 'adsb', lat: 41.79, lon: -87.74, altFt: 3000, gsKt: 180, onGround: false, seenAt: 9999 };
    const choice = choosePosition([stale, airborne], identity, 10_000);
    assert.equal(choice.chosen.provider, 'adsb');
    const origin = { icao: 'KMDW', lat: 41.7868, lon: -87.7522 };
    const dest = { icao: 'KMSP', lat: 44.8848, lon: -93.2223 };
    const prior = { originIcao: origin.icao, destIcao: dest.icao, departureStage: 'taxi' };
    const story = { callsign: 'SWA1111', iata: 'WN1111', origin, dest, currentStage: 'push', live: true,
      aircraft: normalizedToLive(choice.chosen), providers: { chosenPosition: 'adsb', chosenPositionAgeSec: 1, fr24Position: stale },
      times: { airborne: false }, resume: prior };
    const wrapped = applyFr24GroundExperiment(story, prior);
    assert.equal(wrapped.providers.chosenPosition, 'adsb');
    assert.equal(wrapped.aircraft.onGround, false);
    const result = preferFreshAirborneState(preserveDepartureProgress(wrapped, prior));
    assert.equal(result.currentStage, 'ride');
    assert.equal(result.times.airborne, true);

    // Counterfactual selected before the fix: stale ground preserves Taxi.
    const old = { ...story, aircraft: normalizedToLive(stale), providers: { ...story.providers, chosenPosition: 'fr24', chosenPositionAgeSec: 50 } };
    const oldResult = preferFreshAirborneState(preserveDepartureProgress(applyFr24GroundExperiment(old, prior), prior));
    assert.equal(oldResult.currentStage, 'taxi');
    assert.equal(oldResult.times.airborne, false);
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    await rm(directory, { recursive: true, force: true });
  }
});
