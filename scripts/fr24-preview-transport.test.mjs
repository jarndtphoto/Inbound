import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFr24Flight, loadFr24FlightByRegistration, loadFr24FlightByNumber,
  loadFr24FlightByNumberAndRoute, loadFr24RecentArrivalIdentity,
  createFr24Cycle, normalizeFr24Position, fr24Configured,
} from '../src/lib/fr24.server.ts';
import { createFr24Guard, setFr24GuardForTests } from '../src/lib/fr24-budget.server.ts';
import { createFr24PreviewSessionGuard, setFr24PreviewSessionGuardForTests } from '../src/lib/fr24-preview-session.server.ts';

const previewModes = ['fr24-only', 'production-parity'];

async function setup(fn, { mode = 'fr24-only', creditCap = 16 } = {}) {
  const env = { ...process.env }, original = globalThis.fetch;
  Object.assign(process.env, {
    VERCEL_ENV: 'preview', FR24_PREVIEW_MODE: mode, FR24_PREVIEW_ENABLED: '1',
    FR24_API_TOKEN: 'fixture-secret', FR24_PREVIEW_SESSION_ID: 'fixture-one',
    FR24_PREVIEW_CREDIT_CAP: String(creditCap), FR24_PREVIEW_EXPIRES_AT: '2099-01-01T00:00:00Z',
  });
  for (const key of ['FR24_ENABLE_TRACKS', 'FR24_ENABLE_SUMMARY', 'FR24_PREVIEW_ATTEMPT_CAP']) delete process.env[key];
  let attempts = 0, spent = 0, stopped = false, daily = 0, previewChecks = 0;
  let dispatch = true, dailyAllowed = true, cacheEnabled = false;
  const calls = [], keys = [], maxima = [], cache = new Map();
  setFr24PreviewSessionGuardForTests({
    status: async () => {
      previewChecks++;
      return { blocked: stopped || spent >= creditCap, state: stopped ? 'stopped_402' : spent >= creditCap ? 'budget_exhausted' : 'ready' };
    },
    reserve: async maximum => {
      if (stopped || spent + maximum > creditCap) return null;
      attempts++;
      spent += maximum;
      maxima.push(maximum);
      return { reservationId: String(attempts), sessionId: 'fixture-one', maximum, expiresAt: Date.parse('2099-01-01T00:00:00Z') };
    },
    finish: async (_reservation, details) => { if (details.statusCode === 402) stopped = true; },
    canDispatch: async () => dispatch,
  });
  setFr24GuardForTests({
    cached: async key => { keys.push(key); return cacheEnabled && cache.has(key) ? { value: cache.get(key), ageMs: 0 } : null; },
    acquire: async () => true,
    release: async () => {},
    store: async (key, _token, value) => { if (cacheEnabled) cache.set(key, value); },
    usage: async () => null,
    reserve: async maximum => dailyAllowed ? { day: 'fixture', maximum, cap: 1000 } : null,
    finish: async () => { daily++; },
  });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return Response.json({ data: [{ callsign: 'UAL1036', timestamp: Date.now() / 1000, lat: 41.98, lon: -87.9, alt: 0, reg: 'N1', orig_iata: 'ORD', dest_iata: 'RSW' }] });
  };
  try {
    await fn({
      calls, keys, maxima,
      get attempts() { return attempts; }, get spent() { return spent; },
      get daily() { return daily; }, get previewChecks() { return previewChecks; },
      denyDispatch: () => { dispatch = false; }, denyDaily: () => { dailyAllowed = false; },
      enableCache: () => { cacheEnabled = true; },
      setResponse: response => { globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return response(url); }; },
    });
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    setFr24GuardForTests(createFr24Guard());
    setFr24PreviewSessionGuardForTests(createFr24PreviewSessionGuard());
  }
}

for (const mode of previewModes) {
  test(`${mode} caps all requests across independent cycles and namespaces cache`, () => setup(async h => {
    for (let i = 0; i < 2; i++) assert.ok(await loadFr24Flight('UAL1036', undefined, createFr24Cycle('UA1036')));
    await assert.rejects(loadFr24Flight('UAL1036', undefined, createFr24Cycle('UA1036')), /FR24_PREVIEW/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.spent, 16);
    assert.ok(h.keys.every(key => key.startsWith('preview:fixture-one:')));
    assert.ok(h.calls.every(call => call.opts.redirect === 'error' && call.url.endsWith('limit=1')));
  }, { mode }));

  test(`${mode} daily budget and expired dispatch both prevent network`, () => setup(async h => {
    h.denyDaily();
    await assert.rejects(loadFr24Flight('UAL1036'), /BUDGET/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.spent, 8, 'failed daily approval never refunds the Preview reservation');
  }, { mode }));

  test(`${mode} expired reservation after daily SQL prevents dispatch`, () => setup(async h => {
    h.denyDispatch();
    await assert.rejects(loadFr24Flight('UAL1036'), /PREVIEW_BLOCKED/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.spent, 8);
  }, { mode }));

  test(`${mode} rejects invented observation timestamps and invalid coordinates`, () => setup(async () => {
    assert.equal(normalizeFr24Position({ lat: 41, lon: -87, alt: 0 }), null);
    assert.equal(normalizeFr24Position({ lat: 91, lon: -87, timestamp: Date.now() / 1000 }), null);
  }, { mode }));
}

test('mode changes reuse the same Preview cache and allowance', () => setup(async h => {
  h.enableCache();
  assert.ok(await loadFr24Flight('UAL1036', undefined, createFr24Cycle('UA1036')));
  process.env.FR24_PREVIEW_MODE = 'production-parity';
  assert.ok(await loadFr24Flight('UAL1036', undefined, createFr24Cycle('UA1036')));
  assert.equal(h.calls.length, 1);
  assert.equal(h.attempts, 1);
  assert.equal(h.spent, 8);
  assert.equal(new Set(h.keys).size, 1, 'mode is deliberately absent from the session cache key');
}));

