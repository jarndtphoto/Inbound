import test from "node:test";
import assert from "node:assert/strict";
import { acquireGroundInStages } from "./ground-acquisition.ts";

test("strong exact identity success never starts area or alias provider work", async () => {
  const calls: string[] = [];
  const route = (name: string, value: string | null) => ({ route: name, run: async () => { calls.push(name); return value; } });
  assert.deepEqual(await acquireGroundInStages({ strongest: route("hex", "fix"), area: route("area", "area-fix"), aliases: [route("callsign", "alias-fix")] }), { route: "hex", position: "fix" });
  assert.deepEqual(calls, ["hex"]);
});

test("after strong and area misses bounded alias fallback can recover a valid identity", async () => {
  const calls: string[] = [];
  const route = (name: string, value: string | null) => ({ route: name, run: async () => { calls.push(name); return value; } });
  const result = await acquireGroundInStages({ strongest: route("hex", null), area: route("area", null), aliases: [route("callsign", null), route("registration", "valid-current-tail"), route("old-callsign", "must-not-run")] });
  assert.deepEqual(result, { route: "registration", position: "valid-current-tail" });
  assert.deepEqual(calls, ["hex", "area", "callsign", "registration"]);
});

test("all misses and failures end after at most two aliases", async () => {
  const calls: string[] = [];
  const miss = (name: string) => ({ route: name, run: async () => { calls.push(name); throw new Error("provider failed"); } });
  assert.equal(await acquireGroundInStages({ strongest: miss("hex"), area: miss("area"), aliases: [miss("alias1"), miss("alias2"), miss("alias3")] }), null);
  assert.deepEqual(calls, ["hex", "area", "alias1", "alias2"]);
});
