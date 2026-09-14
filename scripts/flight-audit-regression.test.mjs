import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Match the app's extensionless TypeScript imports in the Node test runner.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
    try { return nextResolve(specifier + '.ts', context); } catch {}
  }
  return nextResolve(specifier, context);
}});
const { loadFlightStory, motionFromTrace, currentStageOf, finalApproachEvidence, isFinalApproach, postLandingState, fetchAwarePage, pickTaxi, canonicalLiveDisplayPath } = await import('../src/lib/story.server.ts');
const { routeWeatherEvents, weatherEventMarker } = await import('../src/lib/weather-events.ts');
const { rideOutlook, RideOutlookText, nextStep } = await import('../src/lib/traveler.ts');
const { WeatherEventMarker } = await import('../src/components/weather-event-marker.ts');
const { passengerWeatherCopy } = await import('../src/lib/weather-card-copy.ts');
const { WeatherEventHeadline, WeatherEventBody, WeatherPreviewLabel } = await import('../src/components/weather-event-copy.ts');

describe('passenger weather presentation', () => {
  const appSource = readFileSync(new URL('../src/components/filed-app.tsx', import.meta.url), 'utf8');
  const mapSource = readFileSync(new URL('../src/components/route-map.tsx', import.meta.url), 'utf8');

  it('does not use numbered weather events as passenger titles', () => {
    assert.doesNotMatch(appSource, /Weather event \{i \+ 1\}/);
    assert.doesNotMatch(mapSource, /WEATHER EVENT/);
  });

  it('uses experience-based weather titles and impact copy', () => {
    const copySource = readFileSync(new URL('../src/lib/weather-card-copy.ts', import.meta.url), 'utf8');
    assert.match(copySource, /Bumpy stretch ahead/);
    assert.match(copySource, /Thunderstorms near the route/);
    assert.match(copySource, /Possible light bumps/);
    assert.match(copySource, /Clouds may limit the view outside/);
  });

  it('translates aviation products into passenger source labels', () => {
    assert.match(appSource, /Reported by another aircraft/);
    assert.match(appSource, /Official aviation weather alert/);
    assert.match(appSource, /Aviation weather advisory/);
    assert.match(appSource, /Air traffic weather advisory/);
    assert.match(appSource, /Thunderstorm forecast/);
    assert.match(appSource, /Current airport weather/);
    assert.match(appSource, /Airport forecast/);
  });

  it('retains internal marker numbering for map association', () => {
    assert.match(appSource, /eventNumber: i \+ 1/);
    assert.match(mapSource, /eventNumber: number/);
  });
});

describe('zoom-stable route presentation', () => {
  const source = readFileSync(new URL('../src/components/route-map.tsx', import.meta.url), 'utf8');

  it('keeps every route, flown-track, projected, outline, and weather stroke screen-sized', () => {
    const strokes = source.split('\n').filter(line => line.includes('data-route-stroke='));
    assert.ok(strokes.length >= 3, 'route stroke elements are explicitly identified');
    for (const stroke of strokes) assert.match(stroke, /vectorEffect="non-scaling-stroke"/);
  });

  it('counter-scales route decorations and the aircraft inside the zoom group', () => {
    assert.match(source, /route-fix-marker[\s\S]{0,300}scale\(\$\{1 \/ zoom\.s\}\)|scale\(\$\{1 \/ zoom\.s\}\)[\s\S]{0,300}route-fix-marker/);
    assert.match(source, /WeatherEventMarker[^>]+inverseScale=\{1 \/ zoom\.s\}/);
    assert.match(source, /hasFix[^>]+scale\(\$\{1 \/ zoom\.s\}\)/);
  });
});

