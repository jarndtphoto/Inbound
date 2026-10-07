import { airportSurfaceCacheVersion } from "./airport-surface-cache-version";

const AIRPORT_SURFACE_BROWSER_CACHE = "inbound-airport-surfaces-v7";
const AIRPORT_SURFACE_BROWSER_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function browserSurfaceKey(input: { airport: string; lat: number; lon: number }) {
  return `https://inbound.local/airport-surface/${input.airport.toUpperCase()}/${input.lat.toFixed(3)}/${input.lon.toFixed(3)}${airportSurfaceCacheVersion(input.airport) === "airport-surface-v7" ? "" : `?snapshot=${airportSurfaceCacheVersion(input.airport)}`}`;
}

export async function loadCachedAirportSurface<T>(input: { airport: string; lat: number; lon: number }, load: () => Promise<T>): Promise<T> {
  const key = browserSurfaceKey(input);
  if (typeof window !== "undefined" && "caches" in window) {
    try {
      const store = await caches.open(AIRPORT_SURFACE_BROWSER_CACHE);
      const cached = await store.match(key);
      if (cached) {
        const savedAt = Number(cached.headers.get("x-inbound-saved-at") || 0);
        if (savedAt > 0 && Date.now() - savedAt < AIRPORT_SURFACE_BROWSER_MAX_AGE_MS) {
          return await cached.json();
        }
      }
    } catch {
      // Browser cache is best effort; fall through to the server.
    }
  }

  const value = await load();

  if (typeof window !== "undefined" && "caches" in window) {
    try {
      const store = await caches.open(AIRPORT_SURFACE_BROWSER_CACHE);
      await store.put(key, new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "x-inbound-saved-at": String(Date.now()),
        },
      }));
    } catch {
      // Surface still renders even when persistent browser storage is unavailable.
    }
  }
  return value;
}
