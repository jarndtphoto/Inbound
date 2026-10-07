import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { acquireFreeAdsb, createAdsbAcquirer, createAdsbAcquisitionStore, retryAfterMs, waitForAdsbViewer } from '../src/lib/adsb-acquisition.server.ts';
import { fuseProviderLists, resetFusion } from '../src/lib/adsb-fusion.ts';

async function fixture(now, seedLegacy) {
  const pg = new PGlite({ parsers: { 20: Number } });
  await pg.waitReady;
  await pg.exec(await readFile(new URL('../migrations/0008_adsb_acquisition.sql', import.meta.url), 'utf8'));
  if (seedLegacy) await seedLegacy(pg);
  await pg.exec(await readFile(new URL('../migrations/0009_adsb_dispatch_spacing.sql', import.meta.url), 'utf8'));
  const sql = async (strings, ...values) => {
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    return (await pg.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pg.query(text, values)).rows;
  return { pg, sql, store: createAdsbAcquisitionStore(async () => sql, { now }) };
}
const request = (suffix = 'abc123', provider = 'fi') => ({ provider,
  url: `https://${provider === 'fi' ? 'opendata.adsb.fi' : 'api.adsb.lol'}/api/v2/hex/${suffix}`, timeoutMs: 4000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function busyFixture({ row, onAcquire, onWait } = {}) {
  const state = { now: 10_000, row, waits: [], claims: 0, fetches: 0, cooldownUntil: 0 };
  const store = {
    read: async () => state.row && structuredClone(state.row),
    acquire: async () => { state.claims++; onAcquire?.(state); return null; },
    cooldown: async () => state.cooldownUntil,
    admissionRetryAt: async () => 20_000,
  };
  const acquire = createAdsbAcquirer(store, {
    now: () => state.now,
    wait: async ms => { state.waits.push(ms); state.now += ms; onWait?.(state, ms); },
    fetch: async () => { state.fetches++; throw new Error('busy requests must not fetch'); },
  });
  return { state, acquire };
}
const cacheRow = (receivedAt, refreshExpiresAt = 0) => ({
  payload: receivedAt == null ? null : { ac: [] }, received_at: receivedAt,
  fresh_until: receivedAt == null ? 0 : receivedAt + 5000,
  retain_until: receivedAt == null ? 0 : receivedAt + 120_000,
  refresh_expires_at: refreshExpiresAt,
});

test('provider-only contention skips cache polling when this key has no live refresher', async () => {
  for (const row of [undefined, cacheRow(1000), cacheRow(1000, 9999)]) {
    const { state, acquire } = busyFixture({ row });
    const result = await acquire(request());
    assert.deepEqual(state.waits, [1300, 1300], 'keep admission retries, omit the futile 1500ms cache wait');
    assert.equal(state.now, 12_600);
    assert.equal(state.claims, 3);
    assert.equal(state.fetches, 0);
    assert.equal(result.status, 'busy');
    assert.equal(result.retryAt, 20_000);
    assert.equal(result.receivedAt, row?.received_at ?? null);
    assert.deepEqual(result.data, row?.payload ?? null);
  }
});

test('a same-key refresh elected during the last failed admission is still shared', async () => {
  const { state, acquire } = busyFixture({
    onAcquire: state => { if (state.claims === 3) state.row = cacheRow(null, state.now + 10_000); },
    onWait: (state, ms) => { if (ms === 100) state.row = cacheRow(state.now); },
  });
  const result = await acquire(request());
  assert.deepEqual(state.waits, [1300, 1300, 100]);
  assert.equal(result.status, 'ok');
  assert.equal(result.cache, true);
  assert.equal(result.receivedAt, 12_700);
  assert.equal(state.fetches, 0);
});

test('a fresh result published during the last failed admission returns without polling', async () => {
  const { state, acquire } = busyFixture({
    onAcquire: state => { if (state.claims === 3) state.row = cacheRow(state.now); },
  });
  const result = await acquire(request());
  assert.deepEqual(state.waits, [1300, 1300]);
  assert.equal(result.status, 'ok');
  assert.equal(result.receivedAt, 12_600);
  assert.equal(result.cache, true);
  assert.equal(state.fetches, 0);
});

test('an active same-key worker keeps bounded polling and shares its eventual result', async () => {
  const { state, acquire } = busyFixture({
    row: cacheRow(null, 20_000),
    onWait: (state, ms) => { if (ms === 200) state.row = cacheRow(state.now); },
  });
  const result = await acquire(request());
  assert.deepEqual(state.waits, [100, 200]);
  assert.equal(state.claims, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.receivedAt, 10_300);
  assert.equal(state.fetches, 0);

  const pending = busyFixture({ row: cacheRow(null, 20_000) });
  assert.equal((await pending.acquire(request())).status, 'busy');
  assert.deepEqual(pending.state.waits, [100, 200, 400, 800]);
  assert.equal(pending.state.fetches, 0);
});

test('polling stops when the same-key refresh is released or expires without a result', async () => {
  for (const expires of [false, true]) {
    const { state, acquire } = busyFixture({
      row: cacheRow(1000, expires ? 10_100 : 20_000),
      onWait: state => { if (!expires) state.row = cacheRow(1000); },
    });
    const result = await acquire(request());
    assert.deepEqual(state.waits, [100]);
    assert.equal(result.status, 'busy');
    assert.equal(result.receivedAt, 1000, 'retained data keeps its original age');
    assert.equal(result.retryAt, 20_000);
    assert.equal(state.fetches, 0);
  }
});

test('provider cooldown still returns backoff without polling an active same-key worker', async () => {
  const { state, acquire } = busyFixture({ row: cacheRow(1000, 20_000) });
  state.cooldownUntil = 70_000;
  const result = await acquire(request());
  assert.deepEqual(state.waits, []);
  assert.equal(result.status, 'backoff');
  assert.equal(result.retryAt, 70_000);
  assert.equal(result.receivedAt, 1000);
  assert.equal(state.fetches, 0);
});

test('many concurrent viewers and two cold acquirers share one request and immutable timestamp', async () => {
  const { pg, store } = await fixture();
  try {
    let calls = 0;
    const fetch = async () => { calls++; await delay(30); return Response.json({ ac: [] }); };
    const a = createAdsbAcquirer(store, { fetch });
    const b = createAdsbAcquirer(store, { fetch });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b)(request())));
    assert.equal(calls, 1);
    assert.ok(results.every(r => r.status === 'ok'));
    assert.equal(new Set(results.map(r => r.receivedAt)).size, 1);
    assert.equal((await b(request())).receivedAt, results[0].receivedAt);
    assert.equal(calls, 1, 'empty successful results are cached too');
  } finally { await pg.close(); }
});

