import { interpolateGreatCircle } from "./geo.ts";
import type { RouteSample } from "./types.ts";

export type TurbulenceIntensity = "smooth" | "light" | "light-moderate" | "moderate" | "moderate-severe" | "severe";
export type WeatherKind = "smooth" | "turbulence" | "storms" | "clouds";

export function turbulenceBand(intensity: TurbulenceIntensity) {
  return intensity === "smooth" ? "smooth" : intensity === "light" || intensity === "light-moderate" ? "light" : "moderate";
}
export function turbulenceWords(intensity: TurbulenceIntensity | "light-severe") {
  return { smooth: "Smooth", light: "Light", "light-moderate": "Light to moderate", moderate: "Moderate", "moderate-severe": "Moderate to severe", severe: "Severe", "light-severe": "Light to severe" }[intensity];
}
export function sampleWeather(sample: RouteSample) {
  let intensity: TurbulenceIntensity = sample.chop;
  // Preserve explicit reported ranges when the existing sample retains them.
  // Never infer a range from an event containing separate light/moderate samples.
  if (sample.chop === "moderate" && /\b(?:LGT|LIGHT)\s*(?:-|TO|\/)\s*(?:MOD|MODERATE)\b/i.test(sample.note ?? "")) intensity = "light-moderate";
  if (sample.chop === "severe" && /\b(?:MOD|MODERATE)\s*(?:-|TO|\/)\s*(?:SEV|SEVERE)\b/i.test(sample.note ?? "")) intensity = "moderate-severe";
  const kind: WeatherKind = sample.chop !== "smooth" ? "turbulence" : sample.convective ? "storms" : sample.cloud ? "clouds" : "smooth";
  return { intensity, kind, band: turbulenceBand(intensity) };
}
export function orderedWeatherSamples(samples: RouteSample[]) {
  return samples.filter(s => Number.isFinite(s.frac) && Number.isFinite(s.lat) && Number.isFinite(s.lon)).slice().sort((a, b) => a.frac - b.frac);
}
export type RouteWeatherSegment = ReturnType<typeof sampleWeather> & { past: boolean; points: RouteSample[] };

/** Each edge inherits its entry sample; both adjacent segments share the boundary. */
export function routeWeatherSegments(samples: RouteSample[], progress = -Infinity): RouteWeatherSegment[] {
  const ordered = orderedWeatherSamples(samples), segments: RouteWeatherSegment[] = [];
  // Split the flown/projected edge at progress, retaining an exact observed
  // sample when one already exists. Never reconnect a skipped dateline edge.
  for (let i = 0; i + 1 < ordered.length; i++) {
    const start = ordered[i], end = ordered[i + 1];
    if (start.frac < progress && end.frac > progress && Math.abs(end.lon - start.lon) <= 180) {
      const t = (progress - start.frac) / (end.frac - start.frac);
      const between = (a: number, b: number) => a + (b - a) * t;
      const boundary: RouteSample = { ...start, ...interpolateGreatCircle(start, end, t), frac: progress,
        distNm: between(start.distNm, end.distNm), remainingNm: between(start.remainingNm, end.remainingNm),
        etaMin: between(start.etaMin, end.etaMin), fix: false };
      ordered.splice(i + 1, 0, boundary);
      break;
    }
  }
  ordered.forEach((sample, i) => {
    const candidate = ordered[i + 1];
    const next = candidate && Math.abs(candidate.lon - sample.lon) <= 180 ? candidate : undefined;
    const weather = sampleWeather(sample), past = sample.frac < progress;
    const previous = segments.at(-1);
    if (previous && previous.intensity === weather.intensity && previous.kind === weather.kind && previous.past === past && previous.points.at(-1) === sample) {
      if (next) previous.points.push(next);
    } else segments.push({ ...weather, past, points: next ? [sample, next] : [sample] });
  });
  return segments;
}
