import { randomUUID } from "node:crypto";
import { ageOf, coordsOk, isTeleport, rawToObservation, STALE_AIR_SEC, STALE_GROUND_SEC, type AdsbRaw, type ProviderAcquisitionPack, type Observation } from "../adsb-fusion";
import { isInterestingAircraft } from "../aircraft";
import { haversineNm } from "../geo";
import { CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { DisplayIdentSchema } from "../plugin-v1/contracts";
import type { NearbyPhaseSample } from "../plugin-v1/ranking";
import { NEARBY_POLICY, nearbyStorageBytes, observationFreshness, type AcceptedNearbyObservation } from "./model";

const stringValue = (value: unknown, max = 80): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const ident = (value: unknown): string | null => {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : null;
  return DisplayIdentSchema.safeParse(candidate).success ? candidate : null;
};
const numberValue = (value: unknown, min: number, max: number): number | null => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
const trackValue = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 360 ? value : null;
function evidencedObservations(packs: readonly ProviderAcquisitionPack[], nowMs: number): Observation[] {
  return packs.flatMap(pack => pack.status !== "ok" ? [] : pack.ac.flatMap(raw => {
    const observation = rawToObservation(raw, pack.provider, pack.receivedAt);
    if (!observation || !/^[0-9a-f]{6}$/.test(observation.hex) || raw.extrapolated || raw._fusion?.extrapolated) return [];
    const positionKind = (raw as AdsbRaw & { positionKind?: string }).positionKind;
    if (positionKind && positionKind !== "observed") return [];
    const ageSeconds = ageOf(observation, nowMs);
    const ground = observation.altBaro === "ground" || observation.altBaro === 0;
    if (observation.seen < 0 || !Number.isFinite(pack.receivedAt) || pack.receivedAt > nowMs
      || !Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > (ground ? STALE_GROUND_SEC : STALE_AIR_SEC)) return [];
    return [observation];
  }));
}

/** Small private boundary AFTER existing Inbound fusion. Provider structures end
 * here; only current-cycle evidenced, observed fixes become authoritative. */
export function normalizeAcceptedNearby(
  packs: readonly ProviderAcquisitionPack[], fused: readonly AdsbRaw[], previous: readonly AcceptedNearbyObservation[], nowMs: number,
): AcceptedNearbyObservation[] {
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid collection clock");
  const evidence = evidencedObservations(packs, nowMs);
  const conflicting = new Set<string>();
  const identities = new Map<string, { callsigns: Set<string>; registrations: Set<string> }>();
  for (const observation of evidence) {
    const values = identities.get(observation.hex) ?? { callsigns: new Set<string>(), registrations: new Set<string>() };
    const callsign = ident(observation.raw.flight), registration = ident(observation.raw.r);
    if (callsign) values.callsigns.add(callsign);
    if (registration) values.registrations.add(registration);
    if (values.callsigns.size > 1 || values.registrations.size > 1) conflicting.add(observation.hex);
    identities.set(observation.hex, values);
  }
  const priorByIdentity = new Map(previous.map(observation => [observation.privateAircraftIdentity, observation]));
  const accepted = new Map<string, AcceptedNearbyObservation>();
  for (const raw of fused) {
    if (!raw._fusion || raw.extrapolated || raw._fusion.extrapolated || !coordsOk(raw.lat, raw.lon)) continue;
    const hex = String(raw.hex ?? "").toLowerCase();
    if (conflicting.has(hex)) continue;
    const anchor = evidence.find(observation => observation.hex === hex && observation.provider === raw._fusion!.provider
      && observation.lat === raw.lat && observation.lon === raw.lon
      && observation.raw.flight === raw.flight && observation.raw.r === raw.r
      && Math.abs(ageOf(observation, nowMs) - raw._fusion!.ageSec) < 0.001);
    if (!anchor) continue; // A retained warm-instance fix is last-safe data, not a new observation.
    const latitude = anchor.lat, longitude = anchor.lon;
    if (haversineNm({ lat: CHICAGO_COLLECTION.latitude, lon: CHICAGO_COLLECTION.longitude }, { lat: latitude, lon: longitude }) > CHICAGO_COLLECTION.radiusNm) continue;
    const observedAtMs = anchor.receivedAt - anchor.seen * 1_000;
    if (!Number.isFinite(observedAtMs) || observedAtMs < 0 || observedAtMs > nowMs) continue;
    const privateAircraftIdentity = `adsb:${hex}`;
    const prior = priorByIdentity.get(privateAircraftIdentity);
    const observedCallsign = ident(raw.flight), registration = ident(raw.r);
    const groundspeedKt = numberValue(raw.gs ?? raw.spd, 0, 2_000);
    const priorAt = prior ? Date.parse(prior.observedAt) : NaN;
    const continuing = prior && Number.isFinite(priorAt) && observedAtMs - priorAt <= NEARBY_POLICY.hardStaleMs;
    const priorIdentity = continuing ? prior.sessionIdentity ?? { observedCallsign: prior.observedCallsign, registration: prior.registration } : null;
    if (prior) {
      if (Number.isFinite(priorAt) && observedAtMs < priorAt) continue;
      if (priorIdentity?.registration && registration && priorIdentity.registration !== registration) continue;
      if (prior.positionKind === "observed" && prior.acceptedPosition && Number.isFinite(priorAt)
        && isTeleport({ lat: prior.latitude, lon: prior.longitude, gs: prior.groundspeedKt, at: priorAt },
          { lat: latitude, lon: longitude, gs: groundspeedKt, receivedAt: observedAtMs }, observedAtMs)) continue;
    }
    const callsignChanged = priorIdentity?.observedCallsign && observedCallsign && priorIdentity.observedCallsign !== observedCallsign;
    const stableSession = continuing && !callsignChanged;
    const cardId = stableSession ? prior.cardId : randomUUID();
    const sessionKey = stableSession ? prior.sessionKey : randomUUID();
    const radarId = stableSession ? prior.radarId : randomUUID();
    const onGround = raw.alt_baro === "ground" || raw.alt_baro === 0 ? true
      : numberValue(raw.alt_baro, -2_000, 200_000) !== null || numberValue(raw.alt_geom, -2_000, 200_000) !== null ? false : null;
    const altitudeFt = onGround === true ? 0 : numberValue(raw.alt_baro, -2_000, 200_000) ?? numberValue(raw.alt_geom, -2_000, 200_000);
    const observedAt = new Date(observedAtMs).toISOString();
    const typeCode = stringValue(raw.t, 16), year = stringValue(raw.year, 8);
    const observation: AcceptedNearbyObservation = {
      cardId, radarId, privateAircraftIdentity, sessionKey, observedCallsign, registration, latitude, longitude,
      sessionIdentity: { observedCallsign: observedCallsign ?? priorIdentity?.observedCallsign ?? null,
        registration: registration ?? priorIdentity?.registration ?? null },
      altitudeFt, groundspeedKt, groundTrackDeg: trackValue(raw.track),
      verticalRateFpm: numberValue(raw.baro_rate, -20_000, 20_000) ?? numberValue(raw.geom_rate, -20_000, 20_000), onGround, observedAt,
      positionKind: "observed", acceptedPosition: true, identityConflict: false,
      typeCode, category: stringValue(raw.category, 16), operator: stringValue(raw.ownOp, 80),
      interesting: isInterestingAircraft(typeCode, year, new Date(nowMs).getUTCFullYear()),
      route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
      freshness: observationFreshness(observedAt, nowMs),
      provenance: { source: `adsb:${anchor.provider}`, receivedAt: new Date(anchor.receivedAt).toISOString(),
        positionAgeSeconds: ageOf(anchor, nowMs), acceptance: "inbound-fusion" },
    };
    if (stableSession && prior.positionKind === "observed" && prior.acceptedPosition) {
      const priorSample: NearbyPhaseSample = [priorAt / 1000, prior.altitudeFt, prior.verticalRateFpm, prior.onGround, prior.latitude, prior.longitude];
      const samples = [...prior.phaseEvidence ?? [], priorSample]
        .filter(([seenAt]) => seenAt < observedAtMs / 1000 && observedAtMs / 1000 - seenAt <= 120);
      // Replacing current JSON preserves cold-poll evidence without an append
      // log. Repeated provider timestamps never create additional phase proof.
      observation.phaseEvidence = [...new Map(samples.map(sample => [sample[0], sample])).values()]
        .sort((a, b) => a[0] - b[0]).slice(-NEARBY_POLICY.maxPhaseSamples);
    }
    const existing = accepted.get(privateAircraftIdentity);
    if (!existing || observedAt > existing.observedAt) accepted.set(privateAircraftIdentity, observation);
  }
  // One current snapshot bounded by count AND existing durable JSON capacity.
  // Compact phase evidence must not cause a dense real collection to fail publication.
  const ordered = [...accepted.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.privateAircraftIdentity.localeCompare(b.privateAircraftIdentity));
  const bounded: AcceptedNearbyObservation[] = [];
  let bytes = 2;
  for (const observation of ordered) {
    if (bounded.length >= NEARBY_POLICY.maxAccepted) break;
    const rowBytes = nearbyStorageBytes(observation) + (bounded.length ? 2 : 0);
    if (bytes + rowBytes > NEARBY_POLICY.maxAcceptedBytes) break;
    bounded.push(observation); bytes += rowBytes;
  }
  return bounded;
}
