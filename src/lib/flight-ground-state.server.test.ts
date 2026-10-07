import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import { createFlightGroundStateStore } from "./flight-ground-state.server.ts";

function toSql(pg: PGlite): Sql {
  const sql = (async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query<T>(query, values)).rows;
  }) as Sql;
  sql.query = async <T>(query: string, values: unknown[] = []) => (await pg.query<T>(query, values)).rows;
  return sql;
}

test("ground state keeps identity and refuses to replace a newer position with an older one", async () => {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../migrations/0007_flight_ground_state.sql", import.meta.url), "utf8"));
  const sql = toSql(pg);
  let cleanups = 0;
  const store = createFlightGroundStateStore(async () => sql, async () => { cleanups++; });
  const key = "leg:v1:AAL600|2026-10-06|ORD|RDU";
  const base = {
    landKey: key, requestedIdent: "AA600", serviceDate: "2026-10-06",
    originIata: "ORD", destIata: "RDU", airportIata: "ORD",
    airportLat: 41.9786, airportLon: -87.9048, movementKind: "departure" as const,
    hex: "a0b1c2", registration: "N123AA", callsign: "AAL600",
  };
  const newer = {
    lat: 41.99, lon: -87.91, altFt: 0, gsKt: 12, track: 270, onGround: true,
    seenAt: 1000, registration: "N123AA", callsign: "AAL600", provider: "adsb" as const,
  };
  const older = { ...newer, lat: 41.98, seenAt: 900 };

  try {
    await store.save({ ...base, lastPosition: null, positionSeenAt: null });
    assert.equal((await store.load(key))?.hex, "a0b1c2");
    await store.save({ ...base, lastPosition: newer, positionSeenAt: newer.seenAt });
    await store.save({ ...base, hex: null, registration: null, callsign: null, lastPosition: older, positionSeenAt: older.seenAt });
    const loaded = await store.load(key);
    assert.equal(loaded?.hex, "a0b1c2");
    assert.equal(loaded?.registration, "N123AA");
    assert.equal(loaded?.lastPosition?.lat, newer.lat);
    assert.equal(loaded?.positionSeenAt, newer.seenAt);
    assert.equal((await store.loadRecent("AA600", base))?.landKey, key);
    assert.equal(cleanups, 3);
  } finally {
    await pg.close();
  }
});

const identityBase = {
  landKey: "leg:v1:AAL600|2026-10-07|ORD|RDU", requestedIdent: "AA600", serviceDate: "2026-10-07",
  originIata: "ORD", destIata: "RDU", airportIata: "ORD", airportLat: 41.98, airportLon: -87.90,
  movementKind: "departure" as const, hex: "a0b1c2", registration: "N123AA", callsign: "AAL600",
  lastPosition: null, positionSeenAt: null,
};

test("bootstrap selects only the requested dated route and refuses unscoped recovery", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL("../../migrations/0007_flight_ground_state.sql", import.meta.url), "utf8"));
    const store = createFlightGroundStateStore(async () => toSql(pg), async () => {});
    await store.save(identityBase);
    const scope = { landKey: identityBase.landKey, serviceDate: identityBase.serviceDate,
      originIata: "ORD", destIata: "RDU" };
    assert.equal(await store.loadRecent("AA600"), null);
    assert.equal((await store.loadRecent("AA600", scope))?.landKey, identityBase.landKey);
    for (const changed of [ { serviceDate: "2026-10-06" }, { serviceDate: "2026-10-08" },
      { originIata: "RDU", destIata: "ORD" }, { landKey: "leg:v1:AAL600|2026-10-07|ORD|LAX" } ]) {
      assert.equal(await store.loadRecent("AA600", { ...scope, ...changed }), null);
    }
  } finally { await pg.close(); }
});

