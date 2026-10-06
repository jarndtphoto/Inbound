import { airportDetailGeographyBounds, airportSurfaceBounds, assembleAirportGeography, type AirportDetailedGeography, type SurfacePolygon } from "./airport-coastline.ts";
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
  source: "FAA" | "OpenStreetMap" | "fallback";
  /** Target aerodrome boundary rings from the same surface request, when OSM exposes them. */
  boundary?: SurfacePoint[][];
  /** Detailed coastline/land/water from the same OSM request used for airport detail. */
  geography?: AirportDetailedGeography;
  features: SurfaceFeature[];
};

export function fallbackAirportSurface(
  input: { airport: string; lat: number; lon: number },
  reason = "airport-surface-unavailable",
): AirportSurface {
  return {
    airport: input.airport.toUpperCase(),
    checkedAt: Date.now(),
    source: "fallback",
    geography: {
      bounds: airportDetailGeographyBounds(input),
      base: "land",
      land: [],
      water: [],
      fallback: true,
      fallbackReason: reason,
    },
    features: [],
  };
}

type OverpassGeometryPoint = { lat: number; lon: number };
type OverpassMember = {
  type?: "node" | "way" | "relation";
  ref?: number;
  role?: string;
  geometry?: Array<OverpassGeometryPoint | null>;
};
type OverpassElement = {
  id: number;
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<OverpassGeometryPoint | null>;
  members?: OverpassMember[];
};

type CacheEntry = { value: AirportSurface; at: number };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<AirportSurface>>();
// Allow the declared provider budget plus connection/response transfer time.
const OVERPASS_QUERY_SECONDS = 15;
const OVERPASS_TIMEOUT_MS = 20_000;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
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
  const search = await fetchJsonWithTimeout(`${FAA_HUB_SEARCH}?limit=25&q=${q}`, 5_000) as {
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
    .slice(0, 5);

  // Candidate metadata is independent. Check it in parallel so a few stale
  // catalog entries cannot turn one airport load into a long serial wait.
  const serviceUrls = await Promise.all(ranked.map(async (candidate) => {
    const id = candidate.item.id ?? String(candidate.item.properties?.id ?? "");
    if (!id) return null;
    try {
      const meta = await fetchJsonWithTimeout(`${ARCGIS_ITEM}/${encodeURIComponent(id)}?f=json`, 3_500) as { url?: string; type?: string; title?: string };
      return typeof meta.url === "string" && /FeatureServer/i.test(meta.url)
        ? meta.url.replace(/\/$/, "") : null;
    } catch {
      return null;
    }
  }));
  const serviceUrl = serviceUrls.find((url): url is string => Boolean(url)) ?? null;
  faaServiceByAirport.set(airport, { url: serviceUrl, at: Date.now() });
  return serviceUrl;
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
    const service = await fetchJsonWithTimeout(`${serviceUrl}?f=json`, 5_000) as { layers?: Array<{ id: number; name: string }> };
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
      const payload = await fetchJsonWithTimeout(`${serviceUrl}/${layer.id}/query?${params.toString()}`, 5_000) as { features?: GeoJsonFeature[] };
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
    const bounds = airportDetailGeographyBounds(input);
    const geography: AirportDetailedGeography = {
      bounds, base: "land", land: [], water: [], fallback: true,
      fallbackReason: "OSM-geography-unavailable",
    };
    console.warn("[airport-coastline-fallback]", { airport: input.airport, reason: geography.fallbackReason });
    console.log("[airport-surface]", { airport: input.airport, source: "FAA", serviceUrl, featureCount: features.length });
    return { airport: input.airport, checkedAt: Date.now(), source: "FAA", geography, features };
  } catch (error) {
    console.warn("[airport-surface] FAA feature load failed", input.airport, error instanceof Error ? error.message : String(error));
    return null;
  }
}

