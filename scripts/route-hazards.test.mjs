import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distinctRouteHazards, upcomingStorms } from '../src/lib/route-hazards.ts';

const storm = { id: 'past', kind: 'convective', label: 'Thunderstorm SIGMET', chop: 'moderate', detail: '', lat: 40, lon: -90, remaining: false };

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
