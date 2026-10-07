import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { groundPollingEnabled } from "../src/lib/flight-polling.ts";

const fixture = { calls: [], areaHasAircraft: true };
globalThis.__groundOperatingIdentityFixture = fixture;
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const serverFn = moduleUrl(`export const createServerFn = () => ({ validator(validate) {
  return { handler(run) { return ({ data }) => run({ data: validate(data) }); } };
} });`);
const fusion = moduleUrl(`const fixture = globalThis.__groundOperatingIdentityFixture;
const raw = { hex: "abcdef", flight: "ENY3362", lat: 41.98, lon: -87.9, alt_baro: "ground", seen_pos: 2 };
const run = async (route, key) => {
  fixture.calls.push([route, key]);
  const hit = key === "ENY3362" || (route === "area" && fixture.areaHasAircraft);
  return [{ provider: "fi", status: "ok", ac: hit ? [raw] : [] }];
};
export const fetchByHex = key => run("hex", key);
export const fetchByReg = key => run("registration", key);
export const fetchByCallsign = key => run("callsign", key);
export const fetchAround = () => run("area", "ORD");
export const fuseProviderLists = packs => packs.flatMap(pack => pack.ac);`);
const store = moduleUrl(`export const flightGroundStateStore = { load: async () => null, save: async () => {} };`);
const mode = moduleUrl(`export const fr24PreviewModeEnabled = () => false;`);
const trace = moduleUrl(`export const acquireFreeAdsb = async () => { throw new Error("unexpected provider request"); };`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/src/lib/ground-position.ts")) {
    const found = specifier === "@tanstack/react-start" ? serverFn
      : specifier === "./adsb-fusion" ? fusion
      : specifier === "./flight-ground-state.server.ts" ? store
      : specifier === "./fr24-preview-session.server.ts" ? mode
      : specifier === "./adsb-acquisition.server.ts" ? trace : null;
    if (found) return { url: found, shortCircuit: true };
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });

const input = {
  stateKey: "leg:v1:AAL3362|2026-10-07|ORD|AVP", serviceDate: "2026-10-07",
  flightNumber: "AA3362", callsign: "AAL3362", flightId: "ENY3362-1791178352-airline-1320p:0",
  registration: null, hex: null, originIata: "ORD", destIata: "AVP", airportIata: "ORD",
  movementKind: "departure", airportLat: 41.98, airportLon: -87.9,
};

test("AA3362 without an assigned tail can poll and accept its ENY3362 airport observation", async () => {
  assert.equal(groundPollingEnabled(true, true, false, false, false,
    Boolean(input.stateKey || input.hex || input.registration || input.callsign)), true);
  fixture.calls = []; fixture.areaHasAircraft = true;
  const { getGroundPosition } = await import("../src/lib/ground-position.ts");
  const result = await getGroundPosition({ data: input });
  assert.equal(result.callsign, "ENY3362");
  assert.deepEqual(fixture.calls, [["callsign", "AAL3362"], ["area", "ORD"]]);
});

test("AA3362 operating identity remains an exact fallback when the airport result is empty", async () => {
  fixture.calls = []; fixture.areaHasAircraft = false;
  const { getGroundPosition } = await import("../src/lib/ground-position.ts");
  const result = await getGroundPosition({ data: input });
  assert.equal(result.callsign, "ENY3362");
  assert.deepEqual(fixture.calls, [["callsign", "AAL3362"], ["area", "ORD"], ["callsign", "ENY3362"]]);
});

test("bootstrap forwards the operating flight identity and preserves marketing canonical identity", () => {
  const client = readFileSync(new URL("../src/components/filed-app.tsx", import.meta.url), "utf8");
  const prefetch = client.slice(client.indexOf("void queryClient.prefetchQuery({"));
  assert.match(prefetch, /flightNumber: bootstrap\.requestedIdent,[\s\S]*?flightId: story\.flightId \?\? null,[\s\S]*?callsign,/);
  const server = readFileSync(new URL("../src/lib/story.server.ts", import.meta.url), "utf8");
  const expression = server.match(/const groundCallsign = ([^;]+);/)?.[1];
  assert.ok(expression);
  const groundCallsign = new Function("live", "operatingIdent", "liveCs", "aware", `return ${expression};`);
  assert.equal(groundCallsign(null, "ENY3362", "AAL3362", { ident: "AAL3362" }), "ENY3362");
  assert.equal(groundCallsign({ callsign: "ENY3362A" }, "ENY3362", "AAL3362", null), "ENY3362A");
  assert.equal(groundCallsign(null, null, "AAL3362", null), "AAL3362");
  assert.match(server, /const liveCs = parsed\.callsign;/);
  assert.match(server, /callsign: liveCs,\s*iata: displayIata\(liveCs,/);
});
