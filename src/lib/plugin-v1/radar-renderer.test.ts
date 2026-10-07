import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveNearbyDisplayPosition } from "../nearby-v1/motion";
import { deriveRadarDisplayPosition, projectRadarPoint, radarLabels, radarRouteText, RADAR_AIRPORTS, radarSelectionForClick, radarSelectionSnapshot } from "./radar-renderer";
import type { PublicRadarTarget, PublicFeaturedFlight } from "./nearby-response";

const start = Date.parse("2030-01-15T18:00:00Z");
const target = (patch: Partial<PublicRadarTarget> = {}): PublicRadarTarget => ({
  radarId: "radar-safe-0001", displayIdent: "TEST 1", latitude: 41.97, longitude: -87.90,
  observedAt: new Date(start).toISOString(), altitudeFt: 12_000, groundspeedKt: 250,
  groundTrackDeg: 90, verticalRateFpm: 1_000, positionKind: "observed",
  freshness: { ageSeconds: 0, state: "fresh" }, motion: { phase: "climb", label: "Climbing", verticalTrend: "rising" },
  featured: false, selection: { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null }, ...patch,
});

describe("Radar renderer reuses certified Nearby motion", () => {
  it("matches the engine derivation and changes only display coordinates", () => {
    const anchor = target(), before = structuredClone(anchor);
    const result = deriveRadarDisplayPosition(anchor, start + 10_000, "ok", anchor.observedAt)!;
    const engine = deriveNearbyDisplayPosition({ ...anchor, acceptedPosition: true, onGround: false }, start + 10_000);
    assert.deepEqual(result, engine); assert.ok(result.longitude > anchor.longitude); assert.equal(result.altitudeFt, 12_000);
    assert.deepEqual(anchor, before);
  });
  it("ends movement at 25 seconds and never chains a projected point", () => {
    const anchor = target(), at25 = deriveRadarDisplayPosition(anchor, start + 25_000, "ok", anchor.observedAt)!;
    assert.equal(at25.extrapolatedSeconds, 25); assert.equal(at25.stopped, true);
    const later = deriveRadarDisplayPosition(anchor, start + 110_000, "ok", anchor.observedAt)!;
    assert.equal(later.latitude, at25.latitude); assert.equal(later.longitude, at25.longitude);
    const projected = deriveRadarDisplayPosition(target({ positionKind: "extrapolated" }), start + 10_000, "ok", anchor.observedAt)!;
    assert.equal(projected.longitude, anchor.longitude); assert.equal(projected.extrapolatedSeconds, 0);
  });
  it("missing or invalid track means neutral accepted coordinates", () => {
    for (const groundTrackDeg of [null, NaN, -1, 360]) {
      const anchor = target({ groundTrackDeg }), result = deriveRadarDisplayPosition(anchor, start + 10_000, "ok", anchor.observedAt)!;
      assert.equal(result.longitude, anchor.longitude); assert.equal(result.extrapolatedSeconds, 0); assert.equal(result.stopped, true);
    }
  });
  it("freezes stale health at its response time and stale individual fixes at the existing bound", () => {
    const anchor = target(), generatedAt = new Date(start + 10_000).toISOString();
    const stale1 = deriveRadarDisplayPosition(anchor, start + 11_000, "stale", generatedAt)!;
    const stale2 = deriveRadarDisplayPosition(anchor, start + 40_000, "stale", generatedAt)!;
    assert.deepEqual(stale1, stale2); assert.equal(stale1.stopped, true); assert.equal(stale1.extrapolatedSeconds, 10);
    const old = target({ observedAt: new Date(start - 50_000).toISOString(), freshness: { ageSeconds: 50, state: "stale" } });
    assert.equal(deriveRadarDisplayPosition(old, start, "partial", new Date(start).toISOString())!.stopped, true);
  });
  it("a new authoritative fix replaces the old trajectory immediately", () => {
    const first = target(), replacement = target({ latitude: 41.8, longitude: -87.8, groundTrackDeg: 180, observedAt: new Date(start + 20_000).toISOString() });
    const a = deriveRadarDisplayPosition(first, start + 20_000, "ok", first.observedAt)!;
    const b = deriveRadarDisplayPosition(replacement, start + 20_000, "ok", replacement.observedAt)!;
    assert.notEqual(a.latitude, b.latitude); assert.equal(b.latitude, replacement.latitude); assert.equal(b.longitude, replacement.longitude); assert.equal(b.extrapolatedSeconds, 0);
  });
});

