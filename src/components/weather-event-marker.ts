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
    createElement("circle", {
      key: "mask",
      cx: 0,
      cy: 0,
      r: 11,
      className: "fill-bg",
      stroke: "none"
    }),
    createElement("circle", {
      key: "circle",
      cx: 0,
      cy: 0,
      r: 7,
      className: "fill-bg stroke-fg",
      strokeWidth: 1.5,
      vectorEffect: "non-scaling-stroke"
    }),
    createElement("text", {
      key: "text",
      x: 0,
      y: 3,
      textAnchor: "middle",
      className: "fill-fg",
      fontSize: 9,
      fontWeight: 800
    }, eventNumber)
  ]);
}
