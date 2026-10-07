/** Bump only these identities when refreshing the targeted static geometry pack. */
export function airportSurfaceCacheVersion(airport: string) {
  return /^(KORD|ORD|KMDW|MDW)$/.test(airport.toUpperCase())
    ? "airport-surface-chicago-2026-10-07-v1"
    : "airport-surface-v7";
}
