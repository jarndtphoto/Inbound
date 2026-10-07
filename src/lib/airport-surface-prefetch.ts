import type { QueryClient } from "@tanstack/react-query";
import { airportSurfaceQueryOptions } from "./airport-surface-query";
import type { FlightStory } from "./types";

type SurfacePrefetchClient = Pick<QueryClient, "prefetchQuery">;
type SurfaceAirport = Pick<FlightStory["origin"], "icao" | "lat" | "lon">;

export function airportSurfacePrefetchIdentity(airport: SurfaceAirport) {
  return `${airport.icao.toUpperCase()}:${airport.lat.toFixed(3)}:${airport.lon.toFixed(3)}`;
}

export function flightSurfacePrefetchAirports(story: FlightStory): SurfaceAirport[] {
  const unique = new Map<string, SurfaceAirport>();
  for (const airport of [story.origin, story.dest]) {
    const key = airportSurfacePrefetchIdentity(airport);
    if (!unique.has(key)) unique.set(key, airport);
  }
  return [...unique.values()];
}

/** Warm the exact same React Query/browser/server surface cache used by the maps.
 * The caller owns the Set for one flight-open lifetime. Adding the identity
 * before starting the request guarantees story polls cannot start another
 * prefetch for the same airport. */
export async function prefetchFlightAirportSurfacesOnce(
  client: SurfacePrefetchClient,
  story: FlightStory,
  prefetched: Set<string>,
) {
  const results: PromiseSettledResult<unknown>[] = [];
  // Warm the departure airport first. Running origin + destination Overpass
  // requests in parallel made cold ground maps compete with their own
  // low-priority destination prefetch.
  for (const airport of flightSurfacePrefetchAirports(story)) {
    const identity = airportSurfacePrefetchIdentity(airport);
    if (prefetched.has(identity)) continue;
    prefetched.add(identity);
    try {
      results.push({ status: "fulfilled", value: await client.prefetchQuery(airportSurfaceQueryOptions(airport)) });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export function scheduleLowPrioritySurfacePrefetch(work: () => void) {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const id = idleWindow.requestIdleCallback(work, { timeout: 750 });
    return () => idleWindow.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(work, 100);
  return () => window.clearTimeout(id);
}
