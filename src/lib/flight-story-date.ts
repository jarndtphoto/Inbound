import { departureDate, departureSeedUnix } from "./flight-identity.ts";
import type { FlightStory } from "./types.ts";

/** Date clocks are operational context, separate from scheduled-only orig*. */
export function operationalDepartureUnix(story: FlightStory): number | null {
  const posted = (value: number | null | undefined, kind: string | null | undefined) => ({
    scheduled: kind === "scheduled" ? value : null,
    estimated: kind !== "scheduled" && kind !== "actual" ? value : null,
    actual: kind === "actual" ? value : null,
  });
  const candidates = [departureSeedUnix(story.resume?.gateOut), departureSeedUnix(story.resume?.takeoff),
    departureSeedUnix(posted(story.times.pushUnix, story.times.pushKind)),
    departureSeedUnix(posted(story.times.takeoffUnix, story.times.takeoffKind))];
  return candidates.find(value => value != null && Number.isFinite(value)) ?? null;
}

export function storyLegDate(story: FlightStory, timeZone = "UTC"): string | null {
  const canonical = story.stateKey?.match(/^leg:v1:[A-Z0-9]+\|(\d{4}-\d{2}-\d{2})\|([A-Z0-9]{3,4})\|([A-Z0-9]{3,4})$/);
  const fallback = story.stateKey?.match(/^leg:unvalidated:[A-Z0-9]+\|([A-Z0-9]{3,4})\|([A-Z0-9]{3,4})\|(\d{4}-\d{2}-\d{2})$/);
  const origin = story.origin?.iata || story.origin?.icao, dest = story.dest?.iata || story.dest?.icao;
  const canonicalDate = canonical && canonical[2] === origin && canonical[3] === dest ? canonical[1] : null;
  const utcDate = fallback && fallback[1] === origin && fallback[2] === dest ? fallback[3] : null;
  // Canonical dates are origin-local. Unvalidated keys are UTC; convert a
  // known operational clock for airline/baggage dates before using that key.
  if (canonicalDate) return canonicalDate;
  if (utcDate && timeZone === "UTC") return utcDate;
  const unix = operationalDepartureUnix(story);
  return (unix != null ? departureDate(unix, timeZone) : null) ?? story.schedule?.serviceDate ?? utcDate ?? null;
}
