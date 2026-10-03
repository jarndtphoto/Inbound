import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampRouteMapView } from './route-map-interaction.ts';

test('free pan stops half a route screen beyond each edge', () => {
  assert.deepEqual(clampRouteMapView({s: 1, x: 9999, y: -9999}, 600, true), {s: 1, x: 400, y: -300});
  assert.deepEqual(clampRouteMapView({s: 1, x: -9999, y: 9999}, 600, true), {s: 1, x: -400, y: 300});
});
test('free map zoom cannot shrink below 0.75 or exceed 12', () => {
  assert.equal(clampRouteMapView({s: 0.01, x: 0, y: 0}, 800, true).s, 0.75);
  assert.equal(clampRouteMapView({s: 99, x: 0, y: 0}, 800, true).s, 12);
});
test('bounds contain the viewport within the route buffer at every scale and aspect', () => {
  for (const h of [320, 800, 1600]) for (const s of [0.75, 1, 1.4, 4, 12]) {
    const left = clampRouteMapView({s, x: 1e6, y: 1e6}, h, true);
    const right = clampRouteMapView({s, x: -1e6, y: -1e6}, h, true);
    assert.equal(-left.x / s, -400);
    assert.ok(Math.abs((800-right.x)/s-1200)<1e-9);
    assert.equal(-left.y / s, -h/2);
    assert.ok(Math.abs((h-right.y)/s-h*1.5)<1e-9);
  }
});
test('weather preview retains its existing zoom and pan limits', () => {
  assert.deepEqual(clampRouteMapView({s: .75, x: 500, y: -500}), {s: 1, x: 0, y: 0});
  assert.deepEqual(clampRouteMapView({s: 2, x: -9999, y: 9999}, 600), {s: 2, x: -800, y: 0});
});
