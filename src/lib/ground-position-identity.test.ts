import test from "node:test";
import assert from "node:assert/strict";
import { resolveGroundIdentity } from "./ground-position-identity.ts";
import { groundPositionQueryKey } from "./ground-position-key.ts";

test("current registration replaces cached aircraft hex while same-tail recovery survives", () => {
  const saved = { hex: "abcdef", registration: "N123AA", callsign: "AAL600" };
  assert.deepEqual(resolveGroundIdentity({ registration: "N456AA" }, saved), {
    hex: null, registration: "N456AA", callsign: null,
  });
  assert.deepEqual(resolveGroundIdentity({ registration: "N123AA" }, saved), saved);
  assert.deepEqual(resolveGroundIdentity({}, saved), saved);
  assert.equal(resolveGroundIdentity({ registration: "G-NEW" }, { hex: "abcdef" }).hex, null);
  assert.equal(resolveGroundIdentity({ registration: "n-123aa" }, saved).hex, "abcdef");
  assert.deepEqual(resolveGroundIdentity({ hex: "654321" }, saved), {
    hex: "654321", registration: null, callsign: null,
  });
});

test("ground query cache partitions aircraft reassignment", () => {
  const scope = { stateKey: "leg:v1:AAL600|2026-10-07|ORD|RDU", airportIata: "ORD", movementKind: "departure" as const };
  assert.notDeepEqual(groundPositionQueryKey({ ...scope, registration: "N123AA" }),
    groundPositionQueryKey({ ...scope, registration: "N456AA" }));
});

test("knowing a hex in addition to the same tail preserves shared recovery cache", () => {
  const scope = { stateKey: "leg:v1:AAL600|2026-10-07|ORD|RDU", airportIata: "ORD", movementKind: "departure" as const, registration: "N123AA" };
  assert.deepEqual(groundPositionQueryKey(scope), groundPositionQueryKey({ ...scope, hex: "abcdef" }));
});
