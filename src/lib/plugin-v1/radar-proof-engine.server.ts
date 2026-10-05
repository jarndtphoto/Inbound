import { createPrivateNearbyEngine } from "../nearby-v1/engine.server";
import { createRouteEnrichmentService } from "../nearby-v1/route-enrichment";
import { NEARBY_POLICY, observationFreshness, type AcceptedNearbyObservation, type AcquisitionResult } from "../nearby-v1/model";
import { destPoint, wrap360 } from "../geo";
import { createFakeRadarProofStores } from "./radar-proof-store";
import type { AREA_IDS } from "./areas";

export const FAKE_RADAR_AIRCRAFT_COUNT = 40;
export const FAKE_RADAR_TRACKLESS_ID = "00000000-0000-4000-8000-000000003ea6";
export const FAKE_RADAR_RETIRING_ID = "00000000-0000-4000-8000-000000003ea7";
export const FAKE_RADAR_SCENARIOS = ["ok", "partial", "stale", "unavailable", "route-failure"] as const;
export type FakeRadarProofScenario = (typeof FAKE_RADAR_SCENARIOS)[number];
const opaqueId = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const iso = (at: number) => new Date(at).toISOString();
const chicagoServiceDate = (at: number) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
type AreaId = (typeof AREA_IDS)[number];

/** Invented authoritative fixes follow bounded circuits around ORD, MDW and the
 * Chicago reference. The same accepted geo helper drives the fake positions;
 * between fixes the renderer reuses the certified 25-second motion function.
 * SYN identifiers, private identities and UUIDs are entirely invented. */
export function inventedAcquisition(at: number, startedAt: number, partial: boolean): AcquisitionResult {
  const cycle = Math.max(0, Math.floor((at - startedAt) / NEARBY_POLICY.cadenceMs));
  const acceptedAt = startedAt + cycle * NEARBY_POLICY.cadenceMs;
  const elapsedSeconds = (acceptedAt - startedAt) / 1000;
  const observations: AcceptedNearbyObservation[] = [];
  for (let index = 0; index < FAKE_RADAR_AIRCRAFT_COUNT; index++) {
    // One old, still accepted fix becomes visibly stale, then is omitted by the
    // next acquisition rather than illegally publishing >45-second telemetry.
    if (index === 39 && cycle > 0) continue;
    // Keep fifteen airport-area aircraft relatively dense, then distribute the
    // other twenty-five over three wider circuits. All remain inside each
    // default 25-nm airport view and the shared 38-nm Chicago overview.
    const center = index < 8 ? { lat: 41.974, lon: -87.872 }
      : index < 15 ? { lat: 41.7868, lon: -87.7522 } : { lat: 41.900, lon: -87.800 };
    const radiusNm = index < 8 ? 4.2 + (index % 4) * 0.16
      : index < 15 ? 3.2 : index < 23 ? 9 : index < 31 ? 13 : 17;
    const initialAngle = index < 8 ? index * 45
      : index < 15 ? (index - 8) * 360 / 7 + 2
        : index < 23 ? (index - 15) * 45 + 227
          : index < 31 ? (index - 23) * 45 : (index - 31) * 40 + 20;
    const groundspeedKt = index < 4 ? 210 + index * 10 : 180 + (index % 8) * 22;
    const angle = wrap360(initialAngle + elapsedSeconds * groundspeedKt / 3600 / radiusNm * 180 / Math.PI);
    const position = destPoint(center, angle, radiusNm);
    const groundTrackDeg = index === 38 ? null : wrap360(angle + 90);
    const phase = index % 3 === 1 ? Math.PI : 0;
    const changingAltitude = index < 4 || index % 3 !== 2;
    const altitudeAt = (seconds: number) => changingAltitude
      ? (index < 4 ? 7800 : 16000) + 2500 * Math.sin(seconds * Math.PI / 600 + phase)
      : 28000 + (index % 5) * 1000;
    const rateAt = (seconds: number) => changingAltitude ? Math.round(2500 * Math.PI / 600 * 60 * Math.cos(seconds * Math.PI / 600 + phase)) : 0;
    const observedAt = index === 39 ? startedAt - 40_000 : acceptedAt;
    const observedSeconds = (observedAt - startedAt) / 1000;
    const observedCallsign = `SYN${101 + index}`;
    const sessionKey = `invented-radar-session-${index + 1}`;
    // SYN101/SYN102 carry an exact dated binding. SYN105 carries a confirmed
    // route without a date so the handoff resolver must return two explicit
    // dated candidates rather than guessing. SYN103 remains unconfirmed and
    // SYN104 is the documented unsupported aircraft.
    const confirmed = index < 2 || index === 4;
    const route = confirmed
      ? { originIata: index === 1 ? "MDW" : "ORD", destinationIata: index === 1 ? "DEN" : "BOS",
        verification: "confirmed" as const, checkedAt: iso(observedAt) }
      : { originIata: null, destinationIata: null, verification: "unknown" as const, checkedAt: null };
    observations.push({
      cardId: opaqueId(8000 + index), radarId: opaqueId(16000 + index),
      privateAircraftIdentity: `invented-radar-aircraft-${index + 1}`, sessionKey, observedCallsign,
      registration: null, latitude: position.lat, longitude: position.lon,
      altitudeFt: Math.round(altitudeAt(observedSeconds)), groundspeedKt, groundTrackDeg,
      verticalRateFpm: rateAt(observedSeconds), onGround: false, observedAt: iso(observedAt),
      positionKind: "observed", acceptedPosition: true, identityConflict: false,
      phaseEvidence: [-60, -40, -20].map(offset => [observedAt / 1000 + offset,
        Math.round(altitudeAt(observedSeconds + offset)), rateAt(observedSeconds + offset), false,
        position.lat, position.lon]),
      typeCode: index % 2 ? "A320" : "B738", category: null, operator: "Invented Air",
      interesting: index < 4, route,
      // Confirmed evidence is independently invented and dated in the accepted
      // acquisition; generic fake lookup results can only ever be hints.
      datedBinding: index < 2 ? { sessionKey, observedCallsign, serviceDate: chicagoServiceDate(observedAt), confirmedAt: iso(observedAt) } : null,
      freshness: observationFreshness(iso(observedAt), at),
      provenance: { source: "invented_radar", receivedAt: iso(at), positionAgeSeconds: Math.max(0, (at - observedAt) / 1000), acceptance: "inbound-fusion" },
    });
  }
  return { observations, partial,
    metadata: { providerCalls: 0, rawCount: observations.length, fusedCount: observations.length,
      rejectedCount: 0, successfulProviders: 0, failedProviders: 0 } };
}

