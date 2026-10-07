import test from "node:test";
import assert from "node:assert/strict";
import { usRegistrationHex } from "./us-registration-hex.ts";

test("maps representative FAA N-numbers to their ICAO hex addresses", () => {
  assert.equal(usRegistrationHex("N1"), "a00001");
  assert.equal(usRegistrationHex("N116B"), "a04296");
  assert.equal(usRegistrationHex("N156AN"), "a0e086");
  assert.equal(usRegistrationHex("N832NV"), "ab6108");
  assert.equal(usRegistrationHex("N99999"), "adf7c7");
});

test("accepts normal formatting and rejects non-US or invalid registrations", () => {
  assert.equal(usRegistrationHex("N-7865A"), "aaa9d8");
  assert.equal(usRegistrationHex("G-ABCD"), null);
  assert.equal(usRegistrationHex("N0123"), null);
  assert.equal(usRegistrationHex("N123IO"), null);
});
