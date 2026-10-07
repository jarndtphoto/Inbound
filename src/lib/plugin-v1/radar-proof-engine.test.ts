import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeRadarProofService, FAKE_RADAR_AIRCRAFT_COUNT, FAKE_RADAR_RETIRING_ID, FAKE_RADAR_TRACKLESS_ID } from "./radar-proof-engine.server";
import { areaDefinition } from "./areas";
import { serializeNearbyResponse, PUBLIC_NEARBY_PAYLOAD_BYTES } from "./nearby-response";
import { deriveNearbyDisplayPosition } from "../nearby-v1/motion";
import { haversineNm } from "../geo";
import { projectRadarPoint } from "./radar-renderer";
import type { NearbyRadarObservation } from "../nearby-v1/views";

const NOW = Date.parse("2030-01-15T18:00:06.000Z");
const position = (row: NearbyRadarObservation, at: number) => deriveNearbyDisplayPosition({ ...row,
  onGround: false, acceptedPosition: true }, at)!;
function assertDistinctMobileCenters(rows: NearbyRadarObservation[], at: number) {
  const points = rows.map(row => projectRadarPoint(position(row, at), areaDefinition("preset:chicago").reference, 351, 340, 38)!);
  assert.equal(new Set(points.map(point => `${Math.round(point.x)}:${Math.round(point.y)}`)).size, points.length);
  for (let index = 0; index < points.length; index++) for (let other = index + 1; other < points.length; other++) {
    assert.ok(Math.hypot(points[index].x - points[other].x, points[index].y - points[other].y) >= 3,
      "mobile overview aircraft centers remain distinct at initial and authoritative proof fixes");
  }
  assert.ok(Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)) >= 120,
    "invented overflights exercise a wider area than the airport clusters");
}

test("100 cold proof viewers share one actual engine collection acquisition and zero route work", async () => {
  const service = await createFakeRadarProofService({ clock: () => NOW, warmRoutes: false });
  try {
    const cold = await Promise.all(Array.from({ length: 100 }, () => service.request("preset:chicago")));
    assert.equal(service.diagnostics().fakeAcquisitions, 1);
    assert.equal(service.diagnostics().leaseWinners, 1);
    assert.equal(service.diagnostics().fakeRouteLookups, 0);
    assert.equal(service.diagnostics().explicitConstructionTasks, 0);
    assert.ok(cold.some(response => response.view?.radar.length === FAKE_RADAR_AIRCRAFT_COUNT));
    const warm = await Promise.all(Array.from({ length: 100 }, () => service.request("preset:chicago")));
    assert.ok(warm.every(response => response.view?.radar.length === 40 && response.view.featured.length === 4));
    assert.equal(service.diagnostics().collectionRows, 1);
    assert.equal(service.diagnostics().collectionVersion, 1);
    assert.equal(service.diagnostics().fakeAcquisitions, 1);
    assert.equal(service.diagnostics().fakeRouteLookups, 0);
  } finally { service.dispose(); }
});

test("explicit proof initialization exercises the real route layer without viewer construction", async () => {
  const service = await createFakeRadarProofService({ clock: () => NOW });
  try {
    const initial = service.diagnostics();
    assert.equal(initial.fakeRouteLookups, 2);
    assert.equal(initial.chargedRouteStarts, 2);
    assert.equal(initial.explicitConstructionTasks, 1);
    const response = await service.request("preset:chicago");
    assert.equal(response.view!.featured.length, 4);
    const verification = response.view!.featured.map(row => row.route.verification);
    assert.ok(verification.includes("confirmed"));
    assert.ok(verification.includes("hint"));
    assert.ok(verification.includes("unknown"));
    const confirmed = response.view!.ranked.filter(row => row.route.verification === "confirmed");
    assert.equal(confirmed.length, 2);
    assert.ok(confirmed.some(row => row.route.originIata === "ORD" && row.route.destinationIata === "BOS"));
    assert.ok(confirmed.some(row => row.route.originIata === "MDW" && row.route.destinationIata === "DEN"));
    await Promise.all(Array.from({ length: 100 }, () => service.request("preset:chicago")));
    assert.equal(service.diagnostics().fakeRouteLookups, 2);
    assert.equal(service.diagnostics().explicitConstructionTasks, 1);
    assert.deepEqual(service.diagnostics().routeStarts.map(start => start.callsign).sort(), ["SYN103", "SYN104"]);
  } finally { service.dispose(); }
});

