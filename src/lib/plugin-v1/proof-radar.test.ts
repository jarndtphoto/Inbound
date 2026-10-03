import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { proofFixtureResult, proofWidgetHtml } from "./proof-server";
import { areaDefinition } from "./areas";
import { fixtureRankingCandidate } from "./fixtures";
import { haversineNm } from "../geo";
import { assertFixtureApplication } from "../../../scripts/plugin-v1-preview-isolation.mjs";

// Exercise the actual bundled UI's pure projection, with no mirrored math.
const html = proofWidgetHtml("radar-test-nonce");
const math = html.match(/\/\/ BEGIN FIXTURE RADAR MATH[^\n]*\n([\s\S]*?)\/\/ END FIXTURE RADAR MATH/)![1]!;
const { projectFixturePoint: project, fixtureRadarRadius: radius, fixtureHeading: heading } = new Script(`${math}\n({ projectFixturePoint, fixtureRadarRadius, fixtureHeading })`).runInNewContext();

test("Radar projection centers the named reference and preserves north/east and aspect ratio", () => {
  const reference = areaDefinition("preset:chicago").reference;
  const center = project(reference, reference, 1000, 640, 12);
  assert.equal(center.x, 500); assert.equal(center.y, 320);
  assert.equal(center.eastNm, 0); assert.equal(center.northNm, 0);
  const north = project({ ...reference, latitude: reference.latitude + .1 }, reference, 1000, 640, 12);
  const east = project({ ...reference, longitude: reference.longitude + .1 }, reference, 1000, 640, 12);
  assert.ok(north.y < center.y); assert.ok(east.x > center.x);
  assert.ok(Math.abs(east.eastNm / north.northNm - Math.cos(reference.latitude * Math.PI / 180)) < 1e-10);
  assert.equal(north.scale, east.scale, "one local scale for both axes");
  assert.equal(JSON.stringify(north), JSON.stringify(project({ ...reference, latitude: reference.latitude + .1 }, reference, 1000, 640, 12)));
});

test("Radar projection rejects invalid coordinates and identifies out-of-view observations", () => {
  const reference = areaDefinition("preset:chicago").reference;
  assert.equal(project({ latitude: NaN, longitude: -87 }, reference, 375, 340, 12), null);
  assert.equal(project(reference, reference, 0, 340, 12), null);
  assert.equal(project(reference, reference, 375, 340, 0), null);
  assert.equal(project({ latitude: 44, longitude: -87 }, reference, 375, 340, 12).inView, false);
  assert.equal(heading(null), null); assert.equal(heading({}), null);
  assert.equal(heading({ groundTrackDeg: 450 }), 90);
  assert.equal(heading({ groundTrackDeg: -10 }), 350);
});

test("Same four existing fixture coordinates and timestamps survive Chicago/ORD/MDW reads", () => {
  const boards = ["chicago", "ORD", "MDW"].map(code => proofFixtureResult({ area: code === "chicago" ? { kind: "preset", nameOrId: code } : { kind: "airport", code }, includePosition: true }).structuredContent);
  for (const board of boards) {
    assert.equal(board.flights.length, 4);
    for (const [index, card] of board.flights.entries()) {
      const existing = fixtureRankingCandidate(index);
      assert.equal(card.position!.latitude, existing.latitude);
      assert.equal(card.position!.longitude, existing.longitude);
      assert.equal(card.freshness.observedAt, existing.observedAt);
      const reference = board.resolvedArea!.reference;
      assert.ok(Math.abs(card.proximity.distanceNm - haversineNm({ lat: reference.latitude, lon: reference.longitude }, { lat: existing.latitude, lon: existing.longitude })) < 1e-10);
      assert.equal(heading(card.position), null, "nearby contract has no heading; no invented orientation");
    }
  }
  assert.deepEqual(boards[0]!.flights.map(c => c.position), boards[1]!.flights.map(c => c.position));
  assert.deepEqual(boards[0]!.flights.map(c => c.position), boards[2]!.flights.map(c => c.position));
  const point = boards[0]!.flights[0]!.position;
  const projections = boards.map(b => project(point, b.resolvedArea!.reference, 640, 420, 20));
  assert.notEqual(projections[0].x, projections[1].x);
  assert.notEqual(projections[1].y, projections[2].y);
});

test("Fixture response excludes aircraft outside the requested area before applying limit", () => {
  const result = proofFixtureResult({ area: { kind: "airport", code: "ORD" }, radiusNm: 12, limit: 4, includePosition: true }).structuredContent;
  assert.equal(result.flights.length, 1);
  assert.equal(result.flights[0]!.identity.displayIdent, "UAL1847");
  assert.ok(result.flights.every(c => c.proximity.distanceNm <= 12));
});

test("Radar fits deterministic airport and aircraft coordinates with valid mobile geometry", () => {
  const board = proofFixtureResult({ area: { kind: "preset", nameOrId: "chicago" }, includePosition: true }).structuredContent;
  const airports = [areaDefinition("airport:KORD").reference, areaDefinition("airport:KMDW").reference];
  const points = [...airports, ...board.flights.map(c => c.position)];
  const fitted = radius(board.resolvedArea!.reference, points, board.resolvedArea!.radiusNm);
  assert.equal(fitted, 12);
  assert.equal(fitted, radius(board.resolvedArea!.reference, points, board.resolvedArea!.radiusNm));
  for (const point of points) assert.equal(project(point, board.resolvedArea!.reference, 351, 340, fitted).inView, true);
});

test("Radar UI remains self-contained and passes the same build-time safety check", () => {
  assert.doesNotMatch(html, /__RADAR_AIRPORTS__|__INITIAL_FIXTURE__|__PROOF_NONCE__/);
  const script = html.match(/<script nonce="radar-test-nonce">([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => assertFixtureApplication(script, { widget: true }));
  assert.match(html, /id="track-flight" disabled/);
  assert.doesNotMatch(html, /<script[^>]*\bsrc\s*=|<link[^>]*\bhref\s*=|<img\b|https?:\/\//);
});
