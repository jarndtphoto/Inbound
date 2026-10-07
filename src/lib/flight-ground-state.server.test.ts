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
    assert.equal((await store.loadRecent("AA600"))?.landKey, key);
    assert.equal(cleanups, 3);
  } finally {
    await pg.close();
  }
});
