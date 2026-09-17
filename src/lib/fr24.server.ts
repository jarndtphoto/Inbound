import { emptyTimes, type NormalizedFlight, type NormalizedPosition } from "./flight-data.ts";

const BASE = "https://fr24api.flightradar24.com/api";
const cache = new Map<string, { at: number; value: unknown }>();
const unix = (v: unknown) => typeof v === "number" ? v : typeof v === "string" ? Math.floor(new Date(v).getTime() / 1000) || null : null;

async function get(path: string, ttlMs: number) {
  const token = process.env.FR24_API_TOKEN?.trim();
  if (!token) return null;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
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
  if (!res.ok) throw new Error(`FR24 API ${res.status}`);
  const value = await res.json(); cache.set(path, { at: Date.now(), value }); return value;
}

export function normalizeFr24Position(f: any): NormalizedPosition | null {
  if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return null;
  const seenAt = unix(f.timestamp) ?? Date.now() / 1000;
  const altFt = Number.isFinite(f.alt) ? f.alt : null;
  return { provider: "fr24", flightId: f.fr24_id ?? null, callsign: f.callsign ?? f.flight ?? null, lat: f.lat, lon: f.lon,
    altFt, gsKt: Number.isFinite(f.gspeed) ? f.gspeed : Number.isFinite(f.speed) ? f.speed : null,
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

async function loadFr24ByFilter(filter: "callsigns" | "registrations", value: string): Promise<NormalizedFlight | null> {
  if (!process.env.FR24_API_TOKEN?.trim()) return null;
  const data: any = await get(`/live/flight-positions/full?${filter}=${encodeURIComponent(value)}`, 2_500);
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return hydrateFr24Flight(rows[0], value);
}

export async function loadFr24Flight(ident: string): Promise<NormalizedFlight | null> {
  return loadFr24ByFilter("callsigns", ident);
}

export async function loadFr24FlightByRegistration(registration: string): Promise<NormalizedFlight | null> {
  const reg = registration.trim().toUpperCase();
  if (!reg) return null;
  return loadFr24ByFilter("registrations", reg);
}

export const fr24Configured = () => Boolean(process.env.FR24_API_TOKEN?.trim());