function validCoord(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function compactError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function normalizeKind(value: string | undefined, areaValue?: string | undefined): SurfaceFeature["kind"] | null {
  if (areaValue === "taxiway") return "taxiway_area";
  return value === "runway" || value === "taxiway" || value === "taxilane" || value === "parking_position" || value === "apron" || value === "terminal" || value === "gate" || value === "holding_position" ? value : null;
}

function airportCodeCandidates(airport: string) {
  const code = airport.toUpperCase();
  const codes = new Set([code]);
  if (/^[KP][A-Z0-9]{3}$/.test(code)) codes.add(code.slice(1));
  return codes;
}

function tagCodeValues(tags: Record<string, string> | undefined) {
  const values = new Set<string>();
  if (!tags) return values;
  for (const key of ["icao", "ICAO", "iata", "IATA", "faa", "FAA", "ref", "local_ref", "source_ref"]) {
    const raw = tags[key];
    if (!raw) continue;
    for (const part of raw.toUpperCase().split(/[^A-Z0-9]+/)) if (part) values.add(part);
  }
  return values;
}

function aerodromeMatchesAirport(tags: Record<string, string> | undefined, airport: string) {
  const wanted = airportCodeCandidates(airport);
  for (const value of tagCodeValues(tags)) if (wanted.has(value)) return true;
  return false;
}

function pointOnSegment(point: SurfacePoint, a: SurfacePoint, b: SurfacePoint) {
  const cos = Math.max(0.25, Math.cos(point.lat * Math.PI / 180));
  const ax = (a.lon - point.lon) * 60 * cos, ay = (a.lat - point.lat) * 60;
  const bx = (b.lon - point.lon) * 60 * cos, by = (b.lat - point.lat) * 60;
  const cross = Math.abs(ax * by - ay * bx);
  const dot = ax * bx + ay * by;
  return cross < 0.0008 && dot <= 0;
}

function pointInRing(point: SurfacePoint, ring: SurfacePoint[]) {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (pointOnSegment(point, a, b)) return true;
    const intersects = ((a.lat > point.lat) !== (b.lat > point.lat))
      && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / ((b.lat - a.lat) || 1e-12) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInRings(point: SurfacePoint, rings: SurfacePoint[][]) {
  return rings.some((ring) => pointInRing(point, ring));
}

function centroid(points: SurfacePoint[]): SurfacePoint {
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / Math.max(1, points.length),
    lon: points.reduce((sum, point) => sum + point.lon, 0) / Math.max(1, points.length),
  };
}

type AerodromeBoundary = { id: number; tags?: Record<string, string>; rings: SurfacePoint[][]; matchesTarget: boolean; containsField: boolean };

function aerodromeBoundary(element: OverpassElement, airport: string, field: SurfacePoint): AerodromeBoundary | null {
  if (element.tags?.aeroway !== "aerodrome") return null;
  let rings: SurfacePoint[][] = [];
  if (element.type === "relation") rings = relationOuterRings(element);
  else if (element.type === "way") {
    const points = validGeometry(element.geometry);
    if (points.length >= 3) rings = [points];
  }
  rings = rings.filter((ring) => ring.length >= 3);
  if (!rings.length) return null;
  return {
    id: element.id,
    tags: element.tags,
    rings,
    matchesTarget: aerodromeMatchesAirport(element.tags, airport),
    containsField: pointInRings(field, rings),
  };
}

function selectTargetAerodrome(boundaries: AerodromeBoundary[]) {
  return boundaries.find((boundary) => boundary.matchesTarget && boundary.containsField)
    ?? boundaries.find((boundary) => boundary.matchesTarget)
    ?? boundaries.find((boundary) => boundary.containsField)
    ?? null;
}

function featureFallsInsideAerodrome(points: SurfacePoint[], boundary: AerodromeBoundary) {
  const center = centroid(points);
  if (pointInRings(center, boundary.rings)) return true;
  const inside = points.filter((point) => pointInRings(point, boundary.rings)).length;
  return inside > 0 && inside / points.length >= 0.6;
}

function featureBelongsToTarget(points: SurfacePoint[], target: AerodromeBoundary | null, others: AerodromeBoundary[]) {
  if (points.length === 0) return false;
  const center = centroid(points);
  if (target) return pointInRings(center, target.rings) || points.some((point) => pointInRings(point, target.rings));
  return !others.some((boundary) => featureFallsInsideAerodrome(points, boundary));
}

function samePoint(a: SurfacePoint | undefined, b: SurfacePoint | undefined) {
  return Boolean(a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7);
}

function validGeometry(points: Array<OverpassGeometryPoint | null> | undefined): SurfacePoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p): p is OverpassGeometryPoint => p != null && validCoord(p.lat, -90, 90) && validCoord(p.lon, -180, 180))
    .map((p) => ({ lat: p.lat, lon: p.lon }));
}

