import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
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


type GroundTracePosition = {
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  track: number | null;
  onGround: true;
  seenAt: number;
  registration: string | null;
  callsign: string | null;
  provider: "adsb";
};

const TRACE_HOSTS = [
  "https://globe.theairtraffic.com",
  "https://globe.adsb.fi",
  "https://globe.airplanes.live",
];
const groundTraceCache = new Map<string, { at: number; value: GroundTracePosition | null }>();

async function recentGroundTrace(
  hex: string,
  airport: { lat: number; lon: number },
  registration: string | null,
  callsign: string | null,
  now = Date.now(),
): Promise<GroundTracePosition | null> {
  const id = hex.toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(id)) return null;
  const cached = groundTraceCache.get(id);
  if (cached && now - cached.at <= 8_000) return cached.value;

  const attempts = TRACE_HOSTS.map(async (host) => {
    const response = await fetch(`${host}/data/traces/${id.slice(-2)}/trace_recent_${id}.json`, {
      signal: AbortSignal.timeout(2_200),
      headers: { Accept: "application/json", "User-Agent": "Inbound/1.0 ground-trace-recovery" },
    });
    if (!response.ok) throw new Error(`trace HTTP ${response.status}`);
    const payload = await response.json() as { timestamp?: number; trace?: unknown[][] };
    const base = typeof payload.timestamp === "number" ? payload.timestamp : 0;
    const rows = Array.isArray(payload.trace) ? payload.trace : [];
    const candidates = rows.flatMap((row) => {
      const offset = typeof row?.[0] === "number" ? row[0] : 0;
      const lat = row?.[1], lon = row?.[2], altRaw = row?.[3], gsRaw = row?.[4], trackRaw = row?.[5];
      if (typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
      const seenAt = base + offset;
      const ageSec = now / 1000 - seenAt;
      if (!Number.isFinite(ageSec) || ageSec < -10 || ageSec > 90) return [];
      const gsKt = typeof gsRaw === "number" ? gsRaw : null;
      const ground = altRaw === "ground" || altRaw === 0 || altRaw === "0"
        || (typeof altRaw === "number" && altRaw <= 50 && (gsKt ?? 999) <= 80);
      if (!ground || haversineNm({ lat, lon }, airport) > 20) return [];
      const altFt = typeof altRaw === "number" && altRaw > 0 ? altRaw : 0;
      return [{
        lat, lon, altFt, gsKt,
        track: typeof trackRaw === "number" && trackRaw >= 0 && trackRaw <= 360 ? trackRaw : null,
        onGround: true as const,
        seenAt,
        registration,
        callsign,
        provider: "adsb" as const,
      }];
    }).sort((a, b) => b.seenAt - a.seenAt);
    const position = candidates[0] ?? null;
    if (!position) throw new Error("trace has no recent ground point");
    return position;
  });

  const value = await Promise.any(attempts).catch(() => null);
  groundTraceCache.set(id, { at: now, value });
  return value;
}

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

    const finish = <T extends { provider?: string; seenAt?: number } | null>(position: T): T => {
      if (diagnosticEnabled) {
        const finalAgeSec = position?.seenAt == null ? null : Math.max(0, Date.now() / 1000 - position.seenAt);
        console.info("[ground-coverage]", JSON.stringify({
          pollId,
          airport: diagnosticAirport,
          movement: data.movementKind,
          flight: data.flightNumber,
          fr24KeyType: "disabled-ground-map",
          fr24Upstream: "none",
          fr24RowsReturned: null,
          fr24Result: null,
          rejectReason: null,
          rawAgeSec: null,
          rawDistanceNm: null,
          rawOnGround: null,
          rawAltFt: null,
          errorKind: "none",
          rateLimitedUntilActive: false,
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
    const resolvedRegistration = data.registration;
    const wantedReg = normRegistration(resolvedRegistration);
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

    // The five-second ground-map loop is intentionally free ADS-B only. FR24
    // enrichment belongs to the shared twenty-second tracked-flight cache.

    const matchesIdentity = (raw: AdsbRaw) => {
      const reg = normRegistration(raw.r);
      const cs = normCallsign(raw.flight);
      const hex = String(raw.hex ?? "").toLowerCase();
      if (wantedHex && hex === wantedHex) return true;
      if (wantedReg && reg === wantedReg) return true;
      return Boolean(cs && wantedCallsigns.has(cs));
    };
    // Exact identity is both stronger and much cheaper than scanning the whole
    // airport every five seconds. Try hex, registration, or the operating
    // callsign first; only fall back to the radius feed when exact lookup is
    // unavailable or delayed enough that a broad hit could materially help.
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
      if (!position) continue;
      const ageSec = Math.round(Date.now() / 1000 - position.seenAt);
      console.info("[ground-position]", { provider: "adsb-exact", callsign: position.callsign, ageSec });
      return finish(position);
    }

    // If every exact provider is already rate-limited/backing off, a broad
    // airport scan would hit the same unavailable feeds and only make this
    // ground-map request slower. Let the next scheduled poll recover instead.
    if (exactPacks.length > 0 && exactPacks.every((pack) => pack.status && pack.status !== "ok")) {
      const traced = wantedHex
        ? await recentGroundTrace(wantedHex, airport, resolvedRegistration, callsigns[0] ?? data.callsign)
        : null;
      if (traced) {
        console.info("[ground-position]", {
          provider: "adsb-trace-recovery",
          callsign: traced.callsign,
          ageSec: Math.round(Date.now() / 1000 - traced.seenAt),
        });
        return finish(traced);
      }
      return finish(null);
    }

    const aroundPacks = await fetchAround(airport.lat, airport.lon, 20).catch(() => []);
    noteAdsbPacks(aroundPacks);
    const around = fuseProviderLists(aroundPacks, { airside: true })
      .filter(matchesIdentity)
      .sort((a, b) => (a._fusion?.ageSec ?? 999) - (b._fusion?.ageSec ?? 999));
    let aroundFallback: ReturnType<typeof usableAdsb> = null;
    for (const candidate of around) {
      const position = usableAdsb(candidate);
      if (!position) continue;
      aroundFallback = position;
      break;
    }

    if (aroundFallback) {
      console.info("[ground-position]", {
        provider: "adsb-around-fallback",
        callsign: aroundFallback.callsign,
        ageSec: Math.round(Date.now() / 1000 - aroundFallback.seenAt),
      });
      return finish(aroundFallback);
    }
    return finish(null);
  });;
