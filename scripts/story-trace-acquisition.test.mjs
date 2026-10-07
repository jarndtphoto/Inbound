import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const directory = await mkdtemp(resolve('node_modules/.story-trace-acquisition-'));
after(async () => rm(directory, { recursive: true, force: true }));
const fixture = { calls: [], result: () => ({ data: null, status: 'busy', receivedAt: null, cache: false }) };
globalThis.__storyTraceAcquisitionFixture = fixture;
await build({ configFile: false, logLevel: 'silent', plugins: [{
  name: 'test-story-trace-guard-boundary', enforce: 'pre',
  resolveId(source) { if (/(?:^|\/)adsb-acquisition\.server\.ts$/.test(source)) return '\0story-trace-guard-fixture'; },
  load(id) {
    if (id !== '\0story-trace-guard-fixture') return null;
    return `export async function acquireFreeAdsb(request) {
      const fixture = globalThis.__storyTraceAcquisitionFixture;
      fixture.calls.push(request); return fixture.result(request);
    }
    export async function waitForAdsbViewer(work) { return work; }`;
  },
  transform(code, id) {
    if (id.endsWith('/src/lib/story.server.ts')) return { code: code + '\nexport { fetchTrace as fixtureFetchTrace };', map: null };
  },
}], build: { ssr: resolve('src/lib/story.server.ts'), outDir: directory,
  rollupOptions: { output: { entryFileNames: 'story.mjs' } },
} });
const { fixtureFetchTrace } = await import(pathToFileURL(join(directory, 'story.mjs')).href);
function trapNetwork(t) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Direct provider fetch bypassed guarded acquisition'); };
  t.after(() => { globalThis.fetch = original; });
  fixture.calls = [];
  return () => calls;
}

test('story full and recent traces always use the guarded provider boundary', async (t) => {
  const directCalls = trapNetwork(t);
  fixture.result = () => ({ status: 'ok', receivedAt: 1_800_000_000_000, cache: false,
    data: { timestamp: 1_700_000_000, trace: [[15, 41.98, -87.9, 'ground', 12, 90]] } });
  const [full, recent] = await Promise.all([fixtureFetchTrace('abc123', 'trace_full'), fixtureFetchTrace('abc123', 'trace_recent')]);
  assert.equal(directCalls(), 0);
  assert.equal(fixture.calls.length, 6);
  assert.deepEqual(new Set(fixture.calls.map(call => call.provider)), new Set(['trace-airtraffic', 'trace-fi', 'trace-al']));
  for (const call of fixture.calls) {
    assert.equal(call.timeoutMs, 2800);
    assert.equal('signal' in call, false);
    assert.match(call.url, /\/data\/traces\/23\/trace_(?:full|recent)_abc123\.json$/);
  }
  assert.equal(full[0].t, 1_700_000_015);
  assert.equal(recent[0].t, full[0].t);
});

test('retained trace payload keeps its original timestamps during shared backoff', async (t) => {
  const directCalls = trapNetwork(t);
  fixture.result = (request) => request.provider === 'trace-fi'
    ? { status: 'backoff', receivedAt: 1_800_000_000_000, cache: true,
      data: { timestamp: 1_700_000_000, trace: [[25, 41.99, -87.9, 10000, 300, 90]] } }
    : { status: 'busy', receivedAt: null, cache: false, data: null };
  const trace = await fixtureFetchTrace('abc124', 'trace_recent');
  assert.equal(trace[0].t, 1_700_000_025);
  assert.equal(directCalls(), 0);
});

test('unavailable shared coordination returns an empty trace without unguarded fallback', async (t) => {
  const directCalls = trapNetwork(t);
  fixture.result = () => ({ status: 'unavailable', data: null, receivedAt: null, cache: false });
  assert.deepEqual(await fixtureFetchTrace('abc125', 'trace_full'), []);
  assert.equal(fixture.calls.length, 3);
  assert.equal(directCalls(), 0);
});

test('malformed trace identities and kinds never reach shared acquisition', async (t) => {
  const directCalls = trapNetwork(t);
  assert.deepEqual(await fixtureFetchTrace('../abc126', 'trace_recent'), []);
  assert.deepEqual(await fixtureFetchTrace('abc126', 'other'), []);
  assert.equal(fixture.calls.length, 0);
  assert.equal(directCalls(), 0);
});