test('cross-instance distinct keys require 1250ms between admissions without boundary bursts', async () => {
  let now = Date.now();
  const { pg, sql, store } = await fixture(() => now);
  const other = createAdsbAcquisitionStore(async () => sql, { now: () => now });
  try {
    const initial = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? store : other).acquire(`key-${i}`, 'fi', `owner-${i}`)));
    assert.equal(initial.filter(v => v != null).length, 1);
    const winner = initial.findIndex(v => v != null);
    const first = initial[winner];
    await store.release(`key-${winner}`, `owner-${winner}`);
    assert.equal(await other.admissionRetryAt('fi'), first + 1250);
    now = first + 999;
    assert.equal(await other.acquire('at-boundary-minus-one', 'fi', 'x'), null);
    now = first + 1000;
    assert.equal(await other.acquire('at-old-boundary', 'fi', 'y'), null);
    now = first + 1249;
    assert.equal(await other.acquire('at-margin-minus-one', 'fi', 'z'), null);
    now = first + 1250;
    assert.equal(await other.acquire('next', 'fi', 'next'), now);
    assert.equal(await store.acquire('same-tick', 'fi', 'same'), null);
  } finally { await pg.close(); }
});

test('concurrent different-key cold viewers cannot emit a provider burst', async () => {
  const now = Date.now();
  const { pg, sql } = await fixture(() => now);
  try {
    let calls = 0;
    const fetch = async () => { calls++; return Response.json({ ac: [] }); };
    const viewers = Array.from({ length: 12 }, () => createAdsbAcquirer(
      createAdsbAcquisitionStore(async () => sql, { now: () => now }), { fetch, now: () => now, wait: async () => {} }));
    const results = await Promise.all(viewers.map((acquire, i) => acquire(request(`distinct-${i}`))));
    assert.equal(calls, 1);
    assert.equal(results.filter(r => r.status === 'ok').length, 1);
    assert.ok(results.filter(r => r.status !== 'ok').every(r => r.status === 'busy' && r.retryAt > now));
  } finally { await pg.close(); }
});

