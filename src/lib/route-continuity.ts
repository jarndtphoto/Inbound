import { storyLegDate } from "./flight-story-date.ts";
import { parseFlightQuery } from "./flight-parse.ts";
import { polylineLengthNm, progressAlongPath } from "./geo.ts";
import { freshRouteObservation } from "./route-memory.ts";
import type { FlightStory } from "./types.ts";

function sameLeg(a: FlightStory, b: FlightStory) {
  if (a.origin.iata !== b.origin.iata || a.dest.iata !== b.dest.iata) return false;
  if (a.stateKey || b.stateKey) return Boolean(a.stateKey && a.stateKey === b.stateKey);
  const date = storyLegDate(a), other = storyLegDate(b);
  return Boolean(date && date === other && parseFlightQuery(a.query)?.callsign === parseFlightQuery(b.query)?.callsign);
}

/** Device continuity complements durable server state during read failures.
 * Keep geometry and progress together, including a filed-only plan. */
export function keepRouteGeometry(incoming: FlightStory, saved: FlightStory | undefined): FlightStory {
  if (!saved || !sameLeg(incoming, saved) || incoming.route.source === "track" || saved.route.source === "direct") return incoming;
  if (["taxi_in", "gate"].includes(incoming.currentStage) || incoming.times.landKind === "actual") return incoming;
  if (saved.route.source === "track" && !["ride", "arrival", "final_approach"].includes(incoming.currentStage)) return incoming;
  // An explicit runway reset or new validated filed plan owns the display.
  if (saved.route.arrivalPatternKind && (!incoming.route.arrivalPatternKind
    || saved.route.expectedArrival?.runway !== incoming.route.expectedArrival?.runway)) return incoming;
  if (incoming.route.filedRouteFingerprint && incoming.route.filedRouteFingerprint !== saved.route.filedRouteFingerprint
    && (incoming.route.filedRouteObservedAt ?? 0) >= (saved.route.filedRouteObservedAt ?? 0)) return incoming;
  if (incoming.route.source === "filed" && saved.route.source === "filed") return incoming;
  const oldSamples = saved.route.samples, freshSamples = incoming.route.samples;
  if (oldSamples.length < 2 || freshSamples.length < 2) return incoming;
  // Weather comes from this poll, while the route coordinates stay held.
  const samples = oldSamples.map(old => {
    const best = freshSamples.reduce((a, b) => Math.abs(b.frac - old.frac) < Math.abs(a.frac - old.frac) ? b : a);
    return { ...best, lat: old.lat, lon: old.lon, frac: old.frac };
  });
  const observation = incoming.aircraft ? freshRouteObservation({ ...incoming.aircraft,
    seenAt: incoming.providers?.chosenPositionSeenAt }, incoming.fetchedAt) : null;
  const along = observation ? progressAlongPath(samples, observation) : null;
  const totalNm = along ? Math.max(1, polylineLengthNm(samples)) : saved.route.totalNm;
  const progress = along?.frac ?? saved.route.progress;
  const remainingNm = along?.remainingNm ?? saved.route.remainingNm;
  const observedAt = observation?.seenAt ?? saved.route.progressObservedAt
    ?? (saved.providers?.chosenPositionSeenAt ? saved.providers.chosenPositionSeenAt * 1000 : null);
  return { ...incoming, route: { ...incoming.route, source: saved.route.source, samples,
    filedFixes: saved.route.filedFixes, filedRouteFingerprint: saved.route.filedRouteFingerprint,
    filedRouteObservedAt: saved.route.filedRouteObservedAt,
    progress, totalNm, remainingNm, flownNm: Math.max(0, totalNm - remainingNm),
    observedFlownNm: Math.max(incoming.route.observedFlownNm ?? 0, saved.route.observedFlownNm ?? 0) || null,
    progressSource: observation ? "observed" : observedAt != null ? "last_known" : "unknown",
    progressObservedAt: observedAt,
  } };
}

export function lastKnownProgressLabel(story: FlightStory, now = Date.now()): string | null {
  const at = story.route.progressObservedAt;
  if (story.route.progressSource !== "last_known" || at == null) return null;
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  return `Last known progress · ${minutes} min ago`;
}
