import { loadAeroApiFlight, aeroApiConfigured } from "./flightaware-aeroapi.server.ts";
import { createFr24Cycle, loadFr24Flight, loadFr24FlightByNumber, loadFr24FlightByNumberAndRoute, loadFr24FlightByRegistration, fr24Configured } from "./fr24.server.ts";
import { fr24UsageToday } from "./fr24-budget.server.ts";
export { setFr24GuardForTests } from "./fr24-budget.server.ts";
import type { NormalizedFlight, ProviderState } from "./flight-data.ts";

type MatchedLookup = { kind: "route" | "number" | "callsign" | "registration"; value: string; flightId: string | null; at: number };
// A warm-instance hint, never a position cache. Scope by day and complete leg
// identity, expire promptly, and cap storage. Shared response caching is separate.
const matchedLookups = new Map<string, MatchedLookup>();
const MATCHED_LOOKUP_TTL_MS = 15 * 60_000;
function rememberLookup(key: string, kind: MatchedLookup["kind"], value: string, flight: NormalizedFlight) {
  matchedLookups.delete(key);
  matchedLookups.set(key, { kind, value, flightId: flight.flightId, at: Date.now() });
  if (matchedLookups.size > 500) matchedLookups.delete(matchedLookups.keys().next().value!);
}

function stateFor(error: unknown): ProviderState {
  const message = error instanceof Error ? error.message : String(error);
  if (/FR24_BUDGET_EXHAUSTED/.test(message)) return "BUDGET_EXHAUSTED";
  if (/\b(401|403)\b/.test(message)) return "AUTH_FAILED";
  if (/\b429\b/.test(message)) return "RATE_LIMITED";
  return "ERROR";
}

async function probe(configured: boolean, load: () => Promise<NormalizedFlight | null>) {
  if (!configured) return { flight: null, state: "DISABLED" as ProviderState };
  try {
    const flight = await load();
    return { flight, state: flight ? "ACTIVE" as ProviderState : "NO_MATCH" as ProviderState };
  } catch (error) {
    return { flight: null, state: stateFor(error) };
  }
}

function operatingIdentFromFlightAware(flight: NormalizedFlight | null): string | null {
  const id = flight?.flightId?.toUpperCase() ?? "";
  const match = id.match(/^([A-Z]{3}\d{1,4}[A-Z]?)-/);
  return match?.[1] ?? null;
}

function sameAirport(a?: { iata?: string | null; icao?: string | null } | null, b?: { iata?: string | null; icao?: string | null } | null) {
  if (!a || !b) return false;
  const aiata = a.iata?.trim().toUpperCase() ?? "";
  const biata = b.iata?.trim().toUpperCase() ?? "";
  if (aiata && biata) return aiata === biata;
  const aicao = a.icao?.trim().toUpperCase() ?? "";
  const bicao = b.icao?.trim().toUpperCase() ?? "";
  return Boolean(aicao && bicao && aicao === bicao);
}

function registrationCandidateMatchesLeg(candidate: NormalizedFlight, authoritative: NormalizedFlight) {
  const operating = operatingIdentFromFlightAware(authoritative);
  const candidateCallsign = candidate.callsign?.trim().toUpperCase() ?? "";
  if (operating && candidateCallsign === operating) return true;
  return sameAirport(candidate.origin, authoritative.origin) && sameAirport(candidate.destination, authoritative.destination);
}

