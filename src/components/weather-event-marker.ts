import { createElement } from "react";

export function WeatherEventMarker({ eventNumber, entry, x, y, inverseScale = 1, kind = "turbulence", band = "moderate", label }: {
  eventNumber: number;
  entry: { lat: number; lon: number };
  x: number;
  y: number;
  inverseScale?: number;
  kind?: string;
  band?: string;
  label?: string;
}) {
  return createElement("g", {
    "aria-label": `${kind === "turbulence" ? `Weather marker ${eventNumber}` : kind === "storms" ? "Thunderstorm marker" : "Cloud marker"}${label ? `: ${label}` : ""}`,
    "data-entry-lat": entry.lat,
    "data-entry-lon": entry.lon,
    transform: `translate(${x} ${y}) scale(${inverseScale})`
  }, [
    createElement("title", { key: "title" }, label || kind),
    createElement("circle", { key: "circle", cx: 0, cy: 0, r: 10, className: kind !== "turbulence" ? "fill-bg stroke-weather-atmosphere" : band === "light" ? "fill-bg stroke-turbulence-light" : "fill-bg stroke-turbulence-moderate", strokeWidth: 2, vectorEffect: "non-scaling-stroke" }),
    createElement("text", { key: "text", x: 0, y: 4, textAnchor: "middle", className: "fill-fg", fontSize: 12, fontWeight: 700 }, kind === "storms" ? "⚡" : kind === "clouds" ? "☁" : eventNumber)
  ]);
}
