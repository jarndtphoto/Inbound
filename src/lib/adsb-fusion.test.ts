import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseBest,
  fuseProviderLists,
  isStaleObs,
  isTeleport,
  maybeExtrapolate,
  rawToObservation,
  resetFusion,
  stickyPick,
  type AdsbRaw,
  STALE_AIR_SEC,
} from "./adsb-fusion.ts";

const HEX = "abc123";
const T0 = 1_700_000_000_000;

function ac(partial: Partial<AdsbRaw> & { lat: number; lon: number }): AdsbRaw {
  return {
    hex: HEX,
    flight: "UAL1",
    gs: 420,
    track: 90,
    alt_baro: 31000,
    seen: 0,
    seen_pos: 0,
    ...partial,
  };
}

beforeEach(() => {
  resetFusion();
});

describe("stale reject", () => {
  it("rejects an airside observation older than the stale window", () => {
    const obs = rawToObservation(ac({ lat: 41.97, lon: -87.9, seen: STALE_AIR_SEC + 8, seen_pos: STALE_AIR_SEC + 8 }), "fi", T0);
    assert.ok(obs);
    assert.equal(isStaleObs(obs, T0, true), true);
    const fused = fuseProviderLists([{ provider: "fi", ac: [obs.raw] }], { now: T0, airside: true });
    assert.equal(fused.length, 0);
  });

  it("keeps a fresh airside observation", () => {
    const fused = fuseProviderLists(
      [{ provider: "fi", ac: [ac({ lat: 41.97, lon: -87.9, seen: 2, seen_pos: 2 })] }],
      { now: T0, airside: true },
    );
    assert.equal(fused.length, 1);
    assert.equal(fused[0]?.extrapolated, false);
  });
});

describe("teleport reject", () => {
  it("rejects a multi-NM jump in a couple of seconds", () => {
    assert.equal(
      isTeleport(
        { lat: 41.9786, lon: -87.9048, gs: 420, at: T0 },
        { lat: 42.4, lon: -87.9048, gs: 420, receivedAt: T0 + 2000 },
        T0 + 2000,
      ),
      true,
    );
  });

  it("keeps the previous track when a later feed teleports", () => {
    fuseProviderLists(
      [{ provider: "fi", ac: [ac({ lat: 41.9786, lon: -87.9048, seen: 0 })] }],
      { now: T0, airside: true },
    );
    const next = fuseProviderLists(
      [{ provider: "lol", ac: [ac({ lat: 42.45, lon: -87.9048, seen: 0 })] }],
      { now: T0 + 2000, airside: true },
    );
    assert.equal(next.length, 1);
    assert.ok(Math.abs((next[0]?.lat ?? 0) - 41.9786) < 0.08);
  });
});

describe("fresher provider wins", () => {
  it("picks the observation with the lower seen_pos", () => {
    const fused = fuseProviderLists(
      [
        { provider: "fi", ac: [ac({ lat: 41.97, lon: -87.9, seen: 22, seen_pos: 22 })] },
        { provider: "lol", ac: [ac({ lat: 41.971, lon: -87.901, seen: 1, seen_pos: 1 })] },
      ],
      { now: T0, airside: true },
    );
    assert.equal(fused.length, 1);
    assert.ok(Math.abs((fused[0]?.lat ?? 0) - 41.971) < 0.0005);
    assert.equal(fused[0]?._fusion?.provider, "lol");
  });
});

describe("hex stickiness", () => {
  it("keeps the locked hex when it is still fresh", () => {
    const locked = ac({ hex: "aa11bb", lat: 41.97, lon: -87.9, seen: 3, _fusion: { provider: "fi", extrapolated: false, ageSec: 3 } });
    const other = ac({ hex: "cc22dd", lat: 41.98, lon: -87.91, seen: 1, flight: "UAL1", _fusion: { provider: "lol", extrapolated: false, ageSec: 1 } });
    const pick = stickyPick("aa11bb", [locked, other], {
      isExact: (raw) => String(raw.flight ?? "").replace(/\s/g, "") === "UAL1",
      now: T0,
    });
    assert.equal(pick?.hex, "aa11bb");
  });

  it("swaps only when the locked hex is stale and an exact match is nearby", () => {
    const locked = ac({ hex: "aa11bb", lat: 41.97, lon: -87.9, seen: 30, _fusion: { provider: "fi", extrapolated: false, ageSec: 30 } });
    const other = ac({ hex: "cc22dd", lat: 41.972, lon: -87.902, seen: 1, flight: "UAL1", _fusion: { provider: "lol", extrapolated: false, ageSec: 1 } });
    const pick = stickyPick("aa11bb", [locked, other], {
      isExact: (raw) => String(raw.hex ?? "") === "cc22dd",
      now: T0,
    });
    assert.equal(pick?.hex, "cc22dd");
  });
});

describe("extrapolated flag", () => {
  it("marks a short coast-ahead as extrapolated", () => {
    fuseProviderLists(
      [{ provider: "fi", ac: [ac({ lat: 41.9786, lon: -87.9048, gs: 420, track: 90, seen: 0 })] }],
      { now: T0 },
    );
    const coast = fuseProviderLists([], { now: T0 + 6000 });
    assert.equal(coast.length, 1);
    assert.equal(coast[0]?.extrapolated, true);
    assert.ok((coast[0]?.lon ?? -87.9) > -87.9048);
  });

  it("does not extrapolate after the gap window", () => {
    fuseProviderLists(
      [{ provider: "fi", ac: [ac({ lat: 41.9786, lon: -87.9048, gs: 420, track: 90, seen: 0 })] }],
      { now: T0 },
    );
    const prev = {
      hex: HEX,
      lat: 41.9786,
      lon: -87.9048,
      gs: 420,
      track: 90,
      altBaro: 31000 as const,
      at: T0,
      provider: "fi" as const,
      extrapolated: false,
      raw: ac({ lat: 41.9786, lon: -87.9048 }),
    };
    assert.equal(maybeExtrapolate(prev, T0 + 16_000, true), null);
    const later = chooseBest(HEX, T0 + 20 * 60_000, false);
    assert.equal(later, null);
  });

  it("keeps a few-minute-old oceanic cruise ping", () => {
    const fused = fuseProviderLists(
      [{ provider: "fi", ac: [ac({ lat: 30.2, lon: -140.4, gs: 478, alt_baro: 36000, seen: 240, seen_pos: 240 })] }],
      { now: T0, airside: false },
    );
    assert.equal(fused.length, 1);
    assert.equal(fused[0]?.alt_baro, 36000);
    assert.equal(fused[0]?.gs, 478);
  });

  it("coasts an enroute track for a few minutes", () => {
    fuseProviderLists(
      [{ provider: "fi", ac: [ac({ lat: 30.2, lon: -140.4, gs: 480, track: 70, alt_baro: 35000, seen: 0 })] }],
      { now: T0, airside: false },
    );
    const coast = fuseProviderLists([], { now: T0 + 90_000, airside: false });
    assert.equal(coast.length, 1);
    assert.equal(coast[0]?.extrapolated, true);
    assert.equal(coast[0]?.alt_baro, 35000);
  });
});
