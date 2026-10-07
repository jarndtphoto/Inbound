import { test } from "node:test";
import assert from "node:assert/strict";
import { AirportV1Schema, DelayV1Schema, EventTimeV1Schema, FlightCandidateV1Schema, FlightResultV1Schema, GetFlightRequestV1Schema, InboundFlightV1Schema, InboundNearbyFlightSchema, NearbyFlightsResponseV1Schema, NearbyRequestV1Schema, ResolveNearbyRequestV1Schema, ServiceDateSchema, TimeZoneSchema, TimestampSchema, factSchema, publicJsonSchemas, serializedBytes, NEARBY_PAYLOAD_BYTES, DETAIL_PAYLOAD_BYTES } from "./contracts";
import { z } from "zod";
import { FIXTURE_NOW, detailFixtures, nearbyFixtures, resultFixtures, selectionFixtures, fixtureDetail, fixtureNearbyBoard, fixtureTime, resolvedFixture } from "./fixtures";
import { resolveNearbyRequest } from "./areas";

for (const [name, fixture] of Object.entries(nearbyFixtures)) test(`Nearby fixture: ${name}`, () => assert.deepEqual(NearbyFlightsResponseV1Schema.parse(fixture), fixture));
for (const [name, fixture] of Object.entries(detailFixtures)) test(`Detail fixture: ${name}`, () => assert.deepEqual(InboundFlightV1Schema.parse(fixture), fixture));
for (const [name, fixture] of Object.entries(resultFixtures)) test(`Result fixture: ${name}`, () => assert.deepEqual(FlightResultV1Schema.parse(fixture), fixture));

