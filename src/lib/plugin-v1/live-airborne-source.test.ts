import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createInboundAirborneSourceClient, createInboundAirborneSourceServer,
  LiveAirborneFlightResultSchema, LiveAirborneNearbyResponseSchema,
  type InboundAirborneSourceBackend,
} from "./live-airborne-source.server";

const now = "2026-10-07T01:00:00.000Z";
const unavailableNearby = {
  area: {
    id: "preset:chicago", kind: "city", label: "Chicago",
    reference: { latitude: 41.9, longitude: -87.8, label: "Chicago" },
    radiusNm: 38, associatedAirports: ["ORD", "MDW"],
  },
  collectionVersion: null, health: "unavailable", generatedAt: now,
  radarTargets: [], featuredFlights: [],
  status: "Nearby aircraft data is temporarily unavailable.",
  warning: "No current aircraft snapshot is available. Try again shortly.",
};
const unsupportedFlight = {
  schemaVersion: "1.0", status: "unsupported", responseAt: now,
  refreshAfterSeconds: null, flightInstanceId: null, flight: null,
  candidates: [], error: { code: "unsupported_aircraft", message: "Airborne-only preview does not include this aircraft." },
};

const servers: import("node:http").Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function source(backend: InboundAirborneSourceBackend) {
  const server = createInboundAirborneSourceServer(backend); servers.push(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing source address");
  const local = `http://127.0.0.1:${address.port}`;
  const secureFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const mapped = new URL(local); mapped.pathname = url.pathname;
    return fetch(mapped, init);
  };
  return createInboundAirborneSourceClient({ baseUrl: "https://inbound-live-source.example", fetcher: secureFetch });
}

test("airborne source client rejects direct aviation-provider origins", () => {
  for (const url of [
    "https://opendata.adsb.fi", "https://api.adsb.lol", "https://api.airplanes.live",
    "https://api.flightradar24.com", "https://aeroapi.flightaware.com",
  ]) assert.throws(() => createInboundAirborneSourceClient({ baseUrl: url }), /cannot use an aviation-provider URL/);
  assert.throws(() => createInboundAirborneSourceClient({ baseUrl: "http://inbound.example" }), /one HTTPS origin/);
  assert.throws(() => createInboundAirborneSourceClient({ baseUrl: "https://inbound.example/path" }), /one HTTPS origin/);
});

test("source boundary is read-only, no-store, and validates the same public DTOs", async () => {
  const calls: string[] = [];
  const client = await source({
    async nearby(input) { calls.push(`nearby:${input.area}`); return LiveAirborneNearbyResponseSchema.parse(unavailableNearby); },
    async resolve() { calls.push("resolve"); return LiveAirborneFlightResultSchema.parse(unsupportedFlight); },
    async getFlight() { calls.push("flight"); return LiveAirborneFlightResultSchema.parse(unsupportedFlight); },
  });
  const nearby = await client.nearby({ area: "preset:chicago" });
  const resolved = await client.resolve({ selectionToken: "A".repeat(43) });
  const flight = await client.getFlight({ target: { kind: "lookup", query: "UAL123", date: "2026-10-06" } });
  assert.equal(nearby.health, "unavailable");
  assert.equal(resolved.status, "unsupported");
  assert.equal(flight.status, "unsupported");
  assert.deepEqual(calls, ["nearby:preset:chicago", "resolve", "flight"]);
});

test("live source fails closed if a resolved detail is on the ground", () => {
  const ground = structuredClone(unsupportedFlight) as any;
  ground.status = "resolved"; ground.error = null; ground.flightInstanceId = "00000000-0000-4000-8000-000000000001";
  ground.flight = {
    schemaVersion: "1.0", flightInstanceId: ground.flightInstanceId, snapshotAt: now,
    identity: { displayIdent: "UAL123", operatingIdent: "UAL123", flightNumber: "123", observedCallsign: "UAL123",
      airlineName: "United", serviceDate: "2026-10-06", serviceTimeZone: "America/Chicago" },
    route: {
      origin: { iata: "ORD", icao: "KORD", name: "Chicago O'Hare", city: "Chicago", timeZone: "America/Chicago", latitude: 41.9786, longitude: -87.9048 },
      destination: { iata: "BOS", icao: "KBOS", name: "Boston Logan", city: "Boston", timeZone: "America/New_York", latitude: 42.3656, longitude: -71.0096 },
      divertedTo: null,
    },
    status: { lifecycle: "active", text: "Taxiing", basis: "inbound_inferred", cancelled: null, diverted: null },
    phase: { stage: "taxi", label: "Taxiing", basis: "inbound_inferred", motion: "taxi", arrivalState: null },
    aircraft: { typeCode: "B738", typeName: "Boeing 737-800", registration: null },
    position: { latitude: 41.98, longitude: -87.90, altitudeFt: 0, groundspeedKt: 18, groundTrackDeg: 90,
      verticalRateFpm: 0, onGround: true, kind: "observed", observedAt: now, ageSeconds: 0, freshness: "current" },
    departure: { terminal: null, gate: null, runway: null }, arrival: { terminal: null, gate: null, baggage: null, baggageState: "unavailable", runway: null },
    times: { gateOut: {}, takeoff: {}, landing: {}, gateIn: {} }, delay: { departure: null, landing: null },
    freshness: { storyAgeSeconds: 0, providerAgeSeconds: 0, positionAgeSeconds: 0 },
  };
  assert.equal(LiveAirborneFlightResultSchema.safeParse(ground).success, false);
});

test("live Nearby source accepts unavailable/airborne shapes and rejects ground phases", () => {
  assert.equal(LiveAirborneNearbyResponseSchema.safeParse(unavailableNearby).success, true);
  const invalid = structuredClone(unavailableNearby) as any;
  invalid.health = "ok"; invalid.collectionVersion = 1; delete invalid.status; delete invalid.warning;
  invalid.radarTargets = [{
    radarId: "00000000-0000-4000-8000-000000000001", displayIdent: "UAL123",
    latitude: 41.9, longitude: -87.8, observedAt: now, altitudeFt: 1000, groundspeedKt: 20,
    groundTrackDeg: 90, verticalRateFpm: 0, positionKind: "observed",
    motion: { phase: "taxi", label: "Taxiing", verticalTrend: "level" },
    freshness: { ageSeconds: 0, state: "fresh" }, featured: false,
    selection: { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null },
  }];
  assert.equal(LiveAirborneNearbyResponseSchema.safeParse(invalid).success, false);
});