describe("Radar projection and deterministic bounded labels", () => {
  it("projects reference to center and rejects malformed geometry", () => {
    const reference = { latitude: 41.8819, longitude: -87.6278 };
    const center = projectRadarPoint(reference, reference, 351, 340, 38)!;
    assert.equal(center.x, 175.5); assert.equal(center.y, 170); assert.equal(center.inView, true);
    assert.equal(projectRadarPoint(reference, reference, 0, 340, 38), null);
    assert.equal(projectRadarPoint({ latitude: NaN, longitude: 0 }, reference, 351, 340, 38), null);
  });
  for (const airport of RADAR_AIRPORTS) it(`declutters a dense ${airport.code} layout at 375px without hiding the selected label`, () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ radarId: `radar-${i}`, displayIdent: `TEST ${i}`, featured: i < 5,
      point: projectRadarPoint({ latitude: airport.latitude + (i % 8 - 4) * .03, longitude: airport.longitude + (Math.floor(i / 8) - 2) * .05 }, airport, 351, 340, 25)!,
    }));
    const labels = radarLabels(rows, "radar-22", 351, 340), repeat = radarLabels(rows, "radar-22", 351, 340);
    assert.deepEqual(labels, repeat); assert.ok(labels.length <= 5); assert.equal(labels[0].radarId, "radar-22");
    for (const label of labels) { assert.ok(label.x >= 4); assert.ok(label.y >= 4); assert.ok(label.x + label.width <= 347); assert.ok(label.y + label.height <= 336); }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j]; assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
    assert.ok(labels.length < rows.length);
  });
  it("limits a spacious desktop to eight labels with Featured priority", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ radarId: `r${i}`, displayIdent: `TEST${i}`, featured: i >= 30,
      point: { x: 40 + i % 8 * 130, y: 40 + Math.floor(i / 8) * 80, eastNm: 0, northNm: 0, inView: true },
    }));
    const labels = radarLabels(rows, "r1", 1100, 500); assert.ok(labels.length <= 8); assert.equal(labels[0].radarId, "r1");
    assert.ok(labels.slice(1).some(label => Number(label.radarId.slice(1)) >= 30));
  });
  it("keeps a selected label visible near a crowded edge", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ radarId: `r${i}`, displayIdent: `TEST${i}`, featured: true, point: { x: 25, y: 25, eastNm: 0, northNm: 0, inView: true } }));
    assert.equal(radarLabels(rows, "r19", 351, 340)[0].radarId, "r19");
  });
  it("renders unknown, hint, and confirmed distinctly without provider detail", () => {
    assert.equal(radarRouteText(null), "Route unavailable");
    assert.equal(radarRouteText({ originIata: null, destinationIata: null, verification: "unknown" }), "Route unavailable");
    assert.equal(radarRouteText({ originIata: "ORD", destinationIata: "BOS", verification: "hint" }), "ORD → BOS · Route hint");
    assert.equal(radarRouteText({ originIata: "MDW", destinationIata: "DEN", verification: "confirmed" }), "MDW → DEN · Confirmed route");
  });
});