test('provider-wide 429 blocks new keys and cold instances; late success cannot reset cooldown', async () => {
  const { pg, store } = await fixture();
  try {
    const started = await store.acquire('slow', 'fi', 'slow-owner');
    await store.acquire('failed', 'fi', 'failed-owner');
    await store.fail('fi', '429', 180_000);
    const until = await store.cooldown('fi');
    assert.ok(until >= Date.now() + 179_000);
    await store.complete('slow', 'fi', 'slow-owner', { ac: [] }, Date.now(), started);
    assert.equal(await store.cooldown('fi'), until);
    let calls = 0;
    const cold = createAdsbAcquirer(createAdsbAcquisitionStore(async () => {
      const sql = async () => { throw new Error('unused'); };
      return sql;
    }));
    assert.equal((await cold(request())).status, 'unavailable');
    const b = createAdsbAcquirer(store, { fetch: async () => { calls++; return Response.json({ ac: [] }); } });
    for (const key of ['other-hex', 'callsign', 'area']) {
      const r = await b(request(key));
      assert.equal(r.status, 'backoff'); assert.equal(r.retryAt, until);
    }
    assert.equal(calls, 0);
  } finally { await pg.close(); }
});

test('real 429 response preserves Retry-After and prevents the next cold fetch', async () => {
  const { pg, store } = await fixture();
  try {
    let calls = 0;
    const fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '180' } }); };
    const first = await createAdsbAcquirer(store, { fetch })(request());
    assert.equal(first.status, '429');
    const next = await createAdsbAcquirer(store, { fetch })(request('other'));
    assert.equal(next.status, 'backoff'); assert.equal(calls, 1);
    assert.ok(next.retryAt > Date.now() + 179_000);
  } finally { await pg.close(); }
});

test('expired owner cannot overwrite or release a reacquired lease; freshness blocks redundant claims', async () => {
  const { pg, store } = await fixture();
  try {
    await store.acquire('one', 'fi', 'old');
    await pg.exec("update adsb_shared_cache set refresh_expires_at=0; update adsb_provider_gate set admitted_at=0, dispatch_expires_at=0, next_dispatch_at=0");
    const started = await store.acquire('one', 'fi', 'new');
    await store.complete('one', 'fi', 'old', { ac: ['old'] }, Date.now(), started);
    await store.release('one', 'old');
    assert.equal((await store.read('one')).payload, null);
    assert.ok((await store.read('one')).refresh_expires_at > Date.now());
    await store.complete('one', 'fi', 'new', { ac: ['new'] }, Date.now(), started);
    await pg.exec('update adsb_provider_gate set admitted_at=0, dispatch_expires_at=0, next_dispatch_at=0');
    assert.equal(await store.acquire('one', 'fi', 'redundant'), null);
    assert.deepEqual((await store.read('one')).payload, { ac: ['new'] });
  } finally { await pg.close(); }
});

