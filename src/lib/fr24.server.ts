import { emptyTimes, type NormalizedFlight, type NormalizedPosition } from "./flight-data.ts";
import { fr24CreditsForResponse, fr24Endpoint, fr24MaxCredits } from "./fr24-budget.ts";
import {
  acquireFr24Cache, finishFr24Call, readFr24Cache, releaseFr24Cache,
  reserveFr24Credits, storeFr24Cache,
} from "./fr24-budget.server.ts";

const BASE = "https://fr24api.flightradar24.com/api";
const LAST_GOOD_TTL_MS = 25_000;
const LIVE_POSITION_CACHE_MS = 20_000;
let rateLimitedUntil = 0;
const unix = (v: unknown) => typeof v === "number" ? v : typeof v === "string" ? Math.floor(new Date(v).getTime() / 1000) || null : null;

export type Fr24CycleContext = { ident: string; networkUsed: boolean };
export const createFr24Cycle = (ident: string): Fr24CycleContext => ({
  ident: ident.replace(/[^A-Z0-9-]/gi, "").toUpperCase() || "UNKNOWN",
  networkUsed: false,
});

export type Fr24ProbeDiagnostics = {
  upstream: "fresh" | "cached" | "none";
  rowsReturned: number | null;
  errorKind: "429" | "timeout" | "http" | "budget" | "busy" | "none";
  statusCode: number | null;
  rateLimitedUntilActive: boolean;
  rawPosition: {
    lat: number | null;
    lon: number | null;
    seenAt: number | null;
    onGround: boolean | null;
    altFt: number | null;
  } | null;
};

export function createFr24ProbeDiagnostics(): Fr24ProbeDiagnostics {
  return {
    upstream: "none",
    rowsReturned: null,
    errorKind: "none",
    statusCode: null,
    rateLimitedUntilActive: false,
    rawPosition: null,
  };
}

function fr24ErrorKind(error: unknown): "429" | "timeout" | "http" {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b/.test(message)) return "429";
  if (/timeout|timed out|abort/i.test(message) || (error instanceof Error && /TimeoutError|AbortError/.test(error.name))) return "timeout";
  return "http";
}

function logFr24Error(path: string, statusCode: number | null, errorKind: "429" | "timeout" | "http", activeAtStart: boolean) {
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  console.warn(JSON.stringify({
    event: "fr24_upstream_error",
    timestamp: new Date().toISOString(),
    endpoint: path.split("?")[0],
    callsign: params.get("callsigns"),
    registration: params.get("registrations"),
    flight: params.get("flights"),
    statusCode,
    errorKind,
    rateLimitedUntilActive: activeAtStart,
  }));
}

function requestIdent(path: string, cycle?: Fr24CycleContext): string {
  if (cycle?.ident) return cycle.ident;
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  return (params.get("flights") ?? params.get("callsigns") ?? params.get("registrations")
    ?? params.get("flight_id") ?? params.get("flight_ids") ?? "UNKNOWN")
    .replace(/[^A-Z0-9-]/gi, "").toUpperCase() || "UNKNOWN";
}

