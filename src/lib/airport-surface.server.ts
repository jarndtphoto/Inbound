export type SurfacePoint = { lat: number; lon: number };
export type SurfaceFeature = {
  id: number;
  kind: "runway" | "runway_area" | "taxiway" | "taxiway_area" | "taxilane" | "parking_position" | "apron" | "terminal" | "gate" | "holding_position";
  ref?: string;
  name?: string;
  points: SurfacePoint[];
};
export type AirportSurface = {
  airport: string;
  checkedAt: number;
  source: "FAA" | "OpenStreetMap";
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

const FAA_HUB_SEARCH = "https://adds-faa.opendata.arcgis.com/api/search/v1/collections/dataset/items";
const ARCGIS_ITEM = "https://www.arcgis.com/sharing/rest/content/items";
const FAA_SEARCH_CACHE_MS = 24 * 60 * 60_000;
const faaServiceByAirport = new Map<string, { url: string | null; at: number }>();

type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "LineString"; coordinates: number[][] }
  | { type: "MultiLineString"; coordinates: number[][][] };

type GeoJsonFeature = {
  id?: string | number;
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
};

function likelyUsAirport(icao: string) {
  return /^K[A-Z0-9]{3}$/.test(icao) || /^P[A-Z0-9]{3}$/.test(icao) || /^TJ[A-Z0-9]{2}$/.test(icao) || /^PG[A-Z0-9]{2}$/.test(icao);
}

function faaLayerKind(name: string): SurfaceFeature["kind"] | null {
  const n = name.toLowerCase();
  if (/taxiway/.test(n)) return "taxiway_area";
  if (/apron|ramp/.test(n)) return "apron";
  if (/building|terminal/.test(n)) return "terminal";
  if (/runway/.test(n)) return "runway_area";
  if (/stopway/.test(n)) return "runway_area";
  return null;
}

function propertyText(props: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!props) return undefined;
  for (const key of keys) {
    const value = props[key] ?? props[key.toLowerCase()] ?? props[key.toUpperCase()];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function geoJsonParts(geometry: GeoJsonGeometry | null | undefined): SurfacePoint[][] {
  if (!geometry) return [];
  const line = (coords: number[][]) => coords
    .filter((p) => Array.isArray(p) && validCoord(p[1], -90, 90) && validCoord(p[0], -180, 180))
    .map((p) => ({ lat: p[1]!, lon: p[0]! }));
  if (geometry.type === "LineString") return [line(geometry.coordinates)];
  if (geometry.type === "MultiLineString") return geometry.coordinates.map(line);
  if (geometry.type === "Polygon") return geometry.coordinates.length ? [line(geometry.coordinates[0]!)] : [];
  if (geometry.type === "MultiPolygon") return geometry.coordinates
    .map((poly) => poly[0] ? line(poly[0]) : [])
    .filter((points) => points.length >= 2);
  return [];
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 6_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", "User-Agent": "Inbound/1.0 FAA-airport-surface" },
  });
  if (!response.ok) throw new Error(`FAA surface request failed (${response.status})`);
  return response.json();
}

