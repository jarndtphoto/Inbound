import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { groundPollingEnabled, flightPollingComplete, flightPollingInterval } from "../src/lib/flight-polling.ts";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

test("ground observer makes no hidden/background requests and refreshes immediately on return", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let requests = 0;
  const options = (active, visible) => ({ queryKey: ["ground-position", "test-leg"],
    queryFn: async () => ++requests, staleTime: 0,
    enabled: groundPollingEnabled(active, visible, false, false, false, true) });
  const observer = new QueryObserver(client, options(false, true));
  const unsubscribe = observer.subscribe(() => {});
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    await tick(); assert.equal(requests, 0, "Overview is mounted but inactive");
    observer.setOptions(options(true, true)); await tick(); assert.equal(requests, 1);
    observer.setOptions(options(false, true)); await tick(); assert.equal(requests, 1);
    observer.setOptions(options(true, false)); await tick(); assert.equal(requests, 1);
    observer.setOptions(options(true, true)); await tick(); assert.equal(requests, 2, "visible again fetches immediately");
    assert.equal(groundPollingEnabled(true, true, true, false, false, true), false);
    assert.equal(groundPollingEnabled(true, true, false, true, false, true), false);
    assert.equal(groundPollingEnabled(true, true, false, false, true, true), false);
    assert.equal(groundPollingEnabled(true, true, false, false, false, false), false);
  } finally { unsubscribe(); client.clear(); }
});

test("only completed/actual old arrivals slow down, never scheduled arrival or departure gate", () => {
  const now = Date.now();
  const story = { currentStage: "taxi_in", times: { landKind: "actual", landUnix: now / 1000 - 1800 } };
  assert.equal(flightPollingComplete(story, now), true);
  assert.equal(flightPollingComplete({ ...story, times: { ...story.times, landUnix: now / 1000 - 1799 } }, now), false);
  assert.equal(flightPollingComplete({ ...story, times: { ...story.times, landKind: "estimated" } }, now), false);
  assert.equal(flightPollingComplete({ currentStage: "origin_gate", times: {} }, now), false);
  assert.equal(flightPollingComplete({ currentStage: "gate", times: {} }, now), true);
});

