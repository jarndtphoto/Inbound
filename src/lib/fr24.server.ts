import { emptyTimes, type NormalizedFlight, type NormalizedPosition } from "./flight-data.ts";

const BASE = "https://fr24api.flightradar24.com/api";
const cache = new Map<string, { at: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();
const lastGood = new Map<string, { at: number; flight: NormalizedFlight }>();
const LAST_GOOD_TTL_MS = 25_000;
const LIVE_POSITION_CACHE_MS = 5_000;
let rateLimitedUntil = 0;
const unix = (v: unknown) => typeof v === "number" ? v : typeof v === "string" ? Math.floor(new Date(v).getTime() / 1000) || null : null;

async function get(path: string, ttlMs: number) {
  const token = process.env.FR24_API_TOKEN?.trim();
  if (!token) return null;
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < ttlMs) return hit.value;
  if (now < rateLimitedUntil) {
    if (hit && now - hit.at <= LAST_GOOD_TTL_MS) return hit.value;
    throw new Error("FR24 API 429");
  }
  const existing = pending.get(path);
  if (existing) return existing;

  const request = (async () => {
    const params = new URLSearchParams(path.split("?")[1] ?? "");
    console.info(JSON.stringify({
      event: "fr24_upstream_request",
      timestamp: new Date().toISOString(),
      callsign: params.get("callsigns"),
      registration: params.get("registrations"),
      endpoint: path.split("?")[0],
      cache: "miss",
    }));
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, "Accept-Version": "v1", Accept: "application/json" }, signal: AbortSignal.timeout(5500) });
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : 8_000;
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + backoffMs);
      }
      throw new Error(`FR24 API ${res.status}`);
    }
    const value = await res.json();
    cache.set(path, { at: Date.now(), value });
    return value;
  })().finally(() => pending.delete(path));

  pending.set(path, request);
  return request;
}

export function normalizeFr24Position(f: any): NormalizedPosition | null {
  if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return null;
  const seenAt = unix(f.timestamp) ?? Date.now() / 1000;
  const altFt = Number.isFinite(f.alt) ? f.alt : null;
  return { provider: "fr24", flightId: f.fr24_id ?? null, callsign: f.callsign ?? f.flight ?? null, lat: f.lat, lon: f.lon,
    altFt, vertFpm: Number.isFinite(f.vspeed) ? f.vspeed : null,
    gsKt: Number.isFinite(f.gspeed) ? f.gspeed : Number.isFinite(f.speed) ? f.speed : null,
    track: Number.isFinite(f.track) ? f.track : Number.isFinite(f.heading) ? f.heading : null,
    onGround: typeof f.on_ground === "boolean" ? f.on_ground : altFt === 0, seenAt,
    registration: f.reg ?? f.registration ?? null, type: f.type ?? f.aircraft_type ?? null, hex: f.hex ?? null, confidence: "high" };
}

