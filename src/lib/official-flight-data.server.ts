import { loadAeroApiFlight, aeroApiConfigured } from "./flightaware-aeroapi.server.ts";
import { loadFr24Flight, loadFr24FlightByRegistration, fr24Configured } from "./fr24.server.ts";
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

export async function loadOfficialFlightData(ident: string) {
  const fa = await probe(aeroApiConfigured(), () => loadAeroApiFlight(ident));
  let fr = await probe(fr24Configured(), () => loadFr24Flight(ident));

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
      if (registrationFr.flight) {
        console.info(JSON.stringify({
          event: "fr24_registration_match",
          requested: ident,
          registration,
          flightId: fa.flight.flightId,
        }));
        fr = registrationFr;
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
