import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { composeBrief } from '../src/lib/brief-copy.ts';
import { timeKindLabel } from '../src/lib/presentation-time.ts';
import { polishStory, actualOnlyStory } from './fixtures/presentation-polish.mjs';

const dir = await mkdtemp(resolve('node_modules/.polish-ui-'));
after(() => rm(dir, { recursive: true, force: true }));
await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
  plugins: [{ name: 'polish-test-exports', enforce: 'pre', transform(code, id) {
    if (id === resolve('src/components/filed-app.tsx')) return code + '\nexport { FlightHead, TimesStrip, Freshness, OverviewDetails, BreakdownCard, WeatherTimeline, FlightWelcome, RouteMap, TravelerCompanion, rideFacts, rememberOrigOnClient, readCachedStory, writeCachedStory };';
  } }, react()], build: { ssr: resolve('src/components/filed-app.tsx'), outDir: dir,
    rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
const ui = await import(pathToFileURL(join(dir, 'ui.mjs')).href);
const render = (component, props, prefix = 'test-') => {
  const client = new QueryClient();
  try { return renderToStaticMarkup(h(QueryClientProvider, { client }, h(component, props)), { identifierPrefix: prefix }); }
  finally { client.clear(); }
};

function taxiWelcomeStory() {
  const base = polishStory();
  return { ...base, iata: 'WN544', callsign: 'SWA544', airline: 'Southwest', currentStage: 'taxi',
    aircraft: { ...base.aircraft, lat: 41.7868, lon: -87.7522, onGround: true, altFt: 620, gsKt: 17 },
    origin: { ...base.origin, iata: 'MDW', icao: 'KMDW', city: 'Chicago', name: 'Midway' },
    dest: { ...base.dest, iata: 'FLL', icao: 'KFLL', city: 'Fort Lauderdale', name: 'Fort Lauderdale–Hollywood', tz: 'America/New_York' },
    times: { ...base.times, push: '7:56 PM CDT', pushKind: 'estimated', pushSource: 'live_detected', pushed: true,
      takeoff: '8:01 PM CDT', takeoffKind: 'estimated', airborne: false,
      land: '11:18 PM EDT', landKind: 'estimated', gate: '11:29 PM EDT', gateKind: 'estimated', destGate: 'D4',
      delayMin: 21, arriveDelayMin: 14 },
  };
}

test('client cache rejects old unscheduled memories, retains takeoff evidence, and remembers schedules without pushback', () => {
  const oldStorage = globalThis.localStorage;
  const memory = new Map();
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  try {
    const story = actualOnlyStory();
    story.confirmedTakeoff = { source: 'provider_actual', at: story.times.takeoffUnix, confirmedAt: story.times.takeoffUnix };
    memory.set('filed-orig-sched-v2', JSON.stringify({ [story.stateKey]: { pushUnix: story.times.pushUnix, landUnix: story.times.landUnix } }));
    const result = ui.rememberOrigOnClient(story);
    assert.equal(result.times.origPushUnix, null); assert.equal(result.times.origTakeoffUnix, null); assert.equal(result.times.origLandUnix, null);
    assert.deepEqual(result.confirmedTakeoff, story.confirmedTakeoff); assert.equal(result.currentStage, story.currentStage);
    assert.equal(result.times.pushWas, null); assert.equal(result.times.landWas, null);
    const noPush = { ...story, times: { landUnix: 3000, landKind: 'scheduled', land: '9:01 AM' }, resume: undefined };
    assert.equal(ui.rememberOrigOnClient(noPush).times.origLandUnix, 3000);
    assert.equal(ui.rememberOrigOnClient(story).times.origLandUnix, 3000, 'only the known schedule survives actual updates');
    for (const stateKey of ['leg:v1:UAL219|2026-10-04|ORD|HNL', 'leg:v1:UAL219|2026-10-03|ORD|LAX']) {
      assert.equal(ui.rememberOrigOnClient({ ...story, stateKey }).times.origLandUnix, null);
    }
    ui.writeCachedStory('UA219', result);
    const records = JSON.parse(memory.get('filed-story-cache-v9'));
    records.UAL219.scheduledOnly = false;
    records.UAL219.story.times.origLandUnix = story.times.landUnix;
    memory.set('filed-story-cache-v9', JSON.stringify(records));
    const oldWindow = globalThis.window;
    globalThis.window = {};
    try {
      const cached = ui.readCachedStory('UA219');
      assert.equal(cached.times.origLandUnix, null); assert.deepEqual(cached.confirmedTakeoff, story.confirmedTakeoff);
    } finally { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; }
  } finally { if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage; }
});

test('actual-only Flight details hides all Scheduled rows and planned duration, but shows actual landing and gate kind', () => {
  const html = render(ui.OverviewDetails, { story: actualOnlyStory(), timing: null });
  const details = html.slice(html.indexOf('id="overview-flight-details"'), html.indexOf('id="overview-aircraft-details"'));
  assert.doesNotMatch(details, /Scheduled|Planned flight time|untrusted/);
  assert.match(details, /Actual landing/); assert.match(details, /Estimated gate arrival/);
});

test('identical arrival clocks retain the same reported kind in header, timing, Flight details, and Briefing', () => {
  for (const kind of ['scheduled', 'estimated', 'actual']) {
    const story = { ...actualOnlyStory(), times: { ...actualOnlyStory().times, gateKind: kind } };
    const label = timeKindLabel(kind), event = timeKindLabel(kind, 'gate arrival');
    assert.match(render(ui.FlightHead, { story, fetching: false, refreshing: false, onRefresh() {} }), new RegExp(`>${label}<`));
    assert.match(render(ui.TimesStrip, { story }), new RegExp(label));
    assert.match(render(ui.OverviewDetails, { story, timing: null }), new RegExp(event));
    const brief = composeBrief(ui.rideFacts({ ...story, currentStage: 'arrival' }, 'UA219', 'arrival'));
    assert.match(brief.lead, new RegExp(event));
  }
});

test('Overview removes duplicate next-step and arrival summary while keeping the airline-status action', () => {
  const base = actualOnlyStory();
  const story = { ...base, currentStage: 'final_approach',
    dest: { ...base.dest, city: 'Orlando', iata: 'MCO', icao: 'KMCO' } };
  const html = render(ui.TravelerCompanion, { story });
  assert.doesNotMatch(html, /Landing is next|Arriving in Orlando|Arrival gate|Gate arrival|Recent position available|Landed; waiting for gate confirmation/);
  assert.doesNotMatch(html, /aria-label="What happens next"|aria-label="Arrival help"/);
  assert.match(html, /Check airline status|Search airline flight status|Check your airline app/);
});

test('restored flight freshness shows truthful age until a fresh response succeeds', () => {
  const now = Date.UTC(2026, 9, 4, 12);
  const oldNow = Date.now;
  Date.now = () => now;
  try {
    const props = { at: now - 6 * 60_000, fetching: true, refreshing: false, onRefresh() {} };
    const restoring = render(ui.Freshness, { ...props, restored: true });
    assert.match(restoring, /Updated 6 min ago · refreshing/);

    const fresh = render(ui.Freshness, { ...props, at: now - 1000, restored: false, fetching: false });
    assert.match(fresh, /Flight data just updated/);
    assert.doesNotMatch(fresh, /· refreshing/);

    const ordinaryPoll = render(ui.Freshness, { ...props, restored: false, fetching: true });
    assert.match(ordinaryPoll, /Data from 6 min ago/);
    assert.doesNotMatch(ordinaryPoll, /· refreshing/);

    const failed = render(ui.Freshness, { ...props, restored: true, fetching: false, failed: true });
    assert.match(failed, /Updated 6 min ago · refresh delayed/);
    assert.doesNotMatch(failed, /just updated/);

    const paused = render(ui.Freshness, { ...props, restored: true, fetching: false });
    assert.match(paused, /Updated 6 min ago · waiting to refresh/);

    const retrying = render(ui.Freshness, { ...props, restored: true, fetching: true, failed: true });
    assert.match(retrying, /Updated 6 min ago · refreshing/);
    assert.doesNotMatch(retrying, /refresh delayed/);
  } finally {
    Date.now = oldNow;
  }
});

test('overnight event clocks use each airport zone and mark the next local day across Overview, Flight details, and Briefing', () => {
  const oldStorage = globalThis.localStorage;
  const memory = new Map();
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  try {
    const push = 1791080160, takeoff = 1791080820, land = 1791105360, gate = 1791106020;
    const base = polishStory();
    const story = { ...base,
      stateKey: 'leg:v1:UAL203|2026-10-03|OGG|ORD', query: 'UA203', callsign: 'UAL203', iata: 'UA203',
      origin: { ...base.origin, iata: 'OGG', icao: 'PHOG', city: 'Kahului', tz: 'Pacific/Honolulu' },
      dest: { ...base.dest, iata: 'ORD', icao: 'KORD', city: 'Chicago', tz: 'America/Chicago' },
      times: { ...base.times,
        pushUnix: push, pushKind: 'actual', pushSource: 'provider_actual', push: 'wrong',
        takeoffUnix: takeoff, takeoffKind: 'actual', takeoff: 'wrong',
        landUnix: land, landKind: 'actual', land: 'wrong',
        gateUnix: gate, gateKind: 'estimated', gate: 'wrong',
        origPushUnix: push - 15 * 60, origTakeoffUnix: takeoff - 15 * 60, origLandUnix: land - 15 * 60 },
      resume: {
        gateOut: { scheduled: push - 15 * 60, estimated: null, actual: push },
        takeoff: { scheduled: takeoff - 15 * 60, estimated: null, actual: takeoff },
        landing: { scheduled: land - 15 * 60, estimated: null, actual: land },
        gateIn: { scheduled: gate - 15 * 60, estimated: null, actual: null },
      },
    };
    const shown = ui.rememberOrigOnClient(story);
    assert.equal(shown.times.push, '4:16 PM HST'); assert.equal(shown.times.takeoff, '4:27 PM HST');
    assert.equal(shown.times.land, '4:16 AM CDT +1'); assert.equal(shown.times.gate, '4:27 AM CDT +1');

    const head = render(ui.FlightHead, { story: shown, fetching: false, refreshing: false, onRefresh() {} });
    const details = render(ui.OverviewDetails, { story: shown, timing: h(ui.TimesStrip, { story: shown }) });
    const welcome = render(ui.FlightWelcome, { open: true, onClose() {}, story: shown });
    const brief = composeBrief(ui.rideFacts({ ...shown, currentStage: 'arrival' }, 'UA203', 'arrival'));
    assert.match(head, /4:27 AM/); assert.match(head, /CDT \+1/);
    for (const value of ['4:16 PM HST', '4:27 PM HST', '4:16 AM CDT +1', '4:27 AM CDT +1']) assert.match(details, new RegExp(value.replace('+', '\\+')));
    for (const value of ['4:16 PM', '4:27 PM', '4:16 AM +1', '4:27 AM +1']) assert.match(welcome, new RegExp(value.replace('+', '\\+')));
    assert.equal((welcome.match(/HST/g) ?? []).length, 1); assert.equal((welcome.match(/CDT/g) ?? []).length, 1);
    assert.match(JSON.stringify(brief), /4:16 AM CDT \+1|4:27 AM CDT \+1/);
  } finally {
    if (oldStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = oldStorage;
  }
});

test('Flight welcome shows alert-red delay rows only at five minutes or more', () => {
  const base = polishStory();
  const onTime = { ...base, times: { ...base.times, delayMin: 4, arriveDelayMin: 0 } };
  const onTimeHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story: onTime });
  assert.doesNotMatch(onTimeHtml, /data-flight-alerts|Departure delayed|Arrival delayed|On time/);

  const delayed = { ...base, times: { ...base.times, delayMin: 5, arriveDelayMin: 18 } };
  const delayedHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story: delayed });
  assert.match(delayedHtml, /class="[^"]*text-turbulence-moderate[^"]*" data-flight-alerts/);
  assert.match(delayedHtml, /Departure delayed 5 min/);
  assert.match(delayedHtml, /Arrival delayed 18 min/);
});