/** Fake-only engine-backed host service. No environment lookup, SQL connector,
 * production Inbound API, default acquisition, or live route provider is used.
 * The isolated build guards the certified engine's unused default constructors.
 * Factory scenarios are private test configuration, never an MCP input. */
export async function createFakeRadarProofService(options: {
  clock?: () => number;
  scenario?: FakeRadarProofScenario;
  /** Initialization explicitly constructs a single bounded route task. Viewer
   * requests never construct routes or invoke a lookup. */
  warmRoutes?: boolean;
} = {}) {
  const sourceClock = options.clock ?? Date.now;
  const scenario = options.scenario ?? "ok";
  if (!(FAKE_RADAR_SCENARIOS as readonly string[]).includes(scenario)) throw new RangeError("Unsupported fake proof scenario");
  const originalStart = sourceClock();
  if (!Number.isFinite(originalStart)) throw new RangeError("Invalid fake proof clock");
  // A stale scenario seeds a genuinely accepted previous collection before the
  // current read. It then uses the engine's normal last-safe failure behavior.
  let seedAt: number | null = scenario === "stale" ? originalStart - 60_000 : null;
  const startedAt = seedAt ?? originalStart;
  const clock = () => seedAt ?? sourceClock();
  const stores = createFakeRadarProofStores();
  let disposed = false, fakeAcquisitions = 0, successfulFakeAcquisitions = 0, fakeRouteLookups = 0;
  let explicitConstructionTasks = 0, viewerRequests = 0;
  const routeStarts: { callsign: string; atMs: number }[] = [];
  const routeEnrichment = createRouteEnrichmentService({ store: stores.route, clock,
    lookup: async observedCallsign => {
      fakeRouteLookups++;
      routeStarts.push({ callsign: observedCallsign, atMs: clock() });
      if (scenario === "route-failure") throw new Error("Invented route lookup unavailable");
      const negative = observedCallsign === "SYN104";
      return { observedCallsign, originIata: negative ? null : "ORD", destinationIata: negative ? null : "BOS",
        airlineLabel: negative ? null : "Invented Air", outcome: negative ? "negative" : "positive",
        sourceClass: "invented_route", verification: negative ? "unknown" : "hint" };
    } });
  const engine = createPrivateNearbyEngine({ environment: "fake_radar_proof", clock, store: stores.collection, routeEnrichment,
    acquire: async () => {
      fakeAcquisitions++;
      if (scenario === "unavailable" || scenario === "stale" && seedAt === null) throw new Error("Invented telemetry unavailable");
      successfulFakeAcquisitions++;
      return inventedAcquisition(clock(), startedAt, scenario === "partial");
    } });
  const requireOpen = () => { if (disposed) throw new Error("Fake Radar proof service is disposed"); };
  const constructRoutes = async (area: AreaId = "preset:chicago", input: { radiusNm?: 12 | 25 | 38 } = {}) => {
    requireOpen();
    explicitConstructionTasks++;
    return engine.constructRouteHints(area, input);
  };
  if (scenario === "stale" || options.warmRoutes !== false && scenario !== "unavailable") {
    await engine.request("preset:chicago");
    if (options.warmRoutes !== false) await constructRoutes();
  }
  seedAt = null;
  return {
    async request(area: AreaId, input: { radiusNm?: 12 | 25 | 38; limit?: number } = {}) {
      requireOpen(); viewerRequests++; return engine.request(area, input);
    },
    async requestRadar(area: AreaId, input: { radiusNm?: 12 | 25 | 38 } = {}) {
      requireOpen(); viewerRequests++; return engine.requestRadar(area, input);
    },
    constructRoutes,
    diagnostics: () => ({ scenario, startedAt: iso(startedAt), fakeAircraftCount: FAKE_RADAR_AIRCRAFT_COUNT,
      fakeAcquisitions, successfulFakeAcquisitions, fakeRouteLookups, explicitConstructionTasks, viewerRequests,
      providerApiCalls: 0 as const, productionApiCalls: 0 as const, productionDbAccess: 0 as const,
      authoritativeCadenceMs: NEARBY_POLICY.cadenceMs, routeStarts: structuredClone(routeStarts), ...stores.diagnostics() }),
    dispose() { disposed = true; stores.dispose(); },
  };
}
export type FakeRadarProofService = Awaited<ReturnType<typeof createFakeRadarProofService>>;
