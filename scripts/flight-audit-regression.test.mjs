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
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async (url) => {
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
    now += 5000;
    gs = 3;
    assert.equal((await load()).times.pushed, true, 'movement registers pushback');
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
});
