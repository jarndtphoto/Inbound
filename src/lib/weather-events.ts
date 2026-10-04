import type { Chop, PilotReportObservation, RouteSample } from "./types.ts";
import { routeWeatherSegments, sampleWeather, type TurbulenceIntensity } from "./route-weather-segments.ts";
import { isFreshPilotReport } from "./pirep-time.ts";

export type RouteWeatherEvent = {
  source?: "observed" | "advisory" | "forecast";
  pilotReports?: PilotReportObservation[];
  key: string;
  start: RouteSample;
  end: RouteSample;
  startFrac: number;
  endFrac: number;
  startEtaMin: number;
  endEtaMin: number;
  ranges: { from: number; to: number }[];
  gaps: boolean;
  note: string | null;
  weakestChop: Chop;
  strongestChop: Chop;
  intensities: TurbulenceIntensity[];
};
const ranks: Record<Chop, number> = { smooth: 0, light: 1, moderate: 2, severe: 3 };
const mergeNotes = (a: string | null, b: string | null) => [...new Set([a, b].filter(Boolean))].join("\n") || null;
function uniqueReports(reports: PilotReportObservation[]) {
  return [...new Map(reports.map(report => [`${report.id}:${report.observedAt}`, report])).values()];
}
function extend(a: RouteWeatherEvent, b: RouteWeatherEvent, gap = false) {
  a.end = b.end;
  a.endFrac = b.endFrac;
  a.endEtaMin = b.endEtaMin;
  if (gap) a.ranges.push(...b.ranges);
  else a.ranges[a.ranges.length - 1].to = b.endFrac;
  a.gaps ||= gap;
  a.note = mergeNotes(a.note, b.note);
  a.pilotReports = uniqueReports([...(a.pilotReports ?? []), ...(b.pilotReports ?? [])]);
  if (b.source === "advisory") a.source = "advisory";
  if (ranks[b.weakestChop] < ranks[a.weakestChop]) a.weakestChop = b.weakestChop;
  if (ranks[b.strongestChop] > ranks[a.strongestChop]) a.strongestChop = b.strongestChop;
  a.intensities = [...new Set([...a.intensities, ...b.intensities])];
}
function displayKey(event: RouteWeatherEvent) {
  if (event.key !== "turbulence") return event.key;
  if (event.intensities.length === 1) return `turbulence:${event.intensities[0]}`;
  const levels = event.intensities.flatMap(i => i.split("-") as Chop[]).sort((a, b) => ranks[a] - ranks[b]);
  return `turbulence:${levels[0]}${levels[0] === levels.at(-1) ? "" : `-${levels.at(-1)}`}`;
}

/** Events and line strokes consume the exact same segments and shared boundaries.
 * Smooth gaps split events by default; optional explicit merging retains teal gaps.
 */
function eventsForSamples(samples: RouteSample[], progress: number, mergeGapMin: number, now: number, observed = false): RouteWeatherEvent[] {
  const runs: Array<RouteWeatherEvent | { key: null; start: RouteSample; end: RouteSample }> = [];
  for (const segment of routeWeatherSegments(samples, progress).filter(s => !s.past)) {
    const start = segment.points[0], end = segment.points.at(-1)!;
    if (segment.kind === "smooth") {
      runs.push({ key: null, start, end });
      continue;
    }
    // The shared exit point belongs to the next condition, so exclude its note.
    const interior = segment.points.length > 1 ? segment.points.slice(0, -1) : segment.points;
    const event: RouteWeatherEvent = {
      source: observed ? "observed" : interior.some(point => /AIRMET|SIGMET|CWA|Center weather advisory|Low cloud \/ mountain obscuration/i.test(point.note ?? "")) ? "advisory" : "forecast",
      pilotReports: uniqueReports(interior.flatMap(point => point.pilotReports ?? []).filter(report => isFreshPilotReport(report.observedAt, now))),
      key: segment.kind, start, end, startFrac: start.frac, endFrac: end.frac,
      startEtaMin: start.etaMin, endEtaMin: end.etaMin,
      ranges: [{ from: start.frac, to: end.frac }], gaps: false,
      note: interior.reduce((note, point) => mergeNotes(note, point.note), null as string | null),
      weakestChop: start.chop, strongestChop: start.chop, intensities: [segment.intensity],
    };
    const previous = runs.at(-1);
    if (previous?.key === event.key) extend(previous as RouteWeatherEvent, event);
    else runs.push(event);
  }
  if (mergeGapMin > 0) for (let i = 0; i + 2 < runs.length;) {
    const first = runs[i], gap = runs[i + 1], next = runs[i + 2];
    const minutes = next.start.etaMin - first.end.etaMin;
    if (first.key && gap.key === null && next.key === first.key && minutes >= 0 && minutes <= mergeGapMin) {
      extend(first as RouteWeatherEvent, next as RouteWeatherEvent, true);
      runs.splice(i + 1, 2);
    } else i++;
  }
  return runs.filter((run): run is RouteWeatherEvent => run.key !== null).map(event => ({ ...event, key: displayKey(event) }));
}

/** Forecast samples retain their own severity. Reports are observations of an area,
 * either listed alongside an overlapping forecast or presented as a separate event.
 */
export function routeWeatherEvents(samples: RouteSample[], progress = -Infinity, mergeGapMin = 0, now = Date.now()): RouteWeatherEvent[] {
  const forecasts = eventsForSamples(samples, progress, mergeGapMin, now);
  const observations = samples.map(sample => {
    const reports = sampleWeather(sample).kind === "smooth"
      ? (sample.pilotReports ?? []).filter(report => isFreshPilotReport(report.observedAt, now)) : [];
    const chop = reports.reduce<Chop>((worst, report) => ranks[report.chop] > ranks[worst] ? report.chop : worst, "smooth");
    return { ...sample, chop, cloud: false, convective: false, note: null, pilotReports: reports };
  });
  return [...forecasts, ...eventsForSamples(observations, progress, mergeGapMin, now, true)]
    .sort((a, b) => a.startEtaMin - b.startEtaMin || a.startFrac - b.startFrac);
}
export function weatherEventMarker(event: RouteWeatherEvent) {
  return { lat: event.start.lat, lon: event.start.lon, frac: event.startFrac, etaMin: event.startEtaMin };
}
export function weatherEventNumber(events: RouteWeatherEvent[], event: RouteWeatherEvent) {
  return event.key.startsWith("turbulence:") ? events.slice(0, events.indexOf(event) + 1).filter(e => e.key.startsWith("turbulence:")).length : 0;
}
