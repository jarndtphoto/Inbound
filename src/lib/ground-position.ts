import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
import { loadFr24Flight, loadFr24FlightByNumber, loadFr24FlightByRegistration, loadFr24RecentArrivalIdentity } from "./fr24.server";
import { fetchAround, fetchByCallsign, fetchByReg, fuseProviderLists, type AdsbRaw } from "./adsb-fusion";

type GroundPositionInput = {
  callsign?: string | null;
  flightId?: string | null;
  flightNumber?: string | null;
  registration?: string | null;
  originIata?: string | null;
  destIata?: string | null;
  movementKind?: "departure" | "arrival" | null;
  airportLat: number;
  airportLon: number;
};

export const getGroundPosition = createServerFn({ method: "POST" })
  .validator((input: GroundPositionInput) => {
    const callsign = String(input?.callsign ?? "").trim().toUpperCase() || null;
    const flightId = String(input?.flightId ?? "").trim().toUpperCase() || null;
    const flightNumber = String(input?.flightNumber ?? "").replace(/\s/g, "").trim().toUpperCase() || null;
    const registration = String(input?.registration ?? "").trim().toUpperCase() || null;
    const originIata = String(input?.originIata ?? "").trim().toUpperCase() || null;
    const destIata = String(input?.destIata ?? "").trim().toUpperCase() || null;
    const movementKind = input?.movementKind === "arrival" || input?.movementKind === "departure" ? input.movementKind : null;
    const airportLat = Number(input?.airportLat);
    const airportLon = Number(input?.airportLon);
    if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon)) throw new Error("Invalid airport position");
    return { callsign, flightId, flightNumber, registration, originIata, destIata, movementKind, airportLat, airportLon };
  })
  .handler(async ({ data }) => {
    const airport = { lat: data.airportLat, lon: data.airportLon };
    const diagnosticAirport = data.movementKind === "arrival" ? data.destIata : data.originIata;
    const diagnosticEnabled = diagnosticAirport === "MCO" || diagnosticAirport === "TPA";
    const diagnostic = (event: string, detail: Record<string, unknown> = {}) => {
      if (!diagnosticEnabled) return;
      console.info("[ground-coverage]", {
        airport: diagnosticAirport,
        movement: data.movementKind,
        flight: data.flightNumber,
        event,
        ...detail,
      });
    };

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
    const wantedCallsigns = new Set(callsigns);
    let resolvedRegistration = data.registration;
    let wantedReg = normRegistration(resolvedRegistration);
    const latPad = 0.12;
    const lonPad = Math.min(0.2, latPad / Math.max(0.45, Math.cos(airport.lat * Math.PI / 180)));
    const bounds = [
      airport.lat + latPad,
      airport.lat - latPad,
      airport.lon - lonPad,
      airport.lon + lonPad,
    ].map((v) => v.toFixed(4)).join(",");
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

    // Registration is the strongest identity key. If it is unknown, FR24's
    // commercial flight-number filter is often more reliable on the surface
    // than the transponder callsign filter, especially at a large airport.
    // Make only one direct live-FR24 identity probe per ground poll. A miss or
    // throttle on the strongest key should fall through to open ADS-B instead
    // of immediately spending more FR24 calls on weaker aliases in the same
    // 3-second cycle.
    if (resolvedRegistration) {
      const byRegistration = await loadFr24FlightByRegistration(resolvedRegistration).catch(() => null);
      const position = usable(byRegistration);
      if (position) {
        diagnostic("fr24-registration-hit", { ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        return position;
      }
      diagnostic("fr24-registration-miss", { registration: resolvedRegistration });
    } else if (data.flightNumber) {
      const byFlightNumber = await loadFr24FlightByNumber(data.flightNumber, bounds).catch(() => null);
      const position = usable(byFlightNumber);
      if (position) {
        console.info("[ground-position]", { provider: "fr24-flight-number", flight: data.flightNumber, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        diagnostic("fr24-flight-number-hit", { ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        return position;
      }
      diagnostic("fr24-flight-number-miss");
    } else {
      for (const callsign of callsigns) {
        const byCallsign = await loadFr24Flight(callsign).catch(() => null);
        const position = usable(byCallsign);
        if (position) {
          diagnostic("fr24-callsign-hit", { callsign, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
          return position;
        }
        diagnostic("fr24-callsign-miss", { callsign });
        // Callsigns is a tiny compatibility list (flight-id then story
        // callsign); do not probe a second alias in the same poll.
        break;
      }
    }

    // Arrival flights can disappear from FR24's live flight-number index as
    // soon as the leg ends, especially when that number continues on another
    // segment. A small, cached summary lookup recovers the exact completed
    // leg's registration; then we resume normal exact-registration tracking.
    // This replaces the old broad ORD bounds scan, which could return dozens
    // of paid live records every few seconds.
    if (data.movementKind === "arrival" && !resolvedRegistration && data.flightNumber && data.originIata && data.destIata) {
      const recent = await loadFr24RecentArrivalIdentity(data.flightNumber, data.originIata, data.destIata).catch(() => null);
      if (recent?.registration) {
        resolvedRegistration = recent.registration;
        wantedReg = normRegistration(resolvedRegistration);
        const byRegistration = await loadFr24FlightByRegistration(resolvedRegistration).catch(() => null);
        const position = usable(byRegistration);
        if (position) {
          console.info("[ground-position]", {
            provider: "fr24-summary-registration",
            flight: data.flightNumber,
            registration: resolvedRegistration,
            ageSec: Math.round(Date.now() / 1000 - position.seenAt),
          });
          return position;
        }
      }
    }

    // Open ADS-B remains the final fallback.

    const matchesIdentity = (raw: AdsbRaw) => {
      const reg = normRegistration(raw.r);
      const cs = normCallsign(raw.flight);
      if (wantedReg && reg === wantedReg) return true;
      return Boolean(cs && wantedCallsigns.has(cs));
    };
    const aroundPacks = await fetchAround(airport.lat, airport.lon, 20).catch(() => []);
    diagnostic("adsb-around", {
      providers: aroundPacks.map((pack) => ({ provider: pack.provider, count: pack.ac.length })),
    });
    const around = fuseProviderLists(aroundPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    for (const candidate of around) {
      const position = usableAdsb(candidate);
      if (position) {
        console.info("[ground-position]", { provider: "adsb-around", callsign: position.callsign, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        diagnostic("adsb-around-hit", { callsign: position.callsign, registration: position.registration, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        return position;
      }
    }

    const exactPacks = resolvedRegistration
      ? await fetchByReg(resolvedRegistration).catch(() => [])
      : callsigns[0]
        ? await fetchByCallsign(callsigns[0]).catch(() => [])
        : [];
    diagnostic("adsb-exact", {
      providers: exactPacks.map((pack) => ({ provider: pack.provider, count: pack.ac.length })),
      key: resolvedRegistration ? "registration" : callsigns[0] ? "callsign" : "none",
    });
    const exact = fuseProviderLists(exactPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    for (const candidate of exact) {
      const position = usableAdsb(candidate);
      if (position) {
        diagnostic("adsb-exact-hit", { callsign: position.callsign, registration: position.registration, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
        return position;
      }
    }
    diagnostic("no-ground-fix", { registration: resolvedRegistration, callsigns });
    return null;
  });;