test("100 explicit fake construction workers share two starts per collection and six per minute", async () => {
  let at = NOW;
  const service = await createFakeRadarProofService({ clock: () => at, warmRoutes: false });
  try {
    await service.request("preset:chicago");
    const construct = () => Promise.all(Array.from({ length: 100 }, () => service.constructRoutes()));
    assert.equal((await construct()).reduce((sum, item) => sum + item.lookupsStarted, 0), 2);
    assert.equal(service.diagnostics().fakeRouteLookups, 2);
    assert.equal((await construct()).reduce((sum, item) => sum + item.lookupsStarted, 0), 0);
    for (const elapsed of [20_000, 40_000]) {
      at = NOW + elapsed;
      await service.requestRadar("preset:chicago");
      assert.equal((await construct()).reduce((sum, item) => sum + item.lookupsStarted, 0), 2);
    }
    assert.equal(service.diagnostics().fakeRouteLookups, 6);
    at = NOW + 59_999;
    await service.requestRadar("preset:chicago");
    assert.equal((await construct()).reduce((sum, item) => sum + item.lookupsStarted, 0), 0);
    at = NOW + 60_000;
    await service.requestRadar("preset:chicago");
    assert.equal((await construct()).reduce((sum, item) => sum + item.lookupsStarted, 0), 2);
    assert.equal(service.diagnostics().fakeRouteLookups, 8);
    for (const start of service.diagnostics().routeStarts) {
      assert.ok(service.diagnostics().routeStarts.filter(other => other.atMs > start.atMs - 60_000 && other.atMs <= start.atMs).length <= 6);
    }
  } finally { service.dispose(); }
});

test("Chicago, ORD and MDW use forty invented targets from one shared collection version", async () => {
  const service = await createFakeRadarProofService({ clock: () => NOW });
  try {
    const responses = await Promise.all(["preset:chicago", "airport:KORD", "airport:KMDW"].map(area => service.request(area as "preset:chicago" | "airport:KORD" | "airport:KMDW", { limit: 5 })));
    assert.ok(responses.every(response => response.view!.collectionVersion === 1 && response.view!.radar.length === 40 && response.view!.featured.length === 5));
    assert.equal(new Set(responses.map(response => response.view!.collectionKey)).size, 1);
    assert.equal(service.diagnostics().fakeAcquisitions, 1);
    assert.equal(service.diagnostics().fakeRouteLookups, 2);
    assert.notEqual(responses[0].view!.radar[0].distanceNm, responses[1].view!.radar[0].distanceNm);
    assert.equal(new Set(responses[0].view!.radar.map(row => row.radarId)).size, 40);
    assert.ok(responses[0].view!.radar.every(row => /^SYN1[0-4][0-9]$/.test(row.displayIdent)));
    assertDistinctMobileCenters(responses[0].view!.radar, NOW);
  } finally { service.dispose(); }
});

test("authoritative twenty-second fixes replace the trajectory and movement reuses the certified bound", async () => {
  let at = NOW;
  const service = await createFakeRadarProofService({ clock: () => at });
  try {
    const firstRadar = (await service.request("preset:chicago")).view!.radar;
    assertDistinctMobileCenters(firstRadar, NOW);
    const first = firstRadar.find(row => row.displayIdent === "SYN101")!;
    const before = structuredClone(first);
    const frame = position(first, NOW + 10_000);
    assert.equal(frame.kind, "extrapolated");
    assert.equal(frame.extrapolatedSeconds, 10);
    assert.ok(haversineNm({ lat: first.latitude, lon: first.longitude }, { lat: frame.latitude, lon: frame.longitude }) > .4);
    const stopped = position(first, NOW + 25_000);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.extrapolatedSeconds, 25);
    assert.deepEqual(position(first, NOW + 44_000).latitude, stopped.latitude);
    assert.equal(position(first, NOW + 44_000).altitudeFt, first.altitudeFt);
    assert.deepEqual(first, before, "animation never mutates an accepted fix");
    at += 20_000;
    const secondRadar = (await service.request("preset:chicago")).view!.radar;
    assertDistinctMobileCenters(secondRadar, at);
    const second = secondRadar.find(row => row.radarId === first.radarId)!;
    assert.equal(second.observedAt, new Date(at).toISOString());
    assert.notEqual(second.latitude, first.latitude);
    assert.notEqual(second.groundTrackDeg, first.groundTrackDeg);
    assert.ok(haversineNm({ lat: second.latitude, lon: second.longitude }, { lat: position(first, at).latitude, lon: position(first, at).longitude }) < .3,
      "authoritative curved-path correction remains physically close to accepted-track extrapolation");
    assert.equal(position(second, at).kind, "accepted");
    assert.equal(position(second, at + 10_000).extrapolatedSeconds, 10);
    assert.equal(service.diagnostics().fakeAcquisitions, 2);
    assert.equal(service.diagnostics().collectionVersion, 2);
    at += 20_000;
    assertDistinctMobileCenters((await service.request("preset:chicago")).view!.radar, at);
    assert.equal(service.diagnostics().fakeAcquisitions, 3);
    assert.equal(service.diagnostics().fakeRouteLookups, 2, "refresh never starts route work");
  } finally { service.dispose(); }
});

test("the missing-track proof target never invents direction or drift", async () => {
  const service = await createFakeRadarProofService({ clock: () => NOW });
  try {
    const target = (await service.request("preset:chicago")).view!.radar.find(row => row.radarId === FAKE_RADAR_TRACKLESS_ID)!;
    assert.equal(target.groundTrackDeg, null);
    for (const elapsed of [0, 10_000, 25_000, 60_000]) {
      const display = position(target, NOW + elapsed);
      assert.equal(display.latitude, target.latitude);
      assert.equal(display.longitude, target.longitude);
      assert.equal(display.kind, "accepted");
      assert.equal(display.stopped, true);
    }
  } finally { service.dispose(); }
});

