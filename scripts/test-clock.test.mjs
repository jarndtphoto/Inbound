import { test } from "node:test";
import assert from "node:assert/strict";
import { installTestClock } from "./test-clock.mjs";

test("replay wall clock keeps Date.now, new Date and Date() together as a historical replay advances", () => {
  const OriginalDate = Date;
  const originalNow = Date.now;
  let now = Date.parse("2026-10-02T23:27:31.844Z");
  const restore = installTestClock(() => now);
  try {
    assert.equal(Date.now(), now);
    assert.equal(new Date().getTime(), now);
    assert.equal(Date(), new OriginalDate(now).toString());
    assert.equal(new Date().toISOString(), "2026-10-02T23:27:31.844Z");
    now += 2 * 3_600_000;
    assert.equal(Date.now(), now);
    assert.equal(new Date().toISOString(), "2026-10-03T01:27:31.844Z");
  } finally { restore(); }
  assert.equal(Date, OriginalDate);
  assert.equal(Date.now, originalNow);
});

test("replay wall clock preserves explicit Date arguments, statics, subclasses and instanceof", () => {
  const OriginalDate = Date;
  const restore = installTestClock(1_000);
  try {
    assert.equal(new Date(0).getTime(), 0);
    assert.equal(new Date("2026-01-02T03:04:05Z").toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(new Date(2026, 0, 2, 3, 4, 5).getTime(), new OriginalDate(2026, 0, 2, 3, 4, 5).getTime());
    assert.equal(Date.parse("2026-01-02T03:04:05Z"), OriginalDate.parse("2026-01-02T03:04:05Z"));
    assert.equal(Date.UTC(2026, 0, 2), OriginalDate.UTC(2026, 0, 2));
    assert.ok(new Date() instanceof Date);
    assert.ok(new OriginalDate(0) instanceof Date);
    class ReplayDate extends Date {}
    assert.equal(new ReplayDate().getTime(), 1_000);
    assert.ok(new ReplayDate() instanceof ReplayDate);
  } finally { restore(); }
  assert.equal(Date, OriginalDate);
});
