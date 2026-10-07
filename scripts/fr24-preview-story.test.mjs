import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

test('FR24-only story stays isolated from every other live provider and old story state', async t => {
  const directory = await mkdtemp(resolve('node_modules/.fr24-preview-story-'));
  const realFetch = globalThis.fetch, realNow = Date.now;
  const envKeys = ['VERCEL_ENV', 'FR24_PREVIEW_MODE', 'FR24_PREVIEW_ENABLED', 'FR24_API_TOKEN',
    'FR24_ENABLE_TRACKS', 'FR24_ENABLE_SUMMARY', 'FLIGHTAWARE_PAID_API_ENABLED', 'FLIGHTAWARE_AEROAPI_KEY',
    'FR24_PREVIEW_SESSION_ID', 'FR24_PREVIEW_CREDIT_CAP', 'FR24_PREVIEW_ATTEMPT_CAP', 'FR24_PREVIEW_EXPIRES_AT'];
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const fixture = { dbCalls: 0, otherAcquisitions: 0 };
  globalThis.__fr24PreviewStoryFixture = fixture;
  let now = Date.parse('2026-10-07T16:00:00Z');
  let calls = [], response = null, statusCode = 200;
  const cache = new Map(), leases = new Map();
  let previewBlocked = false, credits = 0, attempts = 0;
  try {
    await build({ configFile: false, logLevel: 'silent', plugins: [{
      name: 'offline-fr24-story-boundaries', enforce: 'pre',
      resolveId(source) {
        if (source === '@tanstack/react-start') return '\0fr24-preview-server-function';
        if (/(?:^|\/)db(?:\.ts)?$/.test(source)) return '\0fr24-preview-no-database';
        if (/(?:^|\/)adsb-acquisition\.server\.ts$/.test(source)) return '\0fr24-preview-no-adsb';
      },
      load(id) {
        if (id === '\0fr24-preview-server-function') return `export function createServerFn() {
          let validate = x => x; const builder = { validator(fn) { validate = fn; return builder; },
            handler(fn) { return async (arg = {}) => fn({ data: validate(arg.data) }); } }; return builder;
        }`;
        if (id === '\0fr24-preview-no-database') return `export const dbSource = 'neon';
          export async function getSql() { globalThis.__fr24PreviewStoryFixture.dbCalls++;
            throw new Error('Preview story must not read mixed-provider durable state'); }`;
        if (id === '\0fr24-preview-no-adsb') return `export async function acquireFreeAdsb() {
          globalThis.__fr24PreviewStoryFixture.otherAcquisitions++;
          throw new Error('FR24-only story attempted ADS-B or trace acquisition');
        } export async function waitForAdsbViewer(work) { return work; }`;
      },
      transform(code, id) {
        if (id.endsWith('/src/lib/story.server.ts')) return { code: code + `
          export function fixtureSeedNormalStory(query, value) {
            cache.set('story43:' + query, { at: Date.now(), value });
            cache.set('aware:AAL1', { at: Date.now(), value: { ...value.resume, confirmedAt: Date.now() } });
          }`, map: null };
        if (id.endsWith('/src/lib/story.ts')) return { code: code + `
          export { loadFlightStory, loadLiveBoard };
          export { fixtureSeedNormalStory } from './story.server.ts';
          export { loadOfficialFlightData, setFr24GuardForTests } from './official-flight-data.server.ts';
          export { setFr24PreviewSessionGuardForTests } from './fr24-preview-session.server.ts';`, map: null };
      },
    }], build: { ssr: resolve('src/lib/story.ts'), outDir: directory,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    process.env.VERCEL_ENV = 'preview';
    process.env.FR24_PREVIEW_MODE = 'fr24-only';
    process.env.FR24_PREVIEW_ENABLED = '1';
    process.env.FR24_API_TOKEN = 'offline-fixture-only';
    process.env.FR24_PREVIEW_SESSION_ID = 'fixture-session';
    process.env.FR24_PREVIEW_CREDIT_CAP = '800';
    process.env.FR24_PREVIEW_ATTEMPT_CAP = '100';
    process.env.FR24_PREVIEW_EXPIRES_AT = '2026-10-07T18:00:00Z';
    // Even configured alternate providers and optional FR24 enrichments must
    // not activate outside the one permitted live-position acquisition.
    process.env.FR24_ENABLE_TRACKS = '1';
    process.env.FR24_ENABLE_SUMMARY = '1';
    process.env.FLIGHTAWARE_PAID_API_ENABLED = '1';
    process.env.FLIGHTAWARE_AEROAPI_KEY = 'offline-fixture-only';
    Date.now = () => now;
    globalThis.fetch = async input => {
      const url = new URL(String(input)); calls.push(url);
      assert.equal(url.hostname, 'fr24api.flightradar24.com', 'no non-FR24 network call is permitted');
      assert.equal(url.pathname, '/api/live/flight-positions/full');
      assert.equal(url.searchParams.get('limit'), '1');
      if (statusCode !== 200) return Response.json({ error: 'offline fixture provider failure' }, { status: statusCode });
      return Response.json({ data: response ? [response] : [] });
    };
    const api = await import(pathToFileURL(join(directory, 'story.mjs')).href);
    api.setFr24GuardForTests({
      usage: async () => { throw new Error('Preview story must not read normal usage'); },
      reserve: async maximum => ({ day: '2026-10-07', maximum, cap: 1000 }), finish: async () => {},
      cached: async (key, ttl, at = Date.now()) => {
        const hit = cache.get(key); return hit && at - hit.at <= ttl ? { value: hit.value, ageMs: at - hit.at } : null;
      },
      acquire: async (key, _endpoint, _ident, token) => { leases.set(key, token); return true; },
      store: async (key, token, value, at = Date.now()) => {
        assert.equal(leases.get(key), token); cache.set(key, { value, at }); leases.delete(key);
      },
      release: async key => { leases.delete(key); },
    });
    const sessionStatus = () => ({ mode: 'fr24-only', modeEnabled: true, enabled: true,
      state: previewBlocked ? 'stopped_402' : 'ready', reason: previewBlocked ? 'stopped_402' : null,
      blocked: previewBlocked, sessionId: 'fixture-session', creditCap: 800, attemptCap: 100,
      expiresAt: now + 60_000, creditsConsumed: credits, creditsReserved: credits, attempts,
      remainingCredits: 800 - credits, remainingAttempts: 100 - attempts, stopped402: previewBlocked,
      inFlight: false, lastStatusCode: previewBlocked ? 402 : null, lastErrorKind: previewBlocked ? '402' : null });
    api.setFr24PreviewSessionGuardForTests({ status: async () => sessionStatus(),
      reserve: async maximum => {
        if (previewBlocked) return null; credits += maximum; attempts++;
        return { reservationId: 'fixture-' + attempts, sessionId: 'fixture-session', maximum, expiresAt: now + 60_000 };
      },
      canDispatch: async () => !previewBlocked,
      finish: async (_reservation, result) => { if (result.statusCode === 402) previewBlocked = true; },
    });
    function reset(overrides = {}) {
      now += 40_000; calls = []; cache.clear(); statusCode = 200; previewBlocked = false;
      response = { fr24_id: 'fr24-fixture-leg', flight: 'AA1', callsign: 'AAL1', reg: 'N123AA',
        hex: 'abc123', type: 'B738', orig_iata: 'MCO', orig_icao: 'KMCO', dest_iata: 'TPA', dest_icao: 'KTPA',
        lat: 28.4294, lon: -81.309, alt: 0, gspeed: 12, track: 92, on_ground: true,
        timestamp: now / 1000 - 2, ...overrides };
    }

    await t.test('mode capability is safe before any paid request', async () => {
      const mode = await api.getFlightDataMode();
      assert.equal(mode.mode, 'fr24-only'); assert.equal(mode.session.state, 'ready');
      assert.equal(calls.length, 0); assert.equal(attempts, 0);
      process.env.VERCEL_ENV = 'production';
      assert.deepEqual(await api.getFlightDataMode(), { mode: 'normal', session: null });
      process.env.VERCEL_ENV = 'preview';
    });

    await t.test('genuine FR24 identity, route, and surface coordinates survive unchanged', async () => {
      reset();
      const story = await api.getFlightStory({ data: { q: 'AA1' } });
      assert.equal(story.providers.previewMode, 'fr24-only');
      assert.equal(story.providers.scheduleSource, 'fr24_live');
      assert.equal(story.providers.chosenPosition, 'fr24');
      assert.equal(story.providers.status.flightaware, 'DISABLED');
      assert.equal(story.providers.flightawarePosition, null); assert.equal(story.providers.adsbPosition, null);
      assert.equal(story.providers.fr24Usage, null);
      assert.equal(story.flightId, response.fr24_id); assert.equal(story.aircraft.registration, response.reg);
      assert.equal(story.origin.iata, 'MCO'); assert.equal(story.dest.iata, 'TPA');
      assert.equal(story.aircraft.lat, response.lat); assert.equal(story.aircraft.lon, response.lon);
      assert.equal(story.aircraft.extrapolated, false);
      assert.equal(story.providers.chosenPositionSeenAt, response.timestamp);
      assert.equal(story.currentStage, 'taxi');
      assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get('flights'), 'AA1');
      assert.equal(fixture.dbCalls, 0); assert.equal(fixture.otherAcquisitions, 0);
    });

    await t.test('warm normal stories, saved resume and provider identity hints cannot enter preview', async () => {
      reset({ gspeed: 0 });
      const resume = { version: 1, callsign: 'AAL1', confirmedAt: now,
        originIata: 'ORD', originIcao: 'KORD', destIata: 'SEA', destIcao: 'KSEA',
        gateOut: { scheduled: now / 1000 - 600, actual: now / 1000 - 500, estimated: null },
        takeoff: { actual: now / 1000 - 400, scheduled: null, estimated: null },
        landing: { actual: null, scheduled: now / 1000 + 4000, estimated: null },
        gateIn: { actual: null, scheduled: now / 1000 + 4500, estimated: null },
        tail: 'NWRONG', hex: 'dddddd', departureStage: 'taxi', stateKey: 'mixed-provider-old-leg' };
      const normalCachedStory = { providers: { chosenPosition: 'adsb' }, aircraft: { lat: 47, lon: -122 }, resume };
      api.fixtureSeedNormalStory('AA1', normalCachedStory);
      process.env.VERCEL_ENV = 'production';
      assert.equal(await api.loadFlightStory('AA1', {}), normalCachedStory, 'Production preserves the existing cache path');
      assert.equal(calls.length, 0);
      process.env.VERCEL_ENV = 'preview';
      const story = await api.getFlightStory({ data: { q: 'AA1', resume } });
      assert.equal(story.origin.iata, 'MCO'); assert.equal(story.dest.iata, 'TPA');
      assert.equal(story.currentStage, 'origin_gate'); assert.equal(story.times.takeoffUnix, null);
      assert.equal(story.resume, undefined); assert.equal(story.stateKey, null);
      assert.equal(story.aircraft.lat, response.lat);
      reset();
      const official = await api.loadOfficialFlightData('AAL1', { fr24FlightNumber: 'AA1',
        fr24Registration: 'NWRONG', fr24OperatingCallsign: 'WRONG1', fr24OriginIata: 'ORD', fr24DestIata: 'SEA' });
      assert.equal(official.fr24.registration, 'N123AA');
      assert.equal(calls[0].searchParams.get('registrations'), null);
      assert.equal(calls[0].searchParams.get('airports'), null);
    });

    await t.test('absolute observation age is never reset on shared cache hits', async () => {
      reset({ gspeed: 0 });
      const observedAt = response.timestamp;
      const first = await api.loadFlightStory('AA1', {});
      now += 15_000;
      const second = await api.loadFlightStory('AA1', {});
      assert.equal(calls.length, 1); assert.equal(second.providers.chosenPositionSeenAt, observedAt);
      assert.equal(second.providers.chosenPositionAgeSec, first.providers.chosenPositionAgeSec + 15);
    });

    await t.test('fresh airborne telemetry stays exact without a synthetic takeoff time', async () => {
      reset({ lat: 28.2, lon: -81.8, alt: 18000, gspeed: 390, on_ground: false });
      const story = await api.getFlightStory({ data: { q: 'AA1' } });
      assert.equal(story.live, true); assert.equal(story.aircraft.onGround, false);
      assert.equal(story.aircraft.lat, 28.2); assert.equal(story.aircraft.lon, -81.8);
      assert.equal(story.aircraft.altFt, 18000); assert.equal(story.times.airborne, true);
      assert.equal(story.times.takeoffUnix, null); assert.equal(story.confirmedTakeoff, null);
      assert.ok(['ride', 'arrival', 'final_approach'].includes(story.currentStage));
      assert.equal(calls.length, 1);
    });

    await t.test('stale surface and airborne fixes are not reused or manufactured', async () => {
      for (const [ground, age] of [[true, 31], [false, 91]]) {
        reset({ on_ground: ground, alt: ground ? 0 : 20000 });
        response.timestamp = now / 1000 - age;
        const story = await api.loadFlightStory('AA1', { resume: { aircraft: { lat: 1, lon: 2 } } });
        assert.equal(story.live, false); assert.equal(story.aircraft, null);
        assert.equal(story.providers.chosenPosition, null); assert.equal(story.providers.chosenPositionSeenAt, null);
        assert.equal(story.providers.fr24Position.seenAt, response.timestamp);
        assert.equal(calls.length, 1);
      }
    });

    await t.test('no match, wrong identity, missing route, malformed position and HTTP errors never recover from another source', async () => {
      for (const kind of ['none', 'identity', 'route', 'coords', 'timestamp', 'error']) {
        reset();
        if (kind === 'none') response = null;
        if (kind === 'identity') response.flight = 'AA9';
        if (kind === 'route') { delete response.orig_iata; delete response.orig_icao; }
        if (kind === 'coords') response.lat = null;
        if (kind === 'timestamp') delete response.timestamp;
        if (kind === 'error') statusCode = 503;
        await assert.rejects(api.loadFlightStory('AA1', { resume: { originIata: 'ORD', destIata: 'SEA' } }), /FR24_ONLY/);
        assert.equal(calls.length, 1, kind);
      }
      assert.equal(fixture.dbCalls, 0); assert.equal(fixture.otherAcquisitions, 0);
    });

    await t.test('disabled and stopped sessions never switch to another provider', async () => {
      reset(); process.env.FR24_PREVIEW_ENABLED = '0';
      await assert.rejects(api.loadFlightStory('AA1', {}), /FR24_ONLY_DISABLED/);
      assert.equal(calls.length, 0);
      process.env.FR24_PREVIEW_ENABLED = '1'; previewBlocked = true;
      await assert.rejects(api.loadFlightStory('AA1', {}), /FR24_ONLY/);
      assert.equal(calls.length, 0);
      assert.deepEqual(await api.loadLiveBoard(), [], 'live board must not independently acquire ADS-B');
      assert.equal(fixture.otherAcquisitions, 0); assert.equal(fixture.dbCalls, 0);
    });
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    delete globalThis.__fr24PreviewStoryFixture;
    for (const key of envKeys) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
