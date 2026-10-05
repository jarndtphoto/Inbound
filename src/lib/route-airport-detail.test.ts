import assert from 'node:assert/strict';
import { test } from 'node:test';
import { airportDetailOpacity, airportNearViewport, maxRouteZoom, routeStrokeWidths, routeVisibleWidthMiles, simplifyRouteAirportSurface } from './route-airport-detail.ts';
import type { SurfaceFeature } from './airport-surface.server';

test('distance zoom limit reaches six miles for short, continental, and transoceanic routes', () => {
  for (const span of [2, 30, 90, 200]) for (const lat of [0, 28.43, 33.43, 60]) {
    const width = routeVisibleWidthMiles(span, lat);
    const limit = maxRouteZoom(width);
    assert.ok(Math.abs(routeVisibleWidthMiles(span, lat, limit) - 6) < 1e-9);
    if (span > 2) assert.ok(limit > 12);
  }
  assert.equal(maxRouteZoom(3), 1);
});

test('visible width uses the Mercator viewport parallel and scales smoothly', () => {
  const base = routeVisibleWidthMiles(40, 30);
  assert.equal(routeVisibleWidthMiles(40, 30, 4), base / 4);
  assert.ok(routeVisibleWidthMiles(200, 30) > routeVisibleWidthMiles(180, 30));
});

test('airport detail is hidden at 60 miles and fades to full by 35 miles', () => {
  for (const width of [60, 61, 2000]) assert.equal(airportDetailOpacity(width), 0);
  assert.equal(airportDetailOpacity(59), .04);
  assert.equal(airportDetailOpacity(47.5), .5);
  for (const width of [35, 6, 0]) assert.equal(airportDetailOpacity(width), 1);
});

test('lazy surface proximity follows the translated viewport and its airport margin', () => {
  const view = { s: 100, x: -40_000, y: -20_000 };
  assert.ok(airportNearViewport({ x: 404, y: 204 }, view, 1200, 1));
  assert.ok(airportNearViewport({ x: 409, y: 204 }, view, 1200, 1));
  assert.equal(airportNearViewport({ x: 420, y: 204 }, view, 1200, 1), false);
  assert.equal(airportNearViewport({ x: 404, y: 220 }, view, 1200, 1), false);
});

test('route, outline, weather and reported strokes shrink with zoom without vanishing', () => {
  for (const band of ['smooth', 'light', 'moderate']) for (const past of [false, true]) {
    const base = routeStrokeWidths(1, band, past), near = routeStrokeWidths(10, band, past), max = routeStrokeWidths(800, band, past);
    assert.ok(base.line > near.line && near.line > max.line);
    assert.ok(base.outline > near.outline && near.outline > max.outline);
    assert.ok(base.reported > near.reported && max.reported > 0);
    assert.ok(max.line > .4);
  }
  assert.equal(routeStrokeWidths(1, 'moderate').line, 6.4 * 2 / 3);
});

test('route surfaces exclude labels, taxilanes, parking, gates and holding bays', () => {
  const kinds: SurfaceFeature['kind'][] = ['runway', 'runway_area', 'taxiway', 'taxiway_area', 'terminal', 'apron', 'taxilane', 'parking_position', 'gate', 'holding_position'];
  const features = kinds.map((kind, id) => ({kind, id, points: [{lat:28,lon:-81}, {lat:28.01,lon:-81}]}));
  assert.deepEqual(simplifyRouteAirportSurface(features).map(f=>f.kind), ['apron', 'taxiway_area', 'taxiway', 'runway_area', 'runway', 'terminal']);
});

test('simplification preserves exact runway endpoints and closed polygon corners', () => {
  const points = Array.from({length:100}, (_,i)=>({lat:28+i/10000,lon:-81+(i%2)*.000001}));
  const ring = [{lat:28,lon:-81}, {lat:28.001,lon:-81}, {lat:28.001,lon:-81.001}, {lat:28,lon:-81.001}, {lat:28,lon:-81}];
  const simplified = simplifyRouteAirportSurface([{kind:'runway',id:1,points}, {kind:'terminal',id:2,points:ring}]);
  assert.equal(simplified[0].points.length, 2);
  assert.deepEqual(simplified[0].points[0], points[0]);
  assert.deepEqual(simplified[0].points.at(-1), points.at(-1));
  assert.deepEqual(simplified[1].points, ring);
});