async function hydrateFr24Flight(f: any, fallbackIdent: string): Promise<NormalizedFlight | null> {
  if (!f) return null;
  const position = normalizeFr24Position(f);
  if (!position) return null;
  const flight: NormalizedFlight = { provider: "fr24", flightId: f.fr24_id ?? null, callsign: f.callsign ?? fallbackIdent, status: null, position,
    origin: f.orig_iata ? { iata: f.orig_iata, icao: f.orig_icao ?? null, gate: null, terminal: null } : null,
    destination: f.dest_iata ? { iata: f.dest_iata, icao: f.dest_icao ?? null, gate: null, terminal: null } : null,
    push: emptyTimes(), takeoff: emptyTimes(), landing: emptyTimes(), gateIn: emptyTimes(), registration: position.registration ?? null,
    type: position.type ?? null, hex: position.hex ?? null, route: null, waypoints: [], track: [], providerEta: unix(f.eta), runway: { takeoff: null, landing: null } };
  if (flight.flightId && process.env.FR24_ENABLE_TRACKS === "1") {
    const trackData: any = await get(`/flight-tracks?flight_id=${encodeURIComponent(flight.flightId)}`, 30_000).catch(() => null);
    const rows = Array.isArray(trackData?.tracks) ? trackData.tracks : Array.isArray(trackData?.data?.[0]?.tracks) ? trackData.data[0].tracks : [];
    flight.track = rows.map((p: any) => ({ lat: p.lat, lon: p.lon, altFt: p.alt ?? null, gsKt: p.gspeed ?? null, track: p.track ?? null, seenAt: unix(p.timestamp) ?? 0 })).filter((p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }
  if (flight.flightId && process.env.FR24_ENABLE_SUMMARY === "1") {
    const summaryData: any = await get(`/flight-summary/full?flight_ids=${encodeURIComponent(flight.flightId)}`, 5 * 60_000).catch(() => null);
    const s = summaryData?.data?.[0];
    if (s) {
      flight.takeoff.actual = unix(s.datetime_takeoff);
      flight.landing.actual = unix(s.datetime_landed);
      flight.runway = { takeoff: s.runway_takeoff ?? null, landing: s.runway_landed ?? null };
      flight.status = s.flight_ended ? "landed" : flight.status;
    }
  }
  return flight;
}

async function loadFr24ByFilter(filter: "callsigns" | "registrations" | "flights", value: string, extraQuery = ""): Promise<NormalizedFlight | null> {
  if (!process.env.FR24_API_TOKEN?.trim()) return null;
  const normalizedValue = value.trim().toUpperCase();
  const stickyKey = `${filter}:${normalizedValue}${extraQuery ? `:${extraQuery}` : ""}`;
  const previous = () => {
    const prior = lastGood.get(stickyKey);
    if (!prior || Date.now() - prior.at > LAST_GOOD_TTL_MS) return null;
    console.info(JSON.stringify({
      event: "fr24_last_good_reuse",
      filter,
      value: normalizedValue,
      ageMs: Date.now() - prior.at,
      flightId: prior.flight.flightId ?? null,
    }));
    return prior.flight;
  };

  let data: any;
  try {
    data = await get(`/live/flight-positions/full?${filter}=${encodeURIComponent(value)}${extraQuery}`, LIVE_POSITION_CACHE_MS);
  } catch (error) {
    const prior = previous();
    if (prior) return prior;
    throw error;
  }

  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const flight = await hydrateFr24Flight(rows[0], value);
  if (flight) {
    lastGood.set(stickyKey, { at: Date.now(), flight });
    return flight;
  }
  return previous();
}

export async function loadFr24Flight(ident: string): Promise<NormalizedFlight | null> {
  return loadFr24ByFilter("callsigns", ident);
}

export async function loadFr24FlightByRegistration(registration: string): Promise<NormalizedFlight | null> {
  const reg = registration.trim().toUpperCase();
  if (!reg) return null;
  return loadFr24ByFilter("registrations", reg);
}

export async function loadFr24FlightByNumber(flightNumber: string, bounds?: string): Promise<NormalizedFlight | null> {
  const flight = flightNumber.replace(/\s/g, "").trim().toUpperCase();
  if (!flight) return null;
  const extra = bounds ? `&bounds=${encodeURIComponent(bounds)}&limit=5` : "";
  return loadFr24ByFilter("flights", flight, extra);
}

export async function loadFr24FlightByNumberAndRoute(
  flightNumber: string,
  originIata: string,
  destIata: string,
): Promise<NormalizedFlight | null> {
  if (!process.env.FR24_API_TOKEN?.trim()) return null;
  const flight = flightNumber.replace(/\s/g, "").trim().toUpperCase();
  const origin = originIata.trim().toUpperCase();
  const destination = destIata.trim().toUpperCase();
  if (!flight || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return null;

  // Combining the flight-number filter with inbound/outbound airport filters
  // keeps this cheap while distinguishing through-flights that reuse the same
  // number on multiple legs (for example AA2966 ORD→SEA then SEA→ORD).
  const airportFilter = `outbound:${origin},inbound:${destination}`;
  const path = `/live/flight-positions/full?flights=${encodeURIComponent(flight)}&airports=${encodeURIComponent(airportFilter)}&limit=5`;
  const data: any = await get(path, LIVE_POSITION_CACHE_MS);
  const rows = (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [])
    .filter((row: any) =>
      String(row?.flight ?? "").replace(/\s/g, "").toUpperCase() === flight
      && String(row?.orig_iata ?? "").trim().toUpperCase() === origin
      && String(row?.dest_iata ?? "").trim().toUpperCase() === destination
    )
    .sort((a: any, b: any) => (unix(b?.timestamp) ?? 0) - (unix(a?.timestamp) ?? 0));
  return hydrateFr24Flight(rows[0], flight);
}

export async function loadFr24RecentArrivalIdentity(
  flightNumber: string,
  originIata: string,
  destIata: string,
): Promise<{ flightId: string | null; registration: string; callsign: string | null; hex: string | null; type: string | null; landedAt: number } | null> {
  if (!process.env.FR24_API_TOKEN?.trim()) return null;
  const flight = flightNumber.replace(/\s/g, "").trim().toUpperCase();
  const origin = originIata.trim().toUpperCase();
  const destination = destIata.trim().toUpperCase();
  if (!flight || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return null;

  const now = Date.now();
  const from = new Date(now - 12 * 60 * 60_000).toISOString().slice(0, 19);
  const to = new Date(now + 5 * 60_000).toISOString().slice(0, 19);
  const path = `/flight-summary/light?flight_datetime_from=${encodeURIComponent(from)}&flight_datetime_to=${encodeURIComponent(to)}&flights=${encodeURIComponent(flight)}&routes=${encodeURIComponent(`${origin}-${destination}`)}&limit=5&sort=desc`;
  const data: any = await get(path, 10 * 60_000).catch(() => null);
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const nowSec = now / 1000;
  for (const row of rows) {
    if (String(row?.flight ?? "").replace(/\s/g, "").toUpperCase() !== flight) continue;
    const registration = String(row?.reg ?? row?.registration ?? "").trim().toUpperCase();
    if (!registration) continue;
    const landedAt = unix(row?.datetime_landed) ?? unix(row?.last_seen);
    if (!landedAt || landedAt > nowSec + 10 * 60 || nowSec - landedAt > 2 * 60 * 60) continue;
    return {
      flightId: row?.fr24_id ?? null,
      registration,
      callsign: row?.callsign ?? null,
      hex: row?.hex ?? null,
      type: row?.type ?? null,
      landedAt,
    };
  }
  return null;
}

export const fr24Configured = () => Boolean(process.env.FR24_API_TOKEN?.trim());