describe('weather card copy hierarchy', () => {
  const sample = { lat: 41.8, lon: -87.7, frac: 0.9, distNm: 900, remainingNm: 100,
    etaMin: 47, chop: 'light', cloud: false, convective: false, note: 'Turbulence AIRMET', fix: false };

  it('renders the full passenger headline once and uses a compact preview-map label', () => {
    const copy = passengerWeatherCopy(sample, true, 'Chicago', 'turbulence:light');
    const html = renderToStaticMarkup(createElement('article', null,
      createElement(WeatherEventHeadline, { copy }),
      createElement(WeatherEventBody, { copy }),
      createElement(WeatherPreviewLabel, { label: copy.mapLabel })
    ));
    assert.equal(copy.headline, 'A few light bumps possible near Chicago');
    assert.equal(copy.body, null);
    assert.equal(copy.mapLabel, 'Light bumps near Chicago');
    assert.equal((html.match(/A few light bumps possible near Chicago/g) || []).length, 1);
    assert.match(html, /Light bumps near Chicago/);
  });

  it('keeps compact labels across turbulence, storms, and clouds', () => {
    assert.equal(passengerWeatherCopy({ ...sample, chop: 'moderate' }, false, 'Chicago', 'turbulence:moderate').mapLabel, 'Moderate bumps');
    assert.equal(passengerWeatherCopy({ ...sample, chop: 'smooth', convective: true }, false, 'Chicago', 'convective').mapLabel, 'Thunderstorms');
    assert.equal(passengerWeatherCopy({ ...sample, chop: 'smooth', cloud: true }, true, 'Chicago', 'cloud').mapLabel, 'Low clouds near Chicago');
  });
});

describe('final approach passenger stage', () => {
  const dest = { lat: 0, lon: 0 };
  const origin = { lat: 0, lon: -10 };
  const airborne = { lat: 0, onGround: false, gsKt: 145, altFt: 3000, vertFpm: -700, phase: 'approach', seenSec: 2 };

  it('keeps a descending aircraft 25 NM out in Arrival', () => {
    const live = { ...airborne, lon: -0.4167, altFt: 6500 };
    assert.equal(isFinalApproach(live, dest), false);
    assert.equal(currentStageOf({ live, origin, dest, remainingNm: 25, pushed: true, faAirborne: true }), 'arrival');
  });

  it('shows Final approach at 10 NM when low and descending', () => {
    const live = { ...airborne, lon: -0.1667, altFt: 2800 };
    assert.equal(isFinalApproach(live, dest), true);
    assert.equal(currentStageOf({ live, origin, dest, remainingNm: 10, pushed: true, faAirborne: true }), 'final_approach');
  });

  it('keeps an established aircraft 5 NM out in Final approach', () => {
    const live = { ...airborne, lon: -0.0833, altFt: 1600, vertFpm: -500 };
    assert.equal(currentStageOf({ live, origin, dest, remainingNm: 5, pushed: true, faAirborne: true }), 'final_approach');
  });

  it('allows close-in geometry when vertical rate and phase are missing', () => {
    const live = { lat: 0, lon: -0.10, onGround: false, gsKt: 135, altFt: 2200, vertFpm: null, phase: null, seenSec: 2 };
    assert.equal(isFinalApproach(live, dest), true);
  });

  it('uses heading toward destination as supporting evidence farther out', () => {
    const live = { lat: 0, lon: -0.18, onGround: false, gsKt: 140, altFt: 4500, vertFpm: null, phase: null, track: 90, seenSec: 2 };
    const evidence = finalApproachEvidence(live, dest);
    assert.ok(evidence.headingDelta <= 1);
    assert.equal(evidence.result, true);
  });

  it('rejects obviously high or implausibly slow close-in aircraft', () => {
    assert.equal(isFinalApproach({ lat: 0, lon: -0.08, onGround: false, gsKt: 140, altFt: 12000 }, dest), false);
    assert.equal(isFinalApproach({ lat: 0, lon: -0.08, onGround: false, gsKt: 20, altFt: 1800 }, dest), false);
  });

  it('transitions touchdown to Landed/rollout', () => {
    const live = { lat: 0, lon: -0.005, onGround: true, gsKt: 120, altFt: 0, seenSec: 1 };
    assert.equal(currentStageOf({ live, origin, dest, remainingNm: 0, ourLanded: true, parkedAtGate: false }), 'arrival');
  });

  it('does not show Final approach while high or far away', () => {
    assert.equal(isFinalApproach({ ...airborne, lon: -0.10, altFt: 14000 }, dest), false);
    assert.equal(isFinalApproach({ ...airborne, lon: -0.30, altFt: 2500 }, dest), false);
  });

  it('logs final-approach evidence for live validation', () => {
    const source = readFileSync(new URL('../src/lib/story.server.ts', import.meta.url), 'utf8');
    assert.match(source, /headingToDestinationDelta/);
    assert.match(source, /isFinalApproach: isFinalApproach/);
    assert.match(source, /verticalRateFpm/);
  });

  it('renders Final approach as a first-class passenger stage', () => {
    const source = readFileSync(new URL('../src/components/filed-app.tsx', import.meta.url), 'utf8');
    assert.match(source, /\{ id: "final_approach", label: "Final approach" \}/);
    assert.match(source, /story\.currentStage === "final_approach"/);
  });
});

