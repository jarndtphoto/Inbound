import { airportByIata, airportByIcao } from "./airports.ts";
import { parseFlightQuery } from "./flight-parse.ts";

type Airport = { iata?: string | null; icao?: string | null; tz?: string | null };
export type LegSchedule = {
  ident?: string | null; iataIdent?: string | null; operatingIdent?: string | null;
  flightId?: string | null;
  originIata?: string | null; originIcao?: string | null;
  destIata?: string | null; destIcao?: string | null; originTz?: string | null;
  gateOut?: { scheduled?: number | null }; takeoff?: { scheduled?: number | null };
  serviceDate?: string | null; _publicScheduleDate?: string | null;
};
export type LegContext = { requested: string; origin: Airport; destination: Airport };
const clean = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : "";
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function airport(field: Airport) {
  const iata = clean(field.iata), icao = clean(field.icao);
  const byIata = airportByIata(iata), byIcao = airportByIcao(icao);
  if (byIata && icao && byIata.icao !== icao) return null;
  if (byIcao && iata && byIcao.iata !== iata) return null;
  return byIata ?? byIcao;
}
function operatingIdent(value: unknown): string | null {
  const parsed = parseFlightQuery(clean(value));
  return parsed && !parsed.registration ? parsed.callsign.replace(/^(\D+)0+(\d)/, "$1$2") : null;
}
export function departureDate(unix: number, timeZone: string): string | null {
  if (!positive(unix)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(unix * 1000));
    const part = (name: string) => parts.find(p => p.type === name)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch { return null; }
}

/** Provider IDs and actual/estimated clocks never choose a durable leg key.
 * Require a scheduled departure and a matching service date/route. */
export function canonicalLegKey(schedule: LegSchedule | null, context: LegContext): string | null {
  if (!schedule) return null;
  const origin = airport(context.origin), destination = airport(context.destination);
  const reportedOrigin = airport({ iata: schedule.originIata, icao: schedule.originIcao });
  const reportedDest = airport({ iata: schedule.destIata, icao: schedule.destIcao });
  if (!origin?.iata || !destination?.iata || origin.iata === destination.iata
    || reportedOrigin?.iata !== origin.iata || reportedDest?.iata !== destination.iata) return null;
  const scheduled = positive(schedule.gateOut?.scheduled) ? schedule.gateOut.scheduled : schedule.takeoff?.scheduled;
  if (!positive(scheduled)) return null;
  const date = departureDate(scheduled, origin.tz ?? context.origin.tz ?? schedule.originTz ?? "");
  const serviceDate = schedule.serviceDate ?? schedule._publicScheduleDate;
  if (!date || (serviceDate != null && serviceDate !== date)) return null;
  const ident = operatingIdent(schedule.operatingIdent) ?? operatingIdent(schedule.ident)
    ?? operatingIdent(schedule.iataIdent) ?? operatingIdent(context.requested);
  return ident ? `leg:v1:${ident}|${date}|${origin.iata}|${destination.iata}` : null;
}
