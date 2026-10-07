import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { advanceGroundMotion } from '../src/lib/ground-motion.ts';
import { polishStory } from './fixtures/presentation-polish.mjs';
import { freezeTestClock } from './helpers/test-clock.mjs';

let directory, ui;
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.ground-marker-test-'));
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
    plugins: [{ name: 'test-ground-marker', enforce: 'pre', transform(code, id) {
      if (id === resolve('src/components/movement-map.tsx')) return code + '\nexport { GroundMovementMap, GroundAircraftDirection };';
    } }, react()], build: { ssr: resolve('src/components/movement-map.tsx'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const arrow = /M0 -31 L12 17 L0 11 L-12 17 Z/;
const dot = /<circle[^>]*class="fill-accent"/;
function groundMarkup(track, provider = 'flightaware-public', patch = {}, timing = {}) {
  const base = polishStory();
  const origin = { ...base.origin, iata: 'MCO', icao: 'KMCO', lat: 28.4312, lon: -81.3081 };
  const aircraft = { ...base.aircraft, ...origin, onGround: true, altFt: 0, gsKt: 0, track, ...patch };
  const story = { ...base, origin, aircraft, currentStage: 'origin_gate',
    times: { ...base.times, airborne: false }, providers: { chosenPosition: provider, chosenPositionAgeSec: 1, ...timing.providers } };
  const restoreClock = freezeTestClock(story.fetchedAt + (timing.elapsedMs ?? 0));
  const realFetch = globalThis.fetch;
  const client = new QueryClient();
  globalThis.fetch = () => { throw new Error('marker rendering must not request providers'); };
  try {
    return renderToStaticMarkup(h(QueryClientProvider, { client }, h(ui.GroundMovementMap, {
      story, mode: { kind: 'departure', airport: origin }, trail: [], aircraft, active: false,
    })));
  } finally { client.clear(); globalThis.fetch = realFetch; restoreClock(); }
}

test('ground story fallback with provider track zero and no confirmed motion draws a dot', () => {
  const html = groundMarkup(0);
  assert.match(html, dot);
  assert.doesNotMatch(html, arrow);
});
test('ground story fallback with a nonzero provider track and no confirmed motion draws a dot', () => {
  const html = groundMarkup(270);
  assert.match(html, dot);
  assert.doesNotMatch(html, arrow);
});
test('fresh physical-provider ground paths also require motion confirmation', () => {
  for (const provider of ['fr24', 'adsb']) for (const track of [0, 270]) {
    const html = groundMarkup(track, provider, { gsKt: 3 });
    assert.match(html, dot, `${provider}/${track}`);
    assert.doesNotMatch(html, arrow, `${provider}/${track}`);
  }
});
test('confirmed eastward motion at MCO draws the arrow east without provider heading or reciprocal rotation', () => {
  let motion = null;
  for (const [index, lon] of [-81.3081, -81.3076, -81.3071].entries()) {
    motion = advanceGroundMotion(motion, { lat: 28.4312, lon, seenAt: 1000 + index * 5 });
    if (index < 2) assert.equal(motion.confirmedTrack, null);
  }
  assert.ok(Math.abs(motion.confirmedTrack - 90) < 0.1);
  const html = renderToStaticMarkup(h(ui.GroundAircraftDirection, {
    displayAircraft: { onGround: true, track: motion.confirmedTrack }, displayFrozen: false,
    plane: { x: 400, y: 400 }, scale: 7,
  }));
  assert.match(html, arrow);
  assert.ok(Math.abs(Number(html.match(/rotate\(([^)]+)\)/)[1]) - 90) < 0.1);
  assert.doesNotMatch(html, dot);
});
test('stationary receiver jitter never confirms a direction', () => {
  let motion = null;
  for (const [index, lon] of [-81.3081, -81.30809, -81.30811, -81.3081].entries()) {
    motion = advanceGroundMotion(motion, { lat: 28.4312, lon, seenAt: 1000 + index * 5 });
    assert.equal(motion.confirmedTrack, null);
  }
});
test('slow surface-like fallback with an uncertain ground flag draws a dot', () => {
  const html = groundMarkup(0, 'flightaware-public', { onGround: false, altFt: 100, gsKt: 3 });
  assert.match(html, dot);
  assert.doesNotMatch(html, arrow);
});
test('airborne story fallback retains its provider heading', () => {
  const html = groundMarkup(123, 'flightaware-public', { onGround: false, altFt: 3000, gsKt: 180 });
  assert.match(html, arrow);
  assert.match(html, /rotate\(123\)/);
});

// A cached story is the same observation even when rendered much later.
test('cached story fix ages past the live window instead of rejuvenating', () => {
  const html = groundMarkup(0, 'adsb', {}, { elapsedMs: 35_000 });
  assert.match(html, /Last seen 36s ago/);
  assert.doesNotMatch(html, /live movement/);
});
test('cached story fix expires after the 120 second hold window', () => {
  const html = groundMarkup(0, 'adsb', {}, { elapsedMs: 121_000 });
  assert.doesNotMatch(html, dot);
  assert.match(html, /Awaiting aircraft/);
});
test('explicit observation timestamp takes precedence over inconsistent relative age', () => {
  const base = polishStory();
  const html = groundMarkup(0, 'adsb', {}, {
    providers: { chosenPositionSeenAt: base.fetchedAt / 1000 - 60 },
  });
  assert.match(html, /Last seen 1m ago/);
  assert.doesNotMatch(html, /live movement/);
});