test("an old invented target is visible but stopped when stale, then retires without invented replacement", async () => {
  let at = NOW;
  const service = await createFakeRadarProofService({ clock: () => at });
  try {
    const original = (await service.request("preset:chicago")).view!.radar.find(row => row.radarId === FAKE_RADAR_RETIRING_ID)!;
    assert.equal(original.freshness.ageSeconds, 40);
    at += 6_000;
    const stale = await service.request("preset:chicago");
    const target = stale.view!.radar.find(row => row.radarId === FAKE_RADAR_RETIRING_ID)!;
    assert.equal(stale.health, "stale");
    assert.equal(target.freshness.state, "stale");
    assert.equal(position(target, at).stopped, true);
    at = NOW + 20_000;
    const refreshed = await service.request("preset:chicago");
    assert.equal(refreshed.view!.radar.length, 39);
    assert.equal(refreshed.view!.radar.some(row => row.radarId === FAKE_RADAR_RETIRING_ID), false);
    assert.equal(position(original, NOW + 80_001).freshness.state, "expired");
    assert.equal(service.diagnostics().historyRows, 0);
  } finally { service.dispose(); }
});

test("partial, stale and unavailable proof scenarios use actual engine health semantics", async () => {
  for (const scenario of ["partial", "stale", "unavailable"] as const) {
    const service = await createFakeRadarProofService({ clock: () => NOW, scenario });
    try {
      const response = await service.request("preset:chicago");
      assert.equal(response.health, scenario);
      if (scenario === "unavailable") assert.equal(response.view, null);
      else {
        assert.ok(response.view!.radar.length >= 39);
        if (scenario === "stale") assert.ok(response.view!.radar.every(row => position(row, NOW).stopped));
      }
      assert.equal(service.diagnostics().providerApiCalls, 0);
      assert.equal(service.diagnostics().productionApiCalls, 0);
      assert.equal(service.diagnostics().productionDbAccess, 0);
    } finally { service.dispose(); }
  }
});

test("route lookup failure preserves all Radar aircraft and cannot cause viewer retries", async () => {
  const service = await createFakeRadarProofService({ clock: () => NOW, scenario: "route-failure" });
  try {
    const initial = await service.request("preset:chicago");
    const selected = initial.view!.featured.map(row => row.candidate.cardId);
    assert.equal(initial.view!.radar.length, 40);
    assert.equal(service.diagnostics().fakeRouteLookups, 2);
    const requests = await Promise.all(Array.from({ length: 100 }, () => service.request("preset:chicago")));
    assert.ok(requests.every(response => response.view!.radar.length === 40));
    assert.ok(requests.every(response => JSON.stringify(response.view!.featured.map(row => row.candidate.cardId)) === JSON.stringify(selected)));
    assert.equal(service.diagnostics().fakeRouteLookups, 2);
    assert.equal((await service.constructRoutes()).lookupsStarted, 0);
    assert.equal(service.diagnostics().fakeAcquisitions, 1);
  } finally { service.dispose(); }
});

test("the engine-backed public proof serializes forty targets and route states within its byte boundary", async () => {
  const service = await createFakeRadarProofService({ clock: () => NOW });
  try {
    const response = serializeNearbyResponse(await service.request("preset:chicago", { limit: 5 }), areaDefinition("preset:chicago"), NOW);
    assert.equal(response.radarTargets.length, 40);
    assert.equal(response.featuredFlights.length, 5);
    const encoded = JSON.stringify(response);
    assert.ok(new TextEncoder().encode(encoded).byteLength <= PUBLIC_NEARBY_PAYLOAD_BYTES);
    for (const privateText of ["invented-radar-aircraft", "invented-radar-session", "phaseEvidence", "datedBinding", "sourceClass",
      "providerCalls", "routeStarts", "environment", "collectionKey", "sessionKey", "registration", "leaseOwner", "fencingGeneration"]) {
      assert.equal(encoded.includes(privateText), false, privateText);
    }
    assert.equal(response.radarTargets.find(row => row.radarId === FAKE_RADAR_TRACKLESS_ID)!.groundTrackDeg, null);
    assert.ok(response.featuredFlights.some(row => row.route.verification === "hint"));
    assert.ok(response.featuredFlights.some(row => row.route.verification === "unknown"));
    assert.ok(response.featuredFlights.some(row => row.route.verification === "confirmed"));
  } finally { service.dispose(); }
});

test("the isolated proof needs no database URL and makes no fetch calls", async () => {
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("External request prohibited in fake proof"); }) as typeof fetch;
  const service = await createFakeRadarProofService({ clock: () => NOW });
  try {
    await service.request("preset:chicago");
    await service.request("airport:KORD");
    await service.request("airport:KMDW");
    assert.equal(outbound, 0);
    assert.equal(service.diagnostics().providerApiCalls, 0);
    assert.equal(service.diagnostics().productionDbAccess, 0);
  } finally { service.dispose(); globalThis.fetch = originalFetch; }
  await assert.rejects(service.request("preset:chicago"), /disposed/);
});