describe('post-landing passenger stage', () => {
  const dest = { lat: 40.6925, lon: -74.1687 };
  const surface = { lat: 40.691, lon: -74.167, onGround: true, seenSec: 4 };

  it('keeps a fresh 120 kt touchdown as Landed/rollout', () => {
    const live = { ...surface, gsKt: 120 };
    assert.equal(postLandingState({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'landed');
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'arrival');
  });

  it('makes fresh 18 kt ground movement a first-class Taxiing in stage', () => {
    const live = { ...surface, gsKt: 18 };
    assert.equal(postLandingState({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'taxi_in');
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'taxi_in');
  });

  it('makes fresh 35 kt post-rollout movement Taxiing in', () => {
    const live = { ...surface, gsKt: 35 };
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'taxi_in');
  });

  it('retains Taxiing in when the surface position disappears', () => {
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live: null }), 'taxi_in');
  });

  it('retains Taxiing in with a stale surface fix', () => {
    const live = { ...surface, gsKt: 18, seenSec: 180 };
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'taxi_in');
  });

  it('never marks a moving aircraft At gate without gate-in', () => {
    const live = { ...surface, gsKt: 9 };
    assert.notEqual(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: false, dest, live }), 'gate');
  });

  it('marks confirmed gate-in At gate', () => {
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: 1_000, parkedAtGate: false, dest, live: { ...surface, gsKt: 8 } }), 'gate');
  });

  it('marks robust stationary/parked detection At gate', () => {
    assert.equal(currentStageOf({ ourLanded: true, gateInActual: null, parkedAtGate: true, dest, live: { ...surface, gsKt: 0 } }), 'gate');
  });

  it('renders Taxiing in as the actual passenger stage', () => {
    const source = readFileSync(new URL('../src/components/filed-app.tsx', import.meta.url), 'utf8');
    assert.match(source, /\{ id: "taxi_in", label: "Taxiing in" \}/);
    assert.match(source, /story\.currentStage === "taxi_in"/);
  });
});

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
    now += 65000;
    record.gateDepartureTimes.actual = now / 1000 - 10;
    assert.equal((await load()).times.pushed, false, 'a fresh fix at the previously observed stand rejects premature gate-out');
    const beforeMovement = traceRequests;
    now += 5000;
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

  it('UA218: a canonical inbound history redirect does not put airborne UA219 at the gate', async (t) => {
    const record = structuredClone(JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8')));
    record.ident = 'UAL218';
    record.iataIdent = 'UA218';
    record.flightStatus = 'scheduled';
    record.origin = { ...record.origin, iata: 'HNL', icao: 'PHNL', coord: [-157.9224, 21.3187], gate: 'G3' };
    record.destination = { ...record.destination, iata: 'ORD', icao: 'KORD', coord: [-87.9048, 41.9786], gate: 'C18' };
    record.aircraft = { type: 'B789', tail: null };
    record.track = null;
    record.coord = null;
    record.gateDepartureTimes = { scheduled: 1789264800, estimated: 1789264800, actual: null };
    record.takeoffTimes = { scheduled: 1789266000, estimated: 1789266000, actual: null };
    record.landingTimes = { scheduled: 1789305600, estimated: 1789305600, actual: null };
    record.gateArrivalTimes = { scheduled: 1789306200, estimated: 1789306200, actual: null };
    record.inboundFlight = { flightId: 'UAL219-1789190000-airline-0001' };
    t.mock.method(Date, 'now', () => 1789257600000);
    t.mock.method(globalThis, 'fetch', async (url) => {
      const u = String(url);
      if (u.includes('/live/flight/id/UAL219-')) {
        return new Response(null, {
          status: 302,
          headers: { location: '/live/flight/UAL219/history/20260912/1430Z/KORD/PHNL' },
        });
      }
      if (u.startsWith('https://www.flightaware.com/live/flight/')) {
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      }
      return new Response(JSON.stringify({
        ac: [{
          hex: 'a21900', flight: 'UAL219', r: 'N219UA', t: 'B78X',
          lat: 21.62, lon: -157.65, gs: 430, alt_baro: 18000, seen_pos: 0,
        }],
        features: [],
      }), { headers: { 'content-type': 'application/json' } });
    });
    const story = await loadFlightStory('UA218', { fresh: true });
    assert.equal(story.inbound.status, 'airborne');
    assert.equal(story.inbound.watch[0]?.iata, 'UA 219');
    assert.equal(story.currentStage, 'inbound');
  });
});