function sharedCacheKey(path: string, ident: string): string {
  const endpoint = fr24Endpoint(path);
  // Every live identity route for one displayed flight shares the same key.
  // Registration -> flight number -> callsign fallbacks therefore cannot each
  // spend credits in separate cold instances during the same twenty seconds.
  return endpoint === "/live/flight-positions/full" ? `live:${ident}` : `${endpoint}:${ident}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(path: string, ttlMs: number, probe?: Fr24ProbeDiagnostics, cycle?: Fr24CycleContext) {
  const token = process.env.FR24_API_TOKEN?.trim();
  const now = Date.now();
  const activeAtStart = now < rateLimitedUntil;
  const ident = requestIdent(path, cycle);
  const endpoint = fr24Endpoint(path);
  const cacheKey = sharedCacheKey(path, ident);
  const cacheTtlMs = Math.max(20_000, ttlMs);
  if (probe) {
    probe.upstream = "none";
    probe.rowsReturned = null;
    probe.errorKind = "none";
    probe.statusCode = null;
    probe.rateLimitedUntilActive = activeAtStart;
    probe.rawPosition = null;
  }
  if (!token) return null;
  const hit = await readFr24Cache(cacheKey, cacheTtlMs, now);
  if (hit) {
    if (cycle) cycle.networkUsed = true;
    if (probe) probe.upstream = "cached";
    return hit.value;
  }
  if (activeAtStart) {
    const stale = await readFr24Cache(cacheKey, LAST_GOOD_TTL_MS, now);
    if (probe) {
      probe.upstream = stale ? "cached" : "none";
      probe.errorKind = "429";
      probe.statusCode = 429;
    }
    if (stale) {
      if (cycle) cycle.networkUsed = true;
      return stale.value;
    }
    logFr24Error(path, 429, "429", true);
    throw new Error("FR24 API 429");
  }
  if (cycle?.networkUsed) {
    if (probe) probe.upstream = "cached";
    return null;
  }
  const refreshToken = crypto.randomUUID();
  const acquired = await acquireFr24Cache(cacheKey, endpoint, ident, refreshToken, now);
  if (!acquired) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await wait(125);
      const shared = await readFr24Cache(cacheKey, cacheTtlMs);
      if (shared) {
        if (cycle) cycle.networkUsed = true;
        if (probe) probe.upstream = "cached";
        return shared.value;
      }
    }
    const stale = await readFr24Cache(cacheKey, 60_000);
    if (probe) {
      probe.upstream = stale ? "cached" : "none";
      probe.errorKind = stale ? "none" : "busy";
    }
    if (stale) {
      if (cycle) cycle.networkUsed = true;
      return stale.value;
    }
    throw new Error("FR24 shared cache refresh busy");
  }

  if (cycle) cycle.networkUsed = true;
  const maximum = fr24MaxCredits(path);
  const reservation = await reserveFr24Credits(maximum, now);
  if (!reservation) {
    await releaseFr24Cache(cacheKey, refreshToken);
    if (probe) probe.errorKind = "budget";
    console.warn(JSON.stringify({ event: "fr24_budget_blocked", timestamp: new Date().toISOString(), ident, endpoint, maximum }));
    throw new Error("[FR24_BUDGET_EXHAUSTED] Daily FR24 credit cap reached");
  }

  if (probe) probe.upstream = "fresh";
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  console.info(JSON.stringify({
    event: "fr24_upstream_request",
    timestamp: new Date().toISOString(),
    deployment: process.env.VERCEL_DEPLOYMENT_ID?.trim() || process.env.VERCEL_URL?.trim() || "local",
    environment: process.env.VERCEL_ENV?.trim() || "development",
    ident,
    callsign: params.get("callsigns"),
    registration: params.get("registrations"),
    flight: params.get("flights"),
    endpoint,
    maximumCredits: maximum,
    cache: "miss",
  }));

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, "Accept-Version": "v1", Accept: "application/json" }, signal: AbortSignal.timeout(5500) });
  } catch (error) {
    const errorKind = fr24ErrorKind(error);
    // A timeout can happen after FR24 processed the request. Count the reserved
    // maximum so an uncertain response can never let the shared cap overspend.
    const uncertainCredits = errorKind === "timeout" ? maximum : 0;
    await finishFr24Call(reservation, { ident, endpoint, credits: uncertainCredits, statusCode: null, resultCount: null, errorKind });
    await releaseFr24Cache(cacheKey, refreshToken);
    if (probe) { probe.errorKind = errorKind; probe.statusCode = null; }
    logFr24Error(path, null, errorKind, activeAtStart);
    throw error;
  }
  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : 8_000;
      rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + backoffMs);
    }
    const errorKind = res.status === 429 ? "429" : "http";
    await finishFr24Call(reservation, { ident, endpoint, credits: 0, statusCode: res.status, resultCount: null, errorKind });
    await releaseFr24Cache(cacheKey, refreshToken);
    if (probe) { probe.errorKind = errorKind; probe.statusCode = res.status; }
    logFr24Error(path, res.status, errorKind, activeAtStart);
    throw new Error(`FR24 API ${res.status}`);
  }
  let value: unknown;
  try {
    value = await res.json();
  } catch (error) {
    await finishFr24Call(reservation, { ident, endpoint, credits: maximum, statusCode: res.status, resultCount: null, errorKind: "parse" });
    await releaseFr24Cache(cacheKey, refreshToken);
    if (probe) { probe.errorKind = "http"; probe.statusCode = res.status; }
    logFr24Error(path, res.status, "http", activeAtStart);
    throw error;
  }
  const cost = fr24CreditsForResponse(path, value);
  let cacheError: unknown = null;
  try {
    await storeFr24Cache(cacheKey, refreshToken, value);
  } catch (error) {
    cacheError = error;
    await releaseFr24Cache(cacheKey, refreshToken).catch(() => undefined);
  }
  await finishFr24Call(reservation, { ident, endpoint, credits: cost.credits, statusCode: res.status, resultCount: cost.resultCount, errorKind: cacheError ? "cache" : null });
  if (cacheError) throw cacheError;
  return value;
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

async function hydrateFr24Flight(f: any, fallbackIdent: string, cycle?: Fr24CycleContext): Promise<NormalizedFlight | null> {
  if (!f) return null;
  const position = normalizeFr24Position(f);
  if (!position) return null;
  const flight: NormalizedFlight = { provider: "fr24", flightId: f.fr24_id ?? null, callsign: f.callsign ?? fallbackIdent, status: null, position,
    origin: f.orig_iata ? { iata: f.orig_iata, icao: f.orig_icao ?? null, gate: null, terminal: null } : null,
    destination: f.dest_iata ? { iata: f.dest_iata, icao: f.dest_icao ?? null, gate: null, terminal: null } : null,
    push: emptyTimes(), takeoff: emptyTimes(), landing: emptyTimes(), gateIn: emptyTimes(), registration: position.registration ?? null,
    type: position.type ?? null, hex: position.hex ?? null, route: null, waypoints: [], track: [], providerEta: unix(f.eta), runway: { takeoff: null, landing: null } };
  if (flight.flightId && process.env.FR24_ENABLE_TRACKS === "1") {
    const trackData: any = await get(`/flight-tracks?flight_id=${encodeURIComponent(flight.flightId)}`, 30_000, undefined, cycle).catch(() => null);
    const rows = Array.isArray(trackData?.tracks) ? trackData.tracks : Array.isArray(trackData?.data?.[0]?.tracks) ? trackData.data[0].tracks : [];
    flight.track = rows.map((p: any) => ({ lat: p.lat, lon: p.lon, altFt: p.alt ?? null, gsKt: p.gspeed ?? null, track: p.track ?? null, seenAt: unix(p.timestamp) ?? 0 })).filter((p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }
  if (flight.flightId && process.env.FR24_ENABLE_SUMMARY === "1") {
    const summaryData: any = await get(`/flight-summary/full?flight_ids=${encodeURIComponent(flight.flightId)}&limit=1`, 5 * 60_000, undefined, cycle).catch(() => null);
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

async function loadFr24ByFilter(filter: "callsigns" | "registrations" | "flights", value: string, extraQuery = "", probe?: Fr24ProbeDiagnostics, cycle?: Fr24CycleContext): Promise<NormalizedFlight | null> {
  if (!fr24Configured()) return null;
  const normalizedValue = value.trim().toUpperCase();
  const limitQuery = extraQuery.includes("limit=") ? "" : "&limit=1";
  const data: any = await get(`/live/flight-positions/full?${filter}=${encodeURIComponent(value)}${extraQuery}${limitQuery}`, LIVE_POSITION_CACHE_MS, probe, cycle);

  const allRows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const norm = (input: unknown) => String(input ?? "").replace(/[-\s]/g, "").toUpperCase();
  const rows = allRows.filter((row: any) => filter === "callsigns"
    ? norm(row?.callsign) === norm(normalizedValue)
    : filter === "registrations"
      ? norm(row?.reg ?? row?.registration) === norm(normalizedValue)
      : norm(row?.flight) === norm(normalizedValue));
  if (probe) {
    const raw = rows[0] ?? null;
    probe.rowsReturned = rows.length;
    probe.rawPosition = raw ? {
      lat: Number.isFinite(raw.lat) ? raw.lat : null,
      lon: Number.isFinite(raw.lon) ? raw.lon : null,
      seenAt: unix(raw.timestamp),
      onGround: typeof raw.on_ground === "boolean" ? raw.on_ground : Number.isFinite(raw.alt) ? raw.alt === 0 : null,
      altFt: Number.isFinite(raw.alt) ? raw.alt : null,
    } : null;
  }
  return hydrateFr24Flight(rows[0], value, cycle);
}

export async function loadFr24Flight(ident: string, probe?: Fr24ProbeDiagnostics, cycle?: Fr24CycleContext): Promise<NormalizedFlight | null> {
  return loadFr24ByFilter("callsigns", ident, "", probe, cycle);
}

export async function loadFr24FlightByRegistration(registration: string, probe?: Fr24ProbeDiagnostics, cycle?: Fr24CycleContext): Promise<NormalizedFlight | null> {
  const reg = registration.trim().toUpperCase();
  if (!reg) return null;
  return loadFr24ByFilter("registrations", reg, "", probe, cycle);
}

export async function loadFr24FlightByNumber(flightNumber: string, bounds?: string, probe?: Fr24ProbeDiagnostics, cycle?: Fr24CycleContext): Promise<NormalizedFlight | null> {
  const flight = flightNumber.replace(/\s/g, "").trim().toUpperCase();
  if (!flight) return null;
  const extra = `${bounds ? `&bounds=${encodeURIComponent(bounds)}` : ""}&limit=1`;
  return loadFr24ByFilter("flights", flight, extra, probe, cycle);
}

export async function loadFr24FlightByNumberAndRoute(
  flightNumber: string,
  originIata: string,
  destIata: string,
  cycle?: Fr24CycleContext,
): Promise<NormalizedFlight | null> {
  if (!fr24Configured()) return null;
  const flight = flightNumber.replace(/\s/g, "").trim().toUpperCase();
  const origin = originIata.trim().toUpperCase();
  const destination = destIata.trim().toUpperCase();
  if (!flight || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return null;

  // Combining the flight-number filter with inbound/outbound airport filters
  // keeps this cheap while distinguishing through-flights that reuse the same
  // number on multiple legs (for example AA2966 ORD→SEA then SEA→ORD).
  const airportFilter = `outbound:${origin},inbound:${destination}`;
  const path = `/live/flight-positions/full?flights=${encodeURIComponent(flight)}&airports=${encodeURIComponent(airportFilter)}&limit=1`;
  const data: any = await get(path, LIVE_POSITION_CACHE_MS, undefined, cycle);
  const rows = (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [])
    .filter((row: any) =>
      String(row?.flight ?? "").replace(/\s/g, "").toUpperCase() === flight
      && String(row?.orig_iata ?? "").trim().toUpperCase() === origin
      && String(row?.dest_iata ?? "").trim().toUpperCase() === destination
    )
    .sort((a: any, b: any) => (unix(b?.timestamp) ?? 0) - (unix(a?.timestamp) ?? 0));
  return hydrateFr24Flight(rows[0], flight, cycle);
}

export async function loadFr24RecentArrivalIdentity(
  flightNumber: string,
  originIata: string,
  destIata: string,
): Promise<{ flightId: string | null; registration: string; callsign: string | null; hex: string | null; type: string | null; landedAt: number } | null> {
  if (!fr24Configured()) return null;
  const flight = flightNumber.replace(/\s/g, "").trim().toUpperCase();
  const origin = originIata.trim().toUpperCase();
  const destination = destIata.trim().toUpperCase();
  if (!flight || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return null;

  const now = Date.now();
  const from = new Date(now - 12 * 60 * 60_000).toISOString().slice(0, 19);
  const to = new Date(now + 5 * 60_000).toISOString().slice(0, 19);
  const path = `/flight-summary/light?flight_datetime_from=${encodeURIComponent(from)}&flight_datetime_to=${encodeURIComponent(to)}&flights=${encodeURIComponent(flight)}&routes=${encodeURIComponent(`${origin}-${destination}`)}&limit=5&sort=desc`;
  const data: any = await get(path, 10 * 60_000, undefined, createFr24Cycle(flight)).catch(() => null);
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

export const fr24Configured = () => Boolean(process.env.FR24_API_TOKEN?.trim())
  && (process.env.VERCEL_ENV !== "preview" || process.env.FR24_PREVIEW_ENABLED === "1");
