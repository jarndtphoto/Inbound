import { destPoint, haversineNm, type Coord } from "./geo.ts";

export type RunwayEnd = Coord & { ident: string; heading: number; displacedFt?: number };
export type ExpectedArrivalRunway = { runway: string; source: "ATIS" | "provider" | "wind estimate"; estimated: boolean; threshold: Coord; heading: number; atisTime?: string };
export type AtisEntry = { airport: string; type: string; datis: string; time?: string; updatedAt?: string };
export const normalizeRunway = (ident: string) => ident.toUpperCase().replace(/^(?:RWY|RUNWAY)\s*/, "").replace(/^0(?=\d)/, "");
const delta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Extract positive arrival/approach assignments, never departure-only or NOTAM runways. */
export function arrivalRunways(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalized = text.toUpperCase().replace(/\b(\d{1,2})\s*(LEFT|RIGHT|CENTER)\b/g, (_, n, side) => n + side[0])
    .replace(/\bLDG\s*\/\s*DEP\b/g, "LDG");
  const found: string[] = [];
  for (const clause of normalized.split(/[.;]/)) {
    // A combined bulletin can switch to departure instructions mid-sentence.
    const arrival = clause.split(/\b(?:DEPS?|DEPARTURES?|DEPARTING|TAKEOFF)\b/)[0];
    if (!/\b(?:LDG|LANDING|ARR|ARRIVALS?|APCH|APPROACH|ILS|RNAV|VISUAL)\b/.test(arrival)) continue;
    if (/\b(?:CLSD|CLOSED|NOTAM)\b/.test(arrival)) continue;
    const list = /\b(?:RWYS?|RUNWAYS?|RY)\s+(\d{1,2}[LRC]?(?:\s*(?:,|\/|AND|&)\s*\d{1,2}[LRC]?)*)\b/g;
    for (const match of arrival.matchAll(list)) {
      for (const runway of match[1].match(/\d{1,2}[LRC]?/g) ?? []) {
        if (+runway.replace(/[LRC]/, "") >= 1 && +runway.replace(/[LRC]/, "") <= 36) found.push(normalizeRunway(runway));
      }
    }
  }
  return [...new Set(found)];
}

export function runwayThreshold(end: RunwayEnd): Coord {
  return end.displacedFt ? destPoint(end, end.heading, end.displacedFt / 6076.12) : { lat: end.lat, lon: end.lon };
}
// Local true bearing keeps runway geometry independent of existing phase helpers.
export function runwayBearing(a: Coord, b: Coord) {
  const rad = Math.PI / 180, lat1 = a.lat * rad, lat2 = b.lat * rad, lon = (b.lon - a.lon) * rad;
  return (Math.atan2(Math.sin(lon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon)) / rad + 360) % 360;
}
export function runwayCoordinates(point: Coord, end: RunwayEnd) {
  const threshold = runwayThreshold(end), distance = haversineNm(threshold, point);
  const angle = (runwayBearing(threshold, point) - end.heading) * Math.PI / 180;
  return { x: distance * Math.cos(angle), y: distance * Math.sin(angle) };
}

export function pickArrivalRunway(input: {
  ends: RunwayEnd[]; atis?: AtisEntry[] | null; aircraft?: Coord | null;
  providerRunway?: string | null; actualLanding?: boolean; windDir?: number | null; windKt?: number | null;
  previous?: ExpectedArrivalRunway | null;
}): ExpectedArrivalRunway | null {
  const { ends, aircraft, previous } = input;
  const provider = ends.find(r => normalizeRunway(r.ident) === normalizeRunway(input.providerRunway ?? ""));
  const entries = (input.atis ?? []).filter(e => e.type !== "dep" && e.type !== "departure");
  const assignments = entries.flatMap(e => arrivalRunways(e.datis));
  let candidates = ends.filter(r => assignments.includes(normalizeRunway(r.ident)));
  let source: ExpectedArrivalRunway["source"] = "ATIS";
  if (input.actualLanding && provider) { candidates = [provider]; source = "provider"; }
  else if (!candidates.length && provider) { candidates = [provider]; source = "provider"; }
  else if (!candidates.length && typeof input.windDir === "number" && Number.isFinite(input.windDir) && (input.windKt ?? 0) >= 3) {
    const best = Math.min(...ends.map(r => delta(r.heading, input.windDir!)));
    // Variable/calm wind, or a wind perpendicular to every usable end, is insufficient evidence.
    if (best >= 85) return null;
    candidates = ends.filter(r => delta(r.heading, input.windDir!) <= best + 5); source = "wind estimate";
  }
  if (!candidates.length) return null;
  // Keep a still-valid assignment for this flight, avoiding parallel-runway flip-flops between polls.
  const held = previous?.source === source ? candidates.find(r => normalizeRunway(r.ident) === previous.runway) : null;
  const selected = held ?? candidates.slice().sort((a, b) => {
    if (!aircraft) return normalizeRunway(a.ident).localeCompare(normalizeRunway(b.ident));
    const score = (r: RunwayEnd) => Math.abs(runwayCoordinates(aircraft, r).y) + haversineNm(aircraft, r) * 0.01;
    return score(a) - score(b);
  })[0];
  return { runway: normalizeRunway(selected.ident), source, estimated: source !== "provider", threshold: runwayThreshold(selected), heading: selected.heading,
    ...(source === "ATIS" && entries[0]?.time ? { atisTime: entries[0].time } : {}) };
}