describe('MDW departure surface-stage replays', () => {
  const now = 1789231976;
  for (const [flight, speed, status, gateActual, takeoffActual, expectedStage, expectedPush] of [
    ['WN363', 0, 'scheduled', now - 90, null, 'push', true],
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
      let groundTraceRequests = 0;
      t.mock.method(Date, 'now', () => now * 1000);
      t.mock.method(globalThis, 'fetch', async (url) => {
        if (String(url).includes('/trace_recent_')) groundTraceRequests++;
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
      if (flight === 'WN363') {
        assert.ok(groundTraceRequests > 0, 'reported gate-out must not suppress movement checks');
        assert.equal(story.times.pushKind, 'actual', 'a stopped aircraft at the airport center does not establish a gate position');
      }
    });
  }
});


describe('ground trace freshness', () => {
  it('accepts recent movement but rejects stale and future movement', (t) => {
    const now = 1789231976;
    t.mock.method(Date, 'now', () => now * 1000);
    const origin = { lat: 41.9786, lon: -87.9048 };
    const point = (age, offset) => ({ t: now - age, lat: origin.lat, lon: origin.lon + offset, gs: 9, alt: 0, ground: true });
    assert.equal(motionFromTrace([point(20, 0), point(2, .003)], origin).taxiing, true);
    assert.deepEqual(motionFromTrace([point(90, 0), point(60, .003)], origin), { pushed: false, taxiing: false, flying: false });
    assert.deepEqual(motionFromTrace([point(-10, 0), point(-20, .003)], origin), { pushed: false, taxiing: false, flying: false });
  });
});


describe('AA2554 inbound/main-stage consistency', () => {
  it('does not alternate Gate and Inbound as surface positions appear and disappear', () => {
    const origin = { lat: 41.9786, lon: -87.9048 };
    const args = { origin, dest: { lat: 33.43, lon: -112.01 }, remainingNm: 1300,
      inboundStatus: 'at_field', pushed: false, faAirborne: false };
    const live = { ...origin, onGround: true, gsKt: 0, phase: 'parked' };
    for (const fix of [live, null, live]) {
      assert.equal(currentStageOf({ ...args, live: fix }), 'inbound');
    }
    assert.equal(currentStageOf({ ...args, live, inboundStatus: 'complete' }), 'origin_gate');
    assert.equal(currentStageOf({ ...args, live, pushed: true }), 'push');
    assert.equal(currentStageOf({ ...args, live, pushed: true, taxiHint: true }), 'taxi');
  });
});


describe('inbound canonical history details', () => {
  it('reads actual gate arrival from the redirected dated flight', async (t) => {
    const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
    record.gateArrivalTimes.actual = 1789231900;
    const history = 'https://www.flightaware.com/live/flight/UAL1532/history/20260912/1200Z/KORD/KMSY';
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      requests.push(String(url));
      if (String(url).includes('/flight/id/')) return new Response(null, { status: 302, headers: { location: history } });
      return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
    });
    const result = await fetchAwarePage('https://www.flightaware.com/live/flight/id/UAL1532-test', 'UAL1532', false, 'manual');
    assert.equal(result.gateIn.actual, 1789231900);
    assert.equal(requests[1], history);
    assert.equal(requests.length, 2);
  });
});


