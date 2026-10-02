import { loadAeroApiFlight, aeroApiConfigured } from "./flightaware-aeroapi.server.ts";
import { loadFr24Flight, loadFr24FlightByNumber, loadFr24FlightByNumberAndRoute, loadFr24FlightByRegistration, fr24Configured } from "./fr24.server.ts";
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
  },
) {
  const fa = await probe(aeroApiConfigured(), () => loadAeroApiFlight(ident));
  const preferredFlightNumber = options?.fr24FlightNumber?.replace(/\s/g, "").trim().toUpperCase() || null;
  const routeOrigin = options?.fr24OriginIata?.trim().toUpperCase() || null;
  const routeDestination = options?.fr24DestIata?.trim().toUpperCase() || null;
  const lookupKey = JSON.stringify([new Date().toISOString().slice(0, 10), ident.toUpperCase(), preferredFlightNumber,
    routeOrigin, routeDestination, options?.fr24Registration?.trim().toUpperCase(), options?.fr24Bounds, options?.fr24OperatingCallsign?.trim().toUpperCase()]);
  const remembered = matchedLookups.get(lookupKey);
  if (remembered && Date.now() - remembered.at < MATCHED_LOOKUP_TTL_MS) {
    const recalled = await probe(fr24Configured(), () => {
      if (remembered.kind === "route") return loadFr24FlightByNumberAndRoute(remembered.value, routeOrigin!, routeDestination!);
      if (remembered.kind === "number") return loadFr24FlightByNumber(remembered.value, options?.fr24Bounds ?? undefined);
      if (remembered.kind === "registration") return loadFr24FlightByRegistration(remembered.value);
      return loadFr24Flight(remembered.value);
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
        configured: { flightaware: aeroApiConfigured(), fr24: fr24Configured() },
        status: { flightaware: fa.state, fr24: recalled.state } };
    }
  }
  matchedLookups.delete(lookupKey);
  let matchedKind: MatchedLookup["kind"] = preferredFlightNumber ? routeOrigin && routeDestination ? "route" : "number" : "callsign";
  let matchedValue = preferredFlightNumber ?? ident;
  let fr = await probe(fr24Configured(), () =>
    preferredFlightNumber && routeOrigin && routeDestination
      ? loadFr24FlightByNumberAndRoute(preferredFlightNumber, routeOrigin, routeDestination)
      : preferredFlightNumber
        ? loadFr24FlightByNumber(preferredFlightNumber, options?.fr24Bounds ?? undefined)
        : loadFr24Flight(ident)
  );
  if (fr.flight && preferredFlightNumber) {
    console.info(JSON.stringify({
      event: "fr24_flight_number_match",
      requested: ident,
      flightNumber: preferredFlightNumber,
      flightId: fr.flight.flightId ?? null,
      callsign: fr.flight.callsign ?? null,
    }));
  }

  if (fr.state === "NO_MATCH" && preferredFlightNumber && !(routeOrigin && routeDestination)) {
    fr = await probe(fr24Configured(), () => loadFr24Flight(ident));
    matchedKind = "callsign";
    matchedValue = ident;
  }

  const publicRegistration = options?.fr24Registration?.trim().toUpperCase() || null;
  const currentAge = fr.flight?.position?.seenAt != null ? Math.max(0, Date.now() / 1000 - fr.flight.position.seenAt) : Number.POSITIVE_INFINITY;
  if ((fr.state === "NO_MATCH" || (fr.state === "ACTIVE" && currentAge > 12)) && publicRegistration) {
    const registrationFr = await probe(fr24Configured(), () => loadFr24FlightByRegistration(publicRegistration));
    const candidate = registrationFr.flight;
    const candidateAge = candidate?.position?.seenAt != null ? Math.max(0, Date.now() / 1000 - candidate.position.seenAt) : Number.POSITIVE_INFINITY;
    const routeMatches = Boolean(
      candidate &&
      (!routeOrigin || candidate.origin?.iata?.trim().toUpperCase() === routeOrigin) &&
      (!routeDestination || candidate.destination?.iata?.trim().toUpperCase() === routeDestination)
    );
    if (candidate && routeMatches && candidateAge < currentAge) {
      console.info(JSON.stringify({
        event: "fr24_public_registration_fresher",
        requested: ident,
        registration: publicRegistration,
        routeOrigin,
        routeDestination,
        previousAgeSec: Number.isFinite(currentAge) ? Math.round(currentAge) : null,
        candidateAgeSec: Number.isFinite(candidateAge) ? Math.round(candidateAge) : null,
      }));
      fr = registrationFr;
      matchedKind = "registration";
      matchedValue = publicRegistration;
    } else if (candidate && !routeMatches) {
      console.warn(JSON.stringify({
        event: "fr24_public_registration_wrong_leg_rejected",
        requested: ident,
        registration: publicRegistration,
        routeOrigin,
        routeDestination,
        candidateOrigin: candidate.origin?.iata ?? candidate.origin?.icao ?? null,
        candidateDestination: candidate.destination?.iata ?? candidate.destination?.icao ?? null,
      }));
    }
  }

  const publicOperating = options?.fr24OperatingCallsign?.trim().toUpperCase();
  if (fr.state === "NO_MATCH" && publicOperating && publicOperating !== ident.toUpperCase()) {
    const operatingFr = await probe(fr24Configured(), () => loadFr24Flight(publicOperating));
    if (operatingFr.flight) {
      fr = operatingFr;
      matchedKind = "callsign";
      matchedValue = publicOperating;
      console.info(JSON.stringify({ event: "fr24_public_operating_callsign_match", requested: ident, operating: publicOperating }));
    }
  }

  if (fr.state === "NO_MATCH" && fa.flight) {
    const operatingIdent = operatingIdentFromFlightAware(fa.flight);
    if (operatingIdent && operatingIdent !== ident.toUpperCase()) {
      const operatingFr = await probe(fr24Configured(), () => loadFr24Flight(operatingIdent));
      if (operatingFr.flight) {
        console.info(JSON.stringify({
          event: "fr24_operating_callsign_match",
          requested: ident,
          operating: operatingIdent,
          flightId: fa.flight.flightId,
        }));
        fr = operatingFr;
        matchedKind = "callsign";
        matchedValue = operatingIdent;
      }
    }
  }

  if (fr.state === "NO_MATCH" && fa.flight?.registration) {
    const registration = fa.flight.registration.trim().toUpperCase();
    if (registration) {
      const registrationFr = await probe(fr24Configured(), () => loadFr24FlightByRegistration(registration));
      if (registrationFr.flight && registrationCandidateMatchesLeg(registrationFr.flight, fa.flight)) {
        console.info(JSON.stringify({
          event: "fr24_registration_match",
          requested: ident,
          registration,
          flightId: fa.flight.flightId,
        }));
        fr = registrationFr;
        matchedKind = "registration";
        matchedValue = registration;
      } else if (registrationFr.flight) {
        console.warn(JSON.stringify({
          event: "fr24_registration_wrong_leg_rejected",
          requested: ident,
          registration,
          requestedOrigin: fa.flight.origin?.iata ?? fa.flight.origin?.icao ?? null,
          requestedDestination: fa.flight.destination?.iata ?? fa.flight.destination?.icao ?? null,
          candidateOrigin: registrationFr.flight.origin?.iata ?? registrationFr.flight.origin?.icao ?? null,
          candidateDestination: registrationFr.flight.destination?.iata ?? registrationFr.flight.destination?.icao ?? null,
          candidateCallsign: registrationFr.flight.callsign ?? null,
        }));
      }
    }
  }

  if (fr.flight) rememberLookup(lookupKey, matchedKind, matchedValue, fr.flight);

  return {
    flightaware: fa.flight,
    fr24: fr.flight,
    configured: { flightaware: aeroApiConfigured(), fr24: fr24Configured() },
    status: { flightaware: fa.state, fr24: fr.state },
  };
}
