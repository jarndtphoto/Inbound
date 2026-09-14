import type { RouteSample } from "./types.ts";

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
};

function conditionKey(sample: RouteSample): string | null {
  if (!sample.convective && sample.chop === "smooth" && !sample.cloud) return null;
  return [sample.convective ? "storm" : "", sample.chop, sample.cloud ? "cloud" : ""].join(":");
}

function mergeNotes(a: string | null, b: string | null): string | null {
  return [...new Set([a, b].filter(Boolean))].join("\n") || null;
}

/**
 * Build passenger weather ranges once. start/startFrac/startEtaMin always mean
 * entry into the affected area; end fields always mean exit.
 */
export function routeWeatherEvents(samples: RouteSample[], mergeGapMin = 5): RouteWeatherEvent[] {
  const runs: Array<RouteWeatherEvent | { key: null; start: RouteSample; end: RouteSample }> = [];
  for (const sample of samples) {
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
      note: sample.note
    });
  }

  for (let i = 0; i + 2 < runs.length;) {
    const first = runs[i];
    const gap = runs[i + 1];
    const next = runs[i + 2];
    const gapMinutes = next.start.etaMin - first.end.etaMin;
    if (first.key && gap.key === null && next.key === first.key && gapMinutes >= 0 && gapMinutes <= mergeGapMin) {
      const a = first as RouteWeatherEvent;
      const b = next as RouteWeatherEvent;
      a.end = b.end;
      a.endFrac = b.endFrac;
      a.endEtaMin = b.endEtaMin;
      a.ranges.push(...b.ranges);
      a.gaps = true;
      a.note = mergeNotes(a.note, b.note);
      runs.splice(i + 1, 2);
    } else {
      i++;
    }
  }
  return runs.filter((run): run is RouteWeatherEvent => run.key !== null);
}
