import { airportSurfaceQueryOptions } from "@/lib/airport-surface-query";
import type { AirportSurface } from "@/lib/airport-surface.server";
import { airportDetailOpacity, showRouteAirportLoadingNote, simplifyRouteAirportSurface } from "@/lib/route-airport-detail";
import { filterAirportSurfaceFeatures } from "@/lib/airport-surface-filter";
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

function BrowserAirportSurface({ airport, near, approachActive, widthMiles, inverseScale, sx, sy }: {
  airport: { icao: string; lat: number; lon: number };
  near: boolean; approachActive: boolean; widthMiles: number; inverseScale: number;
  sx: (lon: number) => number; sy: (lat: number) => number;
}) {
  const opacity = airportDetailOpacity(widthMiles);
  const query = useQuery({ ...airportSurfaceQueryOptions(airport), enabled: approachActive || (near && opacity > 0) });
  const surface = query.data as AirportSurface | undefined;
  const hydro = surface?.hydrography;
  const features = useMemo(() => simplifyRouteAirportSurface(filterAirportSurfaceFeatures(surface?.features ?? [], airport)), [surface, airport.lat, airport.lon]);
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
  const hydroDetail = useMemo(() => {
    if (!hydro || (!hydro.fallback && hydro.coastlineWays === 0 && hydro.waterPolygons === 0)) return null;
    const box = [
      { lat: hydro.bounds.south, lon: hydro.bounds.west },
      { lat: hydro.bounds.south, lon: hydro.bounds.east },
      { lat: hydro.bounds.north, lon: hydro.bounds.east },
      { lat: hydro.bounds.north, lon: hydro.bounds.west },
    ];
    const polygonPath = (polygon: { outer: Array<{ lat: number; lon: number }>; holes?: Array<Array<{ lat: number; lon: number }>> }) =>
      [polygon.outer, ...(polygon.holes ?? [])].map((ring) =>
        ring.map((point, index) => `${index ? "L" : "M"}${sx(point.lon).toFixed(6)} ${sy(point.lat).toFixed(6)}`).join(" ") + " Z",
      ).join(" ");
    const boxPoints = box.map((point) => `${sx(point.lon).toFixed(6)},${sy(point.lat).toFixed(6)}`).join(" ");
    const baseFill = hydro.fallback || !hydro.ocean ? "var(--journey-land)" : "var(--journey-water)";
    return (
      <g data-route-airport-hydro={airport.icao} data-route-airport-hydro-fallback={hydro.fallback ? hydro.fallbackReason ?? "fallback" : undefined}>
        <polygon points={boxPoints} fill={baseFill} stroke="none" />
        {!hydro.fallback && hydro.land.map((polygon, index) => (
          <path key={`land-${index}`} data-airport-detailed-land d={polygonPath(polygon)}
            fill="var(--journey-land)" fillRule="evenodd" stroke="none" />
        ))}
        {!hydro.fallback && hydro.water.map((polygon, index) => (
          <path key={`water-${index}`} data-airport-detailed-water d={polygonPath(polygon)}
            fill="var(--journey-water)" fillRule="evenodd" stroke="none" />
        ))}
      </g>
    );
  }, [hydro, airport.icao, sx, sy]);
  if (!near || opacity <= 0) return null;
  if (showRouteAirportLoadingNote(widthMiles, query.isPending)) {
    return <g data-route-airport-loading={airport.icao}
      transform={`translate(${sx(airport.lon)} ${sy(airport.lat)}) scale(${inverseScale})`}
      pointerEvents="none" aria-hidden="true">
      <rect x="-67" y="-13" width="134" height="26" rx="5" className="fill-bg/90 stroke-border" strokeWidth="1" />
      <text y="4" textAnchor="middle" className="fill-muted" fontSize="11"
        fontFamily="IBM Plex Mono, monospace">Loading airport map…</text>
    </g>;
  }
  if (!shapes.length && !hydroDetail) return null;
  return <g data-route-airport={airport.icao} opacity={opacity} pointerEvents="none" aria-hidden="true">
    {hydroDetail}
    {geometry}
  </g>;
}
