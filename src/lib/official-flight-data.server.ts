import { loadAeroApiFlight, aeroApiConfigured } from "./flightaware-aeroapi.server.ts";
import { loadFr24Flight, loadFr24FlightByNumber, loadFr24FlightByNumberAndRoute, loadFr24FlightByRegistration, fr24Configured } from "./fr24.server.ts";
import type { NormalizedFlight, ProviderState } from "./flight-data.ts";

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
  },
) {
  const fa = await probe(aeroApiConfigured(), () => loadAeroApiFlight(ident));
  const preferredFlightNumber = options?.fr24FlightNumber?.replace(/\s/g, "").trim().toUpperCase() || null;
  const routeOrigin = options?.fr24OriginIata?.trim().toUpperCase() || null;
  const routeDestination = options?.fr24DestIata?.trim().toUpperCase() || null;
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

  return {
    flightaware: fa.flight,
    fr24: fr.flight,
    configured: { flightaware: aeroApiConfigured(), fr24: fr24Configured() },
    status: { flightaware: fa.state, fr24: fr.state },
  };
}
