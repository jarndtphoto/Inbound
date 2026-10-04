import { deriveNearbyDisplayPosition, type NearbyDisplayPosition } from "../nearby-v1/motion";
import type { InboundNearbyResponse, PublicRadarTarget, PublicFeaturedFlight } from "./nearby-response";

export type RadarPoint = { x: number; y: number; inView: boolean; eastNm: number; northNm: number };
export type RadarLabel = { radarId: string; x: number; y: number; width: number; height: number };
export const RADAR_AIRPORTS = Object.freeze([
  { code: "ORD", areaId: "airport:KORD", latitude: 41.9742, longitude: -87.9073 },
  { code: "MDW", areaId: "airport:KMDW", latitude: 41.7868, longitude: -87.7522 },
]);

/** Screen projection only. Flight movement always comes from the shared engine function. */
export function projectRadarPoint(point: { latitude: number; longitude: number }, reference: { latitude: number; longitude: number }, width: number, height: number, radiusNm: number): RadarPoint | null {
  if (![point.latitude, point.longitude, reference.latitude, reference.longitude, width, height, radiusNm].every(Number.isFinite)
    || width <= 0 || height <= 0 || radiusNm <= 0) return null;
  const deltaLongitude = ((point.longitude - reference.longitude + 540) % 360) - 180;
  const eastNm = deltaLongitude * 60.04046 * Math.cos(reference.latitude * Math.PI / 180);
  const northNm = (point.latitude - reference.latitude) * 60.04046;
  const scale = Math.max(1, Math.min(width, height) - 56) / (2 * radiusNm);
  const x = width / 2 + eastNm * scale, y = height / 2 - northNm * scale;
  return { x, y, eastNm, northNm, inView: x >= 22 && x <= width - 22 && y >= 22 && y <= height - 22 && Math.hypot(eastNm, northNm) <= radiusNm };
}

/** The public Radar boundary contains accepted airborne fixes only. It preserves
 * positionKind, so an accepted already-projected point cannot be advanced twice. */
export function deriveRadarDisplayPosition(target: PublicRadarTarget, nowMs: number, health: InboundNearbyResponse["health"], generatedAt: string): NearbyDisplayPosition | null {
  const frozen = health === "stale" || health === "unavailable";
  const display = deriveNearbyDisplayPosition({
    latitude: target.latitude, longitude: target.longitude, altitudeFt: target.altitudeFt,
    groundspeedKt: target.groundspeedKt, groundTrackDeg: target.groundTrackDeg,
    observedAt: target.observedAt, positionKind: target.positionKind,
    acceptedPosition: true, onGround: false,
  }, frozen ? Math.min(nowMs, Date.parse(generatedAt)) : nowMs);
  return display ? { ...display, stopped: frozen || display.stopped } : null;
}

const overlaps = (a: RadarLabel, b: RadarLabel) => a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x
  && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;

/** Small deterministic greedy policy, not a flight-label engine. Selection gets
 * first priority. Featured then input-ranked targets fill a bounded label set. */
export function radarLabels(targets: readonly { radarId: string; displayIdent: string; featured: boolean; point: RadarPoint }[], selectedRadarId: string | null, width: number, height: number): RadarLabel[] {
  const visible = targets.filter(t => t.point.inView);
  const ordered = visible.map((target, index) => ({ target, index })).sort((a, b) =>
    Number(b.target.radarId === selectedRadarId) - Number(a.target.radarId === selectedRadarId)
    || Number(b.target.featured) - Number(a.target.featured) || a.index - b.index);
  const limit = width < 430 ? 5 : 8;
  const placed: RadarLabel[] = [];
  for (const { target } of ordered) {
    if (placed.length >= limit) break;
    const labelWidth = Math.min(112, Math.max(74, target.displayIdent.length * 6.2 + 12)), labelHeight = 31;
    const p = target.point;
    const positions = [[p.x + 14, p.y - 13], [p.x - labelWidth - 14, p.y - 13], [p.x - labelWidth / 2, p.y + 15], [p.x - labelWidth / 2, p.y - labelHeight - 15]];
    let selected: RadarLabel | undefined;
    for (const [x, y] of positions) {
      const label = { radarId: target.radarId, x, y, width: labelWidth, height: labelHeight };
      if (x < 4 || y < 4 || x + labelWidth > width - 4 || y + labelHeight > height - 4 || placed.some(other => overlaps(label, other))) continue;
      // Do not cover another target's visible symbol; hit areas remain 44px.
      if (visible.some(other => other.radarId !== target.radarId && other.point.x > x - 9 && other.point.x < x + labelWidth + 9 && other.point.y > y - 9 && other.point.y < y + labelHeight + 9)) continue;
      selected = label; break;
    }
    if (!selected && target.radarId === selectedRadarId) selected = {
      radarId: target.radarId, x: Math.max(4, Math.min(width - labelWidth - 4, p.x + 14)),
      y: Math.max(4, Math.min(height - labelHeight - 4, p.y - 13)), width: labelWidth, height: labelHeight,
    };
    if (selected) placed.push(selected);
  }
  return placed;
}

/** Keep an expired selected observation without borrowing route evidence for a
 * fresh identity. Exact display identifiers remain separate, including aliases. */
export function radarSelectionSnapshot(selectedRadarId: string | null, targets: readonly PublicRadarTarget[], featuredFlights: readonly PublicFeaturedFlight[], previousTarget: PublicRadarTarget | null, previousFeatured: PublicFeaturedFlight | null): { target: PublicRadarTarget | null; featured: PublicFeaturedFlight | null } {
  const current = targets.find(target => target.radarId === selectedRadarId) || null;
  const target = current || (previousTarget?.radarId === selectedRadarId ? previousTarget : null);
  const freshFeatured = featuredFlights.find(flight => flight.radarId === selectedRadarId) || null;
  const candidate = freshFeatured || (!current && previousFeatured?.radarId === selectedRadarId ? previousFeatured : null);
  return { target, featured: candidate && target && candidate.displayIdent === target.displayIdent ? candidate : null };
}

/** Overlapping accessible hit areas must not steal a tap on a visible symbol.
 * Pointer clicks pick the nearest center among containing 44px hit rectangles;
 * keyboard and programmatic clicks keep the focused button's own identity. */
export function radarSelectionForClick(clickedRadarId: string, pointer: { detail: number; x: number; y: number }, targets: readonly { radarId: string; point: Pick<RadarPoint, "x" | "y" | "inView"> }[]): string {
  if (!(pointer.detail > 0) || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return clickedRadarId;
  let nearest: { radarId: string; distanceSquared: number } | null = null;
  for (const target of targets) {
    if (!target.point.inView || !Number.isFinite(target.point.x) || !Number.isFinite(target.point.y)) continue;
    const dx = pointer.x - target.point.x, dy = pointer.y - target.point.y;
    if (Math.abs(dx) > 22 || Math.abs(dy) > 22) continue;
    const distanceSquared = dx * dx + dy * dy;
    // Input order is the deterministic tie-break for coincident symbols.
    if (nearest === null || distanceSquared < nearest.distanceSquared) nearest = { radarId: target.radarId, distanceSquared };
  }
  return nearest?.radarId || clickedRadarId;
}

export function radarRouteText(route: { originIata: string | null; destinationIata: string | null; verification: "unknown" | "hint" | "confirmed" } | null | undefined): string {
  if (!route || route.verification === "unknown") return "Route unavailable";
  return `${route.originIata || "Unknown"} → ${route.destinationIata || "Unknown"}${route.verification === "hint" ? " · Route hint" : " · Confirmed route"}`;
}
