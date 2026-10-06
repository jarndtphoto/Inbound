import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

test('airborne trace continuity stays observed through 90 seconds and then forces recovery', async () => {
  const directory = await mkdtemp(resolve('node_modules/.live-position-continuity-'));
  const realNow = Date.now;
  try {
    Date.now = () => 10_000_000;
    await build({ configFile: false, logLevel: 'silent', build: {
      ssr: resolve('src/lib/story.server.ts'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'story-server.mjs' } },
    } });
    const story = await import(pathToFileURL(join(directory, 'story-server.mjs')).href + '?continuity=1');
    const seed = { hex: 'a12345', callsign: 'UAL123', registration: 'N12345', type: 'B738', typeName: '737-800' };
    const context = {
      origin: { lat: 41.9786, lon: -87.9048, elevationFt: 672 },
      dest: { lat: 40.7772, lon: -73.8726, elevationFt: 21 },
      history: [],
    };

    const observed60 = story.liveFromTracePt(
      { t: 9_940, lat: 41.2, lon: -86.7, alt: 18_000, gs: 420, track: 95, ground: false },
      seed.hex, seed, context,
    );
    assert.equal(observed60.seenSec, 60);
    assert.equal(observed60.extrapolated, false);
    assert.equal(story.livePositionNeedsRecovery(observed60), false);

    const observed90 = story.liveFromTracePt(
      { t: 9_910, lat: 41.0, lon: -86.2, alt: 20_000, gs: 430, track: 95, ground: false },
      seed.hex, seed, context,
    );
    assert.equal(observed90.seenSec, 90);
    assert.equal(observed90.extrapolated, false);
    assert.equal(story.livePositionNeedsRecovery(observed90), false);

    const stale91 = story.liveFromTracePt(
      { t: 9_909, lat: 40.9, lon: -86.0, alt: 20_000, gs: 430, track: 95, ground: false },
      seed.hex, seed, context,
    );
    assert.equal(stale91.seenSec, 91);
    assert.equal(stale91.extrapolated, true);
    assert.equal(story.livePositionNeedsRecovery(stale91), true);
    assert.equal(story.livePositionNeedsRecovery({ ...observed60, extrapolated: true }), true);
  } finally {
    Date.now = realNow;
    await rm(directory, { recursive: true, force: true });
  }
});
