import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { phaseOf } from "../traffic-motion";
import { destPoint } from "../geo";
import { areaDefinition } from "./areas";
import { compareRank, currentRoute, rankNearbyCandidates, scoreCandidate, verticalTrend, type NearbyCandidate } from "./ranking";
import { FIXTURE_NOW_MS, fixtureId, fixtureRankingCandidate, fixtureTime, rankingFixtures } from "./fixtures";

const area = areaDefinition("preset:chicago");
function scored(c: NearbyCandidate) { const result = scoreCandidate(c, area, FIXTURE_NOW_MS); assert.ok(result); return result; }
test("Existing six-value classifier body is verbatim and its boundaries agree", () => {
  const baseline = execFileSync("git", ["show", "151cee0cd790d5a19e81c12e448ee3eb125dfdf6:src/lib/sky.ts"], { encoding: "utf8" });
  const shared = readFileSync(new URL("../traffic-motion.ts", import.meta.url), "utf8");
  const body = (source: string) => source.match(/function phaseOf\([\s\S]*?\): Traffic\["phase"\] \{([\s\S]*?)\n\}/)![1];
  assert.equal(body(shared), body(baseline));
  // Execute the original body itself rather than mirroring the implementation.
  const original = new Function("ac", body(baseline)) as typeof phaseOf;
  for (const onGround of [false, true]) for (const gsKt of [null, 0, 8, 8.001, 40]) for (const altFt of [null, 499, 7999, 8000, 11999, 12000, 35000]) for (const vertFpm of [null, -401, -400, -251, -250, 0, 250, 400, 401]) assert.equal(phaseOf({ onGround, gsKt, altFt, vertFpm }), original({ onGround, gsKt, altFt, vertFpm }));
});
test("Separate vertical trend preserves thresholds without changing phase math", () => {
  assert.equal(verticalTrend(250), "rising"); assert.equal(verticalTrend(249.999), "level"); assert.equal(verticalTrend(-250), "falling"); assert.equal(verticalTrend(-249.999), "level"); assert.equal(verticalTrend(null), "unknown");
  const c = fixtureRankingCandidate(); c.altitudeFt = 35000; c.verticalRateFpm = 800;
  const r = scored(c); assert.equal(r.motion.phase, "cruise"); assert.equal(r.motion.label, "In flight"); assert.equal(r.motion.verticalTrend, "rising");
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