test('Flight welcome distinguishes occurred and estimated clocks and shares the Overview stage line', () => {
  const base = polishStory();
  const story = { ...base, times: { ...base.times,
    pushKind: 'actual', pushSource: 'provider_actual',
    takeoffKind: 'estimated', landKind: 'estimated', gateKind: 'estimated',
  } };
  const welcome = render(ui.FlightWelcome, { open: true, onClose() {}, story });
  const overview = render(ui.FlightHead, { story, fetching: false, refreshing: false, onRefresh() {} });
  assert.match(welcome, /Pushback[\s\S]*data-time-state="actual"> · Actual/);
  assert.match(welcome, /Takeoff[\s\S]*data-time-state="detected"> · Detected/);
  assert.match(welcome, /data-time-value="takeoff">8:26 AM/);
  assert.doesNotMatch(welcome, /data-time-value="takeoff">~/);
  assert.match(welcome, /data-flight-stage="true">In flight/);
  assert.match(overview, />In flight</);
});

test('taxi welcome uses the Overview pushback clock as detected, without an estimate marker', () => {
  const story = taxiWelcomeStory();
  const welcome = render(ui.FlightWelcome, { open: true, onClose() {}, story });
  const overview = render(ui.TimesStrip, { story });
  const departure = welcome.slice(welcome.indexOf('data-flight-time-row="departure"'), welcome.indexOf('data-flight-ride'));
  assert.match(overview, /7:56 PM CDT/);
  assert.match(departure, /data-time-state="detected"> · Detected/);
  assert.match(departure, /data-time-value="pushback">7:56 PM/);
  assert.doesNotMatch(departure, /~7:56 PM/);
  assert.match(departure, /data-time-value="takeoff">~8:01 PM/);
  assert.equal((departure.match(/CDT/g) ?? []).length, 1, 'departure timezone is shown once');
});

