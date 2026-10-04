import { formatDuration } from "./geo";
import type { FlightStory, RouteSample } from "./types";
import { routeWeatherEvents, type RouteWeatherEvent } from "./weather-events";
import { passengerWeatherCopy } from "./weather-card-copy";
import { formatClockTime } from "./presentation-time";
import { isFreshPilotReport } from "./pirep-time";
import { orderedWeatherSamples, sampleWeather } from "./route-weather-segments";

/** One time-ordered event list for Overview, Weather, and map markers. */
export function upcomingWeatherEvents(samples: RouteSample[], progress: number, now = Date.now()) {
  return routeWeatherEvents(samples, progress, 0, now).sort((a, b) => a.startEtaMin - b.startEtaMin || a.startFrac - b.startFrac);
}

export function eventWeatherCopy(event: RouteWeatherEvent, destination: string) {
  const copy = passengerWeatherCopy(event.start, event.endFrac >= 0.85, destination, event.key);
  return event.source === "observed"
    ? { headline: "Reported by another aircraft", mapLabel: `${copy.mapLabel} reported`, body: null }
    : copy;
}

export function eventWeatherSource(event: RouteWeatherEvent): string {
  if (event.source === "observed") return "Reported by another aircraft";
  const note = event.note ?? "";
  if (/CWA|Center weather advisory/i.test(note)) return "Air traffic weather advisory";
  if (/TCF/i.test(note)) return "Thunderstorm forecast";
  if (/SIGMET/i.test(note)) return "Official aviation weather alert";
  if (/AIRMET/i.test(note)) return "Aviation weather advisory";
  return "Route weather forecast";
}

/** The clock is in the viewer's timezone; observation age is never encounter ETA. */
export function pilotReportTiming(observedAt: number | undefined, now = Date.now(), timeZone?: string): string | null {
  if (!isFreshPilotReport(observedAt, now)) return null;
  const minutes = Math.floor((now - observedAt!) / 60_000);
  const age = minutes < 1 ? "just now" : minutes < 60 ? `about ${minutes} min ago`
    : `about ${Math.round(minutes / 60)} hr ago`;
  return `Reported ${formatClockTime(observedAt!, timeZone)} · ${age}`;
}

/** A single current-versus-later statement for all passenger views. */
export function currentRouteWeatherUnavailable(weatherCoverage: FlightStory["weatherCoverage"]): boolean {
  return Boolean(weatherCoverage?.failedSources.some(source =>
    source === "Turbulence advisories" || source === "Storm advisories"));
}

export function flightWeatherSummary(story: FlightStory, now = Date.now()): string {
  const samples = orderedWeatherSamples(story.route.samples);
  // Route edges inherit their entry condition. Nearest-sample lookup would
  // bring a later advisory into the current ride before its boundary.
  const current = samples.filter(sample => sample.frac <= story.route.progress).at(-1) ?? samples[0] ?? null;
  const levels = { smooth: 0, light: 1, moderate: 2, severe: 3 };
  const bump = (chop: string) => `${chop} bumps`;
  const currentText = !current ? "Current weather along route unavailable"
    : current.convective ? "Storms possible now"
      : current.chop !== "smooth" ? `${bump(current.chop).replace(/^./, c => c.toUpperCase())} possible now`
        : currentRouteWeatherUnavailable(story.weatherCoverage) ? "Current weather along route unavailable" : "Smooth now";
  const forecast = samples.filter(sample => sample.frac > story.route.progress && sample.etaMin > 1
    && sampleWeather(sample).kind !== "smooth"
    && (!current || levels[sample.chop] > levels[current.chop] || sampleWeather(sample).kind !== sampleWeather(current).kind))
    .sort((a, b) => (levels[b.chop] + (b.convective ? 0.5 : 0)) - (levels[a.chop] + (a.convective ? 0.5 : 0)))[0];
  const reports = samples.filter(sample => sample.frac >= story.route.progress || sample === current)
    .flatMap(sample => (sample.pilotReports ?? []).filter(report => isFreshPilotReport(report.observedAt, now))
      .map(report => ({ report, eta: sample === current ? 0 : sample.etaMin })))
    .sort((a, b) => levels[b.report.chop] - levels[a.report.chop]);
  const reported = reports[0];
  if (reported && (!forecast || levels[reported.report.chop] > levels[forecast.chop]))
    return `${currentText} · ${bump(reported.report.chop)} reported ${reported.eta <= 1 ? "nearby" : "ahead"}`;
  if (forecast) {
    const label = forecast.convective ? "storms" : forecast.chop !== "smooth" ? bump(forecast.chop) : "clouds";
    return `${currentText} · ${label} possible later`;
  }
  return currentText;
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
  const sentence = (event: RouteWeatherEvent, later = false) => event.source === "observed"
    ? `${label(event)} in this area. ${event.startEtaMin <= 1 ? "You're passing this area around now." : `You'll pass this area in about ${ahead(event)}.`}`
    : later ? `${label(event)} later, about ${ahead(event)} ahead.`
      : event.startEtaMin <= 1 ? `${label(event)} possible around now.` : `${label(event)} possible in about ${ahead(event)}.`;
  return [
    sentence(next),
    ...(later ? [sentence(later, true)] : []),
  ];
}
