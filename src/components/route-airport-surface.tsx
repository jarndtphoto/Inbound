import { airportSurfaceQueryOptions } from "@/lib/airport-surface-query";
import type { AirportSurface } from "@/lib/airport-surface.server";
import { airportDetailOpacity, simplifyRouteAirportSurface } from "@/lib/route-airport-detail";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;

// Surface detail is browser-lazy; SSR must not fetch surfaces or create cache timers.
export function RouteAirportSurface(props: Parameters<typeof BrowserAirportSurface>[0]) {
  const browser = useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
  return browser ? <BrowserAirportSurface {...props} /> : null;
}

function BrowserAirportSurface({ airport, near, approachActive, widthMiles, sx, sy }: {
  airport: { icao: string; lat: number; lon: number };
  near: boolean; approachActive: boolean; widthMiles: number;
  sx: (lon: number) => number; sy: (lat: number) => number;
}) {
  const opacity = airportDetailOpacity(widthMiles);
  const query = useQuery({ ...airportSurfaceQueryOptions(airport), enabled: approachActive || (near && opacity > 0) });
  const features = useMemo(() => simplifyRouteAirportSurface((query.data as AirportSurface | undefined)?.features ?? []), [query.data]);
  const shapes = useMemo(() => features.map(feature => ({
    feature, points: feature.points.map(p => `${sx(p.lon).toFixed(6)},${sy(p.lat).toFixed(6)}`).join(" "),
    // OSM centerlines have no area: draw a quiet, geographic 45 m runway strip.
    runwayWidth: Math.abs(sx(airport.lon + 45 / (111_195 * Math.cos(airport.lat * Math.PI / 180))) - sx(airport.lon)),
  })), [features, sx, sy, airport.lat, airport.lon]);
  const geometry = useMemo(() => shapes.map(({ feature, points, runwayWidth }) => {
      const key = `${feature.kind}-${feature.id}`;
      if (feature.kind === "runway") return <polyline key={key} data-surface-kind={feature.kind} points={points} fill="none" stroke="var(--route-airport-runway)" strokeWidth={runwayWidth} strokeLinecap="butt" />;
      if (feature.kind === "taxiway") return <polyline key={key} data-surface-kind={feature.kind} points={points} className="fill-none stroke-accent/35" strokeWidth="0.9" vectorEffect="non-scaling-stroke" />;
      const fill = feature.kind === "runway_area" ? "var(--route-airport-runway)"
        : feature.kind === "terminal" ? "var(--route-airport-terminal)"
        : feature.kind === "apron" ? "var(--route-airport-apron)" : "var(--route-airport-taxiway)";
      return <polygon key={key} data-surface-kind={feature.kind} points={points} fill={fill} />;
    }), [shapes]);
  if (!near || opacity <= 0 || !shapes.length) return null;
  return <g data-route-airport={airport.icao} opacity={opacity} pointerEvents="none" aria-hidden="true">{geometry}</g>;
}
