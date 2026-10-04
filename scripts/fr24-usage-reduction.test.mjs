import { test } from "node:test";
import { installTestClock } from "./test-clock.mjs";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { groundPollingEnabled, flightPollingComplete } from "../src/lib/flight-polling.ts";
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

test("visibility and Map selection are wired through to the ground observer", async () => {
  const read = path => readFile(resolve(path), "utf8");
  assert.match(await read("src/components/filed-app.tsx"), /active=\{flightTab === "Route"\}/);
  assert.match(await read("src/components/route-map-experiment.tsx"), /active=\{props.active\}/);
  const movement = await read("src/components/movement-map.tsx");
  assert.match(movement, /enabled: groundPollingEnabled\(active, pageVisible/);
  assert.doesNotMatch(movement, /refetchIntervalInBackground:\s*true/);
  assert.match(movement, /document.visibilityState === "visible"/);
  const hook = await read("src/lib/use-page-visible.ts");
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /removeEventListener\("visibilitychange", onChange\)/);
});

test("matched FR24 registration skips failed route lookup, but wrong leg/missing/stale/expired matches fall back", async () => {
  const directory = await mkdtemp(resolve("node_modules/.fr24-lookup-test-"));
  const realFetch = globalThis.fetch;
  const keys = ["FR24_API_TOKEN", "FR24_ENABLE_TRACKS", "FR24_ENABLE_SUMMARY", "FLIGHTAWARE_PAID_API_ENABLED"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let now = Date.now(), calls = [], mode = "good";
  let restoreClock = () => {};
  try {
    await build({ configFile: false, logLevel: "silent", build: { ssr: resolve("src/lib/official-flight-data.server.ts"), outDir: directory,
      rollupOptions: { output: { entryFileNames: "official.mjs" } } } });
    process.env.FR24_API_TOKEN = "test-only";
    delete process.env.FR24_ENABLE_TRACKS; delete process.env.FR24_ENABLE_SUMMARY; delete process.env.FLIGHTAWARE_ENABLE_PAID_API;
    restoreClock = installTestClock(() => now);
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
    now += 16 * 60000; calls = []; await api.loadOfficialFlightData("AAL1", options);
    assert.equal(calls[0], "route", "expired memory uses original cascade");
    now += 6000; calls = []; await api.loadOfficialFlightData("AAL1", { ...options, fr24DestIata: "DEN" });
    assert.equal(calls[0], "route", "another leg cannot reuse remembered lookup");
  } finally {
    globalThis.fetch = realFetch; restoreClock();
    for (const key of keys) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
