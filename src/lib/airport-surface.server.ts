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

type OverpassGeometryPoint = { lat: number; lon: number };
type OverpassMember = {
  type?: "node" | "way" | "relation";
  ref?: number;
  role?: string;
  geometry?: OverpassGeometryPoint[];
};
type OverpassElement = {
  id: number;
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OverpassGeometryPoint[];
  members?: OverpassMember[];
};

type CacheEntry = { value: AirportSurface; at: number };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<AirportSurface>>();
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CACHE_MS = 24 * 60 * 60_000;

function validCoord(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function normalizeKind(value: string | undefined): SurfaceFeature["kind"] | null {
  return value === "runway" || value === "taxiway" || value === "apron" || value === "terminal" || value === "gate" || value === "holding_position" ? value : null;
}

function samePoint(a: SurfacePoint | undefined, b: SurfacePoint | undefined) {
  return Boolean(a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7);
}

function validGeometry(points: OverpassGeometryPoint[] | undefined): SurfacePoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p) => validCoord(p.lat, -90, 90) && validCoord(p.lon, -180, 180))
    .map((p) => ({ lat: p.lat, lon: p.lon }));
}

function relationOuterRings(element: OverpassElement): SurfacePoint[][] {
  const segments = (element.members ?? [])
    .filter((member) => member.type === "way" && (member.role === "outer" || !member.role))
    .map((member) => validGeometry(member.geometry))
    .filter((points) => points.length >= 2);
  const rings: SurfacePoint[][] = [];

  while (segments.length) {
    let ring = segments.shift()!;
    let joined = true;
    while (joined && segments.length && !samePoint(ring[0], ring.at(-1))) {
      joined = false;
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!;
        if (samePoint(ring.at(-1), segment[0])) {
          ring = [...ring, ...segment.slice(1)];
        } else if (samePoint(ring.at(-1), segment.at(-1))) {
          ring = [...ring, ...segment.slice(0, -1).reverse()];
        } else if (samePoint(ring[0], segment.at(-1))) {
          ring = [...segment.slice(0, -1), ...ring];
        } else if (samePoint(ring[0], segment[0])) {
          ring = [...segment.slice(1).reverse(), ...ring];
        } else {
          continue;
        }
        segments.splice(i, 1);
        joined = true;
        break;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function parse(elements: OverpassElement[], airport: string, checkedAt: number): AirportSurface {
  const features: SurfaceFeature[] = [];
  const pushFeature = (element: OverpassElement, kind: SurfaceFeature["kind"], points: SurfacePoint[], suffix = 0) => {
    if (!points.length || points.length > 800 || features.length >= 2_500) return;
    features.push({
      id: suffix ? -(element.id * 100 + suffix) : element.id,
      kind,
      ...(element.tags?.ref ? { ref: element.tags.ref.slice(0, 20) } : {}),
      ...(element.tags?.name ? { name: element.tags.name.slice(0, 80) } : {}),
      points,
    });
  };

  for (const element of elements) {
    const kind = normalizeKind(element.tags?.aeroway);
    if (!kind) continue;

    if (element.type === "relation") {
      if (kind !== "terminal" && kind !== "apron") continue;
      const rings = relationOuterRings(element);
      rings.forEach((ring, index) => pushFeature(element, kind, ring, index + 1));
      continue;
    }

    let points: SurfacePoint[] = [];
    if (element.type === "node" && validCoord(element.lat, -90, 90) && validCoord(element.lon, -180, 180)) {
      points = [{ lat: element.lat, lon: element.lon }];
    } else {
      points = validGeometry(element.geometry);
    }
    pushFeature(element, kind, points);
    if (features.length >= 2_500) break;
  }
  return { airport, checkedAt, source: "OpenStreetMap", features };
}

export async function loadAirportSurface(input: { airport: string; lat: number; lon: number }): Promise<AirportSurface> {
  const airport = String(input.airport || "").toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(airport) || !validCoord(input.lat, -90, 90) || !validCoord(input.lon, -180, 180)) {
    throw new Error("Invalid airport surface request");
  }
  const key = `${airport}:surface-v4:${input.lat.toFixed(3)}:${input.lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    // Ground radar only renders line/polygon movement geometry. Querying ways
    // directly is materially faster than asking Overpass for nodes + ways +
    // relations and avoids spending time on objects we never render.
    const latPad = 0.075;
    const lonPad = Math.min(0.12, 0.075 / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
    const south = (input.lat - latPad).toFixed(6);
    const north = (input.lat + latPad).toFixed(6);
    const west = (input.lon - lonPad).toFixed(6);
    const east = (input.lon + lonPad).toFixed(6);
    const query = `[out:json][timeout:10];(way["aeroway"~"^(runway|taxiway|apron|terminal)$"](${south},${west},${north},${east});relation["aeroway"~"^(apron|terminal)$"](${south},${west},${north},${east}););out geom;`;
    const body = new URLSearchParams({ data: query }).toString();
    const json = await Promise.any(OVERPASS_ENDPOINTS.map(async (endpoint) => {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "Inbound/1.0 airport-surface experiment",
        },
        body,
      });
      if (!response.ok) throw new Error(`Airport surface unavailable (${response.status})`);
      const payload = await response.json() as { elements?: OverpassElement[] };
      if (!Array.isArray(payload.elements)) throw new Error("Invalid airport surface response");
      return payload;
    })).catch(() => {
      throw new Error("Airport surface unavailable");
    });
    if (!Array.isArray(json.elements)) throw new Error("Invalid airport surface response");
    const value = parse(json.elements, airport, Date.now());
    cache.set(key, { value, at: Date.now() });
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
