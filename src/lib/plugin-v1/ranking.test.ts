import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseOf } from "../aircraft-phase";
import { AIRPORT_BY_IATA } from "../airports";
import { destPoint } from "../geo";
import { areaDefinition } from "./areas";
import { compareRank, currentRoute, rankNearbyCandidates, scoreCandidate, verticalTrend, type NearbyCandidate } from "./ranking";
import { FIXTURE_NOW_MS, fixtureId, fixtureRankingCandidate, fixtureTime, rankingFixtures } from "./fixtures";

const area = areaDefinition("preset:chicago");
function scored(c: NearbyCandidate) { const result = scoreCandidate(c, area, FIXTURE_NOW_MS); assert.ok(result); return result; }
test("Plugin phase shares Inbound's sustained evidence rules while raw display trend remains instantaneous", () => {
  const c = { ...fixtureRankingCandidate(), altitudeFt: 20000,
    route: { originIata: null, destinationIata: null, verification: "unknown" as const, checkedAt: null }, datedBinding: null };
  const seenAt = Date.parse(c.observedAt!) / 1000;
  for (const verticalRateFpm of [-650, -400, -300, -250, 250, 300, 400, 650]) {
    const candidate = { ...c, verticalRateFpm };
    assert.equal(scored(candidate).motion.phase, "cruise");
    assert.equal(scored(candidate).motion.phase, phaseOf({ seenAt, lat: c.latitude, lon: c.longitude, altFt: c.altitudeFt, vertFpm: verticalRateFpm, onGround: false }));
  }
  for (const span of [29, 30, 40]) {
    const candidate: NearbyCandidate = { ...c, verticalRateFpm: 650, phaseEvidence: [[seenAt - span, 19500, 650, false, c.latitude, c.longitude]] };
    const r = scored(candidate);
    assert.equal(r.motion.phase, span < 30 ? "cruise" : "climb");
    assert.equal(r.motion.phase, phaseOf({ seenAt, lat: c.latitude, lon: c.longitude, altFt: 20000, vertFpm: 650, onGround: false },
      { history: [{ seenAt: seenAt - span, altFt: 19500, vertFpm: 650, onGround: false, lat: c.latitude, lon: c.longitude }] }));
    assert.equal(scored({ ...candidate, positionKind: "extrapolated" }).motion.phase, "cruise");
  }
  const flat: NearbyCandidate = { ...c, verticalRateFpm: -650, phaseEvidence: [[seenAt - 40, 20000, -650, false, c.latitude, c.longitude]] };
  assert.equal(scored(flat).motion.phase, "cruise"); assert.equal(scored(flat).motion.verticalTrend, "falling");
});
test("Display-only vertical trend preserves its separate +/-250 fpm thresholds", () => {
  assert.equal(verticalTrend(250), "rising"); assert.equal(verticalTrend(249.999), "level"); assert.equal(verticalTrend(-250), "falling"); assert.equal(verticalTrend(-249.999), "level"); assert.equal(verticalTrend(null), "unknown");
  const c = fixtureRankingCandidate(); c.altitudeFt = 35000; c.verticalRateFpm = 800;
  const r = scored(c); assert.equal(r.motion.phase, "cruise"); assert.equal(r.motion.label, "In flight"); assert.equal(r.motion.verticalTrend, "rising");
});
test("Shared destination geometry requires confirmed dated routes before an approach label", () => {
  const c = fixtureRankingCandidate(1); c.altitudeFt = 8300; c.verticalRateFpm = -650;
  c.route = { ...c.route, originIata: "BOS", destinationIata: "ORD" };
  const seenAt = Date.parse(c.observedAt!) / 1000;
  c.phaseEvidence = [[seenAt - 40, 8800, -650, false, c.latitude, c.longitude]];
  assert.equal(scored(c).motion.phase, "approach");
  assert.equal(scored(c).motion.phase, phaseOf({ seenAt, lat: c.latitude, lon: c.longitude, altFt: c.altitudeFt, vertFpm: c.verticalRateFpm, onGround: false },
    { origin: AIRPORT_BY_IATA.BOS, dest: AIRPORT_BY_IATA.ORD, history: [{ seenAt: seenAt - 40, altFt: 8800, vertFpm: -650, onGround: false, lat: c.latitude, lon: c.longitude }] }));
  assert.equal(scored({ ...c, datedBinding: null }).motion.phase, "descent");
});
test("Every hard eligibility exclusion is enforced, while unknown route/private identity remains eligible", () => {
  const overrides: Partial<NearbyCandidate>[] = [
    { acceptedPosition: false }, { positionKind: "synthetic" }, { identityConflict: true }, { privateAircraftIdentity: "" }, { sessionKey: "" }, { cardId: "provider-id" },
    { latitude: NaN }, { latitude: 91 }, { longitude: Infinity }, { onGround: true }, { altitudeFt: null }, { altitudeFt: 499.99 }, { altitudeFt: NaN }, { groundspeedKt: null }, { groundspeedKt: 39.99 }, { groundspeedKt: Infinity },
    { observedAt: null }, { observedAt: fixtureTime(-45.001) }, { observedAt: fixtureTime(2) }, { verticalRateFpm: NaN }, { typeCode: "SERV" }, { category: "C1" }, { operator: "Airport service" },
    { observedCallsign: null, registration: null }, { observedCallsign: "<raw>", registration: null }, { latitude: 40.64, longitude: -73.78 },
  ];
  for (const override of overrides) assert.equal(scoreCandidate({ ...fixtureRankingCandidate(), ...override }, area, FIXTURE_NOW_MS), null, JSON.stringify(override));
  const edge = fixtureRankingCandidate(3); edge.altitudeFt = 500; edge.groundspeedKt = 40; edge.observedAt = fixtureTime(-45); edge.onGround = null;
  assert.ok(scoreCandidate(edge, area, FIXTURE_NOW_MS));
  const unknown = scored(fixtureRankingCandidate(2)); assert.equal(unknown.route.verification, "unknown");
});
test("Exact score tops out at 128 and bonuses follow the frozen policy", () => {
  const c = fixtureRankingCandidate(1); c.latitude = 41.90; c.longitude = -87.80; c.altitudeFt = 6800; c.interesting = true; c.observedAt = fixtureTime(-20);
  c.phaseEvidence = [[Date.parse(c.observedAt) / 1000 - 40, 6300, 650, false, c.latitude, c.longitude]];
  const max = scored(c); assert.equal(max.score, 128);
  assert.equal(scored({ ...c, positionKind: "extrapolated" }).score, 123);
  assert.equal(scored({ ...c, observedAt: fixtureTime(-20.001) }).score, 123);
  assert.equal(scored({ ...c, observedAt: fixtureTime(-30) }).score, 123);
  assert.equal(scored({ ...c, observedAt: fixtureTime(-30.001) }).score, 118);
  assert.equal(scored({ ...c, observedAt: fixtureTime(-45) }).score, 118);
  assert.equal(scored({ ...c, interesting: false }).score, 123);
  const hint = { ...c, route: { ...c.route, verification: "hint" as const } };
  assert.equal(scored(hint).score, 113); // loses ten route points and five association points
  assert.equal(scored({ ...c, datedBinding: null }).score, 113);
  const high = { ...c, altitudeFt: 12000, verticalRateFpm: -500 }; assert.equal(scored(high).score, 128);
  assert.equal(scored({ ...high, altitudeFt: 12000.1 }).score, 118);
  const p = destPoint({ lat: 41.90, lon: -87.80 }, 0, 4.01);
  assert.equal(scored({ ...c, latitude: p.lat, longitude: p.lon }).score, 124);
});
test("Confirmation ages and aircraft-session binding downgrade safely", () => {
  const c = fixtureRankingCandidate(1);
  assert.equal(currentRoute(c, FIXTURE_NOW_MS).verification, "confirmed");
  assert.equal(currentRoute({ ...c, datedBinding: { ...c.datedBinding!, confirmedAt: fixtureTime(-120.001) } }, FIXTURE_NOW_MS).verification, "hint");
  assert.equal(currentRoute({ ...c, datedBinding: { ...c.datedBinding!, sessionKey: "other-session" } }, FIXTURE_NOW_MS).verification, "hint");
  assert.equal(currentRoute({ ...c, datedBinding: { ...c.datedBinding!, observedCallsign: "UAL1847" } }, FIXTURE_NOW_MS).verification, "hint");
  assert.equal(currentRoute({ ...c, route: { ...c.route, originIata: null, destinationIata: null } }, FIXTURE_NOW_MS).verification, "unknown");
});
test("Ranking ties use score, distance, fix time then opaque card ID; input order is irrelevant", () => {
  const a = scored(fixtureRankingCandidate());
  const b = { ...a, candidate: { ...a.candidate, cardId: fixtureId(9) } };
  assert.ok(compareRank(a, b) < 0);
  assert.ok(compareRank(a, { ...b, observedAtMs: a.observedAtMs - 1 }) < 0);
  assert.ok(compareRank(a, { ...b, distanceNm: a.distanceNm + 0.1 }) < 0);
  assert.ok(compareRank(a, { ...b, score: a.score - 1 }) < 0);
  const normal = rankNearbyCandidates(rankingFixtures, area, FIXTURE_NOW_MS).map(r => r.candidate.cardId);
  assert.deepEqual(rankNearbyCandidates([...rankingFixtures].reverse(), area, FIXTURE_NOW_MS).map(r => r.candidate.cardId), normal);
});
test("Private identity deduplication picks the fresh fix and rejects conflicting sessions", () => {
  const a = fixtureRankingCandidate(); const newer = { ...a, observedAt: fixtureTime(-2), route: { originIata: null, destinationIata: null, verification: "unknown" as const, checkedAt: null } };
  const one = rankNearbyCandidates([a, newer], area, FIXTURE_NOW_MS); assert.equal(one.length, 1); assert.equal(one[0]!.candidate.observedAt, fixtureTime(-2));
  assert.equal(rankNearbyCandidates([a, { ...newer, sessionKey: "different" }], area, FIXTURE_NOW_MS).length, 0);
  assert.equal(rankNearbyCandidates([a, { ...newer, privateAircraftIdentity: "another-aircraft" }], area, FIXTURE_NOW_MS).length, 0);
});