export async function loadOfficialFlightData(
  ident: string,
  options?: {
    fr24FlightNumber?: string | null;
    fr24Bounds?: string | null;
    fr24OriginIata?: string | null;
    fr24DestIata?: string | null;
    fr24Registration?: string | null;
    fr24OperatingCallsign?: string | null;
    // A schedule-only route may be wrong for a reused flight number. A fresh
    // FR24 route is allowed to correct it; a route already confirmed by live
    // aircraft evidence remains a hard lookup boundary.
    fr24AllowRouteOverride?: boolean;
    // Surface departures must stay within the Explorer plan's 10-query/minute
    // throttle. In this mode FR24 gets exactly one live identity probe: known
    // registration first, otherwise the operating/transponder callsign.
    fr24SurfaceDeparture?: boolean;
    // Gate-in/completed stories continue on free ADS-B and saved evidence.
    fr24Allowed?: boolean;
  },
) {
  const fa = await probe(aeroApiConfigured(), () => loadAeroApiFlight(ident));
  const preferredFlightNumber = options?.fr24FlightNumber?.replace(/\s/g, "").trim().toUpperCase() || null;
  const fr24Cycle = createFr24Cycle(preferredFlightNumber ?? ident);
  const frConfigured = options?.fr24Allowed !== false && fr24Configured();
  const routeOrigin = options?.fr24OriginIata?.trim().toUpperCase() || null;
  const routeDestination = options?.fr24DestIata?.trim().toUpperCase() || null;
  const lookupKey = JSON.stringify([new Date(Date.now()).toISOString().slice(0, 10), ident.toUpperCase(), preferredFlightNumber,
    routeOrigin, routeDestination, options?.fr24Registration?.trim().toUpperCase(), options?.fr24Bounds, options?.fr24OperatingCallsign?.trim().toUpperCase(),
    Boolean(options?.fr24SurfaceDeparture), Boolean(options?.fr24AllowRouteOverride)]);
  const remembered = matchedLookups.get(lookupKey);
  if (remembered && Date.now() - remembered.at < MATCHED_LOOKUP_TTL_MS) {
    const recalled = await probe(frConfigured, () => {
      if (remembered.kind === "route") return loadFr24FlightByNumberAndRoute(remembered.value, routeOrigin!, routeDestination!, fr24Cycle);
      if (remembered.kind === "number") return loadFr24FlightByNumber(remembered.value, options?.fr24Bounds ?? undefined, undefined, fr24Cycle);
      if (remembered.kind === "registration") return loadFr24FlightByRegistration(remembered.value, undefined, fr24Cycle);
      return loadFr24Flight(remembered.value, undefined, fr24Cycle);
    });
    const flight = recalled.flight;
    const sameLeg = flight && (!routeOrigin || flight.origin?.iata?.toUpperCase() === routeOrigin)
      && (!routeDestination || flight.destination?.iata?.toUpperCase() === routeDestination)
      && (!fa.flight || registrationCandidateMatchesLeg(flight, fa.flight))
      && (!remembered.flightId || flight.flightId === remembered.flightId);
    const age = flight?.position?.seenAt != null ? Date.now() / 1000 - flight.position.seenAt : Infinity;
    if (sameLeg && age >= -30 && age <= 12) {
      rememberLookup(lookupKey, remembered.kind, remembered.value, flight);
      return { flightaware: fa.flight, fr24: flight,
        configured: { flightaware: aeroApiConfigured(), fr24: frConfigured },
        status: { flightaware: fa.state, fr24: recalled.state },
        fr24Usage: await fr24UsageToday().catch(() => null) };
    }
  }
  matchedLookups.delete(lookupKey);
  const publicRegistration = options?.fr24Registration?.trim().toUpperCase() || null;
  const publicOperating = options?.fr24OperatingCallsign?.trim().toUpperCase() || null;
  const surfaceDeparture = Boolean(options?.fr24SurfaceDeparture);
  const allowRouteOverride = Boolean(options?.fr24AllowRouteOverride);

  let matchedKind: MatchedLookup["kind"];
  let matchedValue: string;
  let fr: { flight: NormalizedFlight | null; state: ProviderState };

  if (surfaceDeparture) {
    matchedKind = publicRegistration ? "registration" : "callsign";
    matchedValue = publicRegistration ?? publicOperating ?? ident.toUpperCase();
    fr = await probe(frConfigured, () => publicRegistration
      ? loadFr24FlightByRegistration(publicRegistration, undefined, fr24Cycle)
      : loadFr24Flight(matchedValue, undefined, fr24Cycle));

    const candidate = fr.flight;
    const routeMatches = Boolean(candidate
      && (!routeOrigin || candidate.origin?.iata?.trim().toUpperCase() === routeOrigin)
      && (!routeDestination || candidate.destination?.iata?.trim().toUpperCase() === routeDestination));
    const candidateAge = candidate?.position?.seenAt != null ? Math.max(0, Date.now() / 1000 - candidate.position.seenAt) : Infinity;
    if (candidate && !routeMatches && !(allowRouteOverride && candidateAge <= 60)) {
      console.warn(JSON.stringify({
        event: "fr24_surface_wrong_leg_rejected",
        requested: ident,
        lookupKind: matchedKind,
        lookupValue: matchedValue,
        routeOrigin,
        routeDestination,
        candidateOrigin: candidate.origin?.iata ?? candidate.origin?.icao ?? null,
        candidateDestination: candidate.destination?.iata ?? candidate.destination?.icao ?? null,
      }));
      fr = { flight: null, state: "NO_MATCH" };
    } else if (candidate && !routeMatches) {
      console.warn(JSON.stringify({
        event: "fr24_live_route_override",
        requested: ident,
        routeOrigin,
        routeDestination,
        candidateOrigin: candidate.origin?.iata ?? candidate.origin?.icao ?? null,
        candidateDestination: candidate.destination?.iata ?? candidate.destination?.icao ?? null,
        positionAgeSec: Math.round(candidateAge),
      }));
    }
  } else {
    // Pick one strongest identity for this cycle. A known tail number is more
    // selective than a reused flight number; otherwise prefer the operating
    // callsign, then the scheduled route/number, then the displayed callsign.
    // There is deliberately no paid fallback cascade here.
    const authoritativeRegistration = fa.flight?.registration?.trim().toUpperCase() || null;
    const lookupRegistration = publicRegistration ?? authoritativeRegistration;
    const operating = publicOperating ?? operatingIdentFromFlightAware(fa.flight);
    if (lookupRegistration) {
      matchedKind = "registration";
      matchedValue = lookupRegistration;
      fr = await probe(frConfigured, () => loadFr24FlightByRegistration(lookupRegistration, undefined, fr24Cycle));
    } else if (operating) {
      matchedKind = "callsign";
      matchedValue = operating;
      fr = await probe(frConfigured, () => loadFr24Flight(operating, undefined, fr24Cycle));
    } else if (preferredFlightNumber && routeOrigin && routeDestination) {
      matchedKind = "route";
      matchedValue = preferredFlightNumber;
      fr = await probe(frConfigured, () => loadFr24FlightByNumberAndRoute(preferredFlightNumber, routeOrigin, routeDestination, fr24Cycle));
    } else if (preferredFlightNumber) {
      matchedKind = "number";
      matchedValue = preferredFlightNumber;
      fr = await probe(frConfigured, () => loadFr24FlightByNumber(preferredFlightNumber, options?.fr24Bounds ?? undefined, undefined, fr24Cycle));
    } else {
      matchedKind = "callsign";
      matchedValue = ident.toUpperCase();
      fr = await probe(frConfigured, () => loadFr24Flight(matchedValue, undefined, fr24Cycle));
    }

    const candidate = fr.flight;
    const routeMatches = Boolean(candidate
      && (!routeOrigin || candidate.origin?.iata?.trim().toUpperCase() === routeOrigin)
      && (!routeDestination || candidate.destination?.iata?.trim().toUpperCase() === routeDestination));
    const authoritativeMatches = Boolean(candidate
      && (!fa.flight || matchedKind !== "registration" || registrationCandidateMatchesLeg(candidate, fa.flight)));
    const candidateAge = candidate?.position?.seenAt != null ? Math.max(0, Date.now() / 1000 - candidate.position.seenAt) : Infinity;
    if (candidate && (!routeMatches || !authoritativeMatches)
      && !(allowRouteOverride && !fa.flight && candidateAge <= 60)) {
      console.warn(JSON.stringify({
        event: "fr24_single_lookup_wrong_leg_rejected",
        requested: ident,
        lookupKind: matchedKind,
        lookupValue: matchedValue,
        routeOrigin,
        routeDestination,
        candidateOrigin: candidate.origin?.iata ?? candidate.origin?.icao ?? null,
        candidateDestination: candidate.destination?.iata ?? candidate.destination?.icao ?? null,
      }));
      fr = { flight: null, state: "NO_MATCH" };
    } else if (candidate && !routeMatches) {
      console.warn(JSON.stringify({
        event: "fr24_live_route_override",
        requested: ident,
        routeOrigin,
        routeDestination,
        candidateOrigin: candidate.origin?.iata ?? candidate.origin?.icao ?? null,
        candidateDestination: candidate.destination?.iata ?? candidate.destination?.icao ?? null,
        positionAgeSec: Math.round(candidateAge),
      }));
    }
  }

  if (fr.flight) rememberLookup(lookupKey, matchedKind, matchedValue, fr.flight);

  return {
    flightaware: fa.flight,
    fr24: fr.flight,
    configured: { flightaware: aeroApiConfigured(), fr24: frConfigured },
    status: { flightaware: fa.state, fr24: fr.state },
    fr24Usage: await fr24UsageToday().catch(() => null),
  };
}