describe("Radar accessible hit-area selection", () => {
  const overlapping = [
    { radarId: "first", point: { x: 100, y: 100, inView: true } },
    { radarId: "second", point: { x: 115, y: 106, inView: true } },
  ];
  it("selects the intended symbol center even if an overlapping neighbor receives the click", () => {
    assert.equal(radarSelectionForClick("second", { detail: 1, x: 100, y: 100 }, overlapping), "first");
    assert.equal(radarSelectionForClick("first", { detail: 1, x: 115, y: 106 }, overlapping), "second");
    assert.equal(radarSelectionForClick("first", { detail: 1, x: 113, y: 104 }, overlapping), "second");
  });
  it("keyboard and programmatic activation select the focused button itself", () => {
    assert.equal(radarSelectionForClick("second", { detail: 0, x: 100, y: 100 }, overlapping), "second");
    assert.equal(radarSelectionForClick("first", { detail: 0, x: 115, y: 106 }, overlapping), "first");
  });
  it("uses a stable tie-break and excludes targets outside the view or hit areas", () => {
    const coincident = [...overlapping, { radarId: "coincident", point: { x: 100, y: 100, inView: true } }];
    assert.equal(radarSelectionForClick("coincident", { detail: 1, x: 100, y: 100 }, coincident), "first");
    assert.equal(radarSelectionForClick("second", { detail: 1, x: 100, y: 100 }, [{ radarId: "hidden", point: { x: 100, y: 100, inView: false } }]), "second");
    assert.equal(radarSelectionForClick("second", { detail: 1, x: 300, y: 300 }, overlapping), "second");
  });
});


describe("Selected Radar route evidence stays with its exact display identity", () => {
  const oldTarget = target({ displayIdent: "EDV 99", featured: true });
  const oldFeatured: PublicFeaturedFlight = {
    cardId: "safe-card", radarId: oldTarget.radarId, displayIdent: oldTarget.displayIdent,
    route: { originIata: "ORD", destinationIata: "BOS", verification: "confirmed", checkedAt: oldTarget.observedAt },
    altitudeFt: 12_000, distanceNm: 5, bearingDeg: 90, motion: oldTarget.motion, freshness: oldTarget.freshness,
    selection: oldTarget.selection,
  };
  it("drops old Featured evidence when the current target is no longer Featured", () => {
    const current = target({ displayIdent: "EDV 99", observedAt: new Date(start + 20_000).toISOString() });
    const selected = radarSelectionSnapshot(current.radarId, [current], [], oldTarget, oldFeatured);
    assert.equal(selected.target, current); assert.equal(selected.featured, null);
  });
  it("callsign changes cannot inherit cached confirmed routes, including operator aliases", () => {
    for (const [before, after] of [["EDV 99", "DAL 99"], ["UA 77", "UAL 77"]]) {
      const old = target({ displayIdent: before }), previous = { ...oldFeatured, displayIdent: before };
      const current = target({ displayIdent: after, observedAt: new Date(start + 20_000).toISOString() });
      const selected = radarSelectionSnapshot(current.radarId, [current], [], old, previous);
      assert.equal(selected.target!.displayIdent, after); assert.equal(selected.featured, null);
      const contradictory = radarSelectionSnapshot(current.radarId, [current], [previous], old, previous);
      assert.equal(contradictory.featured, null);
    }
  });
  it("retains the old selected observation and route when that observation disappears", () => {
    const selected = radarSelectionSnapshot(oldTarget.radarId, [], [], oldTarget, oldFeatured);
    assert.equal(selected.target, oldTarget); assert.equal(selected.featured, oldFeatured);
    assert.deepEqual(radarSelectionSnapshot("different-target", [], [], oldTarget, oldFeatured), { target: null, featured: null });
  });
  it("uses fresh exact-identity evidence without upgrading a generic hint", () => {
    const current = target({ displayIdent: "DAL 99" }), fresh = { ...oldFeatured, displayIdent: "DAL 99", route: { ...oldFeatured.route, verification: "hint" as const } };
    const selected = radarSelectionSnapshot(current.radarId, [current], [fresh], oldTarget, oldFeatured);
    assert.equal(selected.featured, fresh); assert.equal(selected.featured!.route.verification, "hint");
  });
});
