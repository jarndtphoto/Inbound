export type RouteMapView = { s: number; x: number; y: number };
export type RouteMapPanBounds = { minX: number; maxX: number; minY: number; maxY: number };

export const MIN_FREE_ROUTE_ZOOM = 0.75;
const MAP_WIDTH = 800;
const ROUTE_PAN_BUFFER = 0.5;
const WORLD_PAN_OVERSCROLL = 0.08;

export function minimumFreeRouteZoom(bounds: RouteMapPanBounds | null | undefined, mapH = 800) {
  if (!bounds) return MIN_FREE_ROUTE_ZOOM;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  return Math.min(1, Math.max(0.001, Math.min(MAP_WIDTH / width, mapH / height)));
}

function clampWorldAxis(offset: number, scale: number, viewport: number, min: number, max: number) {
  const scaledMin = min * scale;
  const scaledMax = max * scale;
  const span = scaledMax - scaledMin;
  if (span <= viewport) return (viewport - span) / 2 - scaledMin;
  const overscroll = viewport * WORLD_PAN_OVERSCROLL;
  return Math.min(overscroll - scaledMin, Math.max(viewport - overscroll - scaledMax, offset));
}

export function clampRouteMapView(
  next: RouteMapView,
  mapH = 800,
  freePan = false,
  maxZoom = 12,
  panBounds?: RouteMapPanBounds | null,
) {
  const minZoom = freePan ? minimumFreeRouteZoom(panBounds, mapH) : 1;
  const s = Math.min(maxZoom, Math.max(minZoom, next.s));
  if (freePan && panBounds) {
    return {
      s,
      x: clampWorldAxis(next.x, s, MAP_WIDTH, panBounds.minX, panBounds.maxX),
      y: clampWorldAxis(next.y, s, mapH, panBounds.minY, panBounds.maxY),
    };
  }
  if (freePan) {
    // Legacy fallback for callers that do not provide geographic world bounds.
    return {
      s,
      x: Math.min(MAP_WIDTH * ROUTE_PAN_BUFFER * s, Math.max(MAP_WIDTH - MAP_WIDTH * (1 + ROUTE_PAN_BUFFER) * s, next.x)),
      y: Math.min(mapH * ROUTE_PAN_BUFFER * s, Math.max(mapH - mapH * (1 + ROUTE_PAN_BUFFER) * s, next.y)),
    };
  }
  if (s <= 1.001) return { s: 1, x: 0, y: 0 };
  return { s, x: Math.min(0, Math.max(MAP_WIDTH - MAP_WIDTH * s, next.x)), y: Math.min(0, Math.max(mapH - mapH * s, next.y)) };
}

export function reconcileRouteMapView(
  current: RouteMapView,
  resetForNewLeg: boolean,
  mapH = 800,
  freePan = false,
  maxZoom = 12,
  panBounds?: RouteMapPanBounds | null,
) {
  if (resetForNewLeg) return { s: 1, x: 0, y: 0 };
  return clampRouteMapView(current, mapH, freePan, maxZoom, panBounds);
}

export function isMapControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("button, summary, a");
}
