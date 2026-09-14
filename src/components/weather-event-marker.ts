import { createElement } from "react";

export function WeatherEventMarker({ eventNumber, entry, x, y }: {
  eventNumber: number;
  entry: { lat: number; lon: number };
  x: number;
  y: number;
}) {
  return createElement("g", {
    "aria-label": `Weather marker ${eventNumber}`,
    "data-entry-lat": entry.lat,
    "data-entry-lon": entry.lon
  }, [
    createElement("circle", { key: "circle", cx: x, cy: y, r: 10, className: "fill-bg stroke-fg", strokeWidth: 2 }),
    createElement("text", { key: "text", x, y: y + 4, textAnchor: "middle", className: "fill-fg", fontSize: 12, fontWeight: 700 }, eventNumber)
  ]);
}
