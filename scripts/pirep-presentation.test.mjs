import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { composeBrief } from '../src/lib/brief-copy.ts';
import { PIREP_PRESENTATION_NOW as now, PIREP_PRESENTATION_DESCRIPTION as description,
  pirepPresentationStory } from './fixtures/pirep-observation-presentation.mjs';

let directory, ui;
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.pirep-presentation-'));
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
    plugins: [{ name: 'test-pirep-presentation', enforce: 'pre', transform(code, id) {
      if (id === resolve('src/components/filed-app.tsx')) return code + '\nexport { WeatherTimeline, FlightWelcome, TravelerCompanion, RouteMap, rideFacts, readCachedStory, writeCachedStory };\nexport { upcomingWeatherEvents, eventWeatherCopy, flightWeatherSummary, pilotReportTiming } from "@/lib/weather-presentation";';
    } }, react()], build: { ssr: resolve('src/components/filed-app.tsx'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function frozen(callback) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => now;
  globalThis.fetch = () => { throw Error('PIREP presentation replay must not request providers'); };
  try { return callback(); } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
function render(Component, props) {
  const client = new QueryClient();
  try { return renderToStaticMarkup(h(QueryClientProvider, { client }, h(Component, props))); }
  finally { client.clear(); }
}
function text(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function views(story) {
  return frozen(() => {
    const facts = ui.rideFacts(story, story.query, story.currentStage), brief = composeBrief(facts);
    const overviewHtml = render(ui.TravelerCompanion, { story });
    const weatherHtml = render(ui.WeatherTimeline, { story });
    const welcomeHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story, brief });
    const mapHtml = render(ui.RouteMap, { story, fixedViewport: true });
    return { summary: ui.flightWeatherSummary(story), brief, facts,
      overview: text(overviewHtml), weather: text(weatherHtml), welcome: text(welcomeHtml),
      overviewHtml, weatherHtml, welcomeHtml, mapHtml };
  });
}

test('one-hour-old report stays an observation across Weather, Briefing, welcome and map, without returning the removed Overview duplicate', () => {
  const story = pirepPresentationStory(), output = views(story);
  assert.equal(output.summary, 'Smooth now · moderate bumps reported ahead');
  for (const value of [output.weather, output.brief.lead, output.welcome]) {
    assert.match(value, /Smooth now/); assert.match(value, /moderate bumps reported ahead/);
    assert.doesNotMatch(value, /Moderate turbulence on the remaining path|Bumpy stretch ahead|Moderate bumps possible/);
  }
  assert.match(output.overview, /Check airline status for UA203/);
  assert.doesNotMatch(output.overview, /Smooth now|moderate bumps reported ahead|Next weather|Arrival details/);
  assert.match(output.weather, /Reported by another aircraft/);
  assert.match(output.weather, /moderate/i);
  assert.match(output.weather, /1 (?:hour|hr|h) ago|60 (?:minutes|min|m) ago/i);
  assert.match(output.weather, /You(?:'|’)ll pass this area in about 6h/);
  assert.doesNotMatch(output.weather, /Continues for about|Intermittent areas over|16 minutes|around \d+ hours into flight/i);
  const events = frozen(() => ui.upcomingWeatherEvents(story.route.samples, story.route.progress));
  assert.equal(events.length, 1); assert.equal(events[0].source, 'observed');
  const copy = ui.eventWeatherCopy(events[0], story.dest.city);
  assert.equal(copy.headline, 'Reported by another aircraft'); assert.equal(copy.body, null);
  assert.equal(copy.mapLabel, 'Moderate bumps reported');
  assert.doesNotMatch(output.mapHtml, /Bumpy stretch ahead|Moderate bumps possible/);
  assert.doesNotMatch(output.mapHtml, /16 minutes|Continues for about|Intermittent areas over/);
  assert(story.route.samples.every(sample => sample.chop === 'smooth'), 'a report does not overwrite forecast samples');
});

test('stale or untimed reports disappear without turning a smooth forecast into a rough ride', () => {
  for (const story of [pirepPresentationStory({ ageMs: 24 * 60 * 60_000 }), pirepPresentationStory({ untimed: true })]) {
    const output = views(story);
    assert.equal(output.summary, 'Smooth now');
    const events = frozen(() => ui.upcomingWeatherEvents(story.route.samples, story.route.progress));
    assert.equal(events.length, 0);
    for (const value of [output.overview, output.weather, output.brief.lead, output.welcome])
      assert.doesNotMatch(value, /Moderate turbulence reported|moderate bumps reported|Synthetic pilot report|Reported by another aircraft/);
    assert(story.route.samples.every(sample => sample.chop === 'smooth'));
  }
});

test('an advisory overlapping a pilot report keeps forecast timing and identifies the report age separately', () => {
  const story = pirepPresentationStory({ mixed: true }), output = views(story);
  const events = frozen(() => ui.upcomingWeatherEvents(story.route.samples, story.route.progress));
  const forecast = events.find(event => event.source !== 'observed' && event.strongestChop === 'moderate');
  assert(forecast, 'the independent moderate advisory remains a forecast event');
  const copy = ui.eventWeatherCopy(forecast, story.dest.city);
  assert.notEqual(copy.headline, 'Reported by another aircraft');
  assert.match(output.weather, /Continues for about 16 minutes/);
  assert.match(output.weather, /Reported by another aircraft/);
  assert.match(output.weather, /1 (?:hour|hr|h) ago|60 (?:minutes|min|m) ago/i);
  assert.match(output.weather, new RegExp(copy.headline));
  assert.equal(story.route.samples.find(sample => sample.frac === .75).chop, 'moderate', 'the real advisory forecast is not erased');
  assert.match(text(output.mapHtml), /Reported by another aircraft/);
  assert.match(text(output.mapHtml), /1 (?:hour|hr|h) ago|60 (?:minutes|min|m) ago/i);
});

test('a report area remains visibly dashed partway through it without painting a forecast or a predicted duration', () => {
  const story = pirepPresentationStory();
  story.route.progress = .77;
  const html = frozen(() => render(ui.RouteMap, { story, fixedViewport: true }));
  const reportPath = html.match(/<path\b[^>]*data-pilot-report-area[^>]*>/)?.[0];
  assert(reportPath, 'the still-upcoming part of the observed area remains on the map');
  assert.match(reportPath, /stroke-dasharray="3 5"/);
  const path = reportPath.match(/\sd="([^"]+)"/)?.[1];
  assert.match(path, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+/);
  assert.doesNotMatch(text(html), /Approximate duration|Duration not established|Continues for about|16 minutes/);
  assert.match(text(html), /Reported by another aircraft/);
  assert(story.route.samples.every(sample => sample.chop === 'smooth'));
});

test('a stronger observation does not raise an independent lighter forecast or history severity', () => {
  const story = pirepPresentationStory({ mixed: true });
  story.route.samples[1].chop = 'light';
  story.route.samples[1].note = 'SIGMET light turbulence advisory.';
  story.hazards[1].chop = 'light';
  story.hazards[1].label = 'Light turbulence possible';
  story.hazards[1].detail = 'Synthetic SIGMET light turbulence advisory.';
  story.wx.live.worstChop = 'light';
  const output = views(story);
  assert.equal(output.summary, 'Smooth now · moderate bumps reported ahead');
  assert.equal(output.facts.worstChop, 'light');
  const events = frozen(() => ui.upcomingWeatherEvents(story.route.samples, story.route.progress));
  const forecast = events.find(event => event.source !== 'observed');
  assert.equal(forecast.strongestChop, 'light');
  assert.equal(forecast.pilotReports[0].chop, 'moderate', 'an overlapping observation keeps its own severity and age');
  assert.match(output.weather, /Possible light bumps/);
  assert.match(output.weather, /Reported by another aircraft/);
  assert.match(output.weather, /moderate turbulence observed by another aircraft/i);

  const reportOnly = pirepPresentationStory();
  delete reportOnly.wx;
  const reportOnlyOutput = views(reportOnly);
  assert.equal(reportOnlyOutput.summary, 'Smooth now · moderate bumps reported ahead');
  assert.equal(reportOnlyOutput.facts.worstChop, 'smooth', 'history uses only forecast sample severity when wx metadata is missing');
  assert(!reportOnlyOutput.brief.log.some(entry => /moderate|turbulence ahead/i.test(entry.text)));
});

test('the shared welcome summary retains separate icing, wind-shear and visibility alerts', () => {
  const story = pirepPresentationStory();
  const warnings = [
    { id: 'ice', kind: 'ice', label: 'Icing possible ahead' },
    { id: 'wind', kind: 'llws', label: 'Wind shear near arrival' },
    { id: 'cloud', kind: 'ifr', label: 'Low cloud near arrival' },
  ];
  story.hazards.push(...warnings.map(warning => ({ ...warning, remaining: true })));
  const output = views(story);
  assert.match(output.welcome, /Smooth now · moderate bumps reported ahead/);
  assert.match(output.welcome, /Weather alerts:/);
  for (const warning of warnings) assert(output.welcome.includes(warning.label));
});

test('cache accepts timestamped observations and ordinary stories but rejects untimed legacy PIREP forecasts', () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map();
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
  }, configurable: true });
  try {
    frozen(() => {
      const current = pirepPresentationStory();
      ui.writeCachedStory(current.query, current);
      assert.deepEqual(ui.readCachedStory(current.query), current);
      const untimed = pirepPresentationStory({ untimed: true });
      ui.writeCachedStory(untimed.query, untimed);
      assert.equal(ui.readCachedStory(untimed.query), undefined);
      const ordinary = pirepPresentationStory();
      ordinary.hazards = [];
      for (const sample of ordinary.route.samples) sample.pilotReports = [];
      ui.writeCachedStory(ordinary.query, ordinary);
      assert.deepEqual(ui.readCachedStory(ordinary.query), ordinary);
    });
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else delete globalThis.window;
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage;
  }
});