test('viewer abort isolates its wait and shared upstream continues for another viewer', async () => {
  const { pg, store } = await fixture();
  try {
    let release; const gate = new Promise(resolve => { release = resolve; });
    let calls = 0, upstreamSignal;
    const acquire = createAdsbAcquirer(store, { fetch: async (_url, init) => {
      calls++; upstreamSignal = init.signal; assert.equal(init.redirect, "error"); await gate; return Response.json({ ac: [] });
    } });
    const controller = new AbortController();
    const shared = acquire(request());
    const first = waitForAdsbViewer(shared, controller.signal);
    const second = waitForAdsbViewer(acquire(request()));
    controller.abort(); assert.equal(await first, null);
    release(); assert.equal((await second).status, 'ok');
    assert.equal(calls, 1); assert.equal(upstreamSignal.aborted, false);
  } finally { await pg.close(); }
});

test('cached raw packs retain original observation time during later fusion', () => {
  resetFusion();
  const receivedAt = Date.now();
  const packs = [{ provider: 'fi', receivedAt, ac: [{ hex: 'abc123', lat: 28.43, lon: -81.3, alt_baro: 'ground', seen_pos: 4 }] }];
  const first = fuseProviderLists(packs, { now: receivedAt, airside: true })[0];
  const later = fuseProviderLists(packs, { now: receivedAt + 20_000, airside: true })[0];
  assert.equal(first._fusion.ageSec, 4);
  assert.equal(later._fusion.ageSec, 24);
  assert.equal(receivedAt - first._fusion.ageSec * 1000, receivedAt + 20_000 - later._fusion.ageSec * 1000);
  resetFusion();
});

test('cache write failure is unavailable and does not falsely penalize the provider', async () => {
  const { pg, store } = await fixture();
  try {
    let failures = 0;
    const broken = { ...store, complete: async () => { throw new Error('database write failed'); },
      fail: async () => { failures++; } };
    const acquire = createAdsbAcquirer(broken, { fetch: async () => Response.json({ ac: [] }) });
    assert.equal((await acquire(request())).status, 'unavailable');
    assert.equal(failures, 0);
  } finally { await pg.close(); }
});

test('unavailable coordinator fails closed, disallows paid URLs, parses Retry-After dates', async () => {
  let calls = 0;
  const store = createAdsbAcquisitionStore(async () => { throw new Error('database down'); });
  const acquire = createAdsbAcquirer(store, { fetch: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal((await acquire(request())).status, 'unavailable');
  assert.equal((await acquire({ ...request(), url: 'https://fr24api.flightradar24.com/api/live/flight-positions/full' })).status, 'unavailable');
  assert.equal(calls, 0);
  const now = Date.parse('2026-10-07T00:00:00Z');
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 00:02:00 GMT', now), 120_000);
  assert.equal(retryAfterMs('invalid', now), 0);
});

test('repeated cached ground packs crossing fresh-cut never reset observed age', () => {
  resetFusion();
  const receivedAt = Date.now();
  const pack = [{ provider: 'fi', receivedAt, ac: [{ hex: 'abc123', lat: 28.43, lon: -81.3, alt_baro: 'ground', seen_pos: 4 }] }];
  for (const elapsed of [0, 1499, 1501, 1600]) {
    const result = fuseProviderLists(pack, { now: receivedAt + elapsed, airside: true })[0];
    assert.ok(Math.abs(result._fusion.ageSec - (4 + elapsed / 1000)) < 0.000001);
    assert.equal(result.extrapolated, false);
  }
  resetFusion();
});

test('airborne coast preserves existing observation age across cached-pack fresh-cut', () => {
  resetFusion();
  const receivedAt = Date.now();
  const pack = [{ provider: 'fi', receivedAt, ac: [{ hex: 'abc123', lat: 28.43, lon: -81.3, alt_baro: 5000, gs: 200, track: 90, seen_pos: 4 }] }];
  fuseProviderLists(pack, { now: receivedAt, airside: false });
  fuseProviderLists(pack, { now: receivedAt + 1499, airside: false });
  const later = fuseProviderLists(pack, { now: receivedAt + 2000, airside: false })[0];
  assert.ok(Math.abs(later._fusion.ageSec - 6) < 0.000001);
  resetFusion();
});

test('cleanup rechecks expiry on the target row after PostgreSQL lock waits', async () => {
  let statement = '';
  const sql = async (strings) => { statement = strings.join('?'); return []; };
  await createAdsbAcquisitionStore(async () => sql).cleanup();
  // PGlite serializes statements; this asserts the outer target predicates that
  // PostgreSQL must re-evaluate when a refresh wins the row lock during DELETE.
  assert.match(statement, /limit 1024\)\s+and retain_until </);
  assert.match(statement, /limit 1024\)[\s\S]*and refresh_expires_at </);
});

