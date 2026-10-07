import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { acquisitionFixture } from './helpers/acquisition-fixture.mjs';

test('Production-parity Preview keeps normal sources working after the FR24 session stops', async t => {
  const directory = await mkdtemp(resolve('node_modules/.fr24-production-parity-story-'));
  const realFetch = globalThis.fetch, realNow = Date.now, realInfo = console.info;
  const envKeys = ['VERCEL_ENV', 'FR24_PREVIEW_MODE', 'FR24_PREVIEW_ENABLED', 'FR24_API_TOKEN',
    'FR24_ENABLE_TRACKS', 'FR24_ENABLE_SUMMARY', 'FLIGHTAWARE_PAID_API_ENABLED', 'FLIGHTAWARE_AEROAPI_KEY',
    'FLIGHTAWARE_API_KEY', 'FR24_PREVIEW_SESSION_ID', 'FR24_PREVIEW_CREDIT_CAP',
    'FR24_PREVIEW_ATTEMPT_CAP', 'FR24_PREVIEW_EXPIRES_AT'];
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const fixture = { dbCalls: 0 };
  globalThis.__fr24ParityStoryFixture = fixture;
  let now = Date.parse('2026-10-07T17:40:00Z'); const sec = now / 1000;
  let traceOverride = null;
  let holdPireps = false, pirepGate, releasePireps, pirepTimer, overlappedTrace = false;
  const requests = [];
  let statusReads = 0, reserveAttempts = 0;
  const stoppedSession = Object.freeze({ mode: 'production-parity', modeEnabled: true, enabled: true,
    state: 'stopped_402', reason: 'stopped_402', blocked: true, sessionId: 'existing-preview-session',
    creditCap: 400, attemptCap: 50, expiresAt: Date.parse('2026-10-07T17:45:00Z'),
    creditsConsumed: 8, creditsReserved: 8, attempts: 1, remainingCredits: 392,
    remainingAttempts: 49, stopped402: true, inFlight: false, lastStatusCode: 402, lastErrorKind: '402' });
  // Adapt the existing public-feed shape into a wholly synthetic current leg.
  const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
  Object.assign(record, { ident: 'UAL9918', iataIdent: 'UA9918',
    flightId: `UAL9918-${sec - 3600}-airline-fixture`, hexid: 'ac9918',
    flightStatus: 'airborne', coord: null, track: null });
  record.aircraft = { type: 'A320', tail: 'N9918Z' };
  record.gateDepartureTimes = { scheduled: sec - 3800, estimated: sec - 3800, actual: sec - 3800 };
  record.takeoffTimes = { scheduled: sec - 3600, estimated: sec - 3600, actual: sec - 3600 };
  record.landingTimes = { scheduled: sec + 2700, estimated: sec + 2700, actual: null };
  record.gateArrivalTimes = { scheduled: sec + 3000, estimated: sec + 3000, actual: null };
  const aircraft = { hex: 'ac9918', flight: 'UAL9918', r: 'N9918Z', t: 'A320',
    lat: 36.1, lon: -89.5, gs: 450, alt_baro: 35000, baro_rate: 0, track: 185, seen: 2, seen_pos: 2 };
  try {
    await build({ configFile: false, logLevel: 'silent', plugins: [acquisitionFixture(), {
      name: 'offline-production-parity-story-boundaries', enforce: 'pre',
      resolveId(source) {
        if (source === '@tanstack/react-start') return '\0parity-server-function';
        if (/(?:^|\/)db(?:\.ts)?$/.test(source)) return '\0parity-offline-database';
      },
      load(id) {
        if (id === '\0parity-server-function') return `export function createServerFn() {
          let validate = x => x; const builder = { validator(fn) { validate = fn; return builder; },
            handler(fn) { return async (arg = {}) => fn({ data: validate(arg.data) }); } }; return builder;
        }`;
        if (id === '\0parity-offline-database') return `export const dbSource = 'neon';
          const sql = async () => { globalThis.__fr24ParityStoryFixture.dbCalls++; return []; };
          sql.query = sql; export async function getSql() { return sql; }`;
      },
      transform(code, id) {
        if (id.endsWith('/src/lib/flight-phase-state.server.ts')) return {code:`
          export {phaseStateEqual} from './flight-phase-state-logic.ts';
          export async function loadPhaseState() { return globalThis.__fr24ParityStoryFixture.phase ?? {state:{push:null,taxiOut:null},version:0,status:'ok'}; }
          export async function savePhaseState(key,next) {const f=globalThis.__fr24ParityStoryFixture; f.savedPhase=next; if(f.winner){f.phase=f.winner;return 'conflict_resolved';}return 'ok';}
        `,map:null};
        if (id.endsWith('/src/lib/story.server.ts')) return { code: code + `
          export function fixtureSeedNormalStory(query, value) {
            cache.set('story43:' + query, { at: Date.now(), value });
          }`, map: null };
        if (id.endsWith('/src/lib/story.ts')) return { code: code + `
          export { loadFlightStory };
          export { fixtureSeedNormalStory } from './story.server.ts';
          export { loadOfficialFlightData, setFr24GuardForTests } from './official-flight-data.server.ts';
          export { setFr24PreviewSessionGuardForTests } from './fr24-preview-session.server.ts';`, map: null };
      },
    }], build: { ssr: resolve('src/lib/story.ts'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    process.env.VERCEL_ENV = 'preview';
    process.env.FR24_PREVIEW_MODE = 'production-parity';
    process.env.FR24_PREVIEW_ENABLED = '1';
    process.env.FR24_API_TOKEN = 'offline-fixture-only';
    process.env.FR24_PREVIEW_SESSION_ID = stoppedSession.sessionId;
    process.env.FR24_PREVIEW_CREDIT_CAP = '400';
    process.env.FR24_PREVIEW_ATTEMPT_CAP = '50';
    process.env.FR24_PREVIEW_EXPIRES_AT = '2026-10-07T17:45:00Z';
    // Match Production's disabled paid AeroAPI gate even with an available key.
    delete process.env.FLIGHTAWARE_PAID_API_ENABLED;
    delete process.env.FR24_ENABLE_TRACKS;
    delete process.env.FR24_ENABLE_SUMMARY;
    process.env.FLIGHTAWARE_AEROAPI_KEY = 'offline-fixture-only';
    process.env.FLIGHTAWARE_API_KEY = 'offline-fixture-only';
    Date.now = () => now;
    console.info = () => {};
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname.includes('trace_') && releasePireps) {
        overlappedTrace=true; clearTimeout(pirepTimer); releasePireps(); releasePireps=null;
      }
      if (holdPireps && url.pathname.endsWith('/pirep')) {
        if (!pirepGate) pirepGate = new Promise(resolve => {
          releasePireps=resolve; pirepTimer=setTimeout(()=>{releasePireps=null;resolve();},200);
        });
        await pirepGate; return Response.json({features:[]});
      }
      if (url.hostname === 'www.flightaware.com')
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      if (/flightstats/.test(url.hostname)) return new Response(null, { status: 404 });
      if (url.pathname.includes('trace_') && traceOverride) return Response.json(traceOverride);
      if (url.pathname.includes('trace_')) return Response.json({ timestamp: sec - 3600, trace: [
        [0, 41.9769, -87.9081, 5000, 210, 185], [1500, 38.4, -89.0, 35000, 450, 185],
        [3598, aircraft.lat, aircraft.lon, 35000, 450, 185],
      ] });
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname)) return Response.json({ ac: [aircraft] });
      if (url.hostname === 'aviationweather.gov') return Response.json(
        url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf') ? [] : { features: [] });
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw new Error('Unexpected offline provider request: ' + url.href);
    };
    const api = await import(pathToFileURL(join(directory, 'story.mjs')).href);
    api.setFr24PreviewSessionGuardForTests({
      status: async () => { statusReads++; return { ...stoppedSession }; },
      reserve: async () => { reserveAttempts++; return null; },
      canDispatch: async () => false,
      finish: async () => { throw new Error('A stopped session cannot finish a new call'); },
    });
    api.setFr24GuardForTests({
      usage: async () => null,
      reserve: async () => { throw new Error('A stopped Preview cannot reserve daily credits'); },
      finish: async () => { throw new Error('A stopped Preview cannot finish a paid call'); },
      cached: async () => null,
      acquire: async () => { throw new Error('A stopped Preview cannot acquire a paid refresh'); },
      store: async () => { throw new Error('A stopped Preview cannot cache a new paid response'); },
      release: async () => {},
    });

    await t.test('mode reads the existing stopped session without spending', async () => {
      assert.deepEqual(await api.getFlightDataMode(), { mode: 'production-parity', session: stoppedSession });
      assert.equal(requests.length, 0);
      assert.equal(reserveAttempts, 0);
    });

    let story;
    await t.test('the real normal story uses public schedules, free telemetry, weather and durable state', async () => {
      story = await api.getFlightStory({ data: { q: 'UA9918', fresh: true } });
      assert.equal(story.providers.previewMode, 'production-parity');
      assert.deepEqual(story.providers.fr24Preview, stoppedSession);
      assert.equal(story.providers.scheduleSource, 'flightaware_public');
      assert.equal(story.providers.chosenPosition, 'adsb');
      assert.equal(story.providers.status.flightaware, 'DISABLED');
      assert.equal(story.providers.status.fr24, 'ERROR');
      assert.equal(story.providers.fr24Position, null);
      assert.equal(story.live, true);
      assert.equal(story.aircraft.lat, aircraft.lat);
      assert.equal(story.aircraft.lon, aircraft.lon);
      assert.equal(story.aircraft.onGround, false);
      assert.equal(story.origin.iata, 'ORD');
      assert.equal(story.dest.iata, 'MSY');
      assert.equal(story.resume.hex, aircraft.hex);
      assert.notEqual(story.comfort.label, 'Unavailable');
      assert.notEqual(story.providers.phaseStatePersistence, 'isolated-preview');
      assert(requests.some(url => url.hostname === 'www.flightaware.com'));
      assert(requests.some(url => /adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname)));
      assert(requests.some(url => url.hostname === 'aviationweather.gov'));
      assert(fixture.dbCalls > 0, 'normal durable continuity still runs');
    });

    await t.test('normal story cache and fresh mode status remain independent', async () => {
      const cached = { ...story, providers: { ...story.providers, fr24Preview: { ...stoppedSession,
        state: 'ready', reason: null, blocked: false, stopped402: false, creditsConsumed: 0 } } };
      api.fixtureSeedNormalStory('UA9918', cached);
      const requestCount = requests.length, readCount = statusReads;
      assert.equal(await api.loadFlightStory('UA9918', {}), cached, 'the existing story cache is preserved');
      assert.equal(requests.length, requestCount);
      assert.equal(statusReads, readCount, 'story cache is not bypassed to rebuild a flight');
      const mode = await api.getFlightDataMode();
      assert.deepEqual(mode.session, stoppedSession, 'capability response reads current persisted status');
      assert.equal(statusReads, readCount + 1);
    });

    await t.test('official fallback diagnostics keep the original cap, debit and HTTP 402', async () => {
      const official = await api.loadOfficialFlightData('UAL9918', { fr24FlightNumber: 'UA9918' });
      assert.equal(official.fr24, null);
      assert.equal(official.flightaware, null);
      assert.deepEqual(official.fr24Preview, stoppedSession);
      assert.equal(reserveAttempts, 0);
      assert.equal(requests.filter(url => url.hostname === 'fr24api.flightradar24.com').length, 0);
      assert.equal(requests.filter(url => url.hostname === 'aeroapi.flightaware.com').length, 0);
    });

    await t.test('UA561 observed event times reject old tail push and retain current provider actual', async () => {
      now = Date.parse('2026-10-07T17:58:37.665Z');
      record.gateDepartureTimes = {scheduled:1791394800,estimated:null,actual:1791394560};
      record.takeoffTimes = {scheduled:1791394800,estimated:null,actual:null};
      Object.assign(aircraft,{lat:41.99,lon:-87.89,gs:165,alt_baro:1500});
      const old = {unix:1791374036.419,source:'track_detected',live:true,at:now/1000};
      fixture.phase={state:{push:old,taxiOut:null},version:1,status:'ok'};
      traceOverride={timestamp:0,trace:[
        [1791373997.829,41.9786,-87.9048,0,0,90],
        [old.unix,41.9786,-87.9031,0,9.2,90],
        [old.unix+40,41.9786,-87.902,0,9.2,90],
        [now/1000-2,aircraft.lat,aircraft.lon,1500,165,90],
      ]};
      const result=await api.getFlightStory({data:{q:'UA9918',fresh:true}});
      assert.equal(result.times.pushUnix,1791394560);
      assert.equal(result.times.pushSource,'provider_actual');
      assert(fixture.savedPhase.pushNotBeforeUnix>old.unix);
      assert.equal(fixture.savedPhase.push.unix,1791394560);
    });
    await t.test('a late response applies the winning push fence before returning times or resume', async () => {
      now+=35000; traceOverride={timestamp:0,trace:[]};
      const old={unix:1791374036.419,source:'track_detected',live:true,at:now/1000};
      fixture.phase={state:{push:old,taxiOut:null},version:1,status:'ok'};
      fixture.winner={state:{push:{unix:1791394560,source:'provider_actual',live:true,at:now/1000},taxiOut:null,pushNotBeforeUnix:old.unix+40.001},version:2,status:'ok'};
      const result=await api.getFlightStory({data:{q:'UA9918',fresh:true}});
      assert.equal(result.times.pushUnix,1791394560);assert.equal(result.times.pushSource,'provider_actual');
      assert.notEqual(result.resume.detectedPushUnix,old.unix);
      fixture.winner=null;
    });

    await t.test('existing ground traces start while independent PIREPs are pending', async () => {
      now+=35000; fixture.phase={state:{push:null,taxiOut:null},version:0,status:'ok'};
      fixture.winner=null; holdPireps=true; traceOverride={timestamp:0,trace:[]};
      Object.assign(record,{ident:'UAL9919',iataIdent:'UA9919',flightId:'UAL9919-current-fixture',flightStatus:'scheduled'});
      record.gateDepartureTimes={scheduled:now/1000+600,estimated:null,actual:null};
      record.takeoffTimes={scheduled:now/1000+900,estimated:null,actual:null};
      Object.assign(aircraft,{flight:'UAL9919',lat:41.9786,lon:-87.9048,gs:0,alt_baro:'ground'});
      const before=requests.length;
      await api.getFlightStory({data:{q:'UA9919',fresh:true}});
      assert.equal(overlappedTrace,true,'trace acquisition should not wait for PIREP completion');
      const traces=requests.slice(before).filter(url=>url.pathname.includes('trace_'));
      assert.equal(traces.length,6,'same existing three hosts and full/recent requests, no extra acquisition');
      holdPireps=false;
    });

    await t.test('Production retains normal mode even if the Preview selector is present', async () => {
      process.env.VERCEL_ENV = 'production';
      const readCount = statusReads;
      assert.deepEqual(await api.getFlightDataMode(), { mode: 'normal', session: null });
      assert.equal(statusReads, readCount);
      process.env.VERCEL_ENV = 'preview';
    });
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow; console.info = realInfo;
    delete globalThis.__fr24ParityStoryFixture;
    for (const key of envKeys) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
