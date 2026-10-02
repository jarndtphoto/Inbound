import { createElement } from "react";
import type { PassengerWeatherCopy } from "../lib/weather-card-copy";
import { turbulenceBand, turbulenceWords, type TurbulenceIntensity } from "../lib/route-weather-segments.ts";

export function WeatherIntensityLabel({ intensity, band }: { intensity: string; band?: string }) {
  const parts = intensity.split("-");
  return createElement("span", { className: "font-semibold" }, parts.flatMap((part, i) => [
    ...(i ? [createElement("span", { key: `join-${i}`, className: "text-muted" }, " to ")] : []),
    createElement("span", { key: part, className: (band ?? turbulenceBand(part as TurbulenceIntensity)) === "light" ? "text-turbulence-light" : "text-turbulence-moderate" }, turbulenceWords(part as TurbulenceIntensity))
  ]));
}

export function WeatherEventHeadline({ copy }: { copy: PassengerWeatherCopy }) {
  return createElement("h4", { className: "text-lg font-semibold" }, copy.headline);
}

export function WeatherEventBody({ copy }: { copy: PassengerWeatherCopy }) {
  if (!copy.body) return null;
  return createElement("p", { className: "mt-3 text-sm leading-relaxed text-muted" }, copy.body);
}

export function WeatherPreviewLabel({ label }: { label: string }) {
  return createElement("span", null, label);
}
