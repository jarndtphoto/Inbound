import { type FlightTimes, type NormalizedFlight, type NormalizedPosition } from "./flight-data.ts";

const BASE = "https://aeroapi.flightaware.com/aeroapi";
const cache = new Map<string, { at: number; value: unknown }>();
const aeroApiKey = () => process.env.FLIGHTAWARE_AEROAPI_KEY?.trim() || process.env.FLIGHTAWARE_API_KEY?.trim() || "";
const unix = (v: unknown) => typeof v === "string" || typeof v === "number" ? Math.floor(new Date(v).getTime() / 1000) || null : null;
const times = (f: any, name: string): FlightTimes => ({ scheduled: unix(f[`scheduled_${name}`]), estimated: unix(f[`estimated_${name}`]), actual: unix(f[`actual_${name}`]) });

async function get(path: string, ttlMs: number) {
  const key = aeroApiKey();
  if (!key) return null;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  console.info(JSON.stringify({ event: "flightaware_upstream_request", timestamp: new Date().toISOString(), path, cache: "miss" }));
  const res = await fetch(`${BASE}${path}`, { headers: { "x-apikey": key, Accept: "application/json" }, signal: AbortSignal.timeout(6500) });
  if (!res.ok) throw new Error(`AeroAPI ${res.status}`);
  const value = await res.json();
  cache.set(path, { at: Date.now(), value });
  return value;
}

function positionOf(f: any): NormalizedPosition | null {
  const p = f?.last_position;
  if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
  const seenAt = unix(p.timestamp) ?? Date.now() / 1000;
  return { provider: "flightaware", flightId: f.fa_flight_id ?? null, callsign: f.ident ?? null, lat: p.latitude, lon: p.longitude,
    altFt: Number.isFinite(p.altitude) ? p.altitude * 100 : null, gsKt: Number.isFinite(p.groundspeed) ? p.groundspeed : null,
    track: Number.isFinite(p.heading) ? p.heading : null, onGround: p.altitude === 0, seenAt,
    registration: f.registration ?? null, type: f.aircraft_type ?? null, hex: f.hex ?? null, confidence: "medium" };
}

export function normalizeAeroApiFlight(f: any): NormalizedFlight {
  return { provider: "flightaware", flightId: f?.fa_flight_id ?? null, callsign: f?.ident ?? null, status: f?.status ?? null,
    position: positionOf(f), origin: f?.origin ? { iata: f.origin.code_iata ?? null, icao: f.origin.code_icao ?? f.origin.code ?? null, gate: f.gate_origin ?? null, terminal: f.terminal_origin ?? null } : null,
    destination: f?.destination ? { iata: f.destination.code_iata ?? null, icao: f.destination.code_icao ?? f.destination.code ?? null, gate: f.gate_destination ?? null, terminal: f.terminal_destination ?? null } : null,
    push: times(f, "out"), takeoff: times(f, "off"), landing: times(f, "on"), gateIn: times(f, "in"),
    registration: f?.registration ?? null, type: f?.aircraft_type ?? null, hex: f?.hex ?? null, route: f?.route ?? null,
    waypoints: [], track: [], providerEta: unix(f?.predicted_on) ?? unix(f?.estimated_on) ?? unix(f?.estimated_in),
    runway: { takeoff: f?.runway_off ?? null, landing: f?.runway_on ?? null } };
}

export function normalizeAeroApiRoute(data: any) {
  const points = Array.isArray(data?.fixes) ? data.fixes
    : Array.isArray(data?.route) ? data.route
    : Array.isArray(data?.waypoints) ? data.waypoints : [];
  return points.map((p: any) => ({
    lat: p.latitude ?? p.lat,
    lon: p.longitude ?? p.lon,
    label: p.name ?? p.ident ?? p.fix ?? null,
  })).filter((p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && typeof p.label === "string" && p.label.trim().length > 0);
}

export function selectCurrentAeroApiFlight(flights: any[], now = Date.now() / 1000) {
  const valid = flights.filter((f: any) => f && !f.cancelled && f.origin && f.destination);
  const departed = valid.filter((f: any) => {
    const out = unix(f.actual_out) ?? unix(f.actual_off);
    return out != null && out <= now + 120 && unix(f.actual_in) == null && now - out < 36 * 3600;
  });
  if (departed.length) {
    return departed.sort((a: any, b: any) =>
      (unix(b.actual_out) ?? unix(b.actual_off) ?? 0) - (unix(a.actual_out) ?? unix(a.actual_off) ?? 0))[0];
  }
  const upcoming = valid.filter((f: any) => {
    if (unix(f.actual_in) != null || unix(f.actual_out) != null || unix(f.actual_off) != null) return false;
    const dep = unix(f.estimated_out) ?? unix(f.scheduled_out) ?? unix(f.scheduled_off);
    return dep != null && dep >= now - 6 * 3600 && dep <= now + 24 * 3600;
  }).sort((a: any, b: any) => {
    const da = unix(a.estimated_out) ?? unix(a.scheduled_out) ?? unix(a.scheduled_off) ?? Infinity;
    const db = unix(b.estimated_out) ?? unix(b.scheduled_out) ?? unix(b.scheduled_off) ?? Infinity;
    return Math.abs(da - now) - Math.abs(db - now);
  });
  if (upcoming.length) return upcoming[0];
  const recent = valid.filter((f: any) => {
    const arrival = unix(f.actual_in) ?? unix(f.actual_on);
    return arrival != null && arrival <= now && now - arrival < 6 * 3600;
  }).sort((a: any, b: any) =>
    (unix(b.actual_in) ?? unix(b.actual_on) ?? 0) - (unix(a.actual_in) ?? unix(a.actual_on) ?? 0));
  return recent[0] ?? null;
}

export async function loadAeroApiFlight(ident: string): Promise<NormalizedFlight | null> {
  if (!aeroApiKey()) return null;
  const data: any = await get(`/flights/${encodeURIComponent(ident)}?max_pages=1`, 90_000);
  const flights = Array.isArray(data?.flights) ? data.flights : [];
  if (!flights.length) return null;
  const f = selectCurrentAeroApiFlight(flights);
  if (!f) return null;
  const normalized = normalizeAeroApiFlight(f);
  if (normalized.flightId) {
    const [trackData, routeData]: any[] = await Promise.all([
      get(`/flights/${encodeURIComponent(normalized.flightId)}/track`, 120_000).catch(() => null),
      get(`/flights/${encodeURIComponent(normalized.flightId)}/route`, 30 * 60_000).catch(() => null),
    ]);
    normalized.track = (trackData?.positions ?? []).map((p: any) => ({ lat: p.latitude, lon: p.longitude, altFt: Number.isFinite(p.altitude) ? p.altitude * 100 : null, gsKt: p.groundspeed ?? null, track: p.heading ?? null, seenAt: unix(p.timestamp) ?? 0 })).filter((p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    normalized.waypoints = normalizeAeroApiRoute(routeData);
  }
  return normalized;
}

export const aeroApiConfigured = () => Boolean(aeroApiKey());
