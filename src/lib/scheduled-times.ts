import type { FlightStory } from "./types";

export type ScheduledTimes = { pushUnix: number | null; takeoffUnix: number | null; landUnix: number | null };
const unix = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null;

/** Presentation memory contains schedules only, never a first-seen estimate/actual.
 * Resume stamps preserve explicit provider kinds. When present they disambiguate
 * older server orig* fields, which can also contain an unscheduled seed.
 */
export function scheduledTimes(story: FlightStory, previous?: ScheduledTimes): ScheduledTimes {
  const t = story.times;
  const seed = (stamp: { scheduled: number | null } | undefined,
    original: number | null | undefined, posted: number | null | undefined, kind: string | null | undefined) =>
    stamp ? unix(stamp.scheduled) : kind === "scheduled" ? unix(original) ?? unix(posted)
      : story.schedule ? null : unix(original);
  const remember = (old: number | null | undefined, next: number | null) => {
    const prior = unix(old);
    if (prior == null || next == null) return next ?? prior;
    return Math.abs(prior - next) > 8 * 3600 ? next : Math.min(prior, next);
  };
  return {
    pushUnix: remember(previous?.pushUnix, seed(story.resume?.gateOut, t.origPushUnix, t.pushUnix, t.pushKind)),
    takeoffUnix: remember(previous?.takeoffUnix, seed(story.resume?.takeoff, t.origTakeoffUnix, t.takeoffUnix, t.takeoffKind)),
    landUnix: remember(previous?.landUnix, seed(story.resume?.landing, t.origLandUnix, t.landUnix, t.landKind)),
  };
}
