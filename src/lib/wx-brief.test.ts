import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  altOverlaps,
  bandFt,
  digestWx,
  decodeTafPassenger,
  gairmetApplies,
  gairmetChop,
  pirepAltFt,
  pirepRouteBounds,
  pirepMatchesSample,
  rememberFiledWx,
  resetFiledWx,
  sampleAltFt,
  wxDeltas,
  wxHashOf,
  corridorStations,
  worseChop,
} from "./wx-brief.ts";
import type { Taf } from "./metar.ts";

beforeEach(() => {
  resetFiledWx();
});

describe("route PIREP bounds", () => {
  it("bounds Chicago to Los Angeles and ignores invalid coordinates", () => {
    const boxes = pirepRouteBounds([{lat: 42, lon: -88}, {lat: 34, lon: -118}, {lat: NaN, lon: 0}]);
    assert.equal(boxes.length, 1);
    const [south, west, north, east] = boxes[0]!.split(',').map(Number);
    assert.ok(south! < 34 && west! < -118 && north! > 42 && east! > -88);
    assert.deepEqual(pirepRouteBounds([]), []);
  });
  it("splits a dateline crossing into two narrow boxes", () => {
    const boxes = pirepRouteBounds([{lat: 50, lon: 175}, {lat: 50, lon: -175}]);
    assert.equal(boxes.length, 2);
    for (const box of boxes) {
      const [,west,,east] = box.split(',').map(Number);
      assert.ok(east! - west! < 20);
    }
  });
});

describe("altitude-aware AIRMET", () => {
  it("skips high-alt turbulence near the ground on arrival", () => {
    const arrivalAlt = sampleAltFt(0.97, 12, 4000);
    assert.ok(arrivalAlt < 16_000);
    assert.equal(gairmetApplies("TURB-HI", { base: "210", top: "330" }, arrivalAlt), false);
    assert.equal(gairmetApplies("TURB-HI", { base: "210", top: "330" }, 35_000), true);
  });

  it("applies low-level AIRMET and LLWS only near the field", () => {
    assert.equal(gairmetApplies("TURB-LO", { base: "SFC", top: "150" }, 4_000), true);
    assert.equal(gairmetApplies("TURB-LO", { base: "SFC", top: "150" }, 35_000), false);
    assert.equal(gairmetApplies("LLWS", {}, 2_000), true);
    assert.equal(gairmetApplies("LLWS", {}, 18_000), false);
  });

  it("parses FL bands", () => {
    assert.deepEqual(bandFt("SFC", "150"), { lo: 0, hi: 15_000 });
    assert.deepEqual(bandFt("210", "330"), { lo: 21_000, hi: 33_000 });
    assert.equal(altOverlaps(37_000, 21_000, 33_000), false);
    assert.equal(altOverlaps(28_000, 21_000, 33_000), true);
  });

  it("uses severity when present", () => {
    assert.equal(gairmetChop("TURB-HI", "SEV"), "severe");
    assert.equal(gairmetChop("TURB-LO", "MOD"), "moderate");
  });
});

describe("PIREP association", () => {
  it("rejects PIREPs that are far or at the wrong altitude", () => {
    const sample = { lat: 41.5, lon: -90, altFt: 34_000 };
    assert.equal(
      pirepMatchesSample({ lat: 41.5, lon: -90, altFt: 34_000 }, sample, 20),
      true,
    );
    assert.equal(
      pirepMatchesSample({ lat: 41.5, lon: -90, altFt: 4_000 }, sample, 20),
      false,
    );
    assert.equal(
      pirepMatchesSample({ lat: 41.5, lon: -90, altFt: 34_000 }, sample, 80),
      false,
    );
  });

  it("reads FL from raw PIREP text", () => {
    assert.equal(pirepAltFt({}, "UA /OV ORD /TM 2100 /FL350 /TB MOD"), 35_000);
  });
});

describe("filed snapshot vs live delta", () => {
  it("keeps the first digest and reports weather deltas later", () => {
    const filed = digestWx({
      samples: [{ frac: 0.5, chop: "smooth", convective: false }],
      hazards: [],
      originCat: "VFR",
      destCat: "VFR",
      at: 1,
    });
    const kept = rememberFiledWx("UA1|HNL|ORD|2026-09-11", filed);
    const live = digestWx({
      samples: [{ frac: 0.5, chop: "moderate", convective: true }],
      hazards: [
        { kind: "pirep", chop: "moderate", label: "Moderate chop reported", remaining: true },
        { kind: "convective", chop: "moderate", label: "Thunderstorm SIGMET", remaining: true },
      ],
      originCat: "VFR",
      destCat: "MVFR",
      destTaf: "thunderstorms in the forecast",
      at: 2,
    });
    const still = rememberFiledWx("UA1|HNL|ORD|2026-09-11", live);
    assert.equal(still.hash, kept.hash);
    assert.notEqual(live.hash, filed.hash);
    const deltas = wxDeltas(still, live);
    assert.ok(deltas.some((d) => /ride call/.test(d)));
    assert.ok(deltas.some((d) => /thunderstorm/.test(d)));
  });

  it("hash changes when chop changes", () => {
    const a = { worstChop: "smooth" as const, convective: false, pirepCount: 0, originCat: "VFR", destCat: "VFR", originTaf: null, destTaf: null, hazardLabels: [] as string[], corridor: [] as { iata: string; summary: string }[], ride: "Smooth ride" };
    const b = { ...a, worstChop: "light" as const, ride: "Light chop" };
    assert.notEqual(wxHashOf(a), wxHashOf(b));
  });
});

describe("TAF passenger line", () => {
  it("mentions tempo thunderstorms and low ceiling", () => {
    const taf: Taf = {
      icaoId: "KORD",
      rawTAF: "TAF KORD 1200/1306 27012KT P6SM BKN012 TEMPO 1204/1208 TSRA BKN008",
      fcsts: [
        {
          timeFrom: 100,
          timeTo: 500,
          wspd: 12,
          visib: "6+",
          clouds: [{ cover: "BKN", base: 800 }],
          wxString: "TSRA",
          fcstChange: "TEMPO",
        },
      ],
    };
    const line = decodeTafPassenger(taf, 200);
    assert.ok(line);
    assert.match(line, /thunder/i);
    assert.match(line, /ceiling/i);
  });
});

describe("corridor stations", () => {
  it("picks airports near the path, not origin or dest", () => {
    const path = [
      { lat: 41.97, lon: -87.9 },
      { lat: 39.86, lon: -104.67 },
      { lat: 33.94, lon: -118.4 },
    ];
    const aps = [
      { iata: "ORD", lat: 41.97, lon: -87.9 },
      { iata: "DEN", lat: 39.86, lon: -104.67 },
      { iata: "LAX", lat: 33.94, lon: -118.4 },
      { iata: "PHX", lat: 20, lon: -160 },
    ];
    const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
      Math.hypot(a.lat - b.lat, a.lon - b.lon) * 60;
    const picked = corridorStations(path, "ORD", "LAX", aps, dist);
    assert.deepEqual(picked.map((p) => p.iata), ["DEN"]);
  });
});

describe("worseChop", () => {
  it("ranks severe over light", () => {
    assert.equal(worseChop("light", "severe"), "severe");
  });
});