test('occurred takeoff, landing, and gate clocks lose estimate markers', () => {
  const base = polishStory();
  const airborne = { ...base, currentStage: 'ride', confirmedTakeoff: { source: 'observed_airborne', at: null, confirmedAt: base.fetchedAt / 1000 },
    times: { ...base.times, takeoffKind: 'estimated', airborne: true } };
  const airborneHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story: airborne });
  assert.match(airborneHtml, /Takeoff[\s\S]*data-time-state="detected"> · Detected/);
  assert.doesNotMatch(airborneHtml, /data-time-value="takeoff">~/);

  const arrived = actualOnlyStory();
  arrived.currentStage = 'gate';
  arrived.times.gateKind = 'estimated';
  const arrivedHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story: arrived });
  assert.match(arrivedHtml, /Gate[\s\S]*data-time-state="detected"> · Detected/);
  assert.doesNotMatch(arrivedHtml, /data-time-value="gate">~/);
});

test('Flight welcome hides ride weather after landing and does not repeat the Briefing lead', () => {
  const airborne = polishStory();
  const airborneHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story: airborne,
    brief: { lead: 'LONG BRIEFING LEAD SHOULD STAY IN BRIEFING' } });
  assert.match(airborneHtml, /data-flight-ride="true"/);
  assert.doesNotMatch(airborneHtml, /LONG BRIEFING LEAD SHOULD STAY IN BRIEFING/);

  const landedHtml = render(ui.FlightWelcome, { open: true, onClose() {}, story: actualOnlyStory() });
  assert.doesNotMatch(landedHtml, /data-flight-ride|Route weather and ride conditions/);
});