test("Strict request variants reject unknown and mixed properties at every level", () => {
  for (const input of [null, undefined, {}, { area: null, latitude: 41.9 }, { area: { kind: "point", latitude: 41.9, longitude: -87.8 } }, { area: { kind: "airport", code: "ORD", extra: 1 } }, { area: null, radiusNm: 50 }, { area: null, limit: 0 }, { area: null, limit: 6 }, { area: null, includePosition: "true" }]) assert.equal(NearbyRequestV1Schema.safeParse(input).success, false);
  assert.equal(NearbyRequestV1Schema.safeParse({ area: null }).success, true);
  assert.equal(GetFlightRequestV1Schema.safeParse({ target: { kind: "lookup", query: "UA219", flightInstanceId: "bad" } }).success, false);
  assert.equal(GetFlightRequestV1Schema.safeParse({ target: { kind: "choice", candidateToken: "A".repeat(43), query: "UA219" } }).success, false);
  assert.equal(ResolveNearbyRequestV1Schema.safeParse({ selectionToken: "A".repeat(43), raw: {} }).success, false);
});
test("Dates, UTC instants, IANA zones and handle formats validate", () => {
  for (const value of ["2030-02-30", "2030-1-15", "2030-01-15T00:00:00Z"]) assert.equal(ServiceDateSchema.safeParse(value).success, false);
  assert.equal(ServiceDateSchema.safeParse("2032-02-29").success, true);
  for (const value of ["2030-02-30T18:00:00Z", "2030-01-15T18:00:00-06:00", "2030-01-15", "not confirmed"]) assert.equal(TimestampSchema.safeParse(value).success, false);
  assert.equal(TimestampSchema.safeParse(FIXTURE_NOW).success, true);
  for (const value of ["Chicago", "CST", "+06:00", "Mars/Olympus"]) assert.equal(TimeZoneSchema.safeParse(value).success, false);
  assert.equal(TimeZoneSchema.safeParse("America/Chicago").success, true);
  assert.equal(ResolveNearbyRequestV1Schema.safeParse({ selectionToken: "provider-flight-id" }).success, false);
  assert.equal(GetFlightRequestV1Schema.safeParse({ target: { kind: "lookup", query: "UA219", date: "2030-02-30" } }).success, false);
});
test("Nulls stay null; missing fact is not a false, zero, empty, or value:null", () => {
  const f = InboundFlightV1Schema.parse(detailFixtures.noPosition);
  assert.equal(f.position, null); assert.equal(f.freshness.positionAgeSeconds, null); assert.equal(f.status.cancelled, null);
  assert.equal(factSchema(z.boolean()).safeParse({ value: null, basis: "unknown", checkedAt: null, sourceLabel: null }).success, false);
  const value = { value: false, basis: "provider_reported", checkedAt: null, sourceLabel: null };
  assert.deepEqual(factSchema(z.boolean()).parse(value), value);
  const board = NearbyFlightsResponseV1Schema.parse(nearbyFixtures.unknownRoute!);
  assert.equal(board.flights[0]!.route.originIata, null); assert.equal(board.flights[0]!.position, null); assert.equal(board.flights[0]!.identity.flightNumber, null);
});
test("Every public numeric kind rejects NaN/infinities and out-of-range coordinates", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const f = fixtureDetail(); f.position!.latitude = value; assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
    const r = fixtureNearbyBoard(); r.flights[0]!.altitudeFt = value; assert.equal(NearbyFlightsResponseV1Schema.safeParse(r).success, false);
    r.flights[0]!.altitudeFt = 6800; r.flights[0]!.proximity.distanceNm = value; assert.equal(NearbyFlightsResponseV1Schema.safeParse(r).success, false);
    assert.equal(DelayV1Schema.safeParse({ minutes: value, baselineKind: "unknown", baselineAt: null, basis: "derived", checkedAt: null }).success, false);
  }
  const f = fixtureDetail(); f.position!.longitude = 181; assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
  f.position!.longitude = -87.8; f.position!.groundTrackDeg = 360; assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
});
test("Five-card/candidate, 128-point, UTF-8 payload and text bounds", () => {
  const r = fixtureNearbyBoard(); r.flights = Array(6).fill(r.flights[0]); assert.equal(NearbyFlightsResponseV1Schema.safeParse(r).success, false);
  const result = structuredClone(resultFixtures.ambiguous!); result.candidates = Array(6).fill(result.candidates[0]); assert.equal(FlightResultV1Schema.safeParse(result).success, false);
  const f = fixtureDetail(); f.map!.path = Array(128).fill([-87.8, 41.9]); assert.equal(InboundFlightV1Schema.safeParse(f).success, true);
  f.map!.path.push([-87.8, 41.9]); assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
  f.map = null; f.status.text = "x".repeat(161); assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
  assert.ok(serializedBytes(nearbyFixtures.healthyChicago) < NEARBY_PAYLOAD_BYTES);
  assert.ok(serializedBytes(resolvedFixture()) < DETAIL_PAYLOAD_BYTES);
  assert.ok(serializedBytes({ value: "é".repeat(NEARBY_PAYLOAD_BYTES) }) > NEARBY_PAYLOAD_BYTES);
  const huge = { ...fixtureNearbyBoard(), raw: "x".repeat(NEARBY_PAYLOAD_BYTES) };
  assert.equal(NearbyFlightsResponseV1Schema.safeParse(huge).success, false);
  assert.equal(InboundFlightV1Schema.safeParse({ ...fixtureDetail(), debug: "x".repeat(DETAIL_PAYLOAD_BYTES) }).success, false);
});
test("Nearby status invariants distinguish empty, outage, invalid and last-known", () => {
  for (const [name, original] of Object.entries(nearbyFixtures)) {
    const r = structuredClone(original); r.status = original.status === "empty" ? "ok" : "empty";
    assert.equal(NearbyFlightsResponseV1Schema.safeParse(r).success, false, name);
  }
  const r = fixtureNearbyBoard(); r.error = { code: "feed_unavailable", message: "Fixture failure" }; assert.equal(NearbyFlightsResponseV1Schema.safeParse(r).success, false);
  r.error = null; r.responseAt = fixtureTime(200); assert.equal(NearbyFlightsResponseV1Schema.safeParse(r).success, false);
  const stale = structuredClone(nearbyFixtures.staleLastKnown!); stale.stale = false; assert.equal(NearbyFlightsResponseV1Schema.safeParse(stale).success, false);
  const failure = structuredClone(nearbyFixtures.feedUnavailable!); failure.status = "empty"; failure.error = null; assert.equal(NearbyFlightsResponseV1Schema.safeParse(failure).success, false);
  const warming = structuredClone(nearbyFixtures.warming!); warming.error!.code = "feed_unavailable"; assert.equal(NearbyFlightsResponseV1Schema.safeParse(warming).success, false);
});
test("All detailed result statuses enforce their discriminated invariants", () => {
  for (const [name, original] of Object.entries(resultFixtures)) {
    const r = structuredClone(original); r.status = original.status === "resolved" ? "ambiguous" : "resolved";
    assert.equal(FlightResultV1Schema.safeParse(r).success, false, name);
  }
  const r = resolvedFixture(); r.flightInstanceId = "00000000-0000-4000-8000-000000000999"; assert.equal(FlightResultV1Schema.safeParse(r).success, false);
  const a = structuredClone(resultFixtures.ambiguous!); a.candidates = a.candidates.slice(0, 1); assert.equal(FlightResultV1Schema.safeParse(a).success, false);
  const expired = structuredClone(resultFixtures.ambiguous!); expired.candidates[0]!.expiresAt = FIXTURE_NOW; assert.equal(FlightResultV1Schema.safeParse(expired).success, false);
  const failure = structuredClone(resultFixtures.notFound!); failure.error!.code = "backend_unavailable"; assert.equal(FlightResultV1Schema.safeParse(failure).success, false);
});
test("Route, selection, provenance, source attribution and unknown-position invariants", () => {
  const c = structuredClone(selectionFixtures.unresolvedSelectableCard);
  c.identity.flightNumber = "UA1847"; assert.equal(InboundNearbyFlightSchema.safeParse(c).success, false);
  c.identity.flightNumber = null; c.selection.expiresAt = fixtureTime(300); assert.equal(InboundNearbyFlightSchema.safeParse(c).success, false);
  c.selection.expiresAt = fixtureTime(100); c.route.verification = "unknown"; assert.equal(InboundNearbyFlightSchema.safeParse(c).success, false);
  const e = structuredClone(detailFixtures.inferredLanding!.times.landing); e.providerActual = e.selected; assert.equal(EventTimeV1Schema.safeParse(e).success, false);
  assert.equal(detailFixtures.inferredLanding!.times.landing.providerActual, null);
  assert.equal(detailFixtures.providerActualLanding!.times.landing.providerActual!.basis, "provider_actual");
  assert.equal(detailFixtures.unknownTimeProvenance!.times.landing.selected!.basis, "unknown");
  const f = fixtureDetail(); f.position!.kind = "synthetic" as "observed"; assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
  const a = structuredClone(f.route.origin); (a as unknown as Record<string, unknown>).sourceLabel = "https://provider/secret"; assert.equal(AirportV1Schema.safeParse(a).success, false);
  f.phase.stage = "climbing" as "ride"; assert.equal(InboundFlightV1Schema.safeParse(f).success, false);
});
test("Repeated same-day operations remain explicit choices with distinct handles", () => {
  const r = FlightResultV1Schema.parse(selectionFixtures.repeatedSameDayFlightNumber);
  assert.equal(r.flightInstanceId, null); assert.equal(r.candidates[0]!.serviceDate, r.candidates[1]!.serviceDate);
  assert.notEqual(r.candidates[0]!.scheduledDepartureAt, r.candidates[1]!.scheduledDepartureAt);
  assert.notEqual(r.candidates[0]!.candidateToken, r.candidates[1]!.candidateToken);
  assert.equal(FlightCandidateV1Schema.safeParse({ ...r.candidates[0], providerId: "secret" }).success, false);
});
test("Unsupported/missing area resolution is entirely synchronous, before acquisition", () => {
  for (const input of [{ area: { kind: "airport", code: "JFK" } }, { area: null }, {}]) {
    const result = resolveNearbyRequest(input, FIXTURE_NOW);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.response.status, "invalid_request"); assert.equal(result.response.resolvedArea, null); }
  }
  // Resolver takes no provider/loader argument and its dependency graph is checked separately.
});
test("Exported versioned JSON schemas prohibit additional properties recursively", () => {
  const schemas = publicJsonSchemas();
  assert.equal(Object.keys(schemas).length, 12);
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "object") assert.equal(o.additionalProperties, false);
    for (const child of Object.values(o)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  };
  for (const schema of Object.values(schemas)) visit(schema);
});
