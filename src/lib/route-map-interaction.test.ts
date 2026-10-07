import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampRouteMapView,
  minimumFreeRouteZoom,
  reconcileRouteMapView,
} from './route-map-interaction.ts';

test('free pan stops half a route screen beyond each edge without world bounds', () => {
  assert.deepEqual(clampRouteMapView({s: 1, x: 9999, y: -9999}, 600, true), {s: 1, x: 400, y: -300});
  assert.deepEqual(clampRouteMapView({s: 1, x: -9999, y: 9999}, 600, true), {s: 1, x: -400, y: 300});
});
test('legacy free map callers keep the 0.75 floor and supplied distance limit', () => {
  assert.equal(clampRouteMapView({s: 0.01, x: 0, y: 0}, 800, true).s, 0.75);
  assert.equal(clampRouteMapView({s: 99, x: 0, y: 0}, 800, true).s, 12);
  assert.equal(clampRouteMapView({s: 999, x: 0, y: 0}, 800, true, 430).s, 430);
  assert.equal(clampRouteMapView({s: 40, x: 0, y: 0}, 800, true, 430).s, 40);
});
test('short and long routes both zoom out far enough to fit the projected world', () => {
  const shortRouteWorld = { minX: -9600, maxX: 10400, minY: -9600, maxY: 10400 };
  const longRouteWorld = { minX: -1200, maxX: 2000, minY: -1200, maxY: 2000 };
  const shortFloor = minimumFreeRouteZoom(shortRouteWorld, 800);
  const longFloor = minimumFreeRouteZoom(longRouteWorld, 800);
  assert.equal(shortFloor, 0.04);
  assert.equal(longFloor, 0.25);
  assert.ok(shortFloor < longFloor && longFloor < 0.75);

  const short = clampRouteMapView({s: 0.001, x: -9999, y: 9999}, 800, true, 12, shortRouteWorld);
  const long = clampRouteMapView({s: 0.001, x: 9999, y: -9999}, 800, true, 12, longRouteWorld);
  assert.equal(short.s, shortFloor);
  assert.equal(long.s, longFloor);
  assert.equal((shortRouteWorld.maxX - shortRouteWorld.minX) * short.s, 800);
  assert.equal((longRouteWorld.maxX - longRouteWorld.minX) * long.s, 800);
});
test('world pan limits keep the viewport near mapped geography instead of the route frame', () => {
  const world = { minX: -1200, maxX: 2000, minY: -900, maxY: 2300 };
  const farRight = clampRouteMapView({s: 0.5, x: 9999, y: -9999}, 800, true, 12, world);
  const farLeft = clampRouteMapView({s: 0.5, x: -9999, y: 9999}, 800, true, 12, world);
  assert.deepEqual(farRight, {s: 0.5, x: 664, y: -414});
  assert.deepEqual(farLeft, {s: 0.5, x: -264, y: 514});
});
test('same-leg live updates preserve the user view; only a new leg requests recentering', () => {
  const world = { minX: -1200, maxX: 2000, minY: -900, maxY: 2300 };
  const manual = {s: 0.5, x: -120, y: 80};
  assert.deepEqual(reconcileRouteMapView(manual, false, 800, true, 12, world), manual);
  assert.deepEqual(reconcileRouteMapView(manual, false, 760, true, 12, world), manual);
  assert.deepEqual(reconcileRouteMapView(manual, true, 800, true, 12, world), {s: 1, x: 0, y: 0});
});
test('bounds contain the viewport within the route buffer at every scale and aspect without world bounds', () => {
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