// Bounded Overpass output uses nulls for omitted nodes. Keep those breaks:
// removing them would draw a new segment across an unobserved part of a bay.
function geometrySegments(points: Array<OverpassGeometryPoint | null> | undefined): SurfacePoint[][] {
  const segments: SurfacePoint[][] = [];
  let current: SurfacePoint[] = [];
  for (const point of points ?? []) {
    if (point && validCoord(point.lat, -90, 90) && validCoord(point.lon, -180, 180)) {
      current.push({ lat: point.lat, lon: point.lon });
    } else {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

function relationRings(element: OverpassElement, role: "outer" | "inner", requireClosed = false,
  wayGeometry?: Map<number, Array<OverpassGeometryPoint | null>>): SurfacePoint[][] {
  const segments = (element.members ?? [])
    .filter((member) => member.type === "way" && (role === "outer" ? member.role === "outer" || !member.role : member.role === "inner"))
    .flatMap((member) => {
      const geometry = member.geometry ?? (member.ref == null ? undefined : wayGeometry?.get(member.ref));
      return requireClosed ? geometrySegments(geometry) : [validGeometry(geometry)];
    })
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
    if (ring.length >= 3) {
      if (requireClosed && !samePoint(ring[0], ring.at(-1))) continue;
      if (!samePoint(ring[0], ring.at(-1))) ring.push(ring[0]!);
      rings.push(ring);
    }
  }
  return rings;
}

function relationOuterRings(element: OverpassElement) {
  return relationRings(element, "outer");
}

function isWaterElement(element: OverpassElement) {
  return element.tags?.natural === "water"
    || ["lake", "lagoon", "reservoir", "bay"].includes(element.tags?.water ?? "");
}

function waterPolygonFromWay(element: OverpassElement): SurfacePolygon | null {
  if (geometrySegments(element.geometry).length !== 1 || element.geometry?.some((point) => point == null)) return null;
  const ring = validGeometry(element.geometry);
  // Open water ways are not polygons. Do not invent a closing segment across
  // a bay, lake, or reservoir just because the requested box cuts it.
  if (ring.length < 4 || !samePoint(ring[0], ring.at(-1))) return null;
  return { outer: ring };
}

function waterPolygonsFromRelation(element: OverpassElement, wayGeometry: Map<number, Array<OverpassGeometryPoint | null>>): SurfacePolygon[] {
  const outers = relationRings(element, "outer", true, wayGeometry);
  const inners = relationRings(element, "inner", true, wayGeometry);
  return outers.map((outer) => {
    const holes = inners.filter((inner) => inner[0] && pointInRing(inner[0], outer));
    return { outer, ...(holes.length ? { holes } : {}) };
  });
}

export function parseAirportSurfaceElements(elements: OverpassElement[], airport: string, checkedAt: number, field?: SurfacePoint): AirportSurface {
  const fieldPoint = field ?? { lat: 0, lon: 0 };
  const aerodromes = elements
    .map((element) => aerodromeBoundary(element, airport, fieldPoint))
    .filter((boundary): boundary is AerodromeBoundary => Boolean(boundary));
  const target = selectTargetAerodrome(aerodromes);
  const otherAerodromes = aerodromes.filter((boundary) => boundary !== target);
  const features: SurfaceFeature[] = [];
  const pushFeature = (element: OverpassElement, kind: SurfaceFeature["kind"], points: SurfacePoint[], suffix = 0) => {
    if (!points.length || points.length > 800 || features.length >= 2_500) return;
    if (!featureBelongsToTarget(points, target, otherAerodromes)) return;
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
  const bounds = airportDetailGeographyBounds(fieldPoint);
  const coastlineWays = elements
    .filter((element) => element.type === "way" && element.tags?.natural === "coastline")
    .flatMap((element) => geometrySegments(element.geometry))
    .filter((points) => points.length >= 2);
  const waterPolygons: SurfacePolygon[] = [];
  const waterRelations = elements.filter((element) => element.type === "relation" && isWaterElement(element));
  const relationMemberIds = new Set(waterRelations.flatMap((element) =>
    (element.members ?? []).filter((member) => member.type === "way" && member.ref != null).map((member) => member.ref!),
  ));
  const wayGeometry = new Map(elements.filter((element) => element.type === "way" && element.geometry)
    .map((element) => [element.id, element.geometry!]));
  for (const element of elements) {
    if (!isWaterElement(element)) continue;
    if (element.type === "relation") waterPolygons.push(...waterPolygonsFromRelation(element, wayGeometry));
    else if (element.type === "way") {
      if (relationMemberIds.has(element.id)) continue;
      const polygon = waterPolygonFromWay(element);
      if (polygon) waterPolygons.push(polygon);
    }
  }
  const runwaySamples = features
    .filter((feature) => feature.kind === "runway" || feature.kind === "runway_area")
    .map((feature) => centroid(feature.points));
  const geography = assembleAirportGeography({ bounds, coastlineWays, waterPolygons,
    runwaySamples: runwaySamples.length ? runwaySamples : field ? [fieldPoint] : [] });
  if (geography.fallback) console.warn("[airport-coastline-fallback]", { airport, reason: geography.fallbackReason });
  return {
    airport,
    checkedAt,
    source: "OpenStreetMap",
    ...(target ? { boundary: target.rings } : {}),
    geography,
    features,
  };
}

function overpassBounds(bounds: { south: number; west: number; north: number; east: number }) {
  return [bounds.south, bounds.west, bounds.north, bounds.east].map((value) => value.toFixed(6)).join(",");
}

function overpassSurfaceBox(input: { lat: number; lon: number }) {
  return overpassBounds(airportSurfaceBounds(input));
}

function overpassGeographyBox(input: { lat: number; lon: number }) {
  return overpassBounds(airportDetailGeographyBounds(input));
}

function detailedGeographyOverpassQuery(input: { lat: number; lon: number }) {
  const box = overpassGeographyBox(input);
  const clauses = [
    `way["natural"="coastline"](${box});`,
    `way["natural"="water"](${box});`,
    `relation["natural"="water"](${box});`,
    `way["water"~"^(lake|lagoon|reservoir|bay)$"](${box});`,
    `relation["water"~"^(lake|lagoon|reservoir|bay)$"](${box});`,
  ].join("");
  // Keep this in the same HTTP request/cache as the airport surface, but ask
  // Overpass to clip enormous coast/lake relation geometry to the detail box.
  // tags+geom omits unused way node-ID arrays. Relations need body output
  // to retain member roles/references/geometry. qt avoids sorting by ID.
  return `(${clauses})->.geography;way.geography;out tags geom(${box}) qt;relation.geography;out geom(${box}) qt;`;
}

export function exactAirportSurfaceOverpassQuery(airport: string, input?: { lat: number; lon: number }) {
  const code = airport.toUpperCase();
  const aliases = airportCodeCandidates(code);
  const clauses: string[] = [];
  const targetBox = input ? `(${overpassSurfaceBox(input)})` : "";
  for (const value of aliases) {
    clauses.push(`way["aeroway"="aerodrome"]["icao"="${value}"]${targetBox};`);
    clauses.push(`relation["aeroway"="aerodrome"]["icao"="${value}"]${targetBox};`);
    clauses.push(`way["aeroway"="aerodrome"]["iata"="${value}"]${targetBox};`);
    clauses.push(`relation["aeroway"="aerodrome"]["iata"="${value}"]${targetBox};`);
    clauses.push(`way["aeroway"="aerodrome"]["ref"="${value}"]${targetBox};`);
    clauses.push(`relation["aeroway"="aerodrome"]["ref"="${value}"]${targetBox};`);
  }
  const geography = input ? detailedGeographyOverpassQuery(input) : "";
  return `[out:json][timeout:${OVERPASS_QUERY_SECONDS}];(${clauses.join("")})->.target;.target map_to_area -> .airportArea;(.target;way(area.airportArea)["aeroway"~"^(runway|taxiway|taxilane|parking_position|apron|terminal)$"];way(area.airportArea)["area:aeroway"="taxiway"];relation(area.airportArea)["aeroway"~"^(apron|terminal)$"];relation(area.airportArea)["area:aeroway"="taxiway"];);out geom qt;${geography}`;
}

export function boxedAirportSurfaceOverpassQuery(input: { lat: number; lon: number }) {
  const box = overpassSurfaceBox(input);
  return `[out:json][timeout:${OVERPASS_QUERY_SECONDS}];(way["aeroway"~"^(runway|taxiway|taxilane|parking_position|apron|terminal)$"](${box});way["area:aeroway"="taxiway"](${box});relation["aeroway"~"^(apron|terminal)$"](${box});relation["area:aeroway"="taxiway"](${box});way["aeroway"="aerodrome"](${box});relation["aeroway"="aerodrome"](${box}););out geom qt;${detailedGeographyOverpassQuery(input)}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function requireSurface(promise: Promise<AirportSurface | null>, label: string) {
  return promise.then((surface) => {
    if (!surface) throw new Error(`${label} unavailable`);
    return surface;
  });
}

async function loadOsmSurface(
  airport: string,
  input: { lat: number; lon: number },
  mode: "exact" | "boxed",
  query: string,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  const elements = await fetchOverpassElements(query, timeoutMs);
  const osm = parseAirportSurfaceElements(elements, airport, Date.now(), { lat: input.lat, lon: input.lon });
  if (osm.features.length < 5) throw new Error(`OpenStreetMap returned too little geometry (${osm.features.length})`);
  console.log("[airport-surface]", {
    airport, source: "OpenStreetMap", mode,
    durationMs: Date.now() - startedAt,
    featureCount: osm.features.length,
    boundaryRings: osm.boundary?.length ?? 0,
    coastlineWays: elements.filter((element) => element.tags?.natural === "coastline").length,
    waterPolygons: osm.geography?.water.length ?? 0,
    coastlineFallback: osm.geography?.fallback ?? false,
    coastlineFallbackReason: osm.geography?.fallbackReason,
  });
  return osm;
}

export function overpassResponseElements(payload: { elements?: OverpassElement[]; remark?: string }) {
  // Overpass can return HTTP 200 and partial elements after a query/print
  // timeout. Airport features alone must not masquerade as verified land.
  if (payload.remark) throw new Error(`Incomplete Overpass response: ${payload.remark}`);
  if (!Array.isArray(payload.elements)) throw new Error("Invalid airport surface response");
  return payload.elements;
}

async function fetchOverpassElements(query: string, timeoutMs = OVERPASS_TIMEOUT_MS) {
  const body = new URLSearchParams({ data: query }).toString();
  return Promise.any(OVERPASS_ENDPOINTS.map(async (endpoint) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "Inbound/1.0 airport-surface experiment",
        },
        body,
      });
      if (!response.ok) throw new Error(`Airport surface unavailable (${response.status})`);
      return overpassResponseElements(await response.json());
    } catch (error) {
      throw new Error(`${new URL(endpoint).hostname}: ${compactError(error)}`, { cause: error });
    }
  }));
}

export async function loadAirportSurface(input: { airport: string; lat: number; lon: number }): Promise<AirportSurface> {
  const airport = String(input.airport || "").toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(airport) || !validCoord(input.lat, -90, 90) || !validCoord(input.lon, -180, 180)) {
    throw new Error("Invalid airport surface request");
  }
  const key = `${airport}:surface-v12:${input.lat.toFixed(3)}:${input.lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    let settled = false;
    // Start the FAA fallback only if the exact OSM request has not resolved
    // quickly. Its catalog/service lookup overlaps the OSM request.
    const faaFallback = likelyUsAirport(airport)
      ? (async () => {
          await sleep(2_500);
          if (settled) return null;
          try {
            return await withDeadline(loadFaaAirportSurface({ airport, lat: input.lat, lon: input.lon }), 7_000, "FAA surface");
          } catch (error) {
            console.warn("[airport-surface] FAA fallback failed", airport, compactError(error));
            return null;
          }
        })()
      : Promise.resolve(null);

    try {
      const exact = await loadOsmSurface(airport, input, "exact", exactAirportSurfaceOverpassQuery(airport, input), OVERPASS_TIMEOUT_MS);
      settled = true;
      cache.set(key, { value: exact, at: Date.now() });
      return exact;
    } catch (error) {
      console.warn("[airport-surface] OpenStreetMap load failed", airport, "exact", error instanceof AggregateError
        ? error.errors.map(compactError).join(" | ") : compactError(error));
    }

    try {
      const fallback = await Promise.any([
        requireSurface(
          loadOsmSurface(airport, input, "boxed", boxedAirportSurfaceOverpassQuery(input), OVERPASS_TIMEOUT_MS)
            .catch((error) => {
              console.warn("[airport-surface] OpenStreetMap load failed", airport, "boxed", error instanceof AggregateError
                ? error.errors.map(compactError).join(" | ") : compactError(error));
              return null;
            }),
          "boxed OpenStreetMap",
        ),
        requireSurface(faaFallback, "FAA surface"),
      ]);
      settled = true;
      cache.set(key, { value: fallback, at: Date.now() });
      return fallback;
    } catch {
      settled = true;
      const fallback = fallbackAirportSurface({ airport, lat: input.lat, lon: input.lon });
      console.warn("[airport-coastline-fallback]", { airport, reason: fallback.geography?.fallbackReason });
      cache.set(key, { value: fallback, at: Date.now() });
      return fallback;
    }
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
