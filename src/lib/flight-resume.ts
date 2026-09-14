import { airportByIcao } from "./airports.ts";
import { parseFlightQuery, storyMatchesQuery } from "./flight-parse.ts";
import type { FlightStory } from "./types.ts";

// A short bridge through an outage, never a flight-number-to-route database.
export const RESUME_MAX_AGE_MS = 2 * 60 * 60_000;
type Stamp = { scheduled: number | null; estimated: number | null; actual: number | null };
export type FlightResume = {
  version: 1;
  callsign: string;
  ident: string;
  confirmedAt: number;
  originIcao: string;
  destIcao: string;
  originIata: string;
  destIata: string;
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  originTz: string | null;
  destTz: string | null;
  originName: string;
  originCity: string;
  destName: string;
  destCity: string;
  originGate: string | null;
  destGate: string | null;
  gateOut: Stamp;
  takeoff: Stamp;
  landing: Stamp;
  gateIn: Stamp;
  tail: string | null;
  hex: string | null;
  type: string | null;
  waypoints: { lat: number; lon: number }[];
};

/** Whitelist bounded device context; no supplied URLs, status, or live fixes. */
export function readFlightResume(input: unknown, q: string, now = Date.now()): FlightResume | undefined {
  if (!input || typeof input !== "object") return;
  const r = input as Record<string, any>;
  const want = parseFlightQuery(q);
  if (!want || want.registration || r.version !== 1 || r.callsign !== want.callsign) return;
  if (typeof r.confirmedAt !== "number" || !Number.isFinite(r.confirmedAt)
    || r.confirmedAt > now + 30_000 || now - r.confirmedAt > RESUME_MAX_AGE_MS) return;
  if (typeof r.ident !== "string" || !/^[A-Z0-9]{3,8}$/.test(r.ident)) return;
  if (typeof r.originIcao !== "string" || !/^[A-Z]{4}$/.test(r.originIcao)
    || typeof r.destIcao !== "string" || !/^[A-Z]{4}$/.test(r.destIcao) || r.originIcao === r.destIcao) return;
  const fields: Record<string, any> = {};
  for (const prefix of ["origin", "dest"]) {
    const known = airportByIcao(r[`${prefix}Icao`]);
    const lat = known?.lat ?? r[`${prefix}Lat`], lon = known?.lon ?? r[`${prefix}Lon`];
    if (typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > 90
      || typeof lon !== "number" || !Number.isFinite(lon) || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return;
    const label = (s: unknown, fallback: string) => typeof s === "string" && s.length <= 80 ? s.replace(/[\x00-\x1f]/g, "").trim() || fallback : fallback;
    const iata = known?.iata ?? (/^[A-Z]{3}$/.test(r[`${prefix}Iata`] ?? "") ? r[`${prefix}Iata`] : r[`${prefix}Icao`]);
    let tz = known?.tz ?? r[`${prefix}Tz`] ?? null;
    try { if (typeof tz !== "string" || tz.length > 60) tz = null; else new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = null; }
    Object.assign(fields, {
      [`${prefix}Lat`]: lat, [`${prefix}Lon`]: lon, [`${prefix}Iata`]: iata, [`${prefix}Tz`]: tz,
      [`${prefix}Name`]: known?.name ?? label(r[`${prefix}Name`], iata),
      [`${prefix}City`]: known?.city ?? label(r[`${prefix}City`], iata),
    });
  }
  const stamps: Record<string, Stamp> = {};
  for (const key of ["gateOut", "takeoff", "landing", "gateIn"]) {
    const source = r[key];
    if (!source || typeof source !== "object") return;
    const stamp: Stamp = { scheduled: null, estimated: null, actual: null };
    for (const kind of ["scheduled", "estimated", "actual"] as const) {
      const t = source[kind];
      if (t == null) continue;
      if (typeof t !== "number" || !Number.isFinite(t) || Math.abs(t * 1000 - r.confirmedAt) > 36 * 60 * 60_000) return;
      if (kind === "actual" && t * 1000 > r.confirmedAt + 120_000) return;
      stamp[kind] = t;
    }
    stamps[key] = stamp;
  }
  const best = (s: Stamp) => s.actual ?? s.estimated ?? s.scheduled;
  const depart = best(stamps.gateOut) ?? best(stamps.takeoff);
  const arrive = best(stamps.gateIn) ?? best(stamps.landing);
  if (depart == null || depart * 1000 < now - 30 * 60 * 60_000 || depart * 1000 > now + 18 * 60 * 60_000) return;
  if (arrive != null && (arrive <= depart || arrive - depart > 24 * 3600)) return;
  const actuals = [stamps.gateOut.actual, stamps.takeoff.actual, stamps.landing.actual, stamps.gateIn.actual].filter((t): t is number => t != null);
  if (actuals.some((t, i) => i > 0 && t < actuals[i - 1])) return;
  const token = (s: unknown, re: RegExp) => typeof s === "string" && re.test(s) ? s : null;
  const waypoints = Array.isArray(r.waypoints) ? r.waypoints.slice(0, 256).filter((p: any) =>
    p && typeof p.lat === "number" && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
      && typeof p.lon === "number" && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
  ).map((p: any) => ({ lat: p.lat, lon: p.lon })) : [];
  return {
    version: 1, callsign: want.callsign, ident: r.ident, confirmedAt: r.confirmedAt,
    ...fields, originIcao: r.originIcao, destIcao: r.destIcao,
    originGate: token(r.originGate, /^[A-Z0-9 -]{1,12}$/i), destGate: token(r.destGate, /^[A-Z0-9 -]{1,12}$/i),
    gateOut: stamps.gateOut, takeoff: stamps.takeoff, landing: stamps.landing, gateIn: stamps.gateIn,
    tail: token(r.tail, /^[A-Z0-9-]{3,12}$/i), hex: token(r.hex, /^[a-f0-9]{6}$/i),
    type: token(r.type, /^[A-Z0-9-]{2,8}$/i), waypoints,
  } as FlightResume;
}

export function resumeFromStory(story: FlightStory | undefined, q: string, now = Date.now()): FlightResume | undefined {
  if (!story || story.diversion || !storyMatchesQuery(story, q)) return;
  // Never extend the schedule's lifetime when only ADS-B/weather refreshed.
  if (story.resume) return readFlightResume(story.resume, q, now);
  if (story.schedule?.status === "saved") return;
  const callsign = parseFlightQuery(q)?.callsign;
  const t = story.times;
  if (!t) return;
  // Older releases didn't preserve raw provider timestamps. Keep those values
  // as estimates: some displayed "actual" times were movement inferences.
  const stamp = (value?: number | null, original?: number | null): Stamp => ({
    scheduled: original ?? null, estimated: value ?? null, actual: null,
  });
  return readFlightResume({
    version: 1, callsign, ident: callsign, confirmedAt: story.schedule?.confirmedAt ?? story.fetchedAt,
    originIcao: story.origin?.icao, destIcao: story.dest?.icao,
    originIata: story.origin?.iata, destIata: story.dest?.iata,
    originLat: story.origin?.lat, originLon: story.origin?.lon, destLat: story.dest?.lat, destLon: story.dest?.lon,
    originTz: story.origin?.tz, destTz: story.dest?.tz,
    originName: story.origin?.name, originCity: story.origin?.city, destName: story.dest?.name, destCity: story.dest?.city,
    originGate: t.originGate, destGate: t.destGate,
    gateOut: stamp(t.pushUnix, t.origPushUnix), takeoff: stamp(t.takeoffUnix, t.origTakeoffUnix),
    landing: stamp(t.landUnix, t.origLandUnix), gateIn: stamp(t.gateUnix),
    tail: story.aircraft?.registration, hex: story.aircraft?.hex, type: story.aircraft?.type,
    waypoints: [],
  }, q, now);
}

export function savedScheduleNote(confirmedAt: number): string {
  return "Schedule updates are delayed. Times and gates were last checked "
    + new Date(confirmedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    + ". Position and weather are checked separately; the route may have changed.";
}
