import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchAround, fetchAroundWithStatus, fuseProviderLists, resetFusion, type AdsbRaw, type ProviderAcquisitionPack } from "../adsb-fusion";
import { AIRFRAMES, isInterestingAircraft, isWidebody } from "../aircraft";
import { createNearbyAcquire, NearbyAcquisitionUnavailable } from "./acquisition.server";
import { normalizeAcceptedNearby } from "./normalize";

const T0 = Date.parse("2026-10-03T22:00:00Z");
const raw = (changes: Partial<AdsbRaw> = {}): AdsbRaw => ({ hex: "abc123", flight: "UAL123", r: "N12345", lat: 41.91, lon: -87.81,
  alt_baro: 7_000, gs: 210, track: 93, baro_rate: -650, seen: 2, seen_pos: 2, t: "B738", category: "A3", ownOp: "United", ...changes });
const pack = (aircraft: AdsbRaw[], receivedAt = T0, provider: ProviderAcquisitionPack["provider"] = "fi"): ProviderAcquisitionPack =>
  ({ provider, ac: aircraft, receivedAt, status: "ok", attempted: true });
const normalized = (aircraft: AdsbRaw[], nowMs = T0) => {
  const packs = [pack(aircraft, nowMs)];
  return normalizeAcceptedNearby(packs, fuseProviderLists(packs, { now: nowMs, airside: true }), [], nowMs);
};
beforeEach(resetFusion);

async function withProviderFetch(
  respond: (url: URL, advance: (ms: number) => void) => Response | Promise<Response>,
  run: (calls: URL[], advance: (ms: number) => void) => Promise<void>,
) {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let nowMs = T0;
  const calls: URL[] = [], advance = (ms: number) => { nowMs += ms; };
  Date.now = () => nowMs;
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls.push(url);
    return respond(url, advance);
  };
  try { await run(calls, advance); }
  finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
}

