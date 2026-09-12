import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Match the app's extensionless TypeScript imports in the Node test runner.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
    try { return nextResolve(specifier + '.ts', context); } catch {}
  }
  return nextResolve(specifier, context);
}});
const { loadFlightStory } = await import('../src/lib/story.server.ts');

describe('September 12 flight audit replay', () => {
  for (const [ident, query, destination, pushed] of [
    ['ual1532', 'UA1532', 'MSY', true],
    ['aal3008', 'AA3008', 'LAX', false],
  ]) {
    it(`${query}: preserves departure facts when no position is available`, async (t) => {
      const record = JSON.parse(readFileSync(new URL(`./fixtures/${ident}-2026-09-12.json`, import.meta.url), 'utf8'));
      t.mock.method(Date, 'now', () => 1789231976000);
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (url) => {
        const u = String(url); requests.push(u);
        if (u.startsWith('https://www.flightaware.com/live/flight/')) {
          return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
        }
        return new Response(JSON.stringify({ ac: [], features: [] }), { headers: { 'content-type': 'application/json' } });
      });
      const story = await loadFlightStory(query, {fresh: true});
      assert.equal(story.origin.iata, 'ORD');
      assert.equal(story.dest.iata, destination);
      assert.equal(story.live, false, 'an estimated route position must not become a live fix');
      assert.equal(story.times.airborne, false);
      assert.equal(story.times.pushed, pushed);
      assert.notEqual(story.times.taxiOutKind, 'measured');
      if (pushed) {
        assert.equal(story.times.pushUnix, 1789231380);
        assert.equal(story.times.pushKind, 'actual');
        assert.equal(story.currentStage, 'push');
      }
      const pireps = requests.filter(u => u.includes('/api/data/pirep?'));
      assert.ok(pireps.length > 0);
      assert.ok(pireps.every(u => u.includes('&bbox=')), 'PIREP queries require a geographic boundary');
    });
  }

  it('keeps pushback registered when a moving aircraft pauses near its stand', async (t) => {
    const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
    record.ident = 'UAL1533';
    record.iataIdent = 'UA1533';
    record.flightStatus = 'scheduled';
    record.gateDepartureTimes.actual = null;
    let now = 1789231976000;
    let lat = 41.9786;
    let lon = -87.9048;
    let gs = 0;
    let traceRequests = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).includes('/data/traces/')) traceRequests += 1;
      if (String(url).startsWith('https://www.flightaware.com/live/flight/')) {
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      }
      return new Response(JSON.stringify({
        ac: [{ hex: 'abc123', flight: 'UAL1533', lat, lon, gs, alt_baro: 'ground', seen_pos: 0 }],
        features: [],
      }), { headers: { 'content-type': 'application/json' } });
    });
    const load = () => loadFlightStory('UA1533', {fresh: true});
    assert.equal((await load()).times.pushed, false, 'stationary aircraft has not left its stand');
    const beforeMovement = traceRequests;
    now += 65000;
    gs = 3;
    lon += 0.0013;
    assert.equal((await load()).times.pushed, true, 'movement registers pushback');
    assert.equal(traceRequests, beforeMovement, 'fresh ground movement should not wait for a trace fetch');
    now += 5000;
    gs = 0;
    lon += 0.0002;
    const paused = await load();
    assert.equal(paused.times.pushed, true, 'taxi pause cannot erase the earlier pushback');
  });

  it('does not invent ORD to LAX when the route feeds have no flight', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ac: [], features: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(loadFlightStory('UA9087', {fresh: true}), /route unavailable/i);
  });

  it('does not use an old flight-number route when the current schedule feed is unavailable', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).startsWith('https://www.flightaware.com/live/flight/')) return new Response('unavailable', { status: 503 });
      if (String(url).includes('api.adsbdb.com/v0/callsign/')) {
        return new Response(JSON.stringify({ response: { flightroute: {
          origin: { iata_code: 'SMF' }, destination: { iata_code: 'SAN' },
        } } }));
      }
      return new Response(JSON.stringify({ ac: [], features: [] }));
    });
    await assert.rejects(loadFlightStory('WN2531', { fresh: true }), /current flight route unavailable/i);
  });

  it('WN2512: ignores a different airborne tail and future actual push/takeoff', async (t) => {
    const record = JSON.parse(readFileSync(new URL('./fixtures/aal3008-2026-09-12.json', import.meta.url), 'utf8'));
    record.ident = 'SWA2512'; record.iataIdent = 'WN2512'; record.flightStatus = 'scheduled';
    record.origin = { ...record.origin, iata: 'MDW', icao: 'KMDW', coord: [-87.7524, 41.7868], gate: 'B3' };
    record.destination = { ...record.destination, iata: 'LGB', icao: 'KLGB', coord: [-118.1516, 33.8177], gate: '3' };
    record.aircraft = { type: 'B38M', tail: 'N8961K' };
    record.waypoints = []; record.track = null; record.coord = null;
    record.gateDepartureTimes = { scheduled: 1789239000, estimated: 1789240320, actual: 1789240320 };
    record.takeoffTimes = { scheduled: 1789240200, estimated: 1789241220, actual: 1789241220 };
    t.mock.method(Date, 'now', () => 1789238100000); // 1:35 PM CDT
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).startsWith('https://www.flightaware.com/live/flight/')) {
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      }
      return new Response(JSON.stringify({
        ac: [{ hex: 'a12345', flight: 'SWA2512', r: 'N14019', t: 'B78X', lat: 38, lon: -100, gs: 451, alt_baro: 34000, seen_pos: 0 }],
        features: [],
      }), { headers: { 'content-type': 'application/json' } });
    });
    const story = await loadFlightStory('WN2512', { fresh: true });
    assert.equal(story.origin.iata, 'MDW');
    assert.equal(story.dest.iata, 'LGB');
    assert.equal(story.times.pushed, false);
    assert.equal(story.times.airborne, false);
    assert.notEqual(story.currentStage, 'ride');
    assert.equal(story.live, false);
    assert.equal(story.aircraft?.registration, 'N8961K');
    assert.equal(story.times.pushKind, 'estimated');
  });
});