test("tail reassignment discards old hex and position without mixing identity provenance", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL("../../migrations/0007_flight_ground_state.sql", import.meta.url), "utf8"));
    const store = createFlightGroundStateStore(async () => toSql(pg), async () => {});
    const position = { lat: 41.99, lon: -87.91, altFt: 0, gsKt: 12, track: 270, onGround: true,
      seenAt: 1000, registration: "N123AA", callsign: "AAL600", provider: "adsb" as const };
    await store.save({ ...identityBase, lastPosition: position, positionSeenAt: 1000 });
    await store.save({ ...identityBase, registration: "N456AA", hex: null });
    const changed = await store.load(identityBase.landKey);
    assert.equal(changed?.registration, "N456AA");
    assert.equal(changed?.hex, null);
    assert.equal(changed?.lastPosition, null);
    assert.equal(changed?.positionSeenAt, null);
    await store.save({ ...identityBase, registration: "N456AA", hex: "abcdef",
      lastPosition: { ...position, registration: "N456AA", seenAt: 900 }, positionSeenAt: 900 });
    assert.equal((await store.load(identityBase.landKey))?.lastPosition?.registration, "N456AA");
    // A cached hex without a tail cannot be attributed to a newly supplied registration.
    await store.save({ ...identityBase, registration: null, hex: "fedcba" });
    await store.save({ ...identityBase, registration: "G-NEW", hex: null });
    assert.equal((await store.load(identityBase.landKey))?.hex, null);
  } finally { await pg.close(); }
});

test("late old-tail observations and identity-only requests cannot revert a newer assignment", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL("../../migrations/0007_flight_ground_state.sql", import.meta.url), "utf8"));
    const store = createFlightGroundStateStore(async () => toSql(pg), async () => {});
    const position = { lat: 41.99, lon: -87.91, altFt: 0, gsKt: 12, track: 270, onGround: true,
      seenAt: 2000, registration: "N456AA", callsign: "AAL600", provider: "adsb" as const };
    const oldRequestStartedAt = Date.now() - 1000;
    await store.save({ ...identityBase, registration: "N456AA", hex: "abcdef",
      lastPosition: position, positionSeenAt: 2000 });
    await store.save({ ...identityBase, lastPosition: { ...position, registration: "N123AA", seenAt: 1000 }, positionSeenAt: 1000 });
    assert.equal((await store.load(identityBase.landKey))?.registration, "N456AA");
    assert.equal((await store.load(identityBase.landKey))?.positionSeenAt, 2000);
    await store.save(identityBase, oldRequestStartedAt);
    assert.equal((await store.load(identityBase.landKey))?.registration, "N456AA");
    // A genuinely later identity-only assignment still clears the previous position.
    await store.save(identityBase);
    assert.equal((await store.load(identityBase.landKey))?.registration, "N123AA");
    assert.equal((await store.load(identityBase.landKey))?.lastPosition, null);
  } finally { await pg.close(); }
});

test("switching airport or movement scope cannot relabel a retained position", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL("../../migrations/0007_flight_ground_state.sql", import.meta.url), "utf8"));
    const store = createFlightGroundStateStore(async () => toSql(pg), async () => {});
    const arrival = { ...identityBase, airportIata: "RDU", airportLat: 35.88, airportLon: -78.78, movementKind: "arrival" as const };
    const position = { lat: 35.88, lon: -78.78, altFt: 0, gsKt: 12, track: 270, onGround: true,
      seenAt: 2000, registration: "N123AA", callsign: "AAL600", provider: "adsb" as const };
    await store.save({ ...arrival, lastPosition: position, positionSeenAt: position.seenAt });
    await store.save(identityBase);
    const departure = await store.load(identityBase.landKey);
    assert.equal(departure?.airportIata, "ORD");
    assert.equal(departure?.movementKind, "departure");
    assert.equal(departure?.lastPosition, null);
    assert.equal(departure?.positionSeenAt, null);
    assert.equal(departure?.registration, "N123AA");

    const oldRequest = Date.now() - 1000;
    await store.save({ ...identityBase, lastPosition: { ...position, lat: 41.98, lon: -87.9 }, positionSeenAt: 2000 });
    await store.save(arrival, oldRequest);
    assert.equal((await store.load(identityBase.landKey))?.airportIata, "ORD");
    assert.equal((await store.load(identityBase.landKey))?.lastPosition?.lat, 41.98);
    // A new arrival miss clears the departure position, while same-scope misses retain it.
    await store.save(arrival);
    assert.equal((await store.load(identityBase.landKey))?.lastPosition, null);
    await store.save({ ...arrival, lastPosition: position, positionSeenAt: 2000 });
    await store.save(arrival);
    assert.equal((await store.load(identityBase.landKey))?.lastPosition?.lat, 35.88);
    // Movement changes are also a distinct scope even when the airport matches.
    await store.save({ ...arrival, movementKind: "departure" });
    assert.equal((await store.load(identityBase.landKey))?.lastPosition, null);
  } finally { await pg.close(); }
});