test("Chicago acquisition reuses the three existing free providers and the one covering 50nm geometry", async () => {
  await withProviderFetch(() => Response.json({ ac: [raw()] }), async calls => {
    const result = await createNearbyAcquire({ clock: Date.now })([]);
    assert.deepEqual(calls.map(url => url.hostname).sort(), ["api.adsb.lol", "api.airplanes.live", "opendata.adsb.fi"]);
    assert.ok(calls.every(url => /\/41\.9\/.*-87\.8\/.*50$/.test(url.pathname)));
    assert.equal(result.metadata.providerCalls, 3);
    assert.equal(result.metadata.rawCount, 3);
    assert.equal(result.observations.length, 1);
    assert.equal(result.partial, false);
  });
});
test("accepted boundary preserves real motion, altitude, vertical rate, metadata and opaque IDs", () => {
  const [observation] = normalized([raw({ t: "B744", ownOp: "Atlas" })]);
  assert.ok(observation);
  assert.equal(observation.groundTrackDeg, 93);
  assert.equal(observation.groundspeedKt, 210);
  assert.equal(observation.altitudeFt, 7_000);
  assert.equal(observation.verticalRateFpm, -650);
  assert.equal(observation.typeCode, "B744");
  assert.equal(observation.operator, "Atlas");
  assert.equal(observation.category, "A3");
  assert.equal(observation.interesting, true);
  assert.equal(observation.observedAt, new Date(T0 - 2_000).toISOString());
  assert.equal(observation.provenance.source, "adsb:fi");
  assert.equal(observation.freshness.ageSeconds, 2);
  for (const id of [observation.cardId, observation.radarId, observation.sessionKey]) {
    assert.match(id, /^[0-9a-f-]{36}$/); assert.ok(!id.includes("abc123"));
  }
  assert.equal(observation.positionKind, "observed");
  assert.equal(observation.acceptedPosition, true);
  assert.equal(observation.route.verification, "unknown");
});
test("normalization never invents a missing or invalid track, speed, altitude or vertical rate", () => {
  for (const track of [undefined, NaN, Infinity, -1, 360]) {
    resetFusion();
    const [observation] = normalized([raw({ track, gs: undefined, baro_rate: undefined, alt_baro: undefined })]);
    assert.ok(observation);
    assert.equal(observation.groundTrackDeg, null);
    assert.equal(observation.groundspeedKt, null);
    assert.equal(observation.verticalRateFpm, null);
    assert.equal(observation.altitudeFt, null);
    assert.equal(observation.onGround, null);
  }
  resetFusion();
  const [geom] = normalized([raw({ alt_baro: undefined, alt_geom: 8_100, spd: 160, gs: undefined, track: 0 })]);
  assert.equal(geom.altitudeFt, 8_100); assert.equal(geom.groundspeedKt, 160); assert.equal(geom.groundTrackDeg, 0);
});
test("real response latency advances source age without resetting the authoritative fix timestamp", () => {
  const packs = [pack([raw()], T0)];
  const nowMs = T0 + 3_000;
  const fused = fuseProviderLists(packs, { now: nowMs, airside: true });
  const [observation] = normalizeAcceptedNearby(packs, fused, [], nowMs);
  assert.equal(observation.observedAt, new Date(T0 - 2_000).toISOString());
  assert.equal(observation.provenance.receivedAt, new Date(T0).toISOString());
  assert.equal(observation.provenance.positionAgeSeconds, 5);
  assert.equal(observation.freshness.ageSeconds, 5);
});
test("Nearby opt-in observed fusion preserves a fast real fix while a slower provider finishes", async () => {
  const seeded = raw({ seen_pos: 0, seen: 0 });
  fuseProviderLists([pack([seeded])], { now: T0, airside: true });
  const packs = [pack([{ ...seeded, lon: -87.809 }], T0 + 100), pack([], T0 + 4_000, "lol")];
  const legacy = fuseProviderLists(packs, { now: T0 + 4_000, airside: true });
  assert.equal(legacy[0].extrapolated, true, "legacy coast behavior stays unchanged");
  resetFusion(); fuseProviderLists([pack([seeded])], { now: T0, airside: true });
  const result = await createNearbyAcquire({ fetchAround: async () => packs, clock: () => T0 + 4_000 })([]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].longitude, -87.809);
  assert.equal(result.observations[0].positionKind, "observed");
  assert.equal(result.observations[0].observedAt, new Date(T0 + 100).toISOString());
  assert.equal(result.observations[0].freshness.ageSeconds, 3.9);
});
test("strict existing32s airborne and45s ground rules reject stale and future fixes", () => {
  for (const aircraft of [raw({ seen_pos: 33 }), raw({ seen_pos: -1 }), raw({ alt_baro: "ground", seen_pos: 46 })]) {
    resetFusion(); assert.equal(normalized([aircraft]).length, 0);
  }
  resetFusion(); assert.equal(normalized([raw({ seen_pos: 32 })]).length, 1);
  resetFusion(); assert.equal(normalized([raw({ alt_baro: "ground", seen_pos: 45 })]).length, 1);
});
test("conflicting current callsigns or registrations are rejected after existing fusion", () => {
  for (const changed of [raw({ flight: "AAL777" }), raw({ r: "N99999" })]) {
    resetFusion(); const packs = [pack([raw()]), pack([changed], T0, "lol")];
    assert.equal(normalizeAcceptedNearby(packs, fuseProviderLists(packs, { now: T0, airside: true }), [], T0).length, 0);
  }
});
test("persisted previous observation rejects cold-instance teleport and regressed timestamp", () => {
  const previous = normalized([raw({ seen_pos: 0 })]);
  const old = structuredClone(previous);
  for (const next of [raw({ lat: 42.35, seen_pos: 0 }), raw({ seen_pos: 5 })]) {
    resetFusion(); const nowMs = T0 + 2_000, packs = [pack([next], nowMs)];
    assert.equal(normalizeAcceptedNearby(packs, fuseProviderLists(packs, { now: nowMs, airside: true }), previous, nowMs).length, 0);
  }
  assert.deepEqual(previous, old);
});
test("current evidence requirement rejects warm old and fusion-extrapolated positions", () => {
  const currentPacks = [pack([raw()])], current = fuseProviderLists(currentPacks, { now: T0, airside: true });
  const nowMs = T0 + 6_000;
  assert.equal(normalizeAcceptedNearby([pack([], nowMs)], current, [], nowMs).length, 0);
  const coasted = fuseProviderLists([], { now: nowMs, airside: true });
  assert.equal(coasted[0].extrapolated, true);
  assert.equal(normalizeAcceptedNearby(currentPacks, coasted, [], nowMs).length, 0);
  resetFusion(); assert.equal(normalized([raw({ extrapolated: true })]).length, 0);
  resetFusion(); assert.equal(normalized([{ ...raw(), positionKind: "synthetic" } as AdsbRaw]).length, 0);
});
test("normalization crops to covering collection and preserves ground/vehicle evidence for ranking boundary", () => {
  assert.equal(normalized([raw({ lat: 43.2 })]).length, 0);
  resetFusion();
  const [ground] = normalized([raw({ alt_baro: "ground", t: "SERV", category: "C1", ownOp: "Airport" })]);
  assert.equal(ground.onGround, true); assert.equal(ground.altitudeFt, 0); assert.equal(ground.category, "C1");
});
test("opaque IDs persist within one aircraft session and change when accepted callsign changes", () => {
  const previous = normalized([raw()]);
  resetFusion(); const nowMs = T0 + 20_000, packs = [pack([raw({ seen_pos: 1 })], nowMs)];
  const [same] = normalizeAcceptedNearby(packs, fuseProviderLists(packs, { now: nowMs, airside: true }), previous, nowMs);
  assert.equal(same.radarId, previous[0].radarId); assert.equal(same.cardId, previous[0].cardId); assert.equal(same.sessionKey, previous[0].sessionKey);
  resetFusion(); const changedPacks = [pack([raw({ flight: "UAL124", seen_pos: 1 })], nowMs)];
  const [changed] = normalizeAcceptedNearby(changedPacks, fuseProviderLists(changedPacks, { now: nowMs, airside: true }), previous, nowMs);
  assert.notEqual(changed.sessionKey, previous[0].sessionKey); assert.notEqual(changed.radarId, previous[0].radarId);
});
test("optional identity omissions preserve private session continuity without fabricating current identity", () => {
  const first = normalized([raw()]);
  const step = (previous: typeof first, aircraft: AdsbRaw, at: number) => {
    resetFusion(); const packs = [pack([aircraft], at)];
    return normalizeAcceptedNearby(packs, fuseProviderLists(packs, { now: at, airside: true, preferObserved: true }), previous, at);
  };
  const omitted = step(first, raw({ flight: undefined, r: undefined }), T0 + 20_000);
  assert.equal(omitted[0].observedCallsign, null); assert.equal(omitted[0].registration, null);
  assert.deepEqual(omitted[0].sessionIdentity, { observedCallsign: "UAL123", registration: "N12345" });
  assert.equal(omitted[0].cardId, first[0].cardId); assert.equal(omitted[0].radarId, first[0].radarId); assert.equal(omitted[0].sessionKey, first[0].sessionKey);
  const returned = step(omitted, raw(), T0 + 40_000);
  assert.equal(returned[0].sessionKey, first[0].sessionKey);
  assert.equal(step(omitted, raw({ r: "N99999" }), T0 + 40_000).length, 0, "known registration remains a conflict anchor through omission");
  const changed = step(omitted, raw({ flight: "UAL124" }), T0 + 40_000);
  assert.notEqual(changed[0].sessionKey, first[0].sessionKey);
  assert.notEqual(changed[0].radarId, first[0].radarId);
  assert.deepEqual(changed[0].sessionIdentity, { observedCallsign: "UAL124", registration: "N12345" });
});
test("session identity continuity expires after120s observed gap and new identity gets new opaque IDs", () => {
  const previous = normalized([raw()]);
  const nextAt = T0 + 120_001;
  resetFusion(); const packs = [pack([raw({ r: "N99999" })], nextAt)];
  const [next] = normalizeAcceptedNearby(packs, fuseProviderLists(packs, { now: nextAt, airside: true, preferObserved: true }), previous, nextAt);
  assert.ok(next); assert.notEqual(next.sessionKey, previous[0].sessionKey); assert.notEqual(next.cardId, previous[0].cardId);
  assert.deepEqual(next.sessionIdentity, { observedCallsign: "UAL123", registration: "N99999" });
  resetFusion(); const missingPacks = [pack([raw({ flight: undefined, r: undefined })], nextAt)];
  const [missing] = normalizeAcceptedNearby(missingPacks, fuseProviderLists(missingPacks, { now: nextAt, airside: true, preferObserved: true }), previous, nextAt);
  assert.ok(missing); assert.notEqual(missing.sessionKey, previous[0].sessionKey);
  assert.deepEqual(missing.sessionIdentity, { observedCallsign: null, registration: null });
});
test("overlong identifiers are unknown rather than truncated into invented callsigns or registrations", () => {
  const [observation] = normalized([raw({ flight: "UAL12345678901234567890", r: "N12345678901234567890" })]);
  assert.ok(observation); assert.equal(observation.observedCallsign, null); assert.equal(observation.registration, null);
  assert.deepEqual(observation.sessionIdentity, { observedCallsign: null, registration: null });
});
test("successful empty is truly empty despite previously remembered fusion tracks", async () => {
  normalized([raw()]);
  await withProviderFetch(() => Response.json({ ac: [] }), async () => {
    const result = await createNearbyAcquire({ clock: Date.now })([]);
    assert.equal(result.observations.length, 0); assert.equal(result.partial, false); assert.equal(result.metadata.providerCalls, 3);
  });
});
test("partial usable acquisition publishes partial; partial empty and rejected-only are coverage failures", async () => {
  await withProviderFetch(url => url.hostname === "api.adsb.lol" ? new Response("failure", { status: 503 }) : Response.json({ ac: [raw()] }), async () => {
    const result = await createNearbyAcquire({ clock: Date.now })([]);
    assert.equal(result.partial, true); assert.equal(result.observations.length, 1); assert.equal(result.metadata.successfulProviders, 2);
  });
  resetFusion();
  await withProviderFetch(url => url.hostname === "api.adsb.lol" ? new Response("failure", { status: 503 }) : Response.json({ ac: [] }), async () => {
    await assert.rejects(createNearbyAcquire({ clock: Date.now })([]), NearbyAcquisitionUnavailable);
  });
  resetFusion();
  await withProviderFetch(() => Response.json({ ac: [raw({ seen_pos: 200 })] }), async () => {
    await assert.rejects(createNearbyAcquire({ clock: Date.now })([]), error => error instanceof NearbyAcquisitionUnavailable && error.metadata.rawCount === 3);
  });
});
test("status-aware failures and malformed payloads preserve health backoff and legacy behavior", async () => {
  await withProviderFetch(() => new Response("failed", { status: 503 }), async (calls, advance) => {
    const acquire = createNearbyAcquire({ clock: Date.now });
    await assert.rejects(acquire([]), error => error instanceof NearbyAcquisitionUnavailable && error.metadata.providerCalls === 3);
    await assert.rejects(acquire([]), error => error instanceof NearbyAcquisitionUnavailable && error.metadata.providerCalls === 0);
    assert.equal(calls.length, 3);
    assert.deepEqual((await fetchAround(41.9, -87.8, 50)).map(value => value.ac), [[], [], []]);
    assert.equal(calls.length, 3);
    advance(6_000); await assert.rejects(acquire([]), NearbyAcquisitionUnavailable); assert.equal(calls.length, 6);
  });
  resetFusion();
  await withProviderFetch(() => Response.json({ unexpected: "not an empty sky" }), async () => {
    assert.ok((await fetchAroundWithStatus(41.9, -87.8, 50)).every(value => value.status === "failed"));
  });
});
test("extracted existing interesting signal is behavior-equivalent for all known frame types and years", () => {
  function previousSignal(code: string | null, year: string | null, currentYear: number) {
    const widebody = isWidebody(code), kind = code ? AIRFRAMES[code]?.kind : undefined, yearNum = year ? Number(year) : null;
    return widebody || kind === "biz" || code === "A388" || code === "B744" || code === "B748" || code === "B752" || code === "B753"
      || (yearNum != null && yearNum >= currentYear - 1 && kind !== "ga" && kind !== "heli" && kind !== "other");
  }
  for (const code of [null, "UNKNOWN", ...Object.keys(AIRFRAMES)]) for (const year of [null, "", "bad", "2023", "2025", "2026", "2027"]) {
    assert.equal(isInterestingAircraft(code, year, 2026), previousSignal(code, year, 2026), `${code}/${year}`);
  }
});
test("private acquisition does not call paid or per-flight APIs and legacy fixture code remains disconnected", () => {
  const source = readFileSync(new URL("./acquisition.server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /flightaware|fr24|loadOfficialFlightData|loadFr24|loadAeroApi/i);
  for (const file of ["proof-server.ts", "proof-preview.ts", "fixtures.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../plugin-v1/${file}`, import.meta.url), "utf8"), /nearby-v1\/|acquireNearbyChicago|fetchAroundWithStatus/);
  }
});
