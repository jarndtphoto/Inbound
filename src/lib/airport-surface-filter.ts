import { haversineNm } from "./geo";
import type { SurfaceFeature } from "./airport-surface.server";

const MAX_SURFACE_RADIUS_NM = 4;
const RUNWAY_CORE_MIN_SPAN_NM = 0.7;
const CONNECT_GAP_NM = 0.25;
const CORE_PAD_NM = 1;

type AirportPoint = { lat: number; lon: number };

type Box = { minX: number; maxX: number; minY: number; maxY: number };

function localXY(point: AirportPoint, airport: AirportPoint) {
  const cos = Math.max(0.35, Math.cos(airport.lat * Math.PI / 180));
  return {
    x: (point.lon - airport.lon) * 60 * cos,
    y: (point.lat - airport.lat) * 60,
  };
}

function featureBox(feature: SurfaceFeature, airport: AirportPoint): Box {
  const xy = feature.points.map((point) => localXY(point, airport));
  return {
    minX: Math.min(...xy.map((point) => point.x)),
    maxX: Math.max(...xy.map((point) => point.x)),
    minY: Math.min(...xy.map((point) => point.y)),
    maxY: Math.max(...xy.map((point) => point.y)),
  };
}

function boxGapNm(a: Box, b: Box) {
  const dx = a.maxX < b.minX ? b.minX - a.maxX : b.maxX < a.minX ? a.minX - b.maxX : 0;
  const dy = a.maxY < b.minY ? b.minY - a.maxY : b.maxY < a.minY ? a.minY - b.maxY : 0;
  return Math.hypot(dx, dy);
}

function featureSpanNm(feature: SurfaceFeature, airport: AirportPoint) {
  const box = featureBox(feature, airport);
  return Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
}

function nearestPointNm(feature: SurfaceFeature, airport: AirportPoint) {
  return Math.min(...feature.points.map((point) => haversineNm(point, airport)));
}

/**
 * Keep one connected airport complex from a broad OSM surface response.
 *
 * Nearby airports can sit inside the same Overpass box (SAN/KNZY is the
 * motivating case). Seed the component from the real-length runway closest
 * to the requested airport coordinate, flood through nearby surface geometry,
 * then retain detached detail within a modest pad around that selected core.
 */
export function filterAirportSurfaceFeatures(features: SurfaceFeature[], airport: AirportPoint) {
  const local = features
    .map((feature) => ({
      ...feature,
      points: feature.points.filter((point) => haversineNm(point, airport) <= MAX_SURFACE_RADIUS_NM),
    }))
    .filter((feature) => feature.points.length >= 2);

  const longRunwayIndexes = local
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) =>
      (feature.kind === "runway" || feature.kind === "runway_area")
      && featureSpanNm(feature, airport) >= RUNWAY_CORE_MIN_SPAN_NM
    );

  if (!longRunwayIndexes.length) return local;

  const seed = longRunwayIndexes.reduce((best, candidate) =>
    nearestPointNm(candidate.feature, airport) < nearestPointNm(best.feature, airport) ? candidate : best
  );

  const boxes = local.map((feature) => featureBox(feature, airport));
  const selected = new Set<number>([seed.index]);
  const queue = [seed.index];

  while (queue.length) {
    const current = queue.shift()!;
    for (let index = 0; index < local.length; index++) {
      if (selected.has(index)) continue;
      if (boxGapNm(boxes[current]!, boxes[index]!) > CONNECT_GAP_NM) continue;
      selected.add(index);
      queue.push(index);
    }
  }

  const coreBoxes = [...selected].map((index) => boxes[index]!);
  const core: Box = {
    minX: Math.min(...coreBoxes.map((box) => box.minX)) - CORE_PAD_NM,
    maxX: Math.max(...coreBoxes.map((box) => box.maxX)) + CORE_PAD_NM,
    minY: Math.min(...coreBoxes.map((box) => box.minY)) - CORE_PAD_NM,
    maxY: Math.max(...coreBoxes.map((box) => box.maxY)) + CORE_PAD_NM,
  };

  return local
    .map((feature, index) => {
      if (selected.has(index)) return feature;
      const box = boxes[index]!;
      if (box.maxX < core.minX || box.minX > core.maxX || box.maxY < core.minY || box.minY > core.maxY) return null;
      return {
        ...feature,
        points: feature.points.filter((point) => {
          const { x, y } = localXY(point, airport);
          return x >= core.minX && x <= core.maxX && y >= core.minY && y <= core.maxY;
        }),
      };
    })
    .filter((feature): feature is SurfaceFeature => Boolean(feature && feature.points.length >= 2));
}
