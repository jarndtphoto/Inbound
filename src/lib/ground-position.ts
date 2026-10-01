import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
import { loadFr24Flight, loadFr24FlightByRegistration } from "./fr24.server";
import { fetchByCallsign, fetchByReg, fuseProviderLists, type AdsbRaw } from "./adsb-fusion";

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
      const seenAt = typeof p.seenAt === "number" && Number.isFinite(p.seenAt) ? p.seenAt : Date.now() / 1000;
      const ageSec = Date.now() / 1000 - seenAt;
      if (ageSec > 30 || ageSec < -10) return null;
      return {
        lat: p.lat,
        lon: p.lon,
        altFt: p.altFt ?? null,
        gsKt: p.gsKt ?? null,
        track: p.track ?? null,
        onGround: p.onGround === true,
        seenAt,
        registration: p.registration ?? flight.registration ?? null,
        callsign: p.callsign ?? flight.callsign ?? null,
        provider: "fr24" as const,
      };
    };

    const normCallsign = (value: unknown) => String(value ?? "").replace(/\s/g, "").toUpperCase();
    const normRegistration = (value: unknown) => String(value ?? "").replace(/[-\s]/g, "").toUpperCase();
    const usableAdsb = (raw: AdsbRaw | null | undefined) => {
      if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
      const point = { lat: raw.lat as number, lon: raw.lon as number };
      if (haversineNm(point, airport) > 20) return null;
      const onGround = raw.alt_baro === "ground" || raw.alt_baro === 0;
      const altFt = typeof raw.alt_baro === "number" ? raw.alt_baro : onGround ? 0 : null;
      if (!onGround && (altFt ?? 9999) > 250) return null;
      const ageSec = raw._fusion?.ageSec
        ?? (typeof raw.seen_pos === "number" ? raw.seen_pos : typeof raw.seen === "number" ? raw.seen : 999);
      if (!Number.isFinite(ageSec) || ageSec > 30) return null;
      return {
        lat: point.lat,
        lon: point.lon,
        altFt,
        gsKt: typeof raw.gs === "number" ? raw.gs : typeof raw.spd === "number" ? raw.spd : null,
        track: typeof raw.track === "number" ? raw.track : null,
        onGround,
        seenAt: Date.now() / 1000 - ageSec,
        registration: raw.r ?? null,
        callsign: raw.flight?.trim() || null,
        provider: "adsb" as const,
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

    // FR24 can be unavailable or temporarily miss surface coverage. Fall back
    // to open ADS-B fusion so the ground map keeps moving.
    const packs = data.registration
      ? await fetchByReg(data.registration).catch(() => [])
      : data.callsign
        ? await fetchByCallsign(data.callsign).catch(() => [])
        : [];
    const fused = fuseProviderLists(packs, { airside: true });
    const wantedReg = normRegistration(data.registration);
    const wantedCallsign = normCallsign(data.callsign);
    const candidates = fused.filter((raw) => {
      if (wantedReg) return normRegistration(raw.r) === wantedReg;
      if (wantedCallsign) return normCallsign(raw.flight) === wantedCallsign;
      return false;
    });
    candidates.sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    for (const candidate of candidates) {
      const position = usableAdsb(candidate);
      if (position) return position;
    }
    return null;
  });;
