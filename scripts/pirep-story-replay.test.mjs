import { acquisitionFixture } from "./helpers/acquisition-fixture.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { haversineNm } from '../src/lib/geo.ts';
import { sampleAltFt } from '../src/lib/wx-brief.ts';

test('mocked story loader preserves fresh aircraft observations without changing forecast chop', async () => {
  const dir = await mkdtemp(resolve('node_modules/.pirep-story-replay-'));
  const realFetch = globalThis.fetch, realNow = Date.now, realInfo = console.info;
  const envKeys = ['DATABASE_URL', 'FR24_API_TOKEN', 'FLIGHTAWARE_AEROAPI_KEY'];
  const savedEnv = envKeys.map(key => process.env[key]);
  let now = Date.parse('2026-10-04T00:10:00Z'), instance = 0;
  const sec = now / 1000;
  // Synthetic replay: adapt a saved record's shape, then replace flight, times,
  // telemetry and every weather response. No live UA9918 claim/provider calls.
  const record = JSON.parse(readFileSync(new URL('./fixtures/ual1532-2026-09-12.json', import.meta.url), 'utf8'));
  Object.assign(record, { ident: 'UAL9918', iataIdent: 'UA9918', flightId: `UAL9918-${sec - 3600}-airline-fixture`, hexid: 'ac9918',
    flightStatus: 'airborne', coord: null, track: null });
  record.aircraft = { type: 'A320', tail: 'N9918Z' };
  record.gateDepartureTimes = { scheduled: sec - 3800, estimated: sec - 3800, actual: sec - 3800 };
  record.takeoffTimes = { scheduled: sec - 3600, estimated: sec - 3600, actual: sec - 3600 };
  record.landingTimes = { scheduled: sec + 2700, estimated: sec + 2700, actual: null };
  record.gateArrivalTimes = { scheduled: sec + 3000, estimated: sec + 3000, actual: null };
  const aircraft = { hex: 'ac9918', flight: 'UAL9918', r: 'N9918Z', t: 'A320', lat: 36.1, lon: -89.5,
    gs: 450, alt_baro: 35000, baro_rate: 0, track: 185, seen: 0, seen_pos: 0 };
  let reports = [], advisories = [];
  const requests = [];
  try {
    envKeys.forEach(key => delete process.env[key]);
    Date.now = () => now;
    console.info = () => {};
    globalThis.fetch = async input => {
      const url = new URL(String(input)); requests.push(url.href);
      if (url.hostname === 'www.flightaware.com')
        return new Response(`trackpollBootstrap = ${JSON.stringify({ flights: { replay: record } })};`);
      if (/flightstats/.test(url.hostname)) return new Response(null, { status: 404 });
      if (url.pathname.includes('trace_')) return Response.json({ timestamp: sec - 3600, trace: [
        [0, 41.9769, -87.9081, 5000, 210, 185], [300, 40.6, -88.4, 24000, 420, 185],
        [1500, 38.4, -89.0, 35000, 450, 185], [3600, aircraft.lat, aircraft.lon, 35000, 450, 185],
      ] });
      if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname)) return Response.json({ ac: [aircraft] });
      if (url.hostname === 'aviationweather.gov') {
        if (url.pathname.endsWith('/metar') || url.pathname.endsWith('/taf')) return Response.json([]);
        return Response.json({ features: url.pathname.endsWith('/pirep') ? reports : url.pathname.endsWith('/gairmet') ? advisories : [] });
      }
      if (url.hostname === 'external-api.faa.gov') return Response.json({ Status: [] });
      if (url.hostname === 'api.adsbdb.com') return Response.json({ response: { flightroute: null } });
      throw Error('Unexpected mocked provider: ' + url.href);
    };
    await build({ configFile: false, logLevel: 'silent', plugins: [acquisitionFixture()], build: { ssr: resolve('src/lib/story.server.ts'), outDir: dir,
      rollupOptions: { output: { entryFileNames: 'story.mjs' } } } });
    const cold = () => import(pathToFileURL(join(dir, 'story.mjs')).href + '?case=' + ++instance);
    const baseline = await (await cold()).loadFlightStory('UA9918', { fresh: true });
    assert(baseline.live, 'fixture supplies fresh real-shaped telemetry');
    assert(baseline.route.progress > .2 && baseline.route.progress < .8);
    assert(baseline.route.samples.every(sample => sample.chop === 'smooth'));
    const progress = baseline.route.progress;
    const eligible = baseline.route.samples.filter(sample => sampleAltFt(sample.frac, sample.remainingNm, aircraft.alt_baro) >= 27000);
    const past = eligible.find(sample => sample.frac < progress && haversineNm(sample, aircraft) > 80);
    const ahead = eligible.find(sample => sample.frac > progress && haversineNm(sample, aircraft) > 80);
    assert(past && ahead, `reports have separated past and future matches: progress=${progress} eligible=${JSON.stringify(eligible.map(sample => ({ frac: sample.frac, lat: sample.lat, lon: sample.lon, d: haversineNm(sample, aircraft) })))}`);
    const feature = (id, point, observedAt = now - 30 * 60_000, overrides = {}) => ({ type: 'Feature', id,
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, properties: { obsTime: observedAt / 1000,
        fltLvl: '350', tbInt1: 'MOD', rawOb: 'ORD UA /OV ORD /TM2340 /FL350 /TP A320 /TB MOD', ...overrides } });
    const expiringAt = now - 119 * 60_000;
    reports = [feature(101, past), feature(102, ahead), feature(102, ahead),
      feature(103, ahead), feature(102, ahead, now - 29 * 60_000), feature(104, ahead, expiringAt),
      feature(201, ahead, now - 2 * 3600_000 - 1), feature(202, ahead, now + 3600_000),
      feature(203, ahead, now, { obsTime: undefined }), feature(204, ahead, now, { obsTime: NaN }),
      feature(205, ahead, now, { fltLvl: '010' }), feature(206, { lat: 0, lon: 0 }),
      feature(207, { lat: NaN, lon: ahead.lon }), feature(208, { lat: 91, lon: ahead.lon }),
      feature(209, ahead, now, { obsTime: undefined, receiptTime: '2026-10-04 00:09:00.000Z', rawOb: 'UA /TM2355 /FL350 /TB MOD' })];
    const core = await cold();
    const observed = await core.loadFlightStory('UA9918', { fresh: true });
    const hazards = observed.hazards.filter(hazard => hazard.kind === 'pirep');
    assert.equal(hazards.length, 6, 'IDs/times distinct; exact duplicate, old/future/unusable/geo/alt reports rejected');
    const pastHazard = hazards.find(hazard => hazard.id.startsWith('p-101-'));
    assert.equal(pastHazard.remaining, false);
    assert(hazards.filter(hazard => hazard !== pastHazard).every(hazard => hazard.remaining));
    assert(hazards.every(hazard => hazard.source === 'observed' && Number.isFinite(hazard.observedAt)));
    assert.equal(hazards.find(hazard => hazard.id.startsWith('p-209-')).observedAt, Date.parse('2026-10-03T23:55:00Z'));
    assert.deepEqual(observed.route.samples.map(sample => sample.chop), baseline.route.samples.map(sample => sample.chop));
    for (const sample of observed.route.samples) {
      const identities = (sample.pilotReports ?? []).map(report => `${report.id}:${report.observedAt}`);
      assert.equal(new Set(identities).size, identities.length, 'overlapping response never duplicates sample observations');
      for (const report of sample.pilotReports ?? []) assert(hazards.some(hazard => hazard.id === report.id && hazard.observedAt === report.observedAt));
    }
    assert(observed.route.samples.some(sample => sample.pilotReports?.some(report => report.id.startsWith('p-101-'))));
    assert(observed.route.samples.some(sample => sample.pilotReports?.some(report => report.id.startsWith('p-102-'))));
    assert.equal(observed.comfort.score, baseline.comfort.score, 'observed chop does not penalize forecast grade');
    assert.deepEqual(observed.comfort.reasons, baseline.comfort.reasons, 'reports do not become timed forecast reasons');
    assert.match(observed.comfort.summary, /Smooth now.*moderate bumps reported ahead/);
    assert.doesNotMatch(observed.comfort.summary, /Smooth ride/);
    const countPirepRequests = () => requests.filter(url => url.includes('/api/data/pirep?')).length;
    const beforeExpiryRequests = countPirepRequests();
    now += 90_000;
    const expired = await core.loadFlightStory('UA9918', { fresh: true });
    assert.equal(countPirepRequests(), beforeExpiryRequests, 'PIREP pack is cached while observations are revalidated');
    assert.equal(expired.hazards.filter(hazard => hazard.kind === 'pirep').length, 5);
    assert(expired.route.samples.every(sample => !sample.pilotReports?.some(report => report.observedAt === expiringAt)));
    const coldExpired = await (await cold()).loadFlightStory('UA9918', { fresh: true });
    assert.equal(coldExpired.hazards.filter(hazard => hazard.kind === 'pirep').length, 5);

    advisories = [{ type: 'Feature', properties: { hazard: 'TURB-HI', severity: 'LGT', base: '180', top: '450' },
      geometry: { type: 'Polygon', coordinates: [[[-95, 25], [-80, 25], [-80, 45], [-95, 45], [-95, 25]]] } }];
    const forecastWithReports = await (await cold()).loadFlightStory('UA9918', { fresh: true });
    assert(forecastWithReports.route.samples.some(sample => sample.chop === 'light' && sample.pilotReports?.some(report => report.chop === 'moderate')));
    assert(forecastWithReports.route.samples.every(sample => sample.chop === 'smooth' || sample.chop === 'light'));
    reports = [];
    const forecastOnly = await (await cold()).loadFlightStory('UA9918', { fresh: true });
    assert.deepEqual(forecastWithReports.route.samples.map(sample => sample.chop), forecastOnly.route.samples.map(sample => sample.chop));
    assert.deepEqual(forecastWithReports.comfort.reasons, forecastOnly.comfort.reasons);
    assert.doesNotMatch(forecastWithReports.comfort.summary, /Smooth ride/);
    assert.doesNotMatch(forecastOnly.comfort.summary, /Smooth ride/);
    assert(requests.filter(url => url.includes('/api/data/pirep?')).every(url => /^\?format=geojson&bbox=/.test(new URL(url).search)), 'provider query shape unchanged');
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow; console.info = realInfo;
    envKeys.forEach((key, index) => savedEnv[index] == null ? delete process.env[key] : process.env[key] = savedEnv[index]);
    await rm(dir, { recursive: true, force: true });
  }
});
