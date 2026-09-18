import { createServerFn } from "@tanstack/react-start";
import { loadAirportSurface } from "./airport-surface.server";

export const getAirportSurface = createServerFn({ method: "POST" })
  .validator((input: { airport: string; lat: number; lon: number }) => {
    const airport = String(input?.airport ?? "").toUpperCase();
    const lat = Number(input?.lat);
    const lon = Number(input?.lon);
    if (!/^[A-Z0-9]{3,4}$/.test(airport) || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("Invalid airport surface request");
    }
    return { airport, lat, lon };
  })
  .handler(({ data }) => loadAirportSurface(data));


const AIRPORT_SURFACE_BROWSER_CACHE = "inbound-airport-surfaces-v2";
const AIRPORT_SURFACE_BROWSER_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function browserSurfaceKey(input: { airport: string; lat: number; lon: number }) {
  return `https://inbound.local/airport-surface/${input.airport.toUpperCase()}/${input.lat.toFixed(3)}/${input.lon.toFixed(3)}`;
}

export async function getAirportSurfaceCached(input: { airport: string; lat: number; lon: number }) {
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

  const value = await getAirportSurface({ data: input });

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
