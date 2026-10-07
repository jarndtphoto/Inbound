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
    const surface = { ...identity, provider: 'fr24', lat: 41.7868, lon: -87.7522, altFt: 0, gsKt: 0, onGround: true };
    const airborne = { ...identity, provider: 'adsb', lat: 41.79, lon: -87.74, altFt: 3000, gsKt: 180, onGround: false, seenAt: 9999 };
    for (const groundAge of [25, 29, 50, 3]) {
      const stale = { ...surface, seenAt: 10_000 - groundAge };
      const choice = choosePosition([stale, airborne], identity, 10_000);
      const expectedProvider = groundAge === 3 ? 'fr24' : 'adsb';
      assert.equal(choice.chosen.provider, expectedProvider, `FR24 age ${groundAge}`);
      const origin = { icao: 'KMDW', lat: 41.7868, lon: -87.7522 };
      const dest = { icao: 'KMSP', lat: 44.8848, lon: -93.2223 };
      const prior = { originIcao: origin.icao, destIcao: dest.icao, departureStage: 'taxi' };
      const story = { callsign: 'SWA1111', iata: 'WN1111', origin, dest, currentStage: 'push', live: true,
        aircraft: normalizedToLive(choice.chosen), providers: { chosenPosition: expectedProvider, chosenPositionAgeSec: groundAge === 3 ? 3 : 1, fr24Position: stale },
        times: { airborne: false }, resume: prior };
      const wrapped = applyFr24GroundExperiment(story, prior);
      assert.equal(wrapped.providers.chosenPosition, expectedProvider, `wrapper FR24 age ${groundAge}`);
      assert.equal(wrapped.aircraft.onGround, groundAge === 3);
      const result = preferFreshAirborneState(preserveDepartureProgress(wrapped, prior));
      assert.equal(result.currentStage, groundAge === 3 ? 'taxi' : 'ride');
      assert.equal(result.times.airborne, groundAge !== 3);

      // Counterfactual selected before the fix: stale ground preserves Taxi.
      const old = { ...story, aircraft: normalizedToLive(stale), providers: { ...story.providers, chosenPosition: 'fr24', chosenPositionAgeSec: groundAge } };
      const oldResult = preferFreshAirborneState(preserveDepartureProgress(applyFr24GroundExperiment(old, prior), prior));
      assert.equal(oldResult.currentStage, 'taxi');
      assert.equal(oldResult.times.airborne, false);
    }

    const origin = { icao: 'KMDW', lat: 41.7868, lon: -87.7522 };
    const dest = { icao: 'KMSP', lat: 44.8848, lon: -93.2223 };
    for (const age of [60, 90]) {
      const continuity = {
        callsign: 'SWA1111', iata: 'WN1111', origin, dest, currentStage: 'taxi', live: true,
        aircraft: { ...normalizedToLive(airborne), seenSec: age, seenAt: 10_000 - age },
        providers: { chosenPosition: 'adsb', chosenPositionAgeSec: age },
        times: { airborne: false },
      };
      const result = preferFreshAirborneState(continuity);
      assert.equal(result.currentStage, 'ride', `accepted airborne age ${age} keeps Flight stage`);
      assert.equal(result.times.airborne, true);
    }
    for (const age of [90.01, 91]) {
      const stale = {
        callsign: 'SWA1111', iata: 'WN1111', origin, dest, currentStage: 'taxi', live: true,
        aircraft: { ...normalizedToLive(airborne), seenSec: age, seenAt: 10_000 - age },
        providers: { chosenPosition: 'adsb', chosenPositionAgeSec: age },
        times: { airborne: false },
      };
      const result = preferFreshAirborneState(stale);
      assert.equal(result.currentStage, 'taxi', `stale airborne age ${age} cannot advance stage`);
      assert.equal(result.times.airborne, false);
    }
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    await rm(directory, { recursive: true, force: true });
  }
});
