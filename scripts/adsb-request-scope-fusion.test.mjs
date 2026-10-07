import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { acquisitionFixture } from './helpers/acquisition-fixture.mjs';

// Exercise production fusion and scope together. Only the network acquisition
// boundary is replaced; every fetch below is an offline Response fixture.
let directory, api, now, requests;
const realFetch = globalThis.fetch, realNow = Date.now, realWarn = console.warn;
const START = 10_000_000;
const endpoint = key => `https://opendata.adsb.fi/api/v2/hex/${key}`;
before(async () => {
  directory = await mkdtemp(resolve('node_modules/.adsb-scope-fusion-'));
  await build({ configFile: false, logLevel: 'silent', plugins: [acquisitionFixture(), {
    name: 'expose-offline-scope-fusion',
    transform(code, id) {
      if (id.endsWith('/src/lib/adsb-fusion.ts')) return { code: code +
        '\nexport { withAdsbRequestScope } from "./adsb-request-scope.server.ts";\n', map: null };
    },
  }], build: { ssr: resolve('src/lib/adsb-fusion.ts'), outDir: directory,
    rollupOptions: { output: { entryFileNames: 'fusion.mjs' } } } });
  api = await import(pathToFileURL(join(directory, 'fusion.mjs')).href);
});
beforeEach(() => {
  now = START; requests = [];
  Date.now = () => now;
  console.warn = () => {};
  api.resetFusion();
});
afterEach(() => {
  globalThis.fetch = realFetch; Date.now = realNow; console.warn = realWarn;
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('one scoped 429 updates provider health once across concurrent and later consumers', async () => {
  globalThis.fetch = async url => { requests.push(String(url)); return Response.json({}, { status: 429 }); };
  await api.withAdsbRequestScope(async () => {
    await Promise.all([api.fetchProvider('fi', endpoint('limited')), api.fetchProvider('fi', endpoint('limited'))]);
    now += 2000;
    await api.fetchProvider('fi', endpoint('limited'));
    assert.equal(requests.length, 1);
    assert.equal(api.providerHealthy('fi', START + 59_999), false);
    assert.equal(api.providerHealthy('fi', START + 60_000), true,
      'reusing one 429 must not escalate or restart its original 60-second health backoff');
  });
});

test('replaying an earlier scoped success cannot erase a newer endpoint failure', async () => {
  globalThis.fetch = async url => {
    requests.push(String(url));
    return String(url).endsWith('/limited') ? Response.json({}, { status: 429 }) : Response.json({ ac: [] });
  };
  await api.withAdsbRequestScope(async () => {
    await api.fetchProvider('fi', endpoint('ok'));
    now += 1000;
    await api.fetchProvider('fi', endpoint('limited'));
    assert.equal(api.providerHealthy('fi', now), false);
    now += 1000;
    await api.fetchProvider('fi', endpoint('ok'));
    assert.equal(requests.length, 2);
    assert.equal(api.providerHealthy('fi', now), false,
      'cached success is not a new health observation');
    assert.equal(api.providerHealthy('fi', START + 60_999), false);
    assert.equal(api.providerHealthy('fi', START + 61_000), true);
  });
});

test('cancelled viewer leaves the scoped acquisition available for another consumer', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async url => {
    requests.push(String(url)); started();
    await new Promise(resolve => { release = resolve; });
    return Response.json({ ac: [{ hex: 'abc123', lat: 41.98, lon: -87.9, seen_pos: 2 }] });
  };
  await api.withAdsbRequestScope(async () => {
    const controller = new AbortController();
    const first = api.fetchProvider('fi', endpoint('abc123'), now, controller.signal);
    await began;
    controller.abort();
    assert.deepEqual(await first, []);
    now += 2000;
    const second = api.fetchProvider('fi', endpoint('abc123'));
    release();
    assert.equal((await second)[0].hex, 'abc123');
    assert.equal(requests.length, 1, 'viewer cancellation does not cancel or duplicate shared work');
  });
});
