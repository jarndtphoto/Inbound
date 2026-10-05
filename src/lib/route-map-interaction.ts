export const MIN_FREE_ROUTE_ZOOM = 0.75;
const MAP_WIDTH = 800;
const ROUTE_PAN_BUFFER = 0.5;

export function clampRouteMapView(next: { s: number; x: number; y: number }, mapH = 800, freePan = false, maxZoom = 12) {
  const s = Math.min(maxZoom, Math.max(freePan ? MIN_FREE_ROUTE_ZOOM : 1, next.s));
  if (freePan) {
    // Keep the viewport within half a screen of the unscaled route area.
    return {
      s,
      x: Math.min(MAP_WIDTH * ROUTE_PAN_BUFFER * s, Math.max(MAP_WIDTH - MAP_WIDTH * (1 + ROUTE_PAN_BUFFER) * s, next.x)),
      y: Math.min(mapH * ROUTE_PAN_BUFFER * s, Math.max(mapH - mapH * (1 + ROUTE_PAN_BUFFER) * s, next.y)),
    };
  }
  if (s <= 1.001) return { s: 1, x: 0, y: 0 };
  return { s, x: Math.min(0, Math.max(MAP_WIDTH - MAP_WIDTH * s, next.x)), y: Math.min(0, Math.max(mapH - mapH * s, next.y)) };
}

export function isMapControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("button, summary, a");
}
