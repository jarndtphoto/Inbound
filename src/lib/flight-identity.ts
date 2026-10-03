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
  // The server already resolves provider airports beyond the small local list.
  return byIata ?? byIcao ?? (/^[A-Z]{3}$/.test(iata) ? { iata, icao, tz: field.tz } : null);
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
  if ((origin.icao && reportedOrigin.icao && origin.icao !== reportedOrigin.icao)
    || (destination.icao && reportedDest.icao && destination.icao !== reportedDest.icao)) return null;
  const scheduled = positive(schedule.gateOut?.scheduled) ? schedule.gateOut.scheduled : schedule.takeoff?.scheduled;
  if (!positive(scheduled)) return null;
  const date = departureDate(scheduled, origin.tz ?? context.origin.tz ?? schedule.originTz ?? "");
  const serviceDate = schedule.serviceDate ?? schedule._publicScheduleDate;
  if (!date || (serviceDate != null && serviceDate !== date)) return null;
  const ident = operatingIdent(schedule.operatingIdent) ?? operatingIdent(schedule.ident)
    ?? operatingIdent(schedule.iataIdent) ?? operatingIdent(context.requested);
  return ident ? `leg:v1:${ident}|${date}|${origin.iata}|${destination.iata}` : null;
}

/** Exact old forms for this validated schedule. Do not probe neighboring days
 * from delayed actual/estimated clocks or accept resume-scoped device keys. */
export function legacyLegKeys(schedule: LegSchedule | null, context: LegContext): string[] {
  const key = canonicalLegKey(schedule, context);
  if (!key || !schedule) return [];
  const [ident, date, origin, dest] = key.slice("leg:v1:".length).split("|");
  const scheduled = positive(schedule.gateOut?.scheduled) ? schedule.gateOut.scheduled : schedule.takeoff!.scheduled!;
  const utcDate = new Date(scheduled * 1000).toISOString().slice(0, 10);
  const idents = [...new Set([schedule.ident, schedule.iataIdent, ident, context.requested].map(clean).filter(v => /^[A-Z0-9]{3,8}$/.test(v)))];
  const keys = idents.map(id => `${id}|${origin}|${dest}|${utcDate}`);
  const providerId = typeof schedule.flightId === "string" ? schedule.flightId.trim() : "";
  const datedId = providerId.match(/^([A-Z0-9]+)-(\d{10})(?:-|$)/);
  const validDate = !datedId || (operatingIdent(datedId[1]) === ident
    && departureDate(Number(datedId[2]), airport(context.origin)!.tz ?? context.origin.tz ?? schedule.originTz ?? "") === date);
  if (providerId && providerId.length <= 200 && !/[|\x00-\x1f]/.test(providerId) && validDate)
    keys.unshift(`${providerId}|${origin}|${dest}`);
  return keys;
}

export function legacyProviderPattern(key: string): string {
  const [ident, , origin, dest] = key.slice("leg:v1:".length).split("|");
  return `${ident}-%|${origin}|${dest}`;
}
/** Only dated FlightAware IDs can be discovered without the current ID.
 * Opaque IDs require the exact ID on the validated provider record. */
export function legacyProviderBelongsToLeg(legacy: string, key: string): boolean {
  const [ident, date, origin, dest] = key.slice("leg:v1:".length).split("|");
  const [id, from, to, extra] = legacy.split("|");
  const match = id.match(/^([A-Z0-9]+)-(\d{10})(?:-|$)/);
  const tz = airportByIata(origin)?.tz;
  return !!match && !!tz && extra == null && from === origin && to === dest
    && operatingIdent(match[1]) === ident && departureDate(Number(match[2]), tz) === date;
}
