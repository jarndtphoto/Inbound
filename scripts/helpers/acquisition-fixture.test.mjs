import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acquisitionFixture } from './acquisition-fixture.mjs';
import { acquireFreeAdsb } from './acquisition-fixture-runtime.mjs';

test('replay injection changes only default acquisition while retaining production guards and viewer cancellation', () => {
  const source = readFileSync(new URL('../../src/lib/adsb-acquisition.server.ts', import.meta.url), 'utf8');
  const plugin = acquisitionFixture();
  assert.equal(plugin.transform(source, '/src/lib/another-module.ts'), null);
  const transformed = plugin.transform(source, '/src/lib/adsb-acquisition.server.ts').code;
  const defaultExport = 'export const acquireFreeAdsb = createAdsbAcquirer(defaultStore);';
  assert.equal(transformed.slice(0, transformed.indexOf('export { acquireFreeAdsb }')), source.slice(0, source.indexOf(defaultExport)));
  assert.ok(transformed.includes('export function waitForAdsbViewer'));
  assert.ok(transformed.includes('Shared ADS-B coordination requires the configured database in deployment'));
  assert.throws(() => plugin.transform('export const changed = true;', '/src/lib/adsb-acquisition.server.ts'), /boundary changed/);
});

test('replay adapter anchors observation age to synthetic receipt time before mock HTTP', async (t) => {
  const fetch = globalThis.fetch, realNow = Date.now;
  t.after(() => { globalThis.fetch = fetch; Date.now = realNow; });
  let now = 1_700_000_000_000;
  Date.now = () => now;
  globalThis.fetch = async () => { now += 500; return Response.json({ ac: [{ seen_pos: 2 }] }); };
  const result = await acquireFreeAdsb({ url: 'https://fixture.invalid', timeoutMs: 1000 });
  assert.equal(result.receivedAt, 1_700_000_000_000);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.ac[0].seen_pos, 2);
});

test('replay adapter preserves upstream throttle/error distinctions', async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  for (const [status, expected] of [[403, '403'], [429, '429'], [503, 'error']]) {
    globalThis.fetch = async () => new Response(null, { status });
    assert.equal((await acquireFreeAdsb({ url: 'https://fixture.invalid', timeoutMs: 1000 })).status, expected);
  }
});