test('Flight welcome keeps critical operations and compact weather alerts scannable', () => {
  const base = polishStory();
  const story = { ...base, cancelled: true,
    diversion: { source: 'flightaware', reportedAt: base.fetchedAt, originalDestination: 'HNL', destination: 'LAX' },
    inboundDiversion: { source: 'flightaware', reportedAt: base.fetchedAt, flightId: 'inbound-1', flight: 'UA100', aircraft: 'N100UA', destination: 'SFO', originalDestination: 'ORD', chain: [] },
    hazards: [
      { id: 'ice', kind: 'ice', label: 'Icing', detail: '', validity: '', remaining: true },
      { id: 'ifr', kind: 'ifr', label: 'IFR', detail: '', validity: '', remaining: true },
      { id: 'llws', kind: 'llws', label: 'LLWS', detail: '', validity: '', remaining: true },
    ],
  };
  const html = render(ui.FlightWelcome, { open: true, onClose() {}, story });
  for (const text of ['Flight cancelled', 'Flight diverted to LAX', 'Inbound aircraft diverted to SFO', 'Ice', 'Low visibility', 'Wind shear']) assert.match(html, new RegExp(text));
});

test('Weather timeline and map alerts agree on light at 11 minutes and moderate at 228', async () => {
  const story = polishStory();
  const overview = render(ui.TravelerCompanion, { story });
  const weather = render(ui.WeatherTimeline, { story });
  const map = render(ui.RouteMap, { story, fixedViewport: true });
  assert.ok(weather.indexOf('Light bumps') < weather.indexOf('Moderate bumps'));
  assert.match(weather, /11 minutes ahead/); assert.match(weather, /3 hours 48 minutes ahead/);
  assert.ok(map.indexOf('Light bumps') < map.indexOf('Moderate bumps'));
  const names = [...map.matchAll(/<details name="([^"]+)"/g)].map(m => m[1]);
  assert.equal(names.length, 2); assert.equal(names[0], names[1]);

  // Optional read-only browser fixtures use the actual SSR components and built
  // stylesheet. No app route, provider mocks, or test controls ship to Preview.
  if (process.env.POLISH_EVIDENCE_DIR) {
    const output = process.env.POLISH_EVIDENCE_DIR;
    await mkdir(output, { recursive: true });
    const assets = resolve('.vercel/output/static/assets');
    const css = (await Promise.all((await readdir(assets)).filter(name => name.endsWith('.css')).map(name => readFile(join(assets, name), 'utf8')))).join('\n');
    const sections = {
      overview: render(ui.FlightHead, { story, fetching: false, refreshing: false, onRefresh() {} }, 'head-') + overview,
      details: render(ui.OverviewDetails, { story: actualOnlyStory(), timing: h(ui.TimesStrip, { story: actualOnlyStory() }) }, 'details-'),
      briefing: render(ui.BreakdownCard, { briefing: composeBrief(ui.rideFacts(story, 'UA219', 'ride')), pending: false, feedback: null, onCompile() {} }, 'brief-'),
      welcome: render(ui.FlightWelcome, { open: true, onClose() {}, story: taxiWelcomeStory() }, 'welcome-').replace('<dialog', '<dialog open'),
      map, weather,
    };
    for (const [name, content] of Object.entries(sections)) for (const theme of ['sunrise', 'sunset']) {
      const styles = name === 'details' ? '.overview-details .grid-rows-\\[0fr\\]{grid-template-rows:1fr;opacity:1}' : '';
      const html = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inbound polish · ${name} · ${theme}</title><style>${css}\n${styles}</style></head><body class="inbound-redesign"><main class="p-4"><p class="mb-3 text-xs text-muted">Presentation fixture · ${name} · ${theme}</p>${name === 'map' ? `<div class="journey-map" style="height:650px">${content}</div>` : content}</main></body></html>`;
      await writeFile(join(output, `${name}-${theme}.html`), html);
    }
    const frames = ['overview', 'details', 'briefing', 'welcome', 'map', 'weather'].flatMap(name => ['sunrise', 'sunset'].map(theme => `<section><h2>${name} · ${theme} · 390 px</h2><iframe title="${name}-${theme}" src="${name}-${theme}.html" width="390" height="${name === 'welcome' ? 700 : 1100}"></iframe></section>`)).join('');
    await writeFile(join(output, 'index.html'), `<!doctype html><title>Inbound presentation evidence</title><style>body{font:16px system-ui;background:#eee}main{display:grid;grid-template-columns:repeat(2,430px);gap:24px}iframe{border:1px solid #aaa}</style><h1>Inbound presentation evidence</h1><p>Actual components · deterministic fixtures · no provider requests. Flight details expanded for inspection.</p><main>${frames}</main>`);
  }
});