test('pilot-report timing uses the observation clock and viewer timezone rather than fetch or encounter time', () => {
  const report = pirepPresentationStory().route.samples[1].pilotReports[0];
  const timing = ui.pilotReportTiming(report.observedAt, now, 'America/Chicago');
  const formatted = typeof timing === 'string' ? timing : JSON.stringify(timing);
  assert.match(formatted, /9:00 PM|21:00/);
  assert.match(formatted, /1 (?:hour|hr|h) ago|60 (?:minutes|min|m) ago/i);
  assert.doesNotMatch(formatted, /10:00 PM|6 hours|16 minutes/);
});

test('writes optional offline before/after evidence with explicit synthetic provenance', async () => {
  const story = pirepPresentationStory(), output = views(story);
  const legacyLead = frozen(() => composeBrief({ ...output.facts, weatherSummary: undefined,
    rideLabel: 'Moderate turbulence', worstChop: 'moderate' }).lead);
  assert.match(legacyLead, /Moderate turbulence on the remaining path/);
  assert.doesNotMatch(output.brief.lead, /on the remaining path/);
  if (process.env.PIREP_PRESENTATION_EVIDENCE_DIR) {
    const target = process.env.PIREP_PRESENTATION_EVIDENCE_DIR;
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'before-after.json'), JSON.stringify({ description, frozenNow: new Date(now).toISOString(),
      observationTime: new Date(now - 60 * 60_000).toISOString(), areaEtaMin: 360, legacyIncorrectSpanMin: 16,
      before: { reconstruction: 'Legacy RideFacts input with report severity promoted to rideLabel; not a captured live UA203 response.', briefingLead: legacyLead },
      after: { sharedSummary: output.summary, overview: output.overview, weather: output.weather,
        briefingLead: output.brief.lead, welcome: output.welcome }, realProviderRequests: 0 }, null, 2));
    await writeFile(join(target, 'fixture-story.json'), JSON.stringify(story, null, 2));
    for (const name of ['overview', 'weather', 'welcome', 'map']) await writeFile(join(target, `${name}.html`), output[`${name}Html`]);
  }
});