async function faaFeatureServiceForAirport(airport: string): Promise<string | null> {
  const cached = faaServiceByAirport.get(airport);
  if (cached && Date.now() - cached.at < FAA_SEARCH_CACHE_MS) return cached.url;

  const q = encodeURIComponent(`${airport} Airport Diagram`);
  const search = await fetchJsonWithTimeout(`${FAA_HUB_SEARCH}?limit=25&q=${q}`, 7_000) as {
    features?: Array<{ id?: string; properties?: Record<string, unknown>; links?: Array<{ href?: string; rel?: string }> }>;
    items?: Array<{ id?: string; properties?: Record<string, unknown>; links?: Array<{ href?: string; rel?: string }> }>;
  };
  const candidates = [...(search.features ?? []), ...(search.items ?? [])];
  const ranked = candidates
    .map((item) => {
      const title = String(item.properties?.title ?? item.properties?.name ?? "");
      const text = title.toUpperCase();
      const score = (text.includes(airport) ? 4 : 0) + (/AIRPORT/.test(text) ? 2 : 0) + (/DIAGRAM|AMDB/.test(text) ? 2 : 0);
      return { item, title, score };
    })
    .filter((x) => x.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  for (const candidate of ranked) {
    const id = candidate.item.id ?? String(candidate.item.properties?.id ?? "");
    if (!id) continue;
    try {
      const meta = await fetchJsonWithTimeout(`${ARCGIS_ITEM}/${encodeURIComponent(id)}?f=json`, 5_000) as { url?: string; type?: string; title?: string };
      if (typeof meta.url === "string" && /FeatureServer/i.test(meta.url)) {
        faaServiceByAirport.set(airport, { url: meta.url.replace(/\/$/, ""), at: Date.now() });
        return meta.url.replace(/\/$/, "");
      }
    } catch {
      // Try the next matching FAA catalog item.
    }
  }

  faaServiceByAirport.set(airport, { url: null, at: Date.now() });
  return null;
}

async function loadFaaAirportSurface(input: { airport: string; lat: number; lon: number }): Promise<AirportSurface | null> {
  if (!likelyUsAirport(input.airport)) return null;
  let serviceUrl: string | null = null;
  try {
    serviceUrl = await faaFeatureServiceForAirport(input.airport);
  } catch (error) {
    console.warn("[airport-surface] FAA catalog lookup failed", input.airport, error instanceof Error ? error.message : String(error));
    return null;
  }
  if (!serviceUrl) return null;

  try {
    const service = await fetchJsonWithTimeout(`${serviceUrl}?f=json`, 6_000) as { layers?: Array<{ id: number; name: string }> };
    const useful = (service.layers ?? [])
      .map((layer) => ({ ...layer, kind: faaLayerKind(layer.name) }))
      .filter((layer): layer is { id: number; name: string; kind: SurfaceFeature["kind"] } => Boolean(layer.kind));

    if (!useful.length) return null;

    const latPad = 0.085;
    const lonPad = Math.min(0.14, 0.085 / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
    const envelope = [input.lon - lonPad, input.lat - latPad, input.lon + lonPad, input.lat + latPad].join(",");
    const collections = await Promise.all(useful.map(async (layer) => {
      const params = new URLSearchParams({
        where: "1=1",
        outFields: "*",
        returnGeometry: "true",
        outSR: "4326",
        geometry: envelope,
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
        f: "geojson",
      });
      const payload = await fetchJsonWithTimeout(`${serviceUrl}/${layer.id}/query?${params.toString()}`, 7_000) as { features?: GeoJsonFeature[] };
      return { layer, features: payload.features ?? [] };
    }));

    const features: SurfaceFeature[] = [];
    let seq = 1;
    for (const collection of collections) {
      for (const feature of collection.features) {
        const parts = geoJsonParts(feature.geometry);
        const props = feature.properties ?? undefined;
        const ref = propertyText(props, ["DESIGNATOR", "DESIGNATION", "IDENT", "IDENTIFIER", "REF", "TWY_ID", "TXWY_ID", "RUNWAY_ID"]);
        const name = propertyText(props, ["NAME", "FULL_NAME", "DESCRIPTION", "FEATURE_NAME"]);
        for (const points of parts) {
          if (points.length < 2 || points.length > 1_500) continue;
          features.push({
            id: -9_000_000 - seq++,
            kind: collection.layer.kind,
            ...(ref ? { ref: ref.slice(0, 20) } : {}),
            ...(name ? { name: name.slice(0, 80) } : {}),
            points,
          });
          if (features.length >= 4_000) break;
        }
        if (features.length >= 4_000) break;
      }
      if (features.length >= 4_000) break;
    }

    if (!features.some((feature) => feature.kind === "taxiway_area") || features.length < 10) return null;
    console.log("[airport-surface]", { airport: input.airport, source: "FAA", serviceUrl, featureCount: features.length });
    return { airport: input.airport, checkedAt: Date.now(), source: "FAA", features };
  } catch (error) {
    console.warn("[airport-surface] FAA feature load failed", input.airport, error instanceof Error ? error.message : String(error));
    return null;
  }
}

function validCoord(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function normalizeKind(value: string | undefined, areaValue?: string | undefined): SurfaceFeature["kind"] | null {
  if (areaValue === "taxiway") return "taxiway_area";
  return value === "runway" || value === "taxiway" || value === "taxilane" || value === "parking_position" || value === "apron" || value === "terminal" || value === "gate" || value === "holding_position" ? value : null;
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
    const kind = normalizeKind(element.tags?.aeroway, element.tags?.["area:aeroway"]);
    if (!kind) continue;

    if (element.type === "relation") {
      if (kind !== "terminal" && kind !== "apron" && kind !== "taxiway_area") continue;
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
  const key = `${airport}:surface-v7:${input.lat.toFixed(3)}:${input.lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    const faa = await loadFaaAirportSurface({ airport, lat: input.lat, lon: input.lon });
    if (faa) {
      cache.set(key, { value: faa, at: Date.now() });
      return faa;
    }

    // Ground radar only renders line/polygon movement geometry. Querying ways
    // directly is materially faster than asking Overpass for nodes + ways +
    // relations and avoids spending time on objects we never render.
    const latPad = 0.075;
    const lonPad = Math.min(0.12, 0.075 / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
    const south = (input.lat - latPad).toFixed(6);
    const north = (input.lat + latPad).toFixed(6);
    const west = (input.lon - lonPad).toFixed(6);
    const east = (input.lon + lonPad).toFixed(6);
    const query = `[out:json][timeout:10];(way["aeroway"~"^(runway|taxiway|taxilane|parking_position|apron|terminal)$"](${south},${west},${north},${east});way["area:aeroway"="taxiway"](${south},${west},${north},${east});relation["aeroway"~"^(apron|terminal)$"](${south},${west},${north},${east});relation["area:aeroway"="taxiway"](${south},${west},${north},${east}););out geom;`;
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
