import { flightDepartureDate } from "./airline-status.ts";
import { parseFlightQuery, storyMatchesQuery } from "./flight-parse.ts";
import type { FlightStory } from "./types.ts";

export const FLIGHT_TABS = ["Overview", "Route", "Weather", "Briefing"] as const;
export type FlightTab = typeof FLIGHT_TABS[number];

const TAB_SLUG: Record<FlightTab, string> = {
  Overview: "overview",
  Route: "map",
  Weather: "weather",
  Briefing: "briefing",
};
const SLUG_TAB = Object.fromEntries(Object.entries(TAB_SLUG).map(([tab, slug]) => [slug, tab])) as Record<string, FlightTab>;

export type FlightLocation =
  | { kind: "landing" }
  | { kind: "invalid"; flight: string; reason: "invalid_flight" | "invalid_date" }
  | { kind: "flight"; flight: string; tab: FlightTab; date: string | null };

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

export function parseFlightLocation(href: string): FlightLocation {
  const url = new URL(href, "https://inbound.invalid/");
  const raw = url.searchParams.get("flight");
  if (raw == null) return { kind: "landing" };
  const flight = raw.trim().toUpperCase();
  const parsed = parseFlightQuery(flight);
  if (!parsed) return { kind: "invalid", flight, reason: "invalid_flight" };
  const rawDate = url.searchParams.get("date");
  if (rawDate != null && !validDate(rawDate)) return { kind: "invalid", flight, reason: "invalid_date" };
  return {
    kind: "flight",
    flight: parsed.iata ?? parsed.callsign,
    tab: SLUG_TAB[url.searchParams.get("tab")?.toLowerCase() ?? ""] ?? "Overview",
    date: rawDate,
  };
}

export function flightHref(flight: string, tab: FlightTab = "Overview", date?: string | null): string {
  const parsed = parseFlightQuery(flight);
  if (!parsed) return "/";
  const params = new URLSearchParams({ flight: parsed.iata ?? parsed.callsign, tab: TAB_SLUG[tab] });
  if (date && validDate(date)) params.set("date", date);
  return `/?${params.toString()}`;
}

export function storyMatchesFlightLink(story: FlightStory, flight: string, date?: string | null): boolean {
  return storyMatchesQuery(story, flight) && (!date || flightDepartureDate(story) === date);
}
