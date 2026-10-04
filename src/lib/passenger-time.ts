import { formatAirportEventTime } from "./flight-event-time.ts";

export function destinationGateTime(
  gateUnix: number | null | undefined,
  gateText: string | null | undefined,
  timeZone?: string,
  departureDate?: string | null,
): string {
  if (gateUnix != null && Number.isFinite(gateUnix)) {
    const formatted = formatAirportEventTime(gateUnix, timeZone, departureDate);
    if (formatted) return formatted;
  }
  return gateText || "Awaiting update";
}
