import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
import { loadFr24Flight, loadFr24FlightByRegistration } from "./fr24.server";
import { fetchAround, fetchByCallsign, fetchByReg, fuseProviderLists, type AdsbRaw } from "./adsb-fusion";

type GroundPositionInput = {
  callsign?: string | null;
  flightId?: string | null;
  registration?: string | null;
  airportLat: number;
  airportLon: number;
};

export const getGroundPosition = createServerFn({ method: "POST" })
  .validator((input: GroundPositionInput) => {
    const callsign = String(input?.callsign ?? "").trim().toUpperCase() || null;
    const flightId = String(input?.flightId ?? "").trim().toUpperCase() || null;
    const registration = String(input?.registration ?? "").trim().toUpperCase() || null;
    const airportLat = Number(input?.airportLat);
    const airportLon = Number(input?.airportLon);
    if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon)) throw new Error("Invalid airport position");
    return { callsign, flightId, registration, airportLat, airportLon };
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
    const flightIdCallsign = data.flightId?.match(/^([A-Z]{2,4}\d{1,4}[A-Z]?)/)?.[1] ?? null;
    const callsigns = [...new Set([flightIdCallsign, data.callsign].filter(Boolean).map(normCallsign))].slice(0, 2);
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
    for (const callsign of callsigns) {
      const byCallsign = await loadFr24Flight(callsign).catch(() => null);
      const position = usable(byCallsign);
      if (position) return position;
    }

    // Exact callsign endpoints can omit surface aircraft. Search the airport
    // neighborhood first, then fall back to exact lookups if needed.
    const wantedReg = normRegistration(data.registration);
    const wantedCallsigns = new Set(callsigns);
    const matchesIdentity = (raw: AdsbRaw) => {
      const reg = normRegistration(raw.r);
      const cs = normCallsign(raw.flight);
      if (wantedReg && reg === wantedReg) return true;
      return Boolean(cs && wantedCallsigns.has(cs));
    };
    const aroundPacks = await fetchAround(airport.lat, airport.lon, 20).catch(() => []);
    const around = fuseProviderLists(aroundPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    for (const candidate of around) {
      const position = usableAdsb(candidate);
      if (position) {
        console.info("[ground-position]", { provider: "adsb-around", callsign: position.callsign, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        return position;
      }
    }

    const exactPacks = data.registration
      ? await fetchByReg(data.registration).catch(() => [])
      : callsigns[0]
        ? await fetchByCallsign(callsigns[0]).catch(() => [])
        : [];
    const exact = fuseProviderLists(exactPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    for (const candidate of exact) {
      const position = usableAdsb(candidate);
      if (position) return position;
    }
    return null;
  });;
