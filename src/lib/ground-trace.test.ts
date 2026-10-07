import test from "node:test";
import assert from "node:assert/strict";
import { parseRecentGroundTrace } from "./ground-trace.ts";
const airport = { lat: 41.98, lon: -87.9 };
const identity = { registration: "N123AA", callsign: "AAL600" };
const payload = { timestamp: 1_700_000_000, trace: [[0, 41.98, -87.9, "ground", 10, 90]] };

test("cached trace rereads retain original observation timestamp and expire", () => {
  const initial = parseRecentGroundTrace(payload, airport, identity, 1_700_000_010_000);
  const replayed = parseRecentGroundTrace(payload, airport, identity, 1_700_000_110_000);
  assert.equal(initial?.seenAt, 1_700_000_000);
  assert.equal(replayed?.seenAt, initial?.seenAt);
  assert.equal(parseRecentGroundTrace(payload, airport, identity, 1_700_000_121_000), null);
});

test("shared hex trace cannot be reused as a ground fix at another airport", () => {
  assert.equal(parseRecentGroundTrace(payload, { lat: 35.88, lon: -78.78 }, identity, 1_700_000_010_000), null);
  assert.equal(parseRecentGroundTrace({ ...payload, trace: [[0, NaN, -87.9, "ground", 10, 90]] }, airport, identity, 1_700_000_010_000), null);
});