describe('taxi duration consistency', () => {
  it('uses current push and takeoff estimates instead of a generic 25 minutes', () => {
    assert.deepEqual(pickTaxi({ estimated: 10000 }, { estimated: 10600 }, 25, 25), { min: 10, kind: 'posted' });
    assert.deepEqual(pickTaxi({ actual: 10000 }, { estimated: 10900 }, 25, 25), { min: 15, kind: 'posted' });
    assert.deepEqual(pickTaxi({ actual: 10000 }, { actual: 11200 }, 25, 25), { min: 20, kind: 'measured' });
    assert.equal(pickTaxi({}, {}, 25, 20).min, 25);
  });
});


describe('first-class pushback and taxi-out stages', () => {
  const origin = { lat: 41.9786, lon: -87.9048 };
  const base = { origin, dest: { lat: 33.43, lon: -112.01 }, remainingNm: 1300,
    inboundStatus: 'complete', faAirborne: false, taxiHint: false, distPark: 0 };

  it('keeps a parked 0 kt aircraft At gate', () => {
    const live = { ...origin, onGround: true, gsKt: 0, seenSec: 1 };
    assert.equal(currentStageOf({ ...base, live, pushed: false }), 'origin_gate');
  });

  it('shows first 2–5 kt movement as Pushback', () => {
    const live = { ...origin, onGround: true, gsKt: 3, seenSec: 1 };
    assert.equal(currentStageOf({ ...base, live, pushed: true, distPark: 0.04 }), 'push');
  });

  it('shows sustained 8–20 kt movement as Taxiing out', () => {
    const live = { ...origin, onGround: true, gsKt: 14, seenSec: 1 };
    assert.equal(currentStageOf({ ...base, live, pushed: true, distPark: 0.12 }), 'taxi');
  });

  it('does not return to At gate through a stale surface gap', () => {
    const stale = { ...origin, onGround: true, gsKt: 3, seenSec: 120 };
    assert.equal(currentStageOf({ ...base, live: stale, pushed: true }), 'push');
    assert.equal(currentStageOf({ ...base, live: null, pushed: true, taxiOutLatched: true }), 'taxi');
  });

  it('keeps Taxiing out monotonic once its latch is established', () => {
    const slow = { ...origin, onGround: true, gsKt: 2, seenSec: 5 };
    assert.equal(currentStageOf({ ...base, live: slow, pushed: true, taxiOutLatched: true }), 'taxi');
    assert.equal(currentStageOf({ ...base, live: { ...slow, gsKt: 0 }, pushed: true, taxiOutLatched: true }), 'taxi');
    assert.equal(currentStageOf({ ...base, live: { ...slow, seenSec: 180 }, pushed: true, taxiOutLatched: true }), 'taxi');
    assert.equal(currentStageOf({ ...base, live: { ...slow, track: 275 }, pushed: true, taxiOutLatched: true }), 'taxi');
    assert.equal(currentStageOf({ ...base, live: null, pushed: true, taxiOutLatched: true }), 'taxi');
  });

  it('preserves the existing takeoff transition', () => {
    const live = { lat: 42.02, lon: -87.80, onGround: false, gsKt: 155, altFt: 1800, seenSec: 1 };
    assert.equal(currentStageOf({ ...base, live, pushed: true, taxiOutLatched: true, ourTakeoffActual: 1_000 }), 'ride');
  });

  it('renders Pushback and Taxiing out as separate passenger stages', () => {
    const source = readFileSync(new URL('../src/components/filed-app.tsx', import.meta.url), 'utf8');
    assert.match(source, /\{ id: "push", label: "Pushback" \}/);
    assert.match(source, /\{ id: "taxi", label: "Taxiing out" \}/);
    assert.match(source, /story\.currentStage === "push"/);
    assert.match(source, /story\.currentStage === "taxi"/);
  });
});

