import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
import { createFr24ProbeDiagnostics, loadFr24Flight, loadFr24FlightByNumber, loadFr24FlightByRegistration, loadFr24RecentArrivalIdentity, type Fr24ProbeDiagnostics } from "./fr24.server";
import { fetchAround, fetchByCallsign, fetchByHex, fetchByReg, fuseProviderLists, type AdsbRaw, type ProviderPack } from "./adsb-fusion";

type GroundPositionInput = {
  callsign?: string | null;
  flightId?: string | null;
  flightNumber?: string | null;
  registration?: string | null;
  hex?: string | null;
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
    const hex = String(input?.hex ?? "").trim().toLowerCase().replace(/^~+/, "") || null;
    const originIata = String(input?.originIata ?? "").trim().toUpperCase() || null;
    const destIata = String(input?.destIata ?? "").trim().toUpperCase() || null;
    const movementKind = input?.movementKind === "arrival" || input?.movementKind === "departure" ? input.movementKind : null;
    const airportLat = Number(input?.airportLat);
    const airportLon = Number(input?.airportLon);
    if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon)) throw new Error("Invalid airport position");
    return { callsign, flightId, flightNumber, registration, hex, originIata, destIata, movementKind, airportLat, airportLon };
  })
  .handler(async ({ data }) => {
    const airport = { lat: data.airportLat, lon: data.airportLon };
    const diagnosticAirport = data.movementKind === "arrival" ? data.destIata : data.originIata;
    const diagnosticEnabled = diagnosticAirport === "MCO" || diagnosticAirport === "TPA";
    const pollId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    type Fr24Result = "usable" | "no_row" | "rejected" | "error" | null;
    type RejectReason = "missing_position" | "distance_gt_20nm" | "airborne_gt_250ft" | "age_gt_30s" | "future_age" | null;
    type Fr24KeyType = "registration" | "flightNumber" | "callsign" | "owned-by-story";

    let fr24KeyType: Fr24KeyType = data.movementKind === "departure"
      ? "owned-by-story"
      : data.registration
        ? "registration"
        : data.flightNumber
          ? "flightNumber"
          : "callsign";
    let fr24Probe = createFr24ProbeDiagnostics();
    let fr24Result: Fr24Result = null;
    let rejectReason: RejectReason = null;
    let rawAgeSec: number | null = null;
    let rawDistanceNm: number | null = null;
    let rawOnGround: boolean | null = null;
    let rawAltFt: number | null = null;
    const adsbStatus: Record<"fi" | "lol" | "al", string | null> = { fi: null, lol: null, al: null };

    const noteAdsbPacks = (packs: ProviderPack[]) => {
      for (const pack of packs) {
        const next = pack.status && pack.status !== "ok" ? pack.status : `ok+${pack.ac.length}`;
        const current = adsbStatus[pack.provider];
        if (!current || !current.startsWith("ok+") || !next.startsWith("ok+")) {
          adsbStatus[pack.provider] = next;
        } else {
          const currentCount = Number(current.slice(3)) || 0;
          adsbStatus[pack.provider] = `ok+${Math.max(currentCount, pack.ac.length)}`;
        }
      }
    };

    const inspectFr24 = (flight: any, probe: Fr24ProbeDiagnostics) => {
      fr24Probe = probe;
      rejectReason = null;
      const p = flight?.position;
      const raw = probe.rawPosition;
      const rawLat = raw?.lat ?? (Number.isFinite(p?.lat) ? p.lat : null);
      const rawLon = raw?.lon ?? (Number.isFinite(p?.lon) ? p.lon : null);
      const rawSeenAt = raw?.seenAt ?? (typeof p?.seenAt === "number" && Number.isFinite(p.seenAt) ? p.seenAt : null);
      rawOnGround = raw?.onGround ?? (typeof p?.onGround === "boolean" ? p.onGround : null);
      rawAltFt = raw?.altFt ?? (typeof p?.altFt === "number" && Number.isFinite(p.altFt) ? p.altFt : null);
      rawAgeSec = rawSeenAt == null ? null : Date.now() / 1000 - rawSeenAt;
      rawDistanceNm = rawLat == null || rawLon == null ? null : haversineNm({ lat: rawLat, lon: rawLon }, airport);

      if (!flight) {
        if (probe.errorKind !== "none") fr24Result = "error";
        else if (probe.rowsReturned === 0) fr24Result = "no_row";
        else {
          fr24Result = "rejected";
          rejectReason = "missing_position";
        }
        return null;
      }
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
        fr24Result = "rejected";
        rejectReason = "missing_position";
        return null;
      }
      const distanceNm = haversineNm(p, airport);
      rawDistanceNm = distanceNm;
      if (distanceNm > 20) {
        fr24Result = "rejected";
        rejectReason = "distance_gt_20nm";
        return null;
      }
      if (p.onGround !== true && (p.altFt ?? 9999) > 250) {
        fr24Result = "rejected";
        rejectReason = "airborne_gt_250ft";
        return null;
      }
      const seenAt = typeof p.seenAt === "number" && Number.isFinite(p.seenAt) ? p.seenAt : Date.now() / 1000;
      const ageSec = Date.now() / 1000 - seenAt;
      rawAgeSec = ageSec;
      rawOnGround = p.onGround === true;
      rawAltFt = p.altFt ?? null;
      if (ageSec > 30) {
        fr24Result = "rejected";
        rejectReason = "age_gt_30s";
        return null;
      }
      if (ageSec < -10) {
        fr24Result = "rejected";
        rejectReason = "future_age";
        return null;
      }
      fr24Result = "usable";
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

    const finish = <T extends { provider?: string; seenAt?: number } | null>(position: T): T => {
      if (diagnosticEnabled) {
        const finalAgeSec = position?.seenAt == null ? null : Math.max(0, Date.now() / 1000 - position.seenAt);
        console.info("[ground-coverage]", JSON.stringify({
          pollId,
          airport: diagnosticAirport,
          movement: data.movementKind,
          flight: data.flightNumber,
          fr24KeyType,
          fr24Upstream: fr24Probe.upstream,
          fr24RowsReturned: fr24Probe.rowsReturned,
          fr24Result,
          rejectReason,
          rawAgeSec: rawAgeSec == null ? null : Math.round(rawAgeSec * 10) / 10,
          rawDistanceNm: rawDistanceNm == null ? null : Math.round(rawDistanceNm * 100) / 100,
          rawOnGround,
          rawAltFt,
          errorKind: fr24Probe.errorKind,
          rateLimitedUntilActive: fr24Probe.rateLimitedUntilActive,
          registrationKnownAtPollStart: Boolean(data.registration),
          adsbStatus,
          finalProvider: position?.provider ?? "none",
          finalAgeSec: finalAgeSec == null ? null : Math.round(finalAgeSec * 10) / 10,
        }));
      }
      return position;
    };

    const normCallsign = (value: unknown) => String(value ?? "").replace(/\s/g, "").toUpperCase();
    const normRegistration = (value: unknown) => String(value ?? "").replace(/[-\s]/g, "").toUpperCase();
    const flightIdCallsign = data.flightId?.match(/^([A-Z]{2,4}\d{1,4}[A-Z]?)/)?.[1] ?? null;
    const callsigns = [...new Set([flightIdCallsign, data.callsign].filter(Boolean).map(normCallsign))].slice(0, 2);
    const wantedCallsigns = new Set(callsigns);
    const wantedHex = String(data.hex ?? "").toLowerCase();
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

    // The tracked-flight story owns FR24 polling for departures so the main
    // 8-second flight loop and the 3-second ground-map loop never compete for
    // the Explorer plan's 10 queries/minute allowance. Departure ground-map
    // refreshes still use the open ADS-B feeds below between story updates.
    if (data.movementKind === "departure") {
      fr24KeyType = "owned-by-story";
      fr24Probe = createFr24ProbeDiagnostics();
    } else {
      // Arrivals retain the exact identity recovery path because the live
      // flight number can disappear immediately after landing.
      if (resolvedRegistration) {
        fr24KeyType = "registration";
        const probe = createFr24ProbeDiagnostics();
        const byRegistration = await loadFr24FlightByRegistration(resolvedRegistration, probe).catch(() => null);
        const position = inspectFr24(byRegistration, probe);
        if (position) return finish(position);
      } else if (data.flightNumber) {
        fr24KeyType = "flightNumber";
        const probe = createFr24ProbeDiagnostics();
        const byFlightNumber = await loadFr24FlightByNumber(data.flightNumber, bounds, probe).catch(() => null);
        const position = inspectFr24(byFlightNumber, probe);
        if (position) {
          console.info("[ground-position]", { provider: "fr24-flight-number", flight: data.flightNumber, ageSec: Math.round(Date.now() / 1000 - position.seenAt) });
          return finish(position);
        }
      } else if (callsigns[0]) {
        fr24KeyType = "callsign";
        const callsign = callsigns[0];
        const probe = createFr24ProbeDiagnostics();
        const byCallsign = await loadFr24Flight(callsign, probe).catch(() => null);
        const position = inspectFr24(byCallsign, probe);
        if (position) return finish(position);
      }

      if (data.movementKind === "arrival" && !resolvedRegistration && data.flightNumber && data.originIata && data.destIata) {
        const recent = await loadFr24RecentArrivalIdentity(data.flightNumber, data.originIata, data.destIata).catch(() => null);
        if (recent?.registration) {
          resolvedRegistration = recent.registration;
          wantedReg = normRegistration(resolvedRegistration);
          fr24KeyType = "registration";
          const probe = createFr24ProbeDiagnostics();
          const byRegistration = await loadFr24FlightByRegistration(resolvedRegistration, probe).catch(() => null);
          const position = inspectFr24(byRegistration, probe);
          if (position) {
            console.info("[ground-position]", {
              provider: "fr24-summary-registration",
              flight: data.flightNumber,
              registration: resolvedRegistration,
              ageSec: Math.round(Date.now() / 1000 - position.seenAt),
            });
            return finish(position);
          }
        }
      }
    }

    // Open ADS-B remains the final fallback.

    const matchesIdentity = (raw: AdsbRaw) => {
      const reg = normRegistration(raw.r);
      const cs = normCallsign(raw.flight);
      const hex = String(raw.hex ?? "").toLowerCase();
      if (wantedHex && hex === wantedHex) return true;
      if (wantedReg && reg === wantedReg) return true;
      return Boolean(cs && wantedCallsigns.has(cs));
    };
    const aroundPacks = await fetchAround(airport.lat, airport.lon, 20).catch(() => []);
    noteAdsbPacks(aroundPacks);
    const around = fuseProviderLists(aroundPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    let aroundFallback: ReturnType<typeof usableAdsb> = null;
    for (const candidate of around) {
      const position = usableAdsb(candidate);
      if (!position) continue;
      const ageSec = Math.round(Date.now() / 1000 - position.seenAt);
      if (ageSec <= 8) {
        console.info("[ground-position]", { provider: "adsb-around", callsign: position.callsign, ageSec });
        return finish(position);
      }
      aroundFallback = position;
      break;
    }

    // Exact hex is the strongest free lookup for ground traffic and can be
    // materially fresher than an airport-radius response. Prefer it whenever
    // the broad hit is delayed, then registration, then callsign.
    const exactPacks = wantedHex
      ? await fetchByHex(wantedHex).catch(() => [])
      : resolvedRegistration
        ? await fetchByReg(resolvedRegistration).catch(() => [])
        : callsigns[0]
          ? await fetchByCallsign(callsigns[0]).catch(() => [])
          : [];
    noteAdsbPacks(exactPacks);
    const exact = fuseProviderLists(exactPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    for (const candidate of exact) {
      const position = usableAdsb(candidate);
      if (position) {
        if (!aroundFallback || position.seenAt > aroundFallback.seenAt) return finish(position);
      }
    }
    if (aroundFallback) {
      console.info("[ground-position]", {
        provider: "adsb-around-delayed",
        callsign: aroundFallback.callsign,
        ageSec: Math.round(Date.now() / 1000 - aroundFallback.seenAt),
      });
      return finish(aroundFallback);
    }
    return finish(null);
  });;
