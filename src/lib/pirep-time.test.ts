import assert from "node:assert/strict";
import { test } from "node:test";
import { isFreshPilotReport, observationTime } from "./pirep-time.ts";

const now = Date.parse("2026-10-04T00:10:00Z");
const raw = "COU UA /OV COU260020/TM2355/FL350/TP B738/TB MOD";

test("AWC numeric UNIX seconds become occurrence milliseconds, independent of receipt time", () => {
  const observedAt = now - 35 * 60_000;
  assert.equal(observationTime({ obsTime: observedAt / 1000, receiptTime: "invalid" }, raw, now), observedAt);
  assert.equal(isFreshPilotReport(observedAt, now), true);
});

test("freshness includes exactly two hours and rejects older, missing and future timestamps", () => {
  assert.equal(isFreshPilotReport(now - 2 * 3600_000, now), true);
  for (const stamp of [now - 2 * 3600_000 - 1, now + 1, 0, NaN, Infinity, undefined])
    assert.equal(isFreshPilotReport(stamp, now), false);
  assert.equal(isFreshPilotReport(now, NaN), false);
});

test("stale and unusable structured occurrence time cannot be rescued by fresh receipt or raw time", () => {
  const stale = now - 3 * 3600_000;
  const receiptTime = "2026-10-04 00:09:00.000Z";
  assert.equal(observationTime({ obsTime: stale / 1000, receiptTime }, raw, now), stale);
  assert.equal(isFreshPilotReport(observationTime({ obsTime: stale / 1000, receiptTime }, raw, now) ?? undefined, now), false);
  for (const obsTime of ["2026-10-03T23:55:00Z", "1699379880", "", NaN, Infinity, -1, (now + 1) / 1000, now])
    assert.equal(observationTime({ obsTime, receiptTime }, raw, now), null);
});

test("raw UTC time resolves across midnight only from a recent dated receipt", () => {
  assert.equal(observationTime({ receiptTime: "2026-10-04 00:08:00.000Z" }, raw, now), Date.parse("2026-10-03T23:55:00Z"));
  assert.equal(observationTime({ receiptTime: "2026-10-04T00:08:00Z" }, "UA /TM0005 /TB LGT", now), Date.parse("2026-10-04T00:05:00Z"));
  assert.equal(observationTime({}, raw, now), null);
  assert.equal(observationTime(null, raw, now), null);
});

test("raw time does not roll tomorrow back into a fresh report or refresh old receipt data", () => {
  const late = Date.parse("2026-10-03T23:55:00Z");
  assert.equal(observationTime({ receiptTime: "2026-10-03T23:54:00Z" }, "UA /TM0005 /TB MOD", late), null);
  assert.equal(observationTime({ receiptTime: "2026-10-04T00:08:00Z" }, "UA /TM0010 /TB MOD", now), null);
  assert.equal(observationTime({ receiptTime: "2026-10-03T21:00:00Z" }, raw, now), null);
  assert.equal(observationTime({ receiptTime: "2026-10-04T00:11:00Z" }, raw, now), null);
});

test("raw fallback rejects invalid or ambiguous UTC times and invalid dates", () => {
  for (const value of ["UA /TM2400 /TB MOD", "UA /TM2360 /TB MOD", "UA /TM235500 /TB MOD", "UA /TM2355 /TM2356", "UA /TB MOD"])
    assert.equal(observationTime({ receiptTime: "2026-10-04T00:08:00Z" }, value, now), null);
  for (const receiptTime of ["2026-10-04T00:08:00", "2026-02-30T00:08:00Z", "invalid"])
    assert.equal(observationTime({ receiptTime }, raw, now), null);
});
