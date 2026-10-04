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
const baggageMockId = '\0overview-baggage-status';
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.overview-metrics-'));
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
    plugins: [{ name: 'test-overview-metrics', enforce: 'pre',
      resolveId(source, importer) {
        const baggageSources = ['@/components/baggage-status', resolve('src/components/baggage-status'), resolve('src/components/baggage-status.tsx')];
        if (baggageSources.includes(source) && importer === resolve('src/components/filed-app.tsx')) return baggageMockId;
      },
      load(id) {
        if (id === baggageMockId) return `export { BaggageStatus } from ${JSON.stringify(resolve('src/components/baggage-status.tsx'))};
          export function useBaggageStatus() { return globalThis.__overviewBaggageStatusState; }`;
      },
      transform(code, id) {
        if (id === resolve('src/components/filed-app.tsx')) return code + '\nexport { OverviewDetails, TimesStrip, BaggageStatus };';
      },
    }, react()], build: { ssr: resolve('src/components/filed-app.tsx'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function markup(Component, story, baggage = { result: null, supported: true, loading: false }) {
  const realNow = Date.now, realFetch = globalThis.fetch, priorBaggage = globalThis.__overviewBaggageStatusState;
  const client = new QueryClient();
  Date.now = () => story.fetchedAt;
  globalThis.fetch = () => { throw Error('Overview rendering must not request providers'); };
  globalThis.__overviewBaggageStatusState = baggage;
  try {
    const props = { story, timing: h(ui.TimesStrip, { story }) };
    return renderToStaticMarkup(h(QueryClientProvider, { client }, h(Component, props)));
  } finally {
    client.clear(); Date.now = realNow; globalThis.fetch = realFetch;
    if (priorBaggage === undefined) delete globalThis.__overviewBaggageStatusState;
    else globalThis.__overviewBaggageStatusState = priorBaggage;
  }
}
function arrivalButton(html) {
  return [...html.matchAll(/<button\b[^>]*aria-controls="overview-baggage-details"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
}
function metric(html, label) {
  return [...html.matchAll(/<div class="timing-value(?: timing-value-prominent)?">([\s\S]*?)<\/div>/g)]
    .map(match => ({ html: match[0], label: match[1].match(/class="timing-label">([^<]*)<\/p>/)?.[1],
      value: match[1].match(/class="timing-number(?: timing-number-clock)?">([^<]*)<\/p>/)?.[1] }))
    .find(item => item.label === label);
}

test('Overview has one initially collapsed Arrival disclosure after live timing, with arrival grid and baggage help inside it', () => {
  const html = markup(ui.OverviewDetails, polishStory());
  const buttons = arrivalButton(html);
  assert.equal(buttons.length, 1, 'Arrival reuses the existing baggage disclosure');
  assert.match(buttons[0], />Arrival<\/span>/);
  assert.match(buttons[0], /aria-expanded="false"/);
  assert.match(buttons[0], /Gate C4/);
  assert.match(buttons[0], /Baggage not assigned yet/);
  assert.doesNotMatch(html, />Baggage<\/span>/, 'no duplicate Baggage disclosure remains');
  const panelStart = html.indexOf('id="overview-baggage-details"');
  const gridStart = html.indexOf('class="arrival-details"');
  assert(panelStart >= 0 && gridStart > panelStart, 'arrival details belong to the collapsible panel');
  assert(html.indexOf('aria-label="Live timing and position"') < html.indexOf('aria-controls="overview-baggage-details"'));
  assert.equal((html.match(/aria-label="Live timing and position"/g) ?? []).length, 1);
  assert.match(html.slice(panelStart), /<dt>Terminal<\/dt>[\s\S]*<dt>Gate<\/dt>[\s\S]*<dt>Baggage<\/dt>/);
  assert.match(html.slice(panelStart), /Check airport displays after arrival/);
  assert.doesNotMatch(html, /Baggage claim hasn&#x27;t been assigned yet/, 'assignment headline is not repeated beneath the grid');
});

test('Arrival summary uses real terminal, gate and carousel while source/check information remains below the grid', () => {
  const story = polishStory();
  const baggage = { supported: true, loading: false, result: { status: 'posted', carousel: '11', terminal: '2',
    checkedAt: story.fetchedAt, sourceName: 'Airport display', sourceUrl: 'https://example.test/airport' } };
  const html = markup(ui.OverviewDetails, story, baggage), button = arrivalButton(html)[0];
  assert.match(button, /Terminal 2/); assert.match(button, /Gate C4/); assert.match(button, /Carousel 11/);
  assert.doesNotMatch(button, /not assigned/);
  const panel = html.slice(html.indexOf('id="overview-baggage-details"'));
  assert.match(panel, /<dt>Terminal<\/dt><dd>2<\/dd>/);
  assert.match(panel, /<dt>Gate<\/dt><dd>C4<\/dd>/);
  assert.match(panel, /<dt>Baggage<\/dt><dd>11<\/dd>/);
  assert.match(panel, /Airport display/); assert.match(panel, /Checked /);
  assert.match(panel, /Confirm on arrival; assignments can change/);
  assert.doesNotMatch(panel, /Carousel 11 · Terminal 2/, 'existing baggage metadata is retained without a second assignment headline');
});

test('BaggageStatus retains its assignment headline for callers outside the Arrival grid', () => {
  const posted = renderToStaticMarkup(h(ui.BaggageStatus, { state: { supported: true, loading: false,
    result: { status: 'posted', carousel: '11', terminal: '2', checkedAt: polishStory().fetchedAt } } }));
  assert.match(posted, /Carousel 11 · Terminal 2/);
  const pending = renderToStaticMarkup(h(ui.BaggageStatus, { state: { result: null, supported: true, loading: false } }));
  assert.match(pending, /Baggage claim hasn(?:&#x27;|')t been assigned yet/);
});

test('live airborne altitude and speed use separate non-prominent metric cards with exact units', () => {
  const base = polishStory(), story = { ...base, aircraft: { ...base.aircraft, altFt: 34975, gsKt: 467.6 } };
  const html = markup(ui.TimesStrip, story);
  assert.equal(metric(html, 'Altitude')?.value, '34,975 ft');
  assert.equal(metric(html, 'Speed')?.value, '468 kt');
  assert.doesNotMatch(metric(html, 'Altitude').html, /timing-value-prominent/);
  assert.doesNotMatch(metric(html, 'Speed').html, /timing-value-prominent/);
  assert(metric(html, 'Remaining')); assert(metric(html, 'Flown'));
  assert(html.indexOf('>Flown<') < html.indexOf('>Altitude<'));
  assert.doesNotMatch(html, /timing-position/, 'the old inline position row is gone');
});

test('live metrics keep the existing availability and airborne gates, and show a dash for one missing value', () => {
  const base = polishStory();
  for (const patch of [
    { live: false }, { aircraft: null },
    { aircraft: { ...base.aircraft, onGround: true } },
    { aircraft: { ...base.aircraft, altFt: null, gsKt: null } },
    { currentStage: 'taxi', times: { ...base.times, airborne: false } },
  ]) {
    const html = markup(ui.TimesStrip, { ...base, ...patch });
    assert.equal(metric(html, 'Altitude'), undefined); assert.equal(metric(html, 'Speed'), undefined);
  }
  const noAltitude = markup(ui.TimesStrip, { ...base, aircraft: { ...base.aircraft, altFt: null } });
  assert.equal(metric(noAltitude, 'Altitude')?.value, '—'); assert.equal(metric(noAltitude, 'Speed')?.value, '480 kt');
  const noSpeed = markup(ui.TimesStrip, { ...base, aircraft: { ...base.aircraft, gsKt: null } });
  assert.equal(metric(noSpeed, 'Altitude')?.value, '33,000 ft'); assert.equal(metric(noSpeed, 'Speed')?.value, '—');
});
