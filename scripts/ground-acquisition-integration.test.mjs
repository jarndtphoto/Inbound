import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const fixture = { calls: [], run: () => [], saved: null };
globalThis.__groundAcquisitionFixture = fixture;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const serverFn = moduleUrl(`export const createServerFn = () => ({ validator(validate) { return { handler(run) { return ({ data }) => run({ data: validate(data) }); } }; } });`);
const fusion = moduleUrl(`const fixture = globalThis.__groundAcquisitionFixture;
const run = async (route, key) => { fixture.calls.push([route, key]); return [{provider: "fi", status: "ok", ac: fixture.run(route, key)}]; };
export const fetchByHex = (key) => run("hex", key);
export const fetchByReg = (key) => run("registration", key);
export const fetchByCallsign = (key) => run("callsign", key);
export const fetchAround = () => run("area", "airport");
export const fuseProviderLists = (packs) => packs.flatMap(pack => pack.ac);`);
const store = moduleUrl(`export const flightGroundStateStore = { load: async () => globalThis.__groundAcquisitionFixture.saved, save: async () => {} };`);
const shared = moduleUrl(`export const acquireFreeAdsb = async () => { throw new Error("unexpected trace lookup"); };`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/src/lib/ground-position.ts")) {
    const found = specifier === "@tanstack/react-start" ? serverFn
      : specifier === "./adsb-fusion" ? fusion
      : specifier === "./flight-ground-state.server.ts" ? store
      : specifier === "./adsb-acquisition.server.ts" ? shared : null;
    if (found) return { url: found, shortCircuit: true };
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const input = { stateKey: "leg:v1:AAL600|2026-10-07|ORD|RDU", flightNumber: "AA600", callsign: "AAL600",
  originIata: "ORD", destIata: "RDU", airportIata: "ORD", movementKind: "departure", airportLat: 41.98, airportLon: -87.9,
  registration: "N456AA", hex: "abcdef" };
const raw = { hex: "abcdef", r: "N456AA", flight: "AAL600", lat: 41.98, lon: -87.9, alt_baro: "ground", seen_pos: 2 };

test("ground handler exact hit starts only strongest acquisition", async () => {
  fixture.calls = []; fixture.saved = null; fixture.run = () => [raw];
  const { getGroundPosition } = await import("../src/lib/ground-position.ts?strong");
  const result = await getGroundPosition({ data: input });
  assert.equal(result.registration, "N456AA");
  assert.deepEqual(fixture.calls, [["hex", "abcdef"]]);
});

test("ground handler rejects old-tail area result then accepts valid current callsign fallback", async () => {
  fixture.calls = [];
  fixture.saved = { registration: "N123AA", hex: "123abc", callsign: "AAL599" };
  fixture.run = (route) => route === "area" ? [{ ...raw, hex: "123abc", r: "N123AA" }]
    : route === "callsign" ? [raw] : [];
  const { getGroundPosition } = await import("../src/lib/ground-position.ts?alias");
  const result = await getGroundPosition({ data: input });
  assert.equal(result.registration, "N456AA");
  assert.deepEqual(fixture.calls, [["hex", "abcdef"], ["area", "airport"], ["callsign", "AAL600"]]);
  assert.ok(!fixture.calls.some(([, key]) => key === "123abc" || key === "AAL599"));
});
