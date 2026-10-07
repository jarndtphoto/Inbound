import { acquireGroundInStages, type GroundAcquisitionRoute } from "./ground-acquisition.ts";
import { parseRecentGroundTrace, type GroundTracePosition } from "./ground-trace.ts";
import { resolveGroundIdentity } from "./ground-position-identity.ts";
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


const TRACE_HOSTS = [
  { provider: "trace-airtraffic", host: "https://globe.theairtraffic.com" },
  { provider: "trace-fi", host: "https://globe.adsb.fi" },
  { provider: "trace-al", host: "https://globe.airplanes.live" },
] as const;
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
  const { acquireFreeAdsb } = await import("./adsb-acquisition.server.ts");
  for (const { provider, host } of TRACE_HOSTS) {
    const acquired = await acquireFreeAdsb({
      provider,
      url: `${host}/data/traces/${id.slice(-2)}/trace_recent_${id}.json`,
      timeoutMs: 2_200,
    });
    const position = parseRecentGroundTrace(acquired.data, airport, { registration, callsign }, Math.max(now, Date.now()));
    if (position) return position;
  }
  return null;
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
    // Preserve request provenance across provider waits and parallel viewers.
    const requestStartedAt = Date.now();
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
    const identity = resolveGroundIdentity(data, cachedState);
    const flightIdCallsign = data.flightId?.match(/^([A-Z]{2,4}\d{1,4}[A-Z]?)/)?.[1] ?? null;
    const callsigns = [...new Set([data.callsign, flightIdCallsign, identity.callsign].filter(Boolean).map(normCallsign))].slice(0, 3);
    const wantedCallsigns = new Set(callsigns);
    const wantedHex = String(identity.hex ?? "").toLowerCase();
    const resolvedRegistration = identity.registration;
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
      }, requestStartedAt);
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

    let hexPacks: ProviderPack[] = [], regPacks: ProviderPack[] = [], callsignPacks: ProviderPack[] = [], aroundPacks: ProviderPack[] = [];
    const aroundKey = `${airport.lat.toFixed(3)}:${airport.lon.toFixed(3)}:20`;
    const pathsAttempted: string[] = [];
    const lookup = async (route: string, run: () => Promise<ProviderPack[]>) => {
      pathsAttempted.push(route);
      const packs = await run();
      if (route === "hex") hexPacks = packs;
      else if (route === "registration") regPacks = packs;
      else if (route.startsWith("callsign:")) callsignPacks.push(...packs);
      else aroundPacks = packs;
      if (route === "area") {
        const fused = fuseProviderLists(packs, { airside: true });
        if (fused.length) groundAroundCache.set(aroundKey, { at: Date.now(), ac: fused });
      }
      return pick(packs);
    };
    const identityRoutes: GroundAcquisitionRoute<GroundTracePosition>[] = [];
    if (traceHex) identityRoutes.push({ route: "hex", run: () => lookup("hex", () => fetchByHex(traceHex)) });
    if (resolvedRegistration) identityRoutes.push({ route: "registration", run: () => lookup("registration", () => fetchByReg(resolvedRegistration)) });
    for (const callsign of callsigns) identityRoutes.push({
      route: `callsign:${callsign}`, run: () => lookup(`callsign:${callsign}`, () => fetchByCallsign(callsign)),
    });
    const strongest = identityRoutes.shift() ?? null;
    // Prefer the current callsign among bounded fallbacks; cached aliases follow it.
    const aliases = identityRoutes.sort((a, b) => Number(b.route === `callsign:${callsigns[0]}`) - Number(a.route === `callsign:${callsigns[0]}`));
    const winner = await acquireGroundInStages({
      strongest,
      area: { route: "area", run: () => lookup("area", () => fetchAround(airport.lat, airport.lon, 20)) },
      aliases,
    });
    if (winner) {
      console.info("[ground-position]", {
        provider: "adsb-staged", route: winner.route, pathsAttempted,
        callsign: winner.position.callsign,
        ageSec: Math.round(Date.now() / 1000 - winner.position.seenAt),
      });
      return finish(winner.position);
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
        pathsAttempted,
        hexStatus: hexPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
        registrationStatus: regPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
        callsignStatus: callsignPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
        aroundStatus: aroundPacks.map(pack => `${pack.provider}:${pack.status ?? "ok"}+${pack.ac.length}`),
      });
    }
    return finish(null);
  });