test('402 consumes allowance once and blocks both Preview modes permanently', () => setup(async h => {
  h.setResponse(() => Response.json({ code: 'PAYMENT_REQUIRED', message: 'fixture-secret' }, { status: 402 }));
  await assert.rejects(loadFr24Flight('UAL1036'), /402/);
  for (const mode of ['production-parity', 'fr24-only']) {
    process.env.FR24_PREVIEW_MODE = mode;
    await assert.rejects(loadFr24Flight('UAL1036'), /stopped_402/);
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.attempts, 1);
  assert.equal(h.spent, 8);
}));

test('Preview enabled flag alone cannot bypass missing or invalid session configuration', () => setup(async h => {
  const valid = { ...process.env };
  const invalid = [
    { FR24_PREVIEW_MODE: undefined }, { FR24_PREVIEW_MODE: 'unknown' },
    { FR24_PREVIEW_SESSION_ID: undefined }, { FR24_PREVIEW_CREDIT_CAP: undefined },
    { FR24_PREVIEW_CREDIT_CAP: '0' }, { FR24_PREVIEW_EXPIRES_AT: undefined },
    { FR24_PREVIEW_EXPIRES_AT: 'invalid' }, { FR24_PREVIEW_ENABLED: '0' },
  ];
  for (const mode of previewModes) {
    for (const overrides of invalid) {
      Object.assign(process.env, valid, { FR24_PREVIEW_MODE: mode });
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      assert.equal(fr24Configured(), false, `${mode}: ${JSON.stringify(overrides)}`);
      assert.equal(await loadFr24Flight('UAL1036'), null);
      assert.equal(await loadFr24FlightByRegistration('N1'), null);
      assert.equal(await loadFr24FlightByNumber('UA1036'), null);
      assert.equal(await loadFr24FlightByNumberAndRoute('UA1036', 'ORD', 'RSW'), null);
      assert.equal(await loadFr24RecentArrivalIdentity('UA1036', 'ORD', 'RSW'), null);
    }
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.attempts, 0);
  assert.equal(h.keys.length, 0, 'invalid Preview cannot use Production cache or budget paths');
}));

test('production parity guards existing summary and track endpoints by their full worst-case costs', () => setup(async h => {
  process.env.FR24_ENABLE_TRACKS = '1';
  process.env.FR24_ENABLE_SUMMARY = '1';
  h.setResponse(url => {
    if (url.includes('/flight-tracks?')) return Response.json({ tracks: [] });
    if (url.includes('/flight-summary/')) return Response.json({ data: [] });
    return Response.json({ data: [{ fr24_id: 'fixture-flight', callsign: 'UAL1036', timestamp: Date.now() / 1000, lat: 41.98, lon: -87.9, alt: 0 }] });
  });
  assert.ok(await loadFr24Flight('UAL1036'));
  assert.equal(await loadFr24RecentArrivalIdentity('UA1036', 'ORD', 'RSW'), null);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.maxima, [8, 40, 6, 15]);
  assert.equal(h.spent, 69);
  assert.equal(h.attempts, 4);
  assert.ok(h.calls.every(call => call.opts.redirect === 'error'));
  assert.ok(h.keys.every(key => key.startsWith('preview:fixture-one:')));
}, { mode: 'production-parity', creditCap: 400 }));

test('FR24-only retains its live-position-only endpoint restriction', () => setup(async h => {
  assert.equal(await loadFr24RecentArrivalIdentity('UA1036', 'ORD', 'RSW'), null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.attempts, 0);
  assert.equal(h.keys.length, 0);
}));

test('Production retains its normal cache, daily guard and transport without Preview configuration', () => setup(async h => {
  process.env.VERCEL_ENV = 'production';
  for (const key of Object.keys(process.env)) if (key.startsWith('FR24_PREVIEW_')) delete process.env[key];
  assert.equal(fr24Configured(), true);
  for (let i = 0; i < 3; i++) assert.ok(await loadFr24Flight('UAL1036', undefined, createFr24Cycle('UA1036')));
  assert.equal(h.calls.length, 3);
  assert.equal(h.daily, 3);
  assert.equal(h.previewChecks, 0);
  assert.equal(h.attempts, 0);
  assert.ok(h.keys.every(key => key === 'live:UA1036'));
  assert.ok(h.calls.every(call => call.opts.redirect === 'follow'));
  assert.ok(normalizeFr24Position({ lat: 41, lon: -87, alt: 0 }), 'Production normalization remains unchanged');
  h.denyDaily();
  await assert.rejects(loadFr24Flight('UAL1036'), /BUDGET/);
  assert.equal(h.calls.length, 3, 'Production still obeys the ordinary daily cap');
}));

test('FR24-only mode closes free live and trace acquisition before cache or SQL', () => setup(async () => {
  const { createAdsbAcquirer } = await import('../src/lib/adsb-acquisition.server.ts');
  const store = new Proxy({}, { get() { throw Error('must not access free-provider cache'); } });
  const acquire = createAdsbAcquirer(store, { fetch: async () => { throw Error('must not fetch'); } });
  for (const [provider, url] of [
    ['fi', 'https://opendata.adsb.fi/api/v2/hex/a12345'],
    ['trace-fi', 'https://globe.adsb.fi/data/traces/45/trace_recent_a12345.json'],
  ]) {
    const result = await acquire({ provider, url });
    assert.equal(result.data, null);
    assert.equal(result.status, 'unavailable');
  }
}));