describe('on the move evidence', () => {
  it('UA219: keeps an overdue estimate non-actual, then records only observed/provider push', async (t) => {
    const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
    record.ident = 'UAL9219'; record.iataIdent = 'UA9219'; record.flightId = 'UAL9219-20260914-test';
    record.inboundFlight = null; record.flightStatus = 'scheduled';
    // Public bootstrap regression: an estimate copied into the nominal actual slot.
    record.gateDepartureTimes = { scheduled: 1789230300, estimated: 1789230300, actual: 1789230300 };
    record.takeoffTimes = { scheduled: 1789231800, estimated: 1789232400, actual: null };
    let now = 1789230600000; // 9:30: estimate passed five minutes ago.
    let lat = 41.9786; let lon = -87.9048; let gs = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).startsWith('https://www.flightaware.com/live/flight/')) {
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      }
      return new Response(JSON.stringify({
        ac: [{ hex: 'a92190', flight: 'UAL9219', lat, lon, gs, alt_baro: 'ground', seen_pos: 0 }], features: [],
      }), { headers: { 'content-type': 'application/json' } });
    });

    const parked = await loadFlightStory('UA9219', { fresh: true });
    assert.notEqual(parked.currentStage, 'push');
    assert.notEqual(parked.currentStage, 'taxi');
    assert.equal(parked.times.pushed, false);
    assert.equal(parked.times.pushUnix, 1789230300, 'estimate remains available for display');
    assert.equal(parked.times.pushSource, null, 'estimate is not operational push evidence');

    now = 1789231020000; // 9:37
    lon += 0.0012; gs = 4;
    const observed = await loadFlightStory('UA9219', { fresh: true });
    assert.equal(observed.currentStage, 'push');
    assert.equal(observed.times.pushed, true);
    assert.equal(observed.times.pushUnix, 1789231020);
    assert.equal(observed.times.pushSource, 'live_detected');

    now += 30_000;
    lon += 0.0020; gs = 15;
    const taxiing = await loadFlightStory('UA9219', { fresh: true });
    assert.equal(taxiing.currentStage, 'taxi');
    assert.equal(taxiing.times.pushUnix, 1789231020, 'taxi out retains first live-detected push time');
    assert.equal(taxiing.times.pushSource, 'live_detected');
    assert.match(nextStep(taxiing, taxiing.fetchedAt).body, /Pushback was detected from live movement around/);

    now += 40_000;
    record.gateDepartureTimes.actual = 1789231080; // Provider later reports 9:38.
    const reconciled = await loadFlightStory('UA9219', { fresh: true });
    assert.equal(reconciled.times.pushUnix, 1789231080);
    assert.equal(reconciled.times.pushSource, 'provider_actual');
    assert.notEqual(reconciled.times.pushUnix, 1789230300);
  });

  it('UA3600: never regresses from Taxiing out to Pushback during normal surface changes', async (t) => {
    const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
    record.ident = 'UAL9360'; record.iataIdent = 'UA9360'; record.flightId = 'UAL9360-20260914-test';
    record.inboundFlight = null; record.flightStatus = 'scheduled';
    record.gateDepartureTimes = { scheduled: 1789230000, estimated: 1789230600, actual: null };
    record.takeoffTimes = { scheduled: 1789232400, estimated: 1789233000, actual: null };
    let now = 1789230600000;
    let aircraft = { hex: 'a93600', flight: 'UAL9360', lat: 41.9786, lon: -87.9048, gs: 0, track: 90, alt_baro: 'ground', seen_pos: 0 };
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).startsWith('https://www.flightaware.com/live/flight/')) {
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      }
      return new Response(JSON.stringify({ ac: aircraft ? [aircraft] : [], features: [] }), { headers: { 'content-type': 'application/json' } });
    });
    const load = () => loadFlightStory('UA9360', { fresh: true });

    await load();
    now += 10_000;
    aircraft = { ...aircraft, lon: aircraft.lon + 0.0012, gs: 4 };
    const pushed = await load();
    assert.equal(pushed.currentStage, 'push');
    const observedPushUnix = pushed.times.pushUnix;

    now += 10_000;
    aircraft = { ...aircraft, lon: aircraft.lon + 0.0020, gs: 15 };
    const taxiing = await load();
    assert.equal(taxiing.currentStage, 'taxi');
    assert.equal(taxiing.resume?.departureStage, 'taxi');
    assert.equal(taxiing.resume?.detectedPushUnix, observedPushUnix);
    assert.equal(taxiing.times.pushSource, 'live_detected');
    assert.equal(taxiing.times.pushUnix, observedPushUnix);
    const passenger = nextStep(taxiing, taxiing.fetchedAt);
    assert.match(passenger.body, /Pushback was detected from live movement around/);
    assert.doesNotMatch(passenger.body, /not yet confirmed|never confirmed/i);

    for (const update of [
      { gs: 2, track: 270, seen_pos: 0 },
      { gs: 0, track: 15, seen_pos: 0 },
      { gs: 0, track: 190, seen_pos: 125 },
    ]) {
      now += 10_000;
      aircraft = { ...aircraft, ...update };
      const story = await load();
      assert.equal(story.currentStage, 'taxi');
      assert.equal(story.times.pushed, true);
      assert.equal(story.times.pushUnix, observedPushUnix, 'first live movement timestamp remains latched');
    }
  });

  it('does not advance a stationary aircraft just because scheduled departure passed', async (t) => {
    const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
    record.ident = 'AAL9917'; record.iataIdent = 'AA9917';
    record.inboundFlight = null; record.flightStatus = 'scheduled';
    record.gateDepartureTimes = { scheduled: 1789230000, estimated: 1789230100, actual: null };
    record.takeoffTimes = { scheduled: 1789230600, estimated: 1789230700, actual: null };
    t.mock.method(Date, 'now', () => 1789231976000);
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).startsWith('https://www.flightaware.com/live/flight/')) return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      return new Response(JSON.stringify({ ac: [{ hex: 'a99177', flight: 'AAL9917', lat: 41.99, lon: -87.91, gs: 0, alt_baro: 'ground', seen_pos: 0 }], features: [] }));
    });
    const s = await loadFlightStory('AA9917', { fresh: true });
    assert.equal(s.times.pushed, false);
    assert.notEqual(s.currentStage, 'taxi');
  });
});