test('repeated or out-of-order older cached snapshots cannot crowd out a newer ground fix', () => {
  for (const distinct of [false, true]) {
    resetFusion();
    const at = Date.now();
    const old = { provider: 'fi', receivedAt: at, ac: [{ hex: 'abc123', lat: 28.43, lon: -81.3, alt_baro: 'ground', seen_pos: 4 }] };
    const newer = { provider: 'fi', receivedAt: at + 1000, ac: [{ hex: 'abc123', lat: 28.431, lon: -81.3, alt_baro: 'ground', seen_pos: 0 }] };
    fuseProviderLists([old], { now: at, airside: true });
    fuseProviderLists([newer], { now: at + 1000, airside: true });
    for (let i = 0; i < 20; i++) {
      const raw = { ...old, receivedAt: at + (distinct ? i : 0) };
      const result = fuseProviderLists([raw], { now: at + 3000 + i, airside: true })[0];
      assert.equal(result.lat, 28.431);
      assert.ok(Math.abs(result._fusion.ageSec - (2 + i / 1000)) < 0.000001);
    }
  }
  resetFusion();
});

test('production and preview with no database fail closed before any upstream request', async () => {
  const keys = ['DATABASE_URL', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV'];
  const saved = keys.map(k => process.env[k]);
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  try {
    for (const mode of ['production', 'preview', 'non-vercel', 'vercel-flag']) {
      keys.forEach(k => delete process.env[k]);
      if (mode === 'non-vercel') process.env.NODE_ENV = 'production';
      else if (mode === 'vercel-flag') process.env.VERCEL = '1';
      else process.env.VERCEL_ENV = mode;
      assert.equal((await acquireFreeAdsb(request(mode))).status, 'unavailable');
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    keys.forEach((k, i) => { if (saved[i] == null) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});

test('bounded cleanup exceeds maximum per-minute admission rate and retains live leases', async () => {
  const { pg, store } = await fixture();
  try {
    await pg.exec("insert into adsb_shared_cache(cache_key, provider, retain_until) select 'expired-'||i, 'fi', 1 from generate_series(1,800) i");
    await pg.query("insert into adsb_shared_cache(cache_key, provider, retain_until, refresh_expires_at) values ('live', 'fi', 1, $1)", [Date.now() + 10_000]);
    await store.cleanup();
    const rows = (await pg.query('select cache_key from adsb_shared_cache')).rows;
    assert.deepEqual(rows, [{ cache_key: 'live' }]);
  } finally { await pg.close(); }
});


test('429 retries after cooldown expiry escalate until a valid newer success', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  try {
    const fetch = async () => new Response('', { status: 429 });
    for (const [index, expected] of [60000, 120000, 300000].entries()) {
      const acquired = createAdsbAcquirer(store, { fetch, now: () => now, wait: async () => {} });
      const result = await acquired(request(`rate-${index}`));
      assert.equal(result.status, '429');
      assert.equal(result.retryAt, now + expected);
      now = result.retryAt + 1;
    }
  } finally { await pg.close(); }
});

test('expired or wrong-token success never resets failures; valid newer success does', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  try {
    const old = await store.acquire('old', 'fi', 'old-token');
    now += 1;
    await store.fail('fi', '429');
    now = await store.cooldown('fi') + 1;
    const later = await store.acquire('later', 'fi', 'later-token');
    await store.complete('old', 'fi', 'old-token', { ac: [] }, now, later);
    await store.complete('later', 'fi', 'wrong-token', { ac: [] }, now, later);
    assert.equal((await pg.query("select failures from adsb_provider_gate where provider='fi'")).rows[0].failures, 1);
    await store.complete('later', 'fi', 'later-token', { ac: [] }, now, later);
    assert.equal((await pg.query("select failures from adsb_provider_gate where provider='fi'")).rows[0].failures, 0);
    await store.release('later', 'later-token');
    now += 1250;
    assert.ok(await store.acquire('next', 'fi', 'next-token'));
    await store.fail('fi', '429');
    assert.equal(await store.cooldown('fi'), now + 120000, "valid success must not erase the independent 429 streak");
    assert.ok(old < later);
  } finally { await pg.close(); }
});

test('malformed HTTP200 payload cannot reset a prior rate-limit failure', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  try {
    await store.acquire('first', 'fi', 'first-token');
    await store.fail('fi', '429');
    now = await store.cooldown('fi') + 1;
    const acquire = createAdsbAcquirer(store, { fetch: async () => Response.json({ error: 'rate limited' }), now: () => now });
    const result = await acquire(request('malformed'));
    assert.equal(result.status, 'error');
    assert.equal((await pg.query("select failures from adsb_provider_gate where provider='fi'")).rows[0].failures, 2);
  } finally { await pg.close(); }
});

test('a slow dispatch retains its provider slot across cold instances and live/trace hosts', async () => {
  let now = Date.now();
  const { pg, sql, store } = await fixture(() => now);
  let release, started;
  const hold = new Promise(resolve => { release = resolve; });
  const reachedFetch = new Promise(resolve => { started = resolve; });
  let calls = 0;
  try {
    const first = createAdsbAcquirer(store, { now: () => now, wait: async () => {}, fetch: async () => {
      calls++; started(); await hold; return Response.json({ ac: [] });
    } })(request('slow'));
    await reachedFetch;
    now += 2000;
    const otherStore = createAdsbAcquisitionStore(async () => sql, { now: () => now });
    const second = createAdsbAcquirer(otherStore, { now: () => now, wait: async () => {}, fetch: async () => {
      calls++; return Response.json({ timestamp: now / 1000, trace: [] });
    } });
    const trace = { provider: 'trace-fi', url: 'https://globe.adsb.fi/data/traces/23/trace_recent_abc123.json', timeoutMs: 2200 };
    assert.equal((await second(trace)).status, 'busy');
    assert.equal(calls, 1, 'no overlapping cold-instance dispatch while first HTTP is still active');
    release(); assert.equal((await first).status, 'ok');
    now += 1249;
    assert.equal((await second(trace)).status, 'busy');
    assert.equal(calls, 1);
    now += 1;
    assert.equal((await second(trace)).status, 'ok');
    assert.equal(calls, 2);
  } finally { release(); await pg.close(); }
});

test('a grant too close to lease expiry cannot begin an HTTP request longer than its remaining lease', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  let calls = 0;
  try {
    const delayed = { ...store, acquire: async (...args) => {
      const result = await store.acquire(...args); now += 9500; return result;
    } };
    const result = await createAdsbAcquirer(delayed, { now: () => now, fetch: async () => {
      calls++; return Response.json({ ac: [] });
    } })(request('delayed'));
    assert.equal(result.status, 'busy'); assert.equal(calls, 0);
  } finally { await pg.close(); }
});

test('intermittent trace success retains API429 streak; quiet period permits recovery', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  try {
    const invoke = (req, response) => createAdsbAcquirer(store, { now: () => now, wait: async () => {}, fetch: async () => response })(req);
    let result = await invoke(request('first429'), new Response('', { status: 429 }));
    assert.equal(result.retryAt, now + 60000);
    now = result.retryAt + 1;
    const trace = { provider: 'trace-fi', url: 'https://globe.adsb.fi/data/traces/23/trace_recent_abc123.json', timeoutMs: 2200 };
    assert.equal((await invoke(trace, Response.json({ timestamp: now / 1000, trace: [] }))).status, 'ok');
    now += 1250;
    result = await invoke(request('second429'), new Response('', { status: 429 }));
    assert.equal(result.retryAt, now + 120000);
    now += 15 * 60000;
    result = await invoke(request('quiet429'), new Response('', { status: 429, headers: { 'retry-after': '600' } }));
    assert.equal(result.retryAt, now + 600000, 'quiet reset cannot shorten server Retry-After');
    assert.equal((await pg.query("select rate_limit_failures from adsb_provider_gate where provider='fi'")).rows[0].rate_limit_failures, 1);
  } finally { await pg.close(); }
});

