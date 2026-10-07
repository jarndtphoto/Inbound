import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { acquireFreeAdsb, createAdsbAcquirer, createAdsbAcquisitionStore, retryAfterMs, waitForAdsbViewer } from '../src/lib/adsb-acquisition.server.ts';
import { fuseProviderLists, resetFusion } from '../src/lib/adsb-fusion.ts';

async function fixture() {
  const pg = new PGlite({ parsers: { 20: Number } });
  await pg.waitReady;
  await pg.exec(await readFile(new URL('../migrations/0008_adsb_acquisition.sql', import.meta.url), 'utf8'));
  const sql = async (strings, ...values) => {
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    return (await pg.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pg.query(text, values)).rows;
  return { pg, sql, store: createAdsbAcquisitionStore(async () => sql) };
}
const request = (suffix = 'abc123', provider = 'fi') => ({ provider,
  url: `https://${provider === 'fi' ? 'opendata.adsb.fi' : 'api.adsb.lol'}/api/v2/hex/${suffix}`, timeoutMs: 4000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

test('distinct keys have a shared two-admission window ceiling, without a global in-flight lease', async () => {
  const { pg, store } = await fixture();
  try {
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => store.acquire(`key-${i}`, 'fi', `owner-${i}`)));
    assert.equal(attempts.filter(v => v != null).length, 2);
    assert.ok(await store.admissionRetryAt('fi') > Date.now());
    await pg.exec('update adsb_provider_gate set window_at=0');
    assert.ok(await store.acquire('key-new', 'fi', 'new-owner'), 'new window permits another key while earlier HTTP may remain in flight');
  } finally { await pg.close(); }
});

test('concurrent different-key viewers cannot exceed the admitted upstream burst', async () => {
  const { pg, store } = await fixture();
  try {
    await pg.query("insert into adsb_provider_gate(provider, window_at) values ('fi', $1)", [Date.now() + 60_000]);
    let calls = 0;
    const fetch = async () => { calls++; return Response.json({ ac: [] }); };
    const viewers = Array.from({ length: 12 }, () => createAdsbAcquirer(store, { fetch, wait: async () => {} }));
    const results = await Promise.all(viewers.map((acquire, i) => acquire(request(`distinct-${i}`))));
    assert.equal(calls, 2);
    assert.equal(results.filter(r => r.status === 'ok').length, 2);
    assert.ok(results.filter(r => r.status !== 'ok').every(r => r.status === 'busy' && r.retryAt > Date.now()));
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
    await pg.exec("update adsb_shared_cache set refresh_expires_at=0; update adsb_provider_gate set window_at=0");
    const started = await store.acquire('one', 'fi', 'new');
    await store.complete('one', 'fi', 'old', { ac: ['old'] }, Date.now(), started);
    await store.release('one', 'old');
    assert.equal((await store.read('one')).payload, null);
    assert.ok((await store.read('one')).refresh_expires_at > Date.now());
    await store.complete('one', 'fi', 'new', { ac: ['new'] }, Date.now(), started);
    await pg.exec('update adsb_provider_gate set window_at=0');
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
