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
  // AeroAPI's filed-route endpoint returns authoritative named RouteFix
  // objects in `fixes`. Keep the older shapes as compatibility fallbacks.
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

export async function loadAeroApiFlight(ident: string): Promise<NormalizedFlight | null> {
  if (!aeroApiKey()) return null;
  const data: any = await get(`/flights/${encodeURIComponent(ident)}?max_pages=1`, 45_000);
  const flights = Array.isArray(data?.flights) ? data.flights : [];
  if (!flights.length) return null;
  const now = Date.now() / 1000;
  const f = flights.slice().sort((a: any, b: any) => Math.abs((unix(a.scheduled_off) ?? now) - now) - Math.abs((unix(b.scheduled_off) ?? now) - now))[0];
  const normalized = normalizeAeroApiFlight(f);
  if (normalized.flightId) {
    const [trackData, routeData]: any[] = await Promise.all([
      get(`/flights/${encodeURIComponent(normalized.flightId)}/track`, 30_000).catch(() => null),
      get(`/flights/${encodeURIComponent(normalized.flightId)}/route`, 30 * 60_000).catch(() => null),
    ]);
    normalized.track = (trackData?.positions ?? []).map((p: any) => ({ lat: p.latitude, lon: p.longitude, altFt: Number.isFinite(p.altitude) ? p.altitude * 100 : null, gsKt: p.groundspeed ?? null, track: p.heading ?? null, seenAt: unix(p.timestamp) ?? 0 })).filter((p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    normalized.waypoints = normalizeAeroApiRoute(routeData);
  }
  return normalized;
}

export const aeroApiConfigured = () => Boolean(aeroApiKey());