test("tracked-flight polling is phase-aware and cruise waits 20 seconds", () => {
  const now = Date.UTC(2026, 9, 4, 17);
  const base = {
    currentStage: "ride",
    live: true,
    times: { takeoffUnix: now / 1000 - 60 * 60 },
    aircraft: { phase: "cruise" },
  };
  assert.equal(flightPollingInterval(base, now), 20_000, "cruise stays inexpensive");
  assert.equal(flightPollingInterval({ ...base, currentStage: "push", aircraft: { phase: "parked" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "taxi", aircraft: { phase: "taxi" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "takeoff_roll", aircraft: { phase: "taxi" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, aircraft: { phase: "climb" }, times: { takeoffUnix: now / 1000 - 5 * 60 } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, aircraft: { phase: "climb" }, times: { takeoffUnix: now / 1000 - 20 * 60 } }, now), 10_000);
  assert.equal(flightPollingInterval({ ...base, aircraft: { phase: "descent" } }, now), 10_000);
  assert.equal(flightPollingInterval({ ...base, aircraft: { phase: "approach" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "final_approach", aircraft: { phase: "cruise" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "taxi_in", aircraft: { phase: "taxi" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "origin_gate", aircraft: { phase: "parked" } }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "origin_gate", live: false, aircraft: null }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "inbound", live: false, aircraft: null }, now), 8_000);
  assert.equal(flightPollingInterval({ ...base, currentStage: "gate", aircraft: { phase: "parked" } }, now), 60_000);
});

test("visibility and Map selection are wired through to the ground observer", async () => {
  const read = path => readFile(resolve(path), "utf8");
  const app = await read("src/components/filed-app.tsx");
  assert.match(app, /active=\{flightTab === "Route"\}/);
  assert.match(app, /return flightPollingInterval\(s\)/);
  assert.doesNotMatch(app, /if \(s\.live \|\| s\.currentStage === "push"/);
  assert.match(await read("src/components/route-map-experiment.tsx"), /active=\{props.active\}/);
  const movement = await read("src/components/movement-map.tsx");
  assert.match(movement, /enabled: groundPollingEnabled\(active, pageVisible/);
  assert.doesNotMatch(movement, /refetchIntervalInBackground:\s*true/);
  assert.match(movement, /document.visibilityState === "visible"/);
  const hook = await read("src/lib/use-page-visible.ts");
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /removeEventListener\("visibilitychange", onChange\)/);
});

test("departure ground map does not duplicate the tracked-flight FR24 stream", async () => {
  const source = await readFile(resolve("src/lib/ground-position.ts"), "utf8");
  assert.match(source, /if \(data\.movementKind === "departure"\) \{[\s\S]*?diagnostic\("fr24-owned-by-story"\)/);
  assert.match(source, /\} else \{[\s\S]*?loadFr24FlightByRegistration/, "arrival recovery retains FR24");
  assert.match(source, /const aroundPacks = await fetchAround/, "departure map still refreshes from open ADS-B");
  assert.match(source, /wantedHex[\s\S]*?fetchByHex\(wantedHex\)/, "delayed broad fixes retry the strongest free exact hex identity");
  assert.match(source, /if \(ageSec <= 8\)/, "only genuinely fresh broad fixes bypass the exact lookup");
  assert.match(source, /position\.seenAt > aroundFallback\.seenAt/, "the newer exact or broad observation wins");
  assert.match(source, /loadFr24RecentArrivalIdentity/, "completed-arrival identity recovery remains available");
});

test("matched FR24 registration skips failed route lookup, but wrong leg/missing/stale/expired matches fall back", async () => {
  const directory = await mkdtemp(resolve("node_modules/.fr24-lookup-test-"));
  const realFetch = globalThis.fetch, realNow = Date.now;
  const keys = ["FR24_API_TOKEN", "FR24_ENABLE_TRACKS", "FR24_ENABLE_SUMMARY", "FLIGHTAWARE_PAID_API_ENABLED"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let now = realNow(), calls = [], mode = "good";
  try {
    await build({ configFile: false, logLevel: "silent", build: { ssr: resolve("src/lib/official-flight-data.server.ts"), outDir: directory,
      rollupOptions: { output: { entryFileNames: "official.mjs" } } } });
    process.env.FR24_API_TOKEN = "test-only";
    delete process.env.FR24_ENABLE_TRACKS; delete process.env.FR24_ENABLE_SUMMARY; delete process.env.FLIGHTAWARE_ENABLE_PAID_API;
    Date.now = () => now;
    globalThis.fetch = async input => {
      const url = new URL(String(input)); assert.equal(url.hostname, "fr24api.flightradar24.com");
      const params = url.searchParams; calls.push(params.has("registrations") ? "registration" : params.has("callsigns") ? "callsign" : "route");
      const data = (params.has("registrations") || params.has("callsigns")) && mode !== "missing" ? [{ fr24_id: "test-id", flight: "AA1", callsign: "AAL1", reg: "NTEST", lat: 41, lon: -87,
        orig_iata: mode === "wrong" ? "LAX" : "ORD", dest_iata: "SEA", timestamp: now / 1000 - (mode === "stale" ? 60 : 1) }] : [];
      return Response.json({ data });
    };
    const api = await import(pathToFileURL(join(directory, "official.mjs")).href);
    const options = { fr24FlightNumber: "AA1", fr24OriginIata: "ORD", fr24DestIata: "SEA", fr24Registration: "NTEST" };
    assert.ok((await api.loadOfficialFlightData("AAL1", options)).fr24);
    assert.deepEqual(calls, ["route", "registration"]);
    now += 6000; calls = []; await api.loadOfficialFlightData("AAL1", options);
    assert.deepEqual(calls, ["registration"]);
    for (const bad of ["wrong", "missing", "stale"]) {
      now += 30000; mode = bad; calls = [];
      const result = await api.loadOfficialFlightData("AAL1", options);
      assert.ok(calls.includes("route"), `${bad} retries normal lookup`);
      if (bad !== "stale") assert.equal(result.fr24, null);
      mode = "good"; now += 30000; await api.loadOfficialFlightData("AAL1", options);
    }
    const operatingOptions = { fr24FlightNumber: "AA2", fr24OriginIata: "ORD", fr24DestIata: "SEA", fr24OperatingCallsign: "AAL1" };
    now += 30000; calls = []; await api.loadOfficialFlightData("AAL2", operatingOptions);
    assert.deepEqual(calls, ["route", "callsign"]);
    now += 6000; calls = []; await api.loadOfficialFlightData("AAL2", operatingOptions);
    assert.deepEqual(calls, ["callsign"], "marketing flight remembers the successful operating lookup");

    const surfaceCallsign = { fr24OriginIata: "ORD", fr24DestIata: "SEA", fr24OperatingCallsign: "AAL1", fr24SurfaceDeparture: true };
    now += 30000; calls = [];
    assert.ok((await api.loadOfficialFlightData("AAL1", surfaceCallsign)).fr24);
    assert.deepEqual(calls, ["callsign"], "surface departure spends exactly one callsign probe");

    const surfaceRegistration = { ...surfaceCallsign, fr24Registration: "NTEST" };
    now += 30000; calls = [];
    assert.ok((await api.loadOfficialFlightData("AAL1", surfaceRegistration)).fr24);
    assert.deepEqual(calls, ["registration"], "known surface registration replaces the callsign without adding a second probe");

    now += 16 * 60000; calls = []; await api.loadOfficialFlightData("AAL1", options);
    assert.equal(calls[0], "route", "expired memory uses original cascade");
    now += 6000; calls = []; await api.loadOfficialFlightData("AAL1", { ...options, fr24DestIata: "DEN" });
    assert.equal(calls[0], "route", "another leg cannot reuse remembered lookup");
  } finally {
    globalThis.fetch = realFetch; Date.now = realNow;
    for (const key of keys) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
