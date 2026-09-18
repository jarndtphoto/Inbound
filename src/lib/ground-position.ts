import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
import { loadFr24Flight, loadFr24FlightByRegistration } from "./fr24.server";

type GroundPositionInput = {
  callsign?: string | null;
  registration?: string | null;
  airportLat: number;
  airportLon: number;
};

export const getGroundPosition = createServerFn({ method: "POST" })
  .validator((input: GroundPositionInput) => {
    const callsign = String(input?.callsign ?? "").trim().toUpperCase() || null;
    const registration = String(input?.registration ?? "").trim().toUpperCase() || null;
    const airportLat = Number(input?.airportLat);
    const airportLon = Number(input?.airportLon);
    if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon)) throw new Error("Invalid airport position");
    return { callsign, registration, airportLat, airportLon };
  })
  .handler(async ({ data }) => {
    const airport = { lat: data.airportLat, lon: data.airportLon };

    const usable = (flight: any) => {
      const p = flight?.position;
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
      if (haversineNm(p, airport) > 20) return null;
      if (p.onGround !== true && (p.altFt ?? 9999) > 250) return null;
      return {
        lat: p.lat,
        lon: p.lon,
        altFt: p.altFt ?? null,
        gsKt: p.gsKt ?? null,
        track: p.track ?? null,
        onGround: p.onGround === true,
        seenAt: p.seenAt ?? Date.now() / 1000,
        registration: p.registration ?? flight.registration ?? null,
        callsign: p.callsign ?? flight.callsign ?? null,
        provider: "fr24" as const,
      };
    };

    // Registration is the strongest identity key and avoids spending a second
    // FR24 request on every 2.5-second poll when we already know the tail.
    if (data.registration) {
      const byRegistration = await loadFr24FlightByRegistration(data.registration).catch(() => null);
      const position = usable(byRegistration);
      if (position) return position;
    }
    if (data.callsign) {
      const byCallsign = await loadFr24Flight(data.callsign).catch(() => null);
      const position = usable(byCallsign);
      if (position) return position;
    }
    return null;
  });;
