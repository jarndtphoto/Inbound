import { loadAeroApiFlight, aeroApiConfigured } from "./flightaware-aeroapi.server.ts";
import { loadFr24Flight, fr24Configured } from "./fr24.server.ts";
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

export async function loadOfficialFlightData(ident: string) {
  const [fa, fr] = await Promise.all([
    probe(aeroApiConfigured(), () => loadAeroApiFlight(ident)),
    probe(fr24Configured(), () => loadFr24Flight(ident)),
  ]);
  return {
    flightaware: fa.flight,
    fr24: fr.flight,
    configured: { flightaware: aeroApiConfigured(), fr24: fr24Configured() },
    status: { flightaware: fa.state, fr24: fr.state },
  };
}
