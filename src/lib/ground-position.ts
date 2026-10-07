import { createServerFn } from "@tanstack/react-start";
import { haversineNm } from "./geo";
import { fetchAround, fetchByCallsign, fetchByHex, fetchByReg, fuseProviderLists, type AdsbRaw, type ProviderPack } from "./adsb-fusion";
import { usRegistrationHex } from "./us-registration-hex";

export type GroundPositionInput = {
  callsign?: string | null;
  flightId?: string | null;
  flightNumber?: string | null;
  registration?: string | null;
  hex?: string | null;
  stateKey?: string | null;
  serviceDate?: string | null;
  airportIata?: string | null;
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
const groundMissLogAt = new Map<string, number>();
const groundAroundCache = new Map<string, { at: number; ac: AdsbRaw[] }>();

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
      if (!Number.isFinite(ageSec) || ageSec < -10 || ageSec > 120) return [];
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
    const stateKey = typeof input?.stateKey === "string" && input.stateKey.startsWith("leg:") ? input.stateKey : null;
    const serviceDate = typeof input?.serviceDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.serviceDate) ? input.serviceDate : null;
    const airportIata = String(input?.airportIata ?? "").trim().toUpperCase();
    const originIata = String(input?.originIata ?? "").trim().toUpperCase() || null;
    const destIata = String(input?.destIata ?? "").trim().toUpperCase() || null;
    const movementKind = input?.movementKind === "arrival" || input?.movementKind === "departure" ? input.movementKind : null;
    const airportLat = Number(input?.airportLat);
    const airportLon = Number(input?.airportLon);
    if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon)) throw new Error("Invalid airport position");
    return { callsign, flightId, flightNumber, registration, hex, stateKey, serviceDate, airportIata: /^[A-Z]{3}$/.test(airportIata) ? airportIata : null, originIata, destIata, movementKind, airportLat, airportLon };
  })
  .handler(async ({ data }) => {
    const airport = { lat: data.airportLat, lon: data.airportLon };
    const diagnosticAirport = data.airportIata ?? (data.movementKind === "arrival" ? data.destIata : data.originIata);
    const diagnosticEnabled = diagnosticAirport === "MCO" || diagnosticAirport === "TPA";
    const pollId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const adsbStatus: Record<"fi" | "lol" | "al", string | null> = { fi: null, lol: null, al: null };
    const groundStore = data.stateKey ? (await import("./flight-ground-state.server.ts")).flightGroundStateStore : null;
    const cachedState = groundStore && data.stateKey ? await groundStore.load(data.stateKey) : null;

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

    const normCallsign = (value: unknown) => String(value ?? "").replace(/\s/g, "").toUpperCase();
    const normRegistration = (value: unknown) => String(value ?? "").replace(/[-\s]/g, "").toUpperCase();
    const flightIdCallsign = data.flightId?.match(/^([A-Z]{2,4}\d{1,4}[A-Z]?)/)?.[1] ?? null;
    const callsigns = [...new Set([flightIdCallsign, data.callsign, cachedState?.callsign].filter(Boolean).map(normCallsign))].slice(0, 3);
    const wantedCallsigns = new Set(callsigns);
    const wantedHex = String(data.hex ?? cachedState?.hex ?? "").toLowerCase();
    const resolvedRegistration = data.registration ?? cachedState?.registration ?? null;
    const wantedReg = normRegistration(resolvedRegistration);
    const traceHex = wantedHex || usRegistrationHex(resolvedRegistration) || "";

    const persist = async (position: GroundTracePosition | null) => {
      if (!groundStore || !data.stateKey || !data.flightNumber || !data.originIata || !data.destIata
        || !data.movementKind || !diagnosticAirport) return;
      const seenAt = position?.seenAt ?? null;
      await groundStore.save({
        landKey: data.stateKey,
        requestedIdent: data.flightNumber,
        serviceDate: data.serviceDate ?? data.stateKey.split("|")[1] ?? null,
        originIata: data.originIata,
        destIata: data.destIata,
        airportIata: diagnosticAirport,
        airportLat: data.airportLat,
        airportLon: data.airportLon,
        movementKind: data.movementKind,
        hex: traceHex || null,
        registration: position?.registration ?? resolvedRegistration,
        callsign: position?.callsign ?? callsigns[0] ?? null,
        lastPosition: position,
        positionSeenAt: seenAt,
      });
    };

    const finish = async <T extends GroundTracePosition | null>(position: T): Promise<T> => {
      await persist(position);
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
          registrationKnownAtPollStart: Boolean(resolvedRegistration),
          adsbStatus,
          finalProvider: position?.provider ?? "none",
          finalAgeSec: finalAgeSec == null ? null : Math.round(finalAgeSec * 10) / 10,
        }));
      }
      return position;
    };

    const usableAdsb = (raw: AdsbRaw | null | undefined, maxAgeSec = 30): GroundTracePosition | null => {
      if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
      const point = { lat: raw.lat as number, lon: raw.lon as number };
      if (haversineNm(point, airport) > 20) return null;
      const onGround = raw.alt_baro === "ground" || raw.alt_baro === 0;
      const altFt = typeof raw.alt_baro === "number" ? raw.alt_baro : onGround ? 0 : null;
      if (!onGround && (altFt ?? 9999) > 250) return null;
      const ageSec = raw._fusion?.ageSec
        ?? (typeof raw.seen_pos === "number" ? raw.seen_pos : typeof raw.seen === "number" ? raw.seen : 999);
      if (!Number.isFinite(ageSec) || ageSec > maxAgeSec) return null;
      return {
        lat: point.lat,
        lon: point.lon,
        altFt,
        gsKt: typeof raw.gs === "number" ? raw.gs : typeof raw.spd === "number" ? raw.spd : null,
        track: typeof raw.track === "number" ? raw.track : null,
        onGround: true,
        seenAt: Date.now() / 1000 - ageSec,
        registration: raw.r ?? resolvedRegistration,
        callsign: raw.flight?.trim() || callsigns[0] || null,
        provider: "adsb",
      };
    };

    const matchesIdentity = (raw: AdsbRaw) => {
      const reg = normRegistration(raw.r);
      const cs = normCallsign(raw.flight);
      const hex = String(raw.hex ?? "").toLowerCase();
      if (traceHex) return hex === traceHex;
      if (wantedReg) return reg === wantedReg;
      return Boolean(cs && wantedCallsigns.has(cs));
    };

    const pick = (packs: ProviderPack[], maxAgeSec = 30) => {
      noteAdsbPacks(packs);
      return fuseProviderLists(packs, { airside: true })
        .filter(matchesIdentity)
        .map(raw => usableAdsb(raw, maxAgeSec))
        .filter((position): position is GroundTracePosition => Boolean(position))
        .sort((a, b) => b.seenAt - a.seenAt)[0] ?? null;
    };

    const controller = new AbortController();
    const signal = controller.signal;
    let hexPacks: ProviderPack[] = [], regPacks: ProviderPack[] = [], callsignPacks: ProviderPack[] = [], aroundPacks: ProviderPack[] = [];
    const aroundKey = `${airport.lat.toFixed(3)}:${airport.lon.toFixed(3)}:20`;

    const validPath = async (route: string, promise: Promise<ProviderPack[]>) => {
      const packs = await promise;
      if (route === "hex") hexPacks = packs;
      else if (route === "registration") regPacks = packs;
      else if (route === "callsign") callsignPacks = packs;
      else aroundPacks = packs;
      if (route === "area") {
        const fused = fuseProviderLists(packs, { airside: true });
        if (fused.length) groundAroundCache.set(aroundKey, { at: Date.now(), ac: fused });
      }
      const position = pick(packs);
      if (!position) throw new Error(`${route} miss`);
      return { route, position };
    };

    const paths: Promise<{ route: string; position: GroundTracePosition }>[] = [];
    if (traceHex) paths.push(validPath("hex", fetchByHex(traceHex, signal)));
    if (resolvedRegistration) paths.push(validPath("registration", fetchByReg(resolvedRegistration, signal)));
    if (callsigns.length) {
      paths.push(Promise.any(callsigns.map(callsign =>
        fetchByCallsign(callsign, signal).then(packs => {
          callsignPacks.push(...packs);
          const position = pick(packs);
          if (!position) throw new Error("callsign miss");
          return { route: "callsign", position };
        })
      )));
    }
    paths.push(validPath("area", fetchAround(airport.lat, airport.lon, 20, signal)));

    if (paths.length) {
      const winner = await Promise.any(paths).catch(() => null);
      if (winner) {
        controller.abort();
        console.info("[ground-position]", {
          provider: "adsb-parallel",
          route: winner.route,
          callsign: winner.position.callsign,
          ageSec: Math.round(Date.now() / 1000 - winner.position.seenAt),
        });
        return finish(winner.position);
      }
    }

    const heldAround = groundAroundCache.get(aroundKey);
    if (heldAround && Date.now() - heldAround.at <= 120_000) {
      const heldSec = Math.max(0, Date.now() - heldAround.at) / 1000;
      const held = heldAround.ac.map(raw => ({
        ...raw,
        seen_pos: typeof raw.seen_pos === "number" ? raw.seen_pos + heldSec : raw.seen_pos,
        seen: typeof raw.seen === "number" ? raw.seen + heldSec : raw.seen,
        _fusion: raw._fusion ? { ...raw._fusion, ageSec: raw._fusion.ageSec + heldSec } : undefined,
      })).filter(matchesIdentity)
        .map(raw => usableAdsb(raw, 120))
        .filter((position): position is GroundTracePosition => Boolean(position))
        .sort((a, b) => b.seenAt - a.seenAt)[0] ?? null;
      if (held) {
        console.info("[ground-position]", {
          provider: "adsb-held-airport",
          callsign: held.callsign,
          ageSec: Math.round(Date.now() / 1000 - held.seenAt),
        });
        return finish(held);
      }
    }

    const traced = traceHex
      ? await recentGroundTrace(traceHex, airport, resolvedRegistration, callsigns[0] ?? data.callsign)
      : null;
    if (traced) {
      console.info("[ground-position]", {
        provider: "adsb-trace-recovery",
        callsign: traced.callsign,
        ageSec: Math.round(Date.now() / 1000 - traced.seenAt),
      });
      return finish(traced);
    }

    const missKey = `${data.movementKind ?? "ground"}:${data.flightNumber ?? data.callsign ?? traceHex ?? wantedReg ?? "unknown"}:${diagnosticAirport ?? "unknown"}`;
    const now = Date.now();
    if (now - (groundMissLogAt.get(missKey) ?? 0) >= 15_000) {
      groundMissLogAt.set(missKey, now);
      console.info("[ground-position-miss]", {
        airport: diagnosticAirport,
        movement: data.movementKind,
        flight: data.flightNumber,
        hasHex: Boolean(wantedHex),
        derivedUsHex: !wantedHex && Boolean(traceHex),
        hasRegistration: Boolean(wantedReg),
        callsigns,
        hexStatus: hexPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
        registrationStatus: regPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
        callsignStatus: callsignPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
        aroundStatus: aroundPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
      });
    }
    return finish(null);
  });