test('a delayed dispatch-check reply cannot turn an expired grant into an HTTP call', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  let calls = 0;
  try {
    const delayed = { ...store, canDispatch: async (...args) => {
      const result = await store.canDispatch(...args); now += 9500; return result;
    } };
    const result = await createAdsbAcquirer(delayed, { now: () => now, fetch: async () => {
      calls++; return Response.json({ ac: [] });
    } })(request('delayed-check'));
    assert.equal(result.status, 'busy'); assert.equal(calls, 0);
  } finally { await pg.close(); }
});

test('trace403 stays service-local while liveAPI remains permitted and429 remains family-wide', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now);
  let calls = 0;
  try {
    const trace = { provider: 'trace-fi', url: 'https://globe.adsb.fi/data/traces/23/trace_recent_abc123.json', timeoutMs: 2200 };
    const invoke = (req, response) => createAdsbAcquirer(store, { now: () => now, wait: async () => {}, fetch: async () => { calls++; return response; } })(req);
    const denied = await invoke(trace, new Response('', { status: 403 }));
    assert.equal(denied.status, '403'); assert.equal(denied.retryAt, now + 30 * 60000);
    now += 1250;
    assert.equal((await invoke(request('live-allowed'), Response.json({ ac: [] }))).status, 'ok');
    now += 1250;
    assert.equal((await invoke(trace, Response.json({ timestamp: now / 1000, trace: [] }))).status, 'backoff');
    assert.equal(calls, 2, 'denied host never retried even after successful live lookup');
    const rateLimited = await invoke(request('live-rate'), new Response('', { status: 429 }));
    assert.equal(rateLimited.status, '429');
    assert.ok(await store.cooldown('fi') > now);
    assert.ok(await store.cooldown('trace-fi') >= rateLimited.retryAt);
  } finally { await pg.close(); }
});

test('migration preserves legacy trace denial and spacing without imposing denial on liveAPI', async () => {
  let now = Date.now();
  const { pg, store } = await fixture(() => now, async pg => {
    await pg.query("insert into adsb_provider_gate(provider, cooldown_until, failures, last_failure_at) values ('trace-fi',$1,1,$2),('fi',0,0,0)", [now + 1800000, now]);
    await pg.query("update adsb_provider_gate set admitted_at=$1 where provider='trace-fi'", [now - 500]);
  });
  try {
    assert.equal(await store.cooldown('trace-fi'), now + 1800000);
    assert.equal(await store.cooldown('fi'), 0);
    assert.equal(await store.admissionRetryAt('fi'), now + 750);
    assert.equal(await store.acquire('too-early-live', 'fi', 'early-owner'), null);
    now += 750;
    assert.ok(await store.acquire('live', 'fi', 'live-owner'));
    assert.equal(await store.acquire('trace', 'trace-fi', 'trace-owner'), null);
  } finally { await pg.close(); }
});
