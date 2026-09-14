import { createElement } from "react";
import type { PassengerWeatherCopy } from "../lib/weather-card-copy";

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
