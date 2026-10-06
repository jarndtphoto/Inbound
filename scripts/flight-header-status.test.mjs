import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { polishStory } from './fixtures/presentation-polish.mjs';

let directory, ui;
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.flight-header-status-'));
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
    plugins: [{ name: 'test-flight-header-status', enforce: 'pre', transform(code, id) {
      if (id === resolve('src/components/filed-app.tsx')) return code + '\nexport { FlightHead };';
    } }, react()], build: { ssr: resolve('src/components/filed-app.tsx'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function markup(Component, story, now = story.fetchedAt) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => now;
  globalThis.fetch = () => { throw new Error('header presentation must not request providers'); };
  try {
    return renderToStaticMarkup(h(QueryClientProvider, { client: new QueryClient() }, h(Component, { story })));
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
const airlineLine = html => html.match(/<p class="summary-airline text-sm text-muted">([^<]*)<\/p>/)?.[1];
const stageLine = html => html.match(/<h2 class="summary-stage[^>]*">([^<]*)<\/h2>/)?.[1];

test('live airborne headers show only the airline throughout flight and approach', () => {
  const base = polishStory();
  for (const currentStage of ['ride', 'arrival', 'final_approach']) {
    const story = { ...base, currentStage };
    const html = markup(ui.FlightHead, story);
    assert.equal(airlineLine(html), 'United', currentStage);
    assert.doesNotMatch(html, /In the air ·|Final approach · United/);
  }
  assert.equal(airlineLine(markup(ui.FlightHead, { ...base, airline: null })), '');
});

test('missing, stale, extrapolated or surface positions retain the airborne availability warning', () => {
  const base = polishStory();
  for (const currentStage of ['ride', 'arrival', 'final_approach']) {
    for (const patch of [
      { live: false, aircraft: null },
      { aircraft: { ...base.aircraft, seenSec: 91 }, providers: { chosenPositionAgeSec: 91 } },
      { aircraft: { ...base.aircraft, extrapolated: true } },
      { aircraft: { ...base.aircraft, onGround: true } },
      { aircraft: { ...base.aircraft, seenSec: null }, providers: { chosenPositionAgeSec: null } },
    ]) {
      const story = { ...base, currentStage, ...patch };
      if (currentStage === 'arrival' && story.aircraft?.onGround) continue;
      const expected = story.aircraft?.seenSec === 91
        ? 'In the air · Last seen 2 min ago'
        : 'In the air — live position unavailable right now';
      assert.equal(airlineLine(markup(ui.FlightHead, story)), expected);
    }
  }
  assert.equal(airlineLine(markup(ui.FlightHead, base, base.fetchedAt + 90_000)), 'In the air · Last seen 2 min ago');
});

test('ground stages, inbound and landed headers retain their informative labels', () => {
  const base = polishStory();
  const labels = { inbound: 'On the ground · United', origin_gate: 'At the gate · United',
    push: 'Pushback · United', taxi: 'Taxiing out · United', takeoff_roll: 'Takeoff roll · United',
    taxi_in: 'Taxiing in · United', gate: 'United' };
  for (const [currentStage, expected] of Object.entries(labels)) {
    const story = { ...base, currentStage, aircraft: { ...base.aircraft, ...base.origin, onGround: true },
      times: { ...base.times, airborne: false } };
    assert.equal(airlineLine(markup(ui.FlightHead, story)), expected, currentStage);
  }
  const landed = { ...base, currentStage: 'arrival', aircraft: { ...base.aircraft, onGround: true } };
  assert.equal(airlineLine(markup(ui.FlightHead, landed)), 'Landed · United');
  assert.equal(airlineLine(markup(ui.FlightHead, { ...base, times: { ...base.times, landKind: 'actual' } })), 'Landed · United');
  assert.equal(airlineLine(markup(ui.FlightHead, { ...base, currentStage: 'inbound', live: false, aircraft: null })), 'United');
});

test('Skeeter TPA and MCO stale fixes show age instead of live status', () => {
  const base = polishStory();
  for (const [airport, minutes] of [['TPA', 9], ['MCO', 7]]) {
    const age = minutes * 60;
    const story = { ...base, origin: { ...base.origin, iata: airport },
      aircraft: { ...base.aircraft, seenSec: age }, providers: { chosenPositionAgeSec: age } };
    const html = markup(ui.FlightHead, story);
    assert.equal(airlineLine(html), `In the air · Last seen ${minutes} min ago`);
    assert.doesNotMatch(html, /Live route|live movement/i);
  }
});

test('UA219 schedule-only inbound assignment is labeled unconfirmed', () => {
  const base = polishStory();
  const story = { ...base, currentStage: 'inbound', live: false, aircraft: null,
    inbound: { ...base.inbound, status: 'unconfirmed', headline: 'Aircraft status unconfirmed' } };
  assert.equal(stageLine(markup(ui.FlightHead, story)), 'Aircraft status unconfirmed');
});
