import { loadAeroApiFlight, aeroApiConfigured } from "./flightaware-aeroapi.server.ts";
import { loadFr24Flight, fr24Configured } from "./fr24.server.ts";
import type { NormalizedFlight } from "./flight-data.ts";

export async function loadOfficialFlightData(ident: string): Promise<{ flightaware: NormalizedFlight | null; fr24: NormalizedFlight | null; configured: { flightaware: boolean; fr24: boolean } }> {
  const [flightaware, fr24] = await Promise.all([
    loadAeroApiFlight(ident).catch(() => null),
    loadFr24Flight(ident).catch(() => null),
  ]);
  return { flightaware, fr24, configured: { flightaware: aeroApiConfigured(), fr24: fr24Configured() } };
}
