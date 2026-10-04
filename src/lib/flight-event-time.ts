import { storyLegDate } from "./flight-story-date.ts";
import { formatClockTime } from "./presentation-time.ts";
import type { FlightStory } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function airportTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function dateStamp(value: string | null | undefined): number | null {
  const match = value?.match(ISO_DATE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(stamp);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? stamp
    : null;
}

/** Calendar date at an airport for a Unix timestamp in seconds. */
export function airportLocalDate(unix: number | null | undefined, timeZone: string | null | undefined): string | null {
  if (unix == null || !Number.isFinite(unix)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: airportTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(unix * 1000);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/** Positive local-calendar offset from the leg's origin-local departure date. */
export function flightEventDayOffset(
  unix: number | null | undefined,
  timeZone: string | null | undefined,
  departureDate: string | null | undefined,
): number {
  const eventStamp = dateStamp(airportLocalDate(unix, timeZone));
  const departureStamp = dateStamp(departureDate);
  if (eventStamp == null || departureStamp == null) return 0;
  return Math.max(0, Math.round((eventStamp - departureStamp) / DAY_MS));
}

/** Airport-local passenger clock, including a +N marker after the departure date. */
export function formatAirportEventTime(
  unix: number | null | undefined,
  timeZone: string | null | undefined,
  departureDate: string | null | undefined,
): string | null {
  if (unix == null || !Number.isFinite(unix)) return null;
  const zone = airportTimeZone(timeZone);
  const clock = formatClockTime(unix * 1000, zone);
  const offset = flightEventDayOffset(unix, zone, departureDate);
  return `${clock}${offset > 0 ? ` +${offset}` : ""}`;
}

/** Uses the canonical origin-local service date when formatting a story event. */
export function formatStoryEventTime(
  story: FlightStory,
  unix: number | null | undefined,
  airportZone: string | null | undefined,
): string | null {
  const departureDate = storyLegDate(story, story.origin.tz || "UTC");
  return formatAirportEventTime(unix, airportZone, departureDate);
}
