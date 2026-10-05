import { getAirportSurfaceCached } from "./airport-surface";

// One React Query identity for ground and route maps, over the existing browser/server caches.
export function airportSurfaceQueryOptions(airport: { icao: string; lat: number; lon: number }) {
  const input = { airport: airport.icao, lat: airport.lat, lon: airport.lon };
  return {
    queryKey: ["airport-surface-v7", airport.icao, airport.lat.toFixed(3), airport.lon.toFixed(3)] as const,
    queryFn: () => getAirportSurfaceCached(input),
    staleTime: 12 * 60 * 60_000,
    gcTime: 12 * 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
}
