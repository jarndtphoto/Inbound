import { haversineNm } from "./geo.ts";

export type FlightProvider = "fr24" | "flightaware" | "adsb";
export type Confidence = "high" | "medium" | "low";
export type ProviderState = "ACTIVE" | "DISABLED" | "AUTH_FAILED" | "RATE_LIMITED" | "NO_MATCH" | "ERROR";

export type NormalizedPosition = {
  provider: FlightProvider;
  flightId: string | null;
  callsign: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  track: number | null;
  onGround: boolean | null;
  seenAt: number;
  registration: string | null;
  type: string | null;
  hex: string | null;
  confidence: Confidence;
};

export type FlightTimes = {
  scheduled: number | null;
  estimated: number | null;
  actual: number | null;
};

export type NormalizedFlight = {
  provider: FlightProvider;
  flightId: string | null;
  callsign: string | null;
  status: string | null;
  position: NormalizedPosition | null;
  origin: { iata: string | null; icao: string | null; gate: string | null; terminal: string | null } | null;
  destination: { iata: string | null; icao: string | null; gate: string | null; terminal: string | null } | null;
  push: FlightTimes;
  takeoff: FlightTimes;
  landing: FlightTimes;
  gateIn: FlightTimes;
  registration: string | null;
  type: string | null;
  hex: string | null;
  route: string | null;
  waypoints: Array<{ lat: number; lon: number }>;
  track: Array<{ lat: number; lon: number; altFt: number | null; gsKt: number | null; track: number | null; seenAt: number }>;
  providerEta: number | null;
  runway: { takeoff: string | null; landing: string | null };
};

const PROVIDER_WEIGHT: Record<FlightProvider, number> = { fr24: 24, adsb: 20, flightaware: 16 };

export function positionAgeSec(position: NormalizedPosition, now = Date.now() / 1000): number {
  return Math.max(0, now - position.seenAt);
}

export function identityCompatible(position: NormalizedPosition, expected: { callsigns?: string[]; registration?: string | null; hex?: string | null }): boolean {
  const norm = (v: string | null | undefined) => String(v ?? "").replace(/[-\s]/g, "").toUpperCase();
  const lockedHex = norm(expected.hex);
  const lockedReg = norm(expected.registration);
  if (lockedHex && position.hex && norm(position.hex) !== lockedHex) return false;
  if (lockedReg && position.registration && norm(position.registration) !== lockedReg) return false;
  const wanted = (expected.callsigns ?? []).map(norm).filter(Boolean);
  if (!wanted.length || !position.callsign) return true;
  const actual = norm(position.callsign);
  const actualNum = actual.match(/\d+/)?.[0]?.replace(/^0+/, "");
  return wanted.some((candidate) => {
    if (candidate === actual) return true;
    const number = candidate.match(/\d+/)?.[0]?.replace(/^0+/, "");
    return Boolean(number && actualNum && number === actualNum);
  });
}

export type PositionChoice = {
  chosen: NormalizedPosition | null;
  disagreementNm: number | null;
  candidates: Partial<Record<FlightProvider, NormalizedPosition>>;
};

export function choosePosition(
  positions: Array<NormalizedPosition | null | undefined>,
  expected: { callsigns?: string[]; registration?: string | null; hex?: string | null } = {},
  now = Date.now() / 1000,
): PositionChoice {
  const usable = positions.filter((p): p is NormalizedPosition => Boolean(p && identityCompatible(p, expected) && positionAgeSec(p, now) <= (p.onGround ? 60 : 45)));
  const candidates: Partial<Record<FlightProvider, NormalizedPosition>> = {};
  for (const p of usable) if (!candidates[p.provider] || positionAgeSec(p, now) < positionAgeSec(candidates[p.provider]!, now)) candidates[p.provider] = p;
  let disagreementNm: number | null = null;
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    const d = haversineNm(usable[i]!, usable[j]!);
    disagreementNm = disagreementNm == null ? d : Math.max(disagreementNm, d);
  }
  let chosen: NormalizedPosition | null = null;
  let best = -Infinity;
  for (const p of usable) {
    const age = positionAgeSec(p, now);
    const consensus = usable.filter((q) => q !== p && haversineNm(p, q) <= 3).length;
    const score = PROVIDER_WEIGHT[p.provider] + consensus * 30 - age * 2 + (p.confidence === "high" ? 8 : p.confidence === "medium" ? 3 : 0);
    if (score > best) { best = score; chosen = p; }
  }
  return { chosen, disagreementNm, candidates };
}

export function normalizedToLive(position: NormalizedPosition) {
  return {
    hex: position.hex ?? "",
    callsign: position.callsign,
    registration: position.registration,
    type: position.type,
    typeName: position.type,
    year: null,
    operator: null,
    lat: position.lat,
    lon: position.lon,
    altFt: position.altFt,
    gsKt: position.gsKt,
    track: position.track,
    vertFpm: null,
    onGround: Boolean(position.onGround),
    phase: position.onGround ? ((position.gsKt ?? 0) > 8 ? "taxi" : "parked") : "cruise",
    extrapolated: false,
    seenSec: positionAgeSec(position),
    seenAt: position.seenAt,
    source: position.provider,
    confidence: position.confidence,
  };
}

export function finalApproachEtaMin(remainingNm: number, gsKt: number): number {
  const kin = remainingNm / Math.max(90, gsKt) * 60;
  return remainingNm < 0.15 ? 0 : Math.min(60, kin);
}

export function passengerEtaMin(input: {
  remainingNm: number;
  directToDestNm: number | null;
  gsKt: number;
  providerEtaMin: number | null;
}): number {
  const { remainingNm, directToDestNm, gsKt, providerEtaMin } = input;
  const onFinalApproach = directToDestNm != null && directToDestNm <= 25;
  if (onFinalApproach) return finalApproachEtaMin(remainingNm, gsKt);
  const nearDest = remainingNm < 80;
  const speed = gsKt > 120 && nearDest ? gsKt : Math.max(420, gsKt > 300 ? gsKt : 0) || 440;
  const kinetic = remainingNm / speed * 60;
  if (nearDest && gsKt > 120) return Math.max(1, kinetic);
  if (providerEtaMin != null && providerEtaMin > 1) return providerEtaMin;
  return Math.max(1, kinetic);
}

export function emptyTimes(): FlightTimes { return { scheduled: null, estimated: null, actual: null }; }
