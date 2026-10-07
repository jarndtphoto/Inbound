import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTE_HINT_POLICY,
  normalizeObservedCallsign,
  routeHintFromLookup,
  routeHintUsable,
  validateRouteHint,
  type NearbyRouteHint,
  type NearbyRouteLookupResult,
} from "./route-hints";

const now = Date.parse("2030-01-02T12:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();
function positive(overrides: Partial<NearbyRouteLookupResult> = {}): NearbyRouteLookupResult {
  return {
    observedCallsign: "EDV123", originIata: "MSP", destinationIata: "ORD", airlineLabel: "Example Air",
    outcome: "positive", sourceClass: "fake_route", verification: "hint", ...overrides,
  };
}
function negative(overrides: Partial<NearbyRouteLookupResult> = {}): NearbyRouteLookupResult {
  return {
    observedCallsign: "EDV123", originIata: null, destinationIata: null, airlineLabel: null,
    outcome: "negative", sourceClass: "fake_route", verification: "unknown", ...overrides,
  };
}
function invalidLookup(value: unknown) {
  assert.throws(() => routeHintFromLookup(value as NearbyRouteLookupResult, now), /Invalid private route hint/);
}
function invalidHint(value: unknown) {
  assert.throws(() => validateRouteHint(value), /Invalid (?:private route hint|route hint)/);
}

test("Observed callsign normalization preserves operating identity without marketing aliases", () => {
  const cases = [[" edv123 ", "EDV123"], ["DAL123", "DAL123"], ["UA 123", "UA123"], ["ual123", "UAL123"],
    ["N-123", "N-123"], ["123", "123"], ["A123456789012345", "A123456789012345"]];
  for (const [input, expected] of cases) assert.equal(normalizeObservedCallsign(input), expected);
  assert.equal(new Set(["EDV123", "DAL123", "UA123", "UAL123"].map(normalizeObservedCallsign)).size, 4,
    "EDV/DAL and UA/UAL are independent observed keys, even with matching numeric suffixes");
});

test("Observed callsign normalization rejects malformed and oversized identities", () => {
  for (const value of [null, undefined, 123, {}, [], "", " ", "A1234567890123456", "-EDV123", "EDV/123", "EDV_123",
    "EDV\t123", "EDV\n123", "ÉDV123", "EDV<123>", "EDV.123", "EDV:123"]) {
    assert.equal(normalizeObservedCallsign(value), null, String(value));
  }
});

test("Positive route hint records only generic evidence and the original normalized callsign", () => {
  const result = positive();
  const hint = routeHintFromLookup(result, now);
  assert.deepEqual(hint, { ...result, checkedAt: iso(now), expiresAt: iso(now + 1_800_000) });
  assert.equal(hint.verification, "hint");
  assert.doesNotThrow(() => validateRouteHint(hint));
  assert.deepEqual(result, positive(), "construction does not mutate provider-owned data");
});

test("A positive route hint may contain one endpoint but cannot invent a missing endpoint", () => {
  for (const result of [positive({ originIata: null }), positive({ destinationIata: null, airlineLabel: null })]) {
    const hint = routeHintFromLookup(result, now);
    assert.equal(hint.originIata, result.originIata);
    assert.equal(hint.destinationIata, result.destinationIata);
    assert.equal(hint.verification, "hint");
    assert.doesNotThrow(() => validateRouteHint(hint));
  }
  invalidLookup(positive({ originIata: null, destinationIata: null }));
});

test("A negative route hint has no route or airline information and a 60-second TTL", () => {
  const hint = routeHintFromLookup(negative(), now);
  assert.deepEqual(hint, { ...negative(), checkedAt: iso(now), expiresAt: iso(now + 60_000) });
  assert.equal(hint.verification, "unknown");
  assert.doesNotThrow(() => validateRouteHint(hint));
  for (const result of [negative({ originIata: "ORD" }), negative({ destinationIata: "MDW" }), negative({ airlineLabel: "Example Air" }),
    negative({ verification: "hint" })]) invalidLookup(result);
});

test("Generic callsign route lookup can never claim a confirmed occurrence", () => {
  for (const outcome of ["positive", "negative"]) {
    invalidLookup({ ...(outcome === "positive" ? positive() : negative()), verification: "confirmed" });
  }
  invalidLookup(positive({ verification: "unknown" }));
  invalidHint({ ...routeHintFromLookup(positive(), now), verification: "confirmed" });
});

test("Route hints reject malformed endpoint codes instead of parsing route strings", () => {
  for (const field of ["originIata", "destinationIata"]) {
    for (const value of [undefined, "", "ord", " ORD", "ORD ", "KORD", "O1D", "OR", "ORD/MDW", "ORD→MDW", 123, {}, []]) {
      invalidLookup({ ...positive(), [field]: value });
    }
  }
});

test("Lookup shape rejects missing, extra, raw-provider and dated-occurrence fields", () => {
  for (const value of [null, undefined, "EDV123", 42, [], [positive()]]) invalidLookup(value);
  for (const key of Object.keys(positive())) {
    const result = { ...positive() } as Record<string, unknown>;
    delete result[key];
    invalidLookup(result);
  }
  for (const key of ["providerName", "providerEndpoint", "rawProviderPayload", "sessionKey", "aircraftKey", "flightInstanceId", "serviceDate", "checkedAt", "expiresAt"]) {
    invalidLookup({ ...positive(), [key]: "must-not-cross" });
  }
});

test("Lookup accepts only the exact normalized observed key and valid outcomes", () => {
  for (const observedCallsign of ["edv123", " EDV123 ", "EDV 123", "EDV/123", "", null, undefined]) {
    invalidLookup({ ...positive(), observedCallsign });
  }
  for (const outcome of [undefined, null, "unknown", "confirmed", "error", "POSITIVE", 1, true]) {
    invalidLookup({ ...positive(), outcome });
  }
});

test("Safe Unicode airline labels are preserved within the display text bound", () => {
  for (const airlineLabel of ["Étoile Air — Test", "日本の航空会社", "Example's Air (Test)", "é".repeat(64), "✈".repeat(64)]) {
    const hint = routeHintFromLookup(positive({ airlineLabel }), now);
    assert.equal(hint.airlineLabel, airlineLabel);
    assert.doesNotThrow(() => validateRouteHint(hint));
  }
  invalidLookup(positive({ airlineLabel: "é".repeat(65) }));
});

test("Airline labels reject padding, empty text, control characters, markup and URLs", () => {
  for (const airlineLabel of ["", " ", " Example Air", "Example Air ", "x".repeat(65), "Example\nAir", "Example\u007fAir",
    "Example\u0085Air", "<b>Air</b>", "Air > Example", "https://example.invalid", "HTTP:example.invalid", "www.example.invalid",
    123, {}, [], undefined]) invalidLookup({ ...positive(), airlineLabel });
});

test("Private source class is bounded ASCII classification rather than a provider URL or payload", () => {
  for (const sourceClass of ["fake", "safe-class_1", "A".repeat(32)]) {
    const hint = routeHintFromLookup(positive({ sourceClass }), now);
    assert.equal(hint.sourceClass, sourceClass);
  }
  for (const sourceClass of ["", "a".repeat(33), "route provider", " source", "source ", "é", "https://example.invalid", "source/name", "<provider>", null, 1, {}]) {
    invalidLookup({ ...positive(), sourceClass });
  }
});

test("Serialized hint shape requires both timestamps and excludes extra private payloads", () => {
  const hint = routeHintFromLookup(positive(), now);
  for (const key of Object.keys(hint)) {
    const value = { ...hint } as Record<string, unknown>;
    delete value[key];
    invalidHint(value);
  }
  for (const field of ["rawProviderPayload", "providerUrl", "databaseId", "budgetState", "sessionKey", "flightInstanceId"]) {
    invalidHint({ ...hint, [field]: "private-extra" });
  }
  for (const value of [null, [], "hint"]) invalidHint(value);
});

test("Serialized route timestamps must be valid bounded ISO instants", () => {
  const hint = routeHintFromLookup(positive(), now);
  for (const field of ["checkedAt", "expiresAt"]) {
    for (const value of [null, undefined, 123, "", "not-a-date", "2030-01-02", "2030-13-02T12:00:00.000Z",
      "2030-02-31T12:00:00.000Z", "2030-01-02T12:00:00.000000000000000000Z"]) {
      invalidHint({ ...hint, [field]: value });
    }
  }
  for (const at of [NaN, Infinity, -Infinity]) {
    assert.throws(() => routeHintFromLookup(positive(), at), /Invalid route hint clock/);
  }
});

test("Positive and negative TTL limits include the exact maximum and reject any excess", () => {
  for (const [result, maximum] of [[positive(), 1_800_000], [negative(), 60_000]] as const) {
    const hint = routeHintFromLookup(result, now);
    for (const ttl of [1, maximum - 1, maximum]) {
      assert.doesNotThrow(() => validateRouteHint({ ...hint, expiresAt: iso(now + ttl) }));
    }
    for (const ttl of [-1, 0, maximum + 1]) invalidHint({ ...hint, expiresAt: iso(now + ttl) });
  }
  assert.equal(ROUTE_HINT_POLICY.positiveTtlMs, 1_800_000);
  assert.equal(ROUTE_HINT_POLICY.negativeTtlMs, 60_000);
});

test("Logical hint expiry is strict and does not revive a positive or negative entry", () => {
  for (const result of [positive(), negative()]) {
    const hint = routeHintFromLookup(result, now);
    const expires = Date.parse(hint.expiresAt);
    assert.equal(routeHintUsable(hint, now), true);
    assert.equal(routeHintUsable(hint, expires - 1), true);
    assert.equal(routeHintUsable(hint, expires), false);
    assert.equal(routeHintUsable(hint, expires + 1), false);
    for (const at of [NaN, Infinity, -Infinity]) assert.equal(routeHintUsable(hint, at), false);
  }
});

test("Unusable route evidence is ignored and future timestamps have only the existing one-second tolerance", () => {
  const hint = routeHintFromLookup(positive(), now);
  assert.equal(routeHintUsable(hint, now - 1_000), true);
  assert.equal(routeHintUsable(hint, now - 1_001), false);
  assert.equal(routeHintUsable({ ...hint, verification: "confirmed" } as unknown as NearbyRouteHint, now), false);
  assert.equal(routeHintUsable({ ...hint, destinationIata: "bad" }, now), false);
  assert.equal(routeHintUsable({ ...hint, expiresAt: "not-a-time" }, now), false);
  assert.equal(routeHintUsable({ ...hint, rawProviderPayload: {} } as NearbyRouteHint, now), false);
});