it('preserves missing weather feeds as unknown while the flight still loads', async (t) => {
  const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
  record.ident = 'UAL1599'; record.iataIdent = 'UA1599';
  t.mock.method(Date, 'now', () => 1789311976000);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.startsWith('https://www.flightaware.com/live/flight/')) return new Response(`trackpollBootstrap = ${JSON.stringify({flights:{replay:record}})};`);
    if (u.includes('aviationweather.gov')) return new Response('Unavailable', {status:503});
    return new Response(JSON.stringify({ac:[],features:[]}), {headers:{'content-type':'application/json'}});
  });
  const story = await loadFlightStory('UA1599', {fresh:true});
  assert.equal(story.origin.iata, 'ORD');
  assert.ok(story.weatherCoverage.failedSources.includes('Turbulence advisories'));
  assert.ok(story.weatherCoverage.failedSources.includes('Pilot reports'));
});


describe('live reroute display geometry', () => {
  const dest = { lat: 0, lon: 10 };
  const filedPath = Array.from({ length: 11 }, (_, lon) => ({ lat: 0, lon }));
  const flownTrack = [
    { lat: 0, lon: 0 },
    { lat: 0.18, lon: 1 },
    { lat: 0.45, lon: 2 },
    { lat: 0.72, lon: 3 },
    { lat: 0.92, lon: 4 },
    { lat: 1.0, lon: 4.8 }
  ];
  const live = { lat: 1.0, lon: 5, track: 90, onGround: false, extrapolated: false };
  const path = canonicalLiveDisplayPath({ filedPath, flownTrack, live, dest });
  const liveIndex = path.findIndex((p) => Math.abs(p.lat - live.lat) < 1e-9 && Math.abs(p.lon - live.lon) < 1e-9);

  it('uses the actual deviation for the portion behind the aircraft', () => {
    assert.ok(liveIndex >= flownTrack.length - 1);
    assert.ok(path.slice(1, liveIndex).some((p) => p.lat > 0.7));
    assert.ok(path.slice(Math.max(0, liveIndex - 2), liveIndex).every((p) => p.lat > 0.4));
  });

  it('joins actual track naturally to the current aircraft without an obsolete filed-route jump', () => {
    assert.ok(liveIndex > 0);
    const previous = path[liveIndex - 1];
    assert.ok(Math.hypot(previous.lat - live.lat, previous.lon - live.lon) < 0.3);
  });

  it('starts projection at the current aircraft and never selects a segment behind it', () => {
    assert.ok(liveIndex >= 0 && liveIndex < path.length - 1);
    assert.ok(path.slice(liveIndex + 1).every((p) => p.lon >= live.lon));
    assert.deepEqual(path.at(-1), dest);
  });

  it('keeps Route and Weather on the same canonical story samples', () => {
    const mapSource = readFileSync(new URL('../src/components/route-map.tsx', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../src/components/filed-app.tsx', import.meta.url), 'utf8');
    assert.match(mapSource, /const samples = story\.route\.samples/);
    assert.match(appSource, /<RouteMap[\s\S]*story=\{story\}/);
  });

  it('does not evaluate future weather against the abandoned route behind the aircraft', () => {
    const abandonedWeather = { lat: 0, lon: 4 };
    const future = path.slice(liveIndex);
    const closest = Math.min(...future.map((p) => Math.hypot(p.lat - abandonedWeather.lat, p.lon - abandonedWeather.lon)));
    assert.ok(closest > 1);
  });
});


describe('AAL3197 weather entry rendering', () => {
  const sample = (frac, etaMin, chop = 'smooth', extra = {}) => ({
    lat: 40 + frac, lon: -90 + frac, frac, distNm: frac * 1000,
    remainingNm: (1 - frac) * 1000, etaMin, chop, cloud: false,
    convective: false, note: chop === 'smooth' ? null : 'Turbulence AIRMET', fix: false,
    ...extra
  });
  // Deliberately shuffled. Real story samples were verified to have ETA increase
  // from current progress toward destination.
  const samples = [
    sample(0.72, 59, 'moderate'),
    sample(0.40, 0),
    sample(0.60, 47, 'moderate'),
    sample(0.50, 0, 'light'),
    sample(0.78, 65),
    sample(0.66, 53, 'moderate'),
    sample(0.55, 12)
  ];
  const events = routeWeatherEvents(samples, 0.50);
  const event = events.find((candidate) => candidate.key === 'turbulence:moderate');

  it('orders samples in direction of travel and discards points behind progress', () => {
    assert.ok(event);
    assert.equal(event.startFrac, 0.60);
    assert.equal(event.endFrac, 0.72);
    assert.equal(event.startEtaMin, 47);
    assert.equal(event.endEtaMin, 59);
    assert.deepEqual(event.ranges, [{ from: 0.60, to: 0.72 }]);
  });

  it('renders the numbered marker at the affected-range entry coordinate', () => {
    const marker = weatherEventMarker(event);
    assert.deepEqual({ lat: marker.lat, lon: marker.lon }, { lat: event.start.lat, lon: event.start.lon });
    const html = renderToStaticMarkup(createElement(WeatherEventMarker, {
      eventNumber: 2, entry: marker, x: marker.lon, y: marker.lat
    }));
    assert.match(html, new RegExp(`data-entry-lat="${event.start.lat}"`));
    assert.match(html, new RegExp(`data-entry-lon="${event.start.lon}"`));
    assert.match(html, />2<\/text>/);
  });

  it('renders moderate turbulence exactly once and keeps the entry timing', () => {
    const story = {
      route: { progress: 0.50, samples },
      weatherCoverage: { failedSources: [] }
    };
    const text = rideOutlook(story);
    const html = renderToStaticMarkup(createElement(RideOutlookText, { story }));
    assert.equal((text.match(/moderate turbulence/gi) || []).length, 1);
    assert.match(text, /Moderate turbulence is possible in about 47 minutes\./);
    assert.match(text, /^Projected ride is currently choppy\./);
    assert.match(html, /Moderate turbulence is possible in about 47 minutes\./);
  });

  it('does not split one continuous moderate range when storm detail changes', () => {
    const continuous = [
      sample(0.60, 47, 'moderate', { convective: true }),
      sample(0.66, 53, 'moderate', { convective: true }),
      sample(0.72, 59, 'moderate', { convective: false })
    ];
    const [range] = routeWeatherEvents(continuous, 0.50);
    assert.equal(range.startFrac, 0.60);
    assert.equal(range.endFrac, 0.72);
  });
});
