import { test } from "node:test";
import assert from "node:assert/strict";
import { areaDefinition } from "./areas";
import { scoreCandidate, type RankedCandidate } from "./ranking";
import { stablePrefix, updateStableView, RANKING_RETENTION_MS, type NearbyStabilityState } from "./stability";
import { FIXTURE_NOW_MS, fixtureId, fixtureRankingCandidate } from "./fixtures";

const viewKey = "preset:chicago:38:ranking-v1";
function row(id: number, score: number, distanceNm = id): RankedCandidate {
  const c = fixtureRankingCandidate(); c.cardId = fixtureId(id); c.privateAircraftIdentity = `fixture-${id}`;
  const r = scoreCandidate(c, areaDefinition("preset:chicago"), FIXTURE_NOW_MS)!;
  return { ...r, score, distanceNm };
}
const firstRows = [row(1, 100), row(2, 90), row(3, 80), row(4, 70), row(5, 60)];
const update = (previous: NearbyStabilityState | null, ranked: RankedCandidate[], version: number, seconds: number, success = true) => updateStableView(previous, { viewKey, collectionVersion: version, nowMs: FIXTURE_NOW_MS + seconds * 1000, successfulCollection: success, ranked });
test("Shared top five and all one-to-five limits use one deterministic prefix", () => {
  const state = update(null, [...firstRows].reverse(), 1, 0)!;
  assert.deepEqual(stablePrefix(state, 5), [1, 2, 3, 4, 5].map(fixtureId));
  for (let limit = 1; limit <= 5; limit++) assert.deepEqual(stablePrefix(state, limit), stablePrefix(state, 5).slice(0, limit));
  assert.throws(() => stablePrefix(state, 6));
});
test("Incumbents are held for 90 seconds despite a large challenger score", () => {
  const first = update(null, firstRows, 1, 0)!;
  const before = update(first, [...firstRows, row(6, 128)], 2, 89.999)!;
  assert.deepEqual(before.slots, first.slots);
  const after = update(before, [...firstRows, row(6, 128)], 3, 90)!;
  assert.deepEqual(stablePrefix(after, 5), [1, 2, 3, 4, 6].map(fixtureId));
  assert.equal(after.slots[4]!.pickedAtMs, FIXTURE_NOW_MS + 90000);
});
test("Twenty-point margin is inclusive; one competitive replacement per version", () => {
  const first = update(null, firstRows, 1, 0)!;
  assert.deepEqual(update(first, [...firstRows, row(6, 79)], 2, 90)!.slots, first.slots);
  const replaced = update(first, [...firstRows, row(6, 80), row(7, 79)], 2, 90)!;
  assert.deepEqual(stablePrefix(replaced, 5), [1, 2, 3, 4, 6].map(fixtureId));
  const reread = update(replaced, [...firstRows, row(6, 128), row(7, 128)], 2, 100)!;
  assert.deepEqual(reread.slots, replaced.slots);
  const old = update(replaced, [...firstRows, row(7, 128)], 1, 100)!; assert.deepEqual(old.slots, replaced.slots);
});
test("Hard removal bypasses hold, fills vacancies, and preserves surviving relative order", () => {
  const first = update(null, firstRows, 1, 0)!;
  const next = update(first, [row(1, 50), row(3, 120), row(5, 70), row(6, 100), row(7, 90)], 2, 20)!;
  assert.deepEqual(stablePrefix(next, 5), [1, 3, 5, 6, 7].map(fixtureId));
  assert.equal(next.slots[0]!.pickedAtMs, FIXTURE_NOW_MS); assert.equal(next.slots[3]!.pickedAtMs, FIXTURE_NOW_MS + 20000);
  assert.equal(update(next, [], 3, 40)!.slots.length, 0);
});
test("Changing scores never sorts incumbents; reverse ranking tie breaks select the worst", () => {
  const first = update(null, firstRows, 1, 0)!;
  const shuffled = update(first, [row(1, 60), row(2, 110), row(3, 90), row(4, 60), row(5, 60), row(6, 80)], 2, 90)!;
  assert.deepEqual(stablePrefix(shuffled, 5), [1, 2, 3, 4, 6].map(fixtureId));
});
test("Outage does not rank or replace; cold failure has no board; inactive state expires", () => {
  const first = update(null, firstRows, 1, 0)!;
  assert.equal(update(null, firstRows, 1, 0, false), null);
  assert.deepEqual(update(first, [row(6, 128)], 2, 100, false)!.slots, first.slots);
  const resumed = update(first, [row(6, 70)], 2, RANKING_RETENTION_MS / 1000)!;
  assert.deepEqual(stablePrefix(resumed, 5), [fixtureId(6)]); assert.equal(resumed.slots[0]!.pickedAtMs, FIXTURE_NOW_MS + RANKING_RETENTION_MS);
  const other = updateStableView(first, { viewKey: "airport:KORD:25:ranking-v1", collectionVersion: 1, nowMs: FIXTURE_NOW_MS, successfulCollection: true, ranked: [row(6, 70)] });
  assert.deepEqual(stablePrefix(other, 5), [fixtureId(6)]);
});
