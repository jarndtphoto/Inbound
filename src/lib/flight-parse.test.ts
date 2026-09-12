import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IATA_TO_ICAO, displayIata, parseFlightQuery, storyMatchesQuery } from "./flight-parse.ts";

describe("regional codeshare idents", () => {
  it("maps marketed Delta Connection 9E to Endeavor EDV", () => {
    assert.equal(IATA_TO_ICAO["9E"], "EDV");
    const q = parseFlightQuery("9E5305");
    assert.equal(q?.callsign, "EDV5305");
    assert.equal(q?.iata, "9E5305");
    assert.equal(displayIata("EDV5305", "9E5305"), "9E 5305");
  });

  it("keeps marketed DL5305 as DAL5305, not the regional operator", () => {
    const q = parseFlightQuery("DL5305");
    assert.equal(q?.callsign, "DAL5305");
    assert.equal(q?.iata, "DL5305");
    assert.notEqual(q?.callsign, "EDV5305");
  });

  it("parses operator callsign EDV5305 when the passenger types that", () => {
    const q = parseFlightQuery("EDV5305");
    assert.equal(q?.callsign, "EDV5305");
  });

  it("maps other US regionals used as codeshares", () => {
    assert.equal(parseFlightQuery("OO5500")?.callsign, "SKW5500");
    assert.equal(parseFlightQuery("YX4500")?.callsign, "RPA4500");
    assert.equal(parseFlightQuery("OH5400")?.callsign, "JIA5400");
    assert.equal(parseFlightQuery("MQ3400")?.callsign, "ENY3400");
    assert.equal(parseFlightQuery("G7500")?.callsign, "GJS500");
  });

  it("still treats a DL5305 story as the flight the passenger asked for", () => {
    assert.equal(
      storyMatchesQuery({ iata: "DL 5305", callsign: "DAL5305", query: "DL5305" }, "DL 5305"),
      true,
    );
  });
});
