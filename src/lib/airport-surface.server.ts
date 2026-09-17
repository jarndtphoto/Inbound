export type SurfacePoint = { lat: number; lon: number };
export type SurfaceFeature = {
  id: number;
  kind: "runway" | "taxiway" | "apron" | "terminal" | "gate" | "holding_position";
  ref?: string;
  name?: string;
  points: SurfacePoint[];
};
export type AirportSurface = {
  airport: string;
  checkedAt: number;
  source: "OpenStreetMap";
  features: SurfaceFeature[];
};

type OverpassElement = {
  id: number;
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

type CacheEntry = { value: AirportSurface; at: number };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<AirportSurface>>();
const OVERPASS = "https://overpass-api.de/api/interpreter";
const CACHE_MS = 12 * 60 * 60_000;

function validCoord(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function normalizeKind(value: string | undefined): SurfaceFeature["kind"] | null {
  return value === "runway" || value === "taxiway" || value === "apron" || value === "terminal" || value === "gate" || value === "holding_position" ? value : null;
}

function parse(elements: OverpassElement[], airport: string, checkedAt: number): AirportSurface {
  const features: SurfaceFeature[] = [];
  for (const element of elements) {
    const kind = normalizeKind(element.tags?.aeroway);
    if (!kind) continue;
    let points: SurfacePoint[] = [];
    if (element.type === "node" && validCoord(element.lat, -90, 90) && validCoord(element.lon, -180, 180)) {
      points = [{ lat: element.lat, lon: element.lon }];
    } else if (Array.isArray(element.geometry)) {
      points = element.geometry
        .filter((p) => validCoord(p.lat, -90, 90) && validCoord(p.lon, -180, 180))
        .map((p) => ({ lat: p.lat, lon: p.lon }));
    }
    if (!points.length || points.length > 400) continue;
    features.push({
      id: element.id,
      kind,
      ...(element.tags?.ref ? { ref: element.tags.ref.slice(0, 20) } : {}),
      ...(element.tags?.name ? { name: element.tags.name.slice(0, 80) } : {}),
      points,
    });
    if (features.length >= 900) break;
  }
  return { airport, checkedAt, source: "OpenStreetMap", features };
}

export async function loadAirportSurface(input: { airport: string; lat: number; lon: number }): Promise<AirportSurface> {
  const airport = String(input.airport || "").toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(airport) || !validCoord(input.lat, -90, 90) || !validCoord(input.lon, -180, 180)) {
    throw new Error("Invalid airport surface request");
  }
  const key = `${airport}:${input.lat.toFixed(3)}:${input.lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    // Roughly 5-7 nm each direction at mid-latitudes. Enough to cover large hubs
    // such as ORD while keeping the public Overpass request intentionally small.
    const latPad = 0.075;
    const lonPad = Math.min(0.12, 0.075 / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
    const south = (input.lat - latPad).toFixed(6);
    const north = (input.lat + latPad).toFixed(6);
    const west = (input.lon - lonPad).toFixed(6);
    const east = (input.lon + lonPad).toFixed(6);
    const query = `[out:json][timeout:12];nwr["aeroway"~"^(runway|taxiway|apron|terminal|gate|holding_position)$"](${south},${west},${north},${east});out geom;`;
    const response = await fetch(OVERPASS, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "Inbound/1.0 airport-surface experiment",
      },
      body: new URLSearchParams({ data: query }).toString(),
    });
    if (!response.ok) throw new Error(`Airport surface unavailable (${response.status})`);
    const json = await response.json() as { elements?: OverpassElement[] };
    if (!Array.isArray(json.elements)) throw new Error("Invalid airport surface response");
    const value = parse(json.elements, airport, Date.now());
    cache.set(key, { value, at: Date.now() });
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
