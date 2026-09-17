import { createElement } from "react";

export function WeatherEventMarker({ eventNumber, entry, x, y, inverseScale = 1 }: {
  eventNumber: number;
  entry: { lat: number; lon: number };
  x: number;
  y: number;
  inverseScale?: number;
}) {
  return createElement("g", {
    "aria-label": `Weather marker ${eventNumber}`,
    "data-entry-lat": entry.lat,
    "data-entry-lon": entry.lon,
    transform: `translate(${x} ${y}) scale(${inverseScale})`
  }, [
    createElement("circle", { key: "circle", cx: 0, cy: 0, r: 10, className: "fill-bg stroke-fg", strokeWidth: 2, vectorEffect: "non-scaling-stroke" }),
    createElement("text", { key: "text", x: 0, y: 4, textAnchor: "middle", className: "fill-fg", fontSize: 12, fontWeight: 700 }, eventNumber)
  ]);
}