describe('MDW departure surface-stage replays', () => {
  const now = 1789231976;
  for (const [flight, speed, status, gateActual, takeoffActual, expectedStage, expectedPush] of [
    ['WN363', 0, 'scheduled', now - 90, null, 'push', false],
    ['WN1035', 14, 'airborne', now - 180, now - 30, 'taxi', true],
    ['WN102', 65, 'airborne', now - 580, now - 480, 'taxi', true],
  ]) {
    it(`${flight}: a fresh ground fix controls the stage`, async (t) => {
      const record = structuredClone(JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8')));
      record.ident = flight;
      record.iataIdent = flight;
      record.flightStatus = status;
      record.origin.iata = 'MDW';
      record.origin.icao = 'KMDW';
      record.origin.coord = [-87.7524, 41.7868];
      record.destination.iata = 'LGB';
      record.destination.icao = 'KLGB';
      record.destination.coord = [-118.1516, 33.8177];
      record.gateDepartureTimes.actual = gateActual;
      record.takeoffTimes.actual = takeoffActual;
      record.inboundFlight = null;
      const raw = {
        hex: flight === 'WN363' ? 'a12363' : flight === 'WN1035' ? 'a11035' : 'a10102',
        flight: flight.replace('WN', 'SWA'),
        lat: 41.7868, lon: -87.7524, alt_baro: 'ground', gs: speed,
        seen: 1, seen_pos: 1,
      };
      t.mock.method(Date, 'now', () => now * 1000);
      t.mock.method(globalThis, 'fetch', async (url) => {
        if (String(url).startsWith('https://www.flightaware.com/live/flight/')) {
          return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
        }
        return new Response(JSON.stringify({ ac: [raw], features: [] }), { headers: { 'content-type': 'application/json' } });
      });
      const story = await loadFlightStory(flight, { fresh: true });
      assert.equal(story.currentStage, expectedStage);
      assert.equal(story.times.airborne, false);
      assert.equal(story.times.pushed, expectedPush);
      assert.equal(story.aircraft.onGround, true);
    });
  }
});
