import type { Chop, RouteSample } from "./types.ts";
import { orderedWeatherSamples, sampleWeather } from "./route-weather-segments.ts";

export type RouteWeatherEvent = {
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
};

const CHOP_RANK: Record<Chop, number> = {
  smooth: 0,
  light: 1,
  moderate: 2,
  severe: 3,
};

function minChop(a: Chop, b: Chop): Chop {
  return CHOP_RANK[a] <= CHOP_RANK[b] ? a : b;
}

function maxChop(a: Chop, b: Chop): Chop {
  return CHOP_RANK[a] >= CHOP_RANK[b] ? a : b;
}

function conditionKey(sample: RouteSample): string | null {
  // All contiguous turbulence intensities are one passenger weather event.
  // The route line may still vary sample-by-sample, but a light→moderate
  // stretch should read as one area instead of several back-to-back alerts.
  const kind = sampleWeather(sample).kind;
  return kind === "smooth" ? null : kind;
}

function turbulenceDisplayKey(event: RouteWeatherEvent): string {
  if (event.weakestChop === event.strongestChop) return `turbulence:${event.strongestChop}`;
  return `turbulence:${event.weakestChop}-${event.strongestChop}`;
}

function mergeNotes(a: string | null, b: string | null): string | null {
  return [...new Set([a, b].filter(Boolean))].join("\n") || null;
}

/**
 * Build passenger weather ranges once. start/startFrac/startEtaMin always mean
 * entry into the affected area; end fields always mean exit.
 */
export function routeWeatherEvents(samples: RouteSample[], progress = -Infinity, mergeGapMin = 0): RouteWeatherEvent[] {
  // Real story.route.samples were verified origin → destination: both frac and
  // ETA-from-now increase in direction of travel. Never trust caller array order.
  const ordered = orderedWeatherSamples(samples).filter(sample => sample.frac >= progress);

  const runs: Array<RouteWeatherEvent | { key: null; start: RouteSample; end: RouteSample }> = [];
  for (const sample of ordered) {
    const key = conditionKey(sample);
    const previous = runs[runs.length - 1];

    if (previous && previous.key === key) {
      previous.end = sample;
      if (key) {
        const event = previous as RouteWeatherEvent;
        event.endFrac = sample.frac;
        event.endEtaMin = sample.etaMin;
        event.ranges[event.ranges.length - 1].to = sample.frac;
        event.note = mergeNotes(event.note, sample.note);
        event.weakestChop = minChop(event.weakestChop, sample.chop);
        event.strongestChop = maxChop(event.strongestChop, sample.chop);
      }
      continue;
    }

    if (!key) {
      runs.push({ key: null, start: sample, end: sample });
      continue;
    }

    runs.push({
      key,
      start: sample,
      end: sample,
      startFrac: sample.frac,
      endFrac: sample.frac,
      startEtaMin: sample.etaMin,
      endEtaMin: sample.etaMin,
      ranges: [{ from: sample.frac, to: sample.frac }],
      gaps: false,
      note: sample.note,
      weakestChop: sample.chop,
      strongestChop: sample.chop,
    });
  }

  for (let i = 0; i + 2 < runs.length;) {
    const first = runs[i];
    const gap = runs[i + 1];
    const next = runs[i + 2];
    const gapMinutes = next.start.etaMin - first.end.etaMin;
    if (mergeGapMin > 0 && first.key && gap.key === null && next.key === first.key && gapMinutes >= 0 && gapMinutes <= mergeGapMin) {
      const a = first as RouteWeatherEvent;
      const b = next as RouteWeatherEvent;
      a.end = b.end;
      a.endFrac = b.endFrac;
      a.endEtaMin = b.endEtaMin;
      a.ranges.push(...b.ranges);
      a.gaps = true;
      a.note = mergeNotes(a.note, b.note);
      a.weakestChop = minChop(a.weakestChop, b.weakestChop);
      a.strongestChop = maxChop(a.strongestChop, b.strongestChop);
      runs.splice(i + 1, 2);
    } else {
      i++;
    }
  }

  return runs
    .filter((run): run is RouteWeatherEvent => run.key !== null)
    .map((event) => event.key === "turbulence"
      ? { ...event, key: turbulenceDisplayKey(event) }
      : event);
}

export function weatherEventMarker(event: RouteWeatherEvent) {
  return { lat: event.start.lat, lon: event.start.lon, frac: event.startFrac, etaMin: event.startEtaMin };
}

export function weatherEventNumber(events: RouteWeatherEvent[], event: RouteWeatherEvent) {
  return event.key.startsWith("turbulence:") ? events.slice(0, events.indexOf(event) + 1).filter(e => e.key.startsWith("turbulence:")).length : 0;
}
