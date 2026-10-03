import { formatDuration } from "./geo";
import type { RouteSample } from "./types";
import { routeWeatherEvents, type RouteWeatherEvent } from "./weather-events";
import { passengerWeatherCopy } from "./weather-card-copy";

/** One time-ordered event list for Overview, Weather, and map markers. */
export function upcomingWeatherEvents(samples: RouteSample[], progress: number) {
  return routeWeatherEvents(samples, progress).sort((a, b) => a.startEtaMin - b.startEtaMin || a.startFrac - b.startFrac);
}

export function eventWeatherCopy(event: RouteWeatherEvent, destination: string) {
  return passengerWeatherCopy(event.start, event.endFrac >= 0.85, destination, event.key);
}

export function weatherOutlook(events: RouteWeatherEvent[], destination: string): string[] {
  const next = events[0];
  if (!next) return [];
  const ranks = { smooth: 0, light: 1, moderate: 2, severe: 3 };
  const rank = (event: RouteWeatherEvent) => ranks[event.strongestChop] + (event.start.convective ? 0.5 : 0);
  const later = events.slice(1).reduce<RouteWeatherEvent | null>((best, event) =>
    rank(event) > rank(next) && (!best || rank(event) > rank(best)) ? event : best, null);
  const ahead = (event: RouteWeatherEvent) => {
    const minutes = Math.max(0, Math.round(event.startEtaMin));
    return minutes < 60 ? `${minutes} min` : formatDuration(minutes);
  };
  const label = (event: RouteWeatherEvent) => eventWeatherCopy(event, destination).mapLabel;
  return [
    next.startEtaMin <= 1 ? `${label(next)} possible around now.` : `${label(next)} possible in about ${ahead(next)}.`,
    ...(later ? [`${label(later)} later, about ${ahead(later)} ahead.`] : []),
  ];
}
