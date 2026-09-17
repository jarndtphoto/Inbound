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
