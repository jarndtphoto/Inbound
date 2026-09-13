import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryTiming, distinctRouteHazards, upcomingStorms } from '../src/lib/route-hazards.ts';

const storm = { id: 'past', kind: 'convective', label: 'Thunderstorm SIGMET', chop: 'moderate', detail: '', lat: 40, lon: -90, remaining: false };

test('validity preserves a UTC window across midnight', () => {
  assert.equal(advisoryTiming({ validTimeFrom: '2026-09-12T23:00:00Z', validTimeTo: '2026-09-13T03:00:00Z' }),
    'Valid from 2026-09-12 23:00 UTC · until 2026-09-13 03:00 UTC');
});

test('compact forecast timestamps are displayed without inventing missing times', () => {
  assert.equal(advisoryTiming({ validTime: '20260913_0300' }), 'Forecast valid at 2026-09-13 03:00 UTC');
  assert.equal(advisoryTiming({ validTime: 'invalid' }), 'Validity time unavailable');
  assert.equal(advisoryTiming(null), 'Validity time unavailable');
});

test('warnings with different validity windows remain separate', () => {
  assert.equal(distinctRouteHazards([{ ...storm, validity: 'first' }, { ...storm, validity: 'second' }]).length, 2);
});

test('a storm already passed does not label a smooth remaining route', () => {
  assert.deepEqual(upcomingStorms(distinctRouteHazards([storm])), []);
});

test('a matching storm ahead survives deduplication of earlier route samples', () => {
  const ahead = { ...storm, id: 'ahead', remaining: true, lon: -85 };
  const warnings = distinctRouteHazards([storm, ahead, { ...ahead, id: 'duplicate' }]);
  assert.deepEqual(upcomingStorms(warnings), [ahead]);
});

test('past storms cannot exhaust the six-marker limit', () => {
  const past = Array.from({ length: 7 }, (_, i) => ({ ...storm, id: String(i) }));
  const ahead = { ...storm, id: 'ahead', remaining: true };
  assert.deepEqual(upcomingStorms([...past, ahead]), [ahead]);
});
