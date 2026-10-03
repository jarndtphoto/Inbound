import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resumeFromStory } from '../src/lib/flight-resume.ts';
import { scheduledTimes } from '../src/lib/scheduled-times.ts';
import { composeBrief } from '../src/lib/brief-copy.ts';
import { formatClockTime } from '../src/lib/presentation-time.ts';
import { displayStage, flightAirborne } from '../src/lib/flight-presentation.ts';
import { departureSeedUnix } from '../src/lib/flight-identity.ts';
import { flightDepartureDate } from '../src/lib/airline-status.ts';
import { journeyKey } from '../src/lib/traveler.ts';

const fr24 = JSON.parse(await readFile(new URL('./fixtures/ua219-fr24-only.json', import.meta.url)));
const handoff = JSON.parse(await readFile(new URL('./fixtures/ua219-provider-handoff.json', import.meta.url)));
const none = { scheduled: null, estimated: null, actual: null };
let directory, core, ui, taxi;
const evidence = { fixture: 'Synthetic UA219 FR24-only and provider-handoff fixtures; every fetch mocked', cases: [] };
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.scheduled-original-replay-'));
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } },
    plugins: [{ name: 'test-original-ui', enforce: 'pre', transform(code, id) {
      if (id === resolve('src/components/filed-app.tsx')) return code + '\nexport { FlightHead, TimesStrip, OverviewDetails, BreakdownCard, TravelerCompanion, rideFacts, origMemKey, briefHistoryKey, savedBrief, saveBrief };\nexport { sanitizeDetectedPushTime, suppressLateJoinDetectedPush } from "@/lib/story";';
    } }, react()], build: { ssr: resolve('src/components/filed-app.tsx'), outDir: join(directory, 'ui'),
      rollupOptions: { output: { entryFileNames: 'ui.mjs' } } } });
  ui = await import(pathToFileURL(join(directory, 'ui/ui.mjs')).href);
  await build({ configFile: false, logLevel: 'silent', plugins: [{ name: 'test-original-server', enforce: 'pre', transform(code, id) {
    if (id === resolve('src/lib/story.server.ts')) return code + '\nexport { timesOf, rememberOrig, origKey, awareFromLiveFr24 };';
  } }], build: { ssr: resolve('src/lib/story.server.ts'), outDir: join(directory, 'server'),
    rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
  core = await import(pathToFileURL(join(directory, 'server/story.mjs')).href);
});
after(async () => {
  if (process.env.ORIG_REPLAY_EVIDENCE) await writeFile(process.env.ORIG_REPLAY_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  if (directory) await rm(directory, { recursive: true, force: true });
});
function staysTaxi(story) {
  assert.equal(story.currentStage, 'taxi'); assert.equal(displayStage(story), 'taxi'); assert.equal(flightAirborne(story), false);
}
function detected(reference, scheduled = null, original = scheduled) {
  const now = taxi.fetchedAt / 1000;
  return { ...taxi, times: { ...taxi.times, origPushUnix: original, pushUnix: now - 60,
    push: 'stale display text', pushKind: 'estimated', pushSource: 'live_detected', pushWas: 'stale schedule text' },
    resume: { ...taxi.resume, gateOut: { ...none, scheduled, estimated: reference }, detectedPushUnix: now - 60 } };
}
function render(component, props) {
  const client = new QueryClient();
  try { return renderToStaticMarkup(h(QueryClientProvider, { client }, h(component, props))); }
  finally { client.clear(); }
}

test('FR24-only no schedule: cold taxi stories have null originals and no Scheduled rows in all five views', async () => {
  const realFetch = globalThis.fetch, RealDate = Date;
  const envKeys = ['FR24_API_TOKEN', 'FR24_ENABLE_TRACKS', 'FR24_ENABLE_SUMMARY', 'FLIGHTAWARE_AEROAPI_KEY'];
  const oldEnv = envKeys.map(key => process.env[key]);
  let now = fr24.nowUnix * 1000, raw = structuredClone(fr24.data[0]), mode = 'fr24';
  const awareRecord = structuredClone(handoff.flightawareRecord);
  awareRecord.flightStatus = 'scheduled'; awareRecord.gateDepartureTimes.actual = null;
  awareRecord.takeoffTimes.actual = null; awareRecord.track = []; delete awareRecord.coord;
  const requests = [];
  try {
    envKeys.forEach(key => delete process.env[key]); process.env.FR24_API_TOKEN = 'fixture-only-no-network';
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com') return mode === 'aware'
        ? new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: awareRecord } })};`) : new Response(null, { status: 402 });
      if (/flightstats/.test(url.hostname)) return mode === 'stats' && url.searchParams.get('date') === '2' && url.searchParams.get('month') === '10'
        ? new Response(handoff.flightstatsHtml) : new Response(null, { status: 404 });
      if (url.hostname === 'fr24api.flightradar24.com') {
        assert.equal(url.pathname, '/api/live/flight-positions/full', 'no new provider paths');
        return Response.json({ data: [{ ...raw, timestamp: now / 1000 }] });
      }
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname) && !url.pathname.includes('trace_')) return Response.json({ ac: [] });
      if (url.pathname.includes('trace_')) return Response.json({ timestamp: now / 1000, trace: [] });
      if (url.hostname === 'aviationweather.gov') return Response.json(url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : { features: [] });
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw Error('Unexpected provider: ' + url);
    };
    await globalThis.__pgBootstrapPromise__; const pg = await globalThis.__pgliteInstance__;
    await pg.exec('delete from flight_phase_state; delete from arrival_projection_state');
    await core.loadFlightStory('UA219', { fresh: true });
    now += 10_000; raw.lon += 0.0012; raw.gspeed = 4;
    await core.loadFlightStory('UA219', { fresh: true });
    now += 10_000; raw.lon += 0.002; raw.gspeed = 15;
    const cold = await import(pathToFileURL(join(directory, 'server/story.mjs')).href + '?cold=taxi');
    taxi = await cold.loadFlightStory('UA219', { fresh: true }); staysTaxi(taxi);
    const again = await (await import(pathToFileURL(join(directory, 'server/story.mjs')).href + '?cold=held')).loadFlightStory('UA219', { fresh: true });
    staysTaxi(again); assert.equal(again.times.pushUnix, taxi.times.pushUnix);
    let renders = 0;
    for (const story of [taxi, again]) {
      assert.deepEqual([story.times.origPushUnix, story.times.origTakeoffUnix, story.times.origLandUnix], [null, null, null]);
      assert.deepEqual(scheduledTimes(story), { pushUnix: null, takeoffUnix: null, landUnix: null });
      const briefing = composeBrief(ui.rideFacts(story, 'UA219', 'taxi'));
      for (const [name, component, props] of [['Header', ui.FlightHead, { story, fetching: false, refreshing: false, onRefresh() {} }],
        ['Timing', ui.TimesStrip, { story }], ['Flight details', ui.OverviewDetails, { story, timing: null }],
        ['Arrival help', ui.TravelerCompanion, { story }], ['Briefing', ui.BreakdownCard, { briefing, pending: false, feedback: null, onCompile() {} }]]) {
        const html = render(component, props);
        const content = name === 'Flight details' ? html.slice(html.indexOf('id="overview-flight-details"'), html.indexOf('id="overview-aircraft-details"')) : html;
        assert.doesNotMatch(content, />Scheduled(?:\s+(?:pushback|takeoff|landing|gate arrival))?</i);
        if (name === 'Flight details') assert.doesNotMatch(content, /Scheduled|Planned flight time/);
        if (name === 'Briefing') assert.doesNotMatch(content, /Scheduled gate departure|Scheduled landing|Scheduled takeoff/);
        renders++;
      }
    }
    assert.equal(requests.filter(url => url.includes('fr24api')).length, 4);
    evidence.cases.push({ case: 'FR24-only cold taxi', stage: taxi.currentStage, coldStage: again.currentStage, scheduledRows: 0, renders, liveRequests: 4 });
    // Actual FlightAware -> FlightStats -> FlightAware loading, with fresh
    // origin surface evidence throughout. Preserve proven original schedules
    // even where the two providers post different scheduled clocks.
    now += 70_000; mode = 'aware'; const aware = await core.loadFlightStory('UA219', { fresh: true });
    now += 10_000; mode = 'stats'; const fallback = await core.loadFlightStory('UA219', { fresh: true });
    now += 70_000; mode = 'aware'; const back = await core.loadFlightStory('UA219', { fresh: true });
    for (const story of [aware, fallback, back]) {
      staysTaxi(story); assert.equal(story.stateKey, aware.stateKey);
      assert.deepEqual([story.times.origPushUnix, story.times.origTakeoffUnix, story.times.origLandUnix],
        [aware.times.origPushUnix, aware.times.origTakeoffUnix, aware.times.origLandUnix]);
    }
    assert.equal(aware.times.origPushUnix, awareRecord.gateDepartureTimes.scheduled);
    assert.equal(fallback.flightId ?? null, null); assert.equal(back.flightId, aware.flightId);
    assert.equal(requests.filter(url => url.includes('fr24api')).length, 7);
    evidence.cases.push({ case: 'actual UA219 provider handoff', stages: [aware, fallback, back].map(story => story.currentStage),
      originalSchedules: [aware.times.origPushUnix, aware.times.origTakeoffUnix, aware.times.origLandUnix], stateKey: aware.stateKey, liveRequests: 7 });
  } finally {
    globalThis.fetch = realFetch; globalThis.Date = RealDate;
    envKeys.forEach((key, i) => oldEnv[i] == null ? delete process.env[key] : process.env[key] = oldEnv[i]);
  }
});

test('FR24 estimated/actual-only timestamps never seed original schedules', () => {
  const now = taxi.fetchedAt / 1000;
  const flight = { flightId: 'unscheduled-variant', callsign: 'UAL220', origin: { iata: 'ORD', icao: 'KORD' }, destination: { iata: 'HNL', icao: 'PHNL' },
    position: { seenAt: Date.now() / 1000, lat: 41.98, lon: -87.90, onGround: true, gsKt: 15 },
    push: { ...none, estimated: now - 1200 }, takeoff: { ...none, actual: now - 600 }, landing: { ...none, estimated: now + 8 * 3600 }, gateIn: { ...none } };
  const times = core.timesOf(core.awareFromLiveFr24(flight), taxi.origin, taxi.dest);
  assert.deepEqual([times.origPushUnix, times.origTakeoffUnix, times.origLandUnix], [null, null, null]);
  assert.equal(times.delayMin, null); assert.equal(times.arriveDelayMin, null);
  staysTaxi({ ...taxi, times: { ...taxi.times, origPushUnix: times.origPushUnix, origTakeoffUnix: times.origTakeoffUnix, origLandUnix: times.origLandUnix } });
  evidence.cases.push({ case: 'FR24 estimated/actual-only seed', originals: [null, null, null], stage: 'taxi' });
});

test('late join uses the true reference kind; no reference or an existing taxi checkpoint keeps the detection', () => {
  const now = taxi.fetchedAt / 1000;
  for (const kind of ['scheduled', 'estimated']) {
    const reference = now - 1200, input = detected(kind === 'estimated' ? reference : reference + 600, kind === 'scheduled' ? reference : null);
    const output = ui.suppressLateJoinDetectedPush(input);
    staysTaxi(output); assert.equal(output.times.pushUnix, reference); assert.equal(output.times.pushKind, kind);
    assert.equal(output.times.push, formatClockTime(reference * 1000, taxi.origin.tz));
    assert.equal(output.times.pushSource, null); assert.equal(output.resume.detectedPushUnix, null);
    assert.equal(ui.suppressLateJoinDetectedPush(input, { originIcao: taxi.origin.icao, destIcao: taxi.dest.icao, departureStage: 'taxi' }), input);
  }
  const noReference = detected(null);
  assert.equal(ui.suppressLateJoinDetectedPush(noReference), noReference); staysTaxi(noReference);
  evidence.cases.push({ case: 'late join', referenceKinds: ['scheduled', 'estimated'], noReference: 'keeps detected push', stage: 'taxi' });
});

test('push sanitization uses schedule or explicit estimate without promoting kinds; no reference retains even a future detection', () => {
  const now = taxi.fetchedAt / 1000;
  for (const kind of ['scheduled', 'estimated']) {
    const reference = now + 7200, input = detected(kind === 'estimated' ? reference : reference + 600, kind === 'scheduled' ? reference : null);
    const output = ui.sanitizeDetectedPushTime(input);
    staysTaxi(output); assert.equal(output.times.pushUnix, reference); assert.equal(output.times.pushKind, kind);
    assert.equal(output.times.push, formatClockTime(reference * 1000, taxi.origin.tz));
    assert.equal(output.times.pushSource, null);
  }
  const input = detected(null); input.times.pushUnix = now + 600;
  assert.equal(ui.sanitizeDetectedPushTime(input), input); staysTaxi(input);
  const actualOnly = { ...input, resume: { ...input.resume, gateOut: { ...none, actual: now - 1200 } } };
  assert.equal(ui.sanitizeDetectedPushTime(actualOnly), actualOnly, 'actual is never used as a schedule/estimate reference');
  evidence.cases.push({ case: 'push sanitization', referenceKinds: ['scheduled', 'estimated'], noReference: 'keeps detected push', stage: 'taxi' });
});

test('legacy resume scheduled stamps require an explicit scheduled kind and never trust contaminated originals', () => {
  const now = taxi.fetchedAt / 1000;
  const legacy = { ...taxi, resume: undefined, times: { ...taxi.times,
    pushUnix: now - 1200, pushKind: 'estimated', origPushUnix: now - 1200,
    takeoffUnix: now - 600, takeoffKind: 'actual', origTakeoffUnix: now - 600,
    landUnix: now + 8 * 3600, landKind: 'estimated', origLandUnix: now + 8 * 3600 } };
  const resumed = resumeFromStory(legacy, 'UA219', taxi.fetchedAt);
  assert(resumed); assert.deepEqual([resumed.gateOut.scheduled, resumed.takeoff.scheduled, resumed.landing.scheduled], [null, null, null]);
  assert.equal(resumed.gateOut.estimated, legacy.times.pushUnix); assert.equal(resumed.takeoff.actual, null);
  assert.equal(resumed.departureStage, 'taxi'); staysTaxi(legacy);
  const scheduled = { ...legacy, times: { ...legacy.times, pushKind: 'scheduled', takeoffKind: 'scheduled', landKind: 'scheduled',
    origPushUnix: now - 1800, origTakeoffUnix: now - 1800, origLandUnix: now + 7 * 3600 } };
  const real = resumeFromStory(scheduled, 'UA219', taxi.fetchedAt);
  assert.equal(real.gateOut.scheduled, scheduled.times.pushUnix); assert.equal(real.takeoff.scheduled, scheduled.times.takeoffUnix);
  assert.equal(real.landing.scheduled, scheduled.times.landUnix); staysTaxi(scheduled);
  evidence.cases.push({ case: 'legacy resume', unprovenOriginals: 'ignored', explicitSchedules: 'retained', stage: 'taxi' });
});

test('real schedule memory survives provider-ID/fallback/back and partial stamps; eight-hour slip never promotes an estimate', async () => {
  const stats = core.parseFlightStatsPublicSchedule(handoff.flightstatsHtml, 'UAL219', '2026-10-02');
  assert(stats?.gateOut.scheduled); const s = stats.gateOut.scheduled;
  const aware = { ...stats, ident: 'UAL221', flightId: 'provider-one' };
  const first = core.timesOf(aware, taxi.origin, taxi.dest);
  const gap = { ...aware, flightId: null, gateOut: { ...none, estimated: s + 600 }, takeoff: { ...none }, landing: { ...none } };
  const fallback = core.timesOf(gap, taxi.origin, taxi.dest);
  const back = core.timesOf({ ...aware, flightId: 'provider-one' }, taxi.origin, taxi.dest);
  for (const times of [first, fallback, back]) {
    assert.equal(times.origPushUnix, s); assert.equal(times.origTakeoffUnix, first.origTakeoffUnix); assert.equal(times.origLandUnix, first.origLandUnix);
    staysTaxi({ ...taxi, times: { ...taxi.times, origPushUnix: times.origPushUnix, origTakeoffUnix: times.origTakeoffUnix, origLandUnix: times.origLandUnix } });
  }
  const slipped = { ...aware, ident: 'UAL222', gateOut: { scheduled: s, estimated: s + 9 * 3600, actual: s + 10 * 3600 } };
  assert.equal(core.timesOf(slipped, taxi.origin, taxi.dest).origPushUnix, s);
  assert.equal(departureSeedUnix(slipped.gateOut), s + 9 * 3600);
  assert.equal(core.origKey(slipped), `UAL222|ORD|HNL|${new Date((s + 9 * 3600) * 1000).toISOString().slice(0, 10)}`);
  assert.equal(core.timesOf({ ...slipped, gateOut: { ...slipped.gateOut, scheduled: null } }, taxi.origin, taxi.dest).origPushUnix, null);
  evidence.cases.push({ case: 'real schedules and eight-hour slip', handoffSchedulesRetained: true, slippedOriginal: s, operationalClock: s + 9 * 3600, stage: 'taxi' });
});

test('original memories isolate different-day and different-route legs', () => {
  const now = taxi.fetchedAt / 1000;
  const base = { ident: 'UAL223', originIata: 'ORD', destIata: 'HNL', gateOut: { ...none, scheduled: now }, takeoff: none, landing: none, gateIn: none };
  core.rememberOrig(base);
  const tomorrow = { ...base, gateOut: { ...none, estimated: now + 86400 } };
  const route = { ...base, destIata: 'LAX', gateOut: { ...none, estimated: now } };
  assert.equal(core.rememberOrig(tomorrow).gateOut, null); assert.equal(core.rememberOrig(route).gateOut, null);
  assert.equal(core.rememberOrig({ ...base, gateOut: { ...none, estimated: now + 600 } }).gateOut, now);
});

test('client schedule and briefing keys plus baggage/history dates are stable before/after original clearing', () => {
  const unix = Date.parse('2026-10-03T04:30:00Z') / 1000;
  for (const stateKey of [undefined, 'leg:v1:UAL219|2026-10-02|ORD|HNL', 'leg:unvalidated:UAL219|ORD|HNL|2026-10-03']) {
    const before = { ...taxi, stateKey, flightId: null, fetchedAt: (unix + 3600) * 1000,
      resume: { ...taxi.resume, gateOut: { ...none, estimated: unix }, takeoff: none },
      times: { ...taxi.times, origPushUnix: unix, origTakeoffUnix: null, pushUnix: unix, pushKind: 'estimated' } };
    const after = { ...before, times: { ...before.times, origPushUnix: null, origTakeoffUnix: null, origLandUnix: null } };
    assert.equal(ui.origMemKey(before), ui.origMemKey(after)); assert.equal(ui.briefHistoryKey(before), ui.briefHistoryKey(after));
    assert.equal(journeyKey(before), journeyKey(after)); assert.equal(flightDepartureDate(before), flightDepartureDate(after));
    assert.equal(flightDepartureDate(after), '2026-10-02'); staysTaxi(after);
    if (stateKey) assert.equal(ui.briefHistoryKey({ ...before, flightId: 'provider-one' }), ui.briefHistoryKey({ ...after, flightId: 'provider-two' }));
    for (const other of [{ ...after, stateKey: 'leg:v1:UAL219|2026-10-03|ORD|HNL' },
      { ...after, stateKey: 'leg:v1:UAL219|2026-10-02|ORD|LAX', dest: { ...after.dest, iata: 'LAX', icao: 'KLAX' } }]) {
      assert.notEqual(ui.origMemKey(after), ui.origMemKey(other)); assert.notEqual(ui.briefHistoryKey(after), ui.briefHistoryKey(other));
    }
  }
  evidence.cases.push({ case: 'history/baggage keys', stableBeforeAfterClearing: true, originLocalDate: '2026-10-02', stage: 'taxi' });
});

test('existing saved briefing history is retained when the dated state key becomes the primary key', () => {
  const realStorage = globalThis.localStorage;
  const memory = new Map(); globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  try {
    const story = { ...taxi, stateKey: 'leg:v1:UAL219|2026-10-02|ORD|HNL' };
    const brief = composeBrief(ui.rideFacts(story, 'UA219', 'taxi'));
    memory.set('inbound-brief-history-v2', JSON.stringify({ [ui.briefHistoryKey(story, true)]: { at: story.fetchedAt, brief } }));
    assert.deepEqual(ui.savedBrief(story), brief);
    ui.saveBrief(story, brief);
    assert.deepEqual(ui.savedBrief({ ...story, flightId: null }), brief, 'provider handoff retains the migrated brief');
  } finally { if (realStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = realStorage; }
});
