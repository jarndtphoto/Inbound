import { createPhaseHistory } from "./aircraft-phase.ts";
import { createServerFn } from "@tanstack/react-start";
import { AIRPORT_BY_ICAO, airportByIcao } from "./airports";
import { airframeOf, airlineOf, isVehicleType, isWidebody, isInterestingAircraft } from "./aircraft";
import { haversineNm, initialBearing } from "./geo";
import { decodeMetar, passengerDelayHint, type Metar, type Taf } from "./metar";
import type { FieldSnapshot, Traffic } from "./types";
import { phaseOf } from "./traffic-motion";
import { fetchAround, fuseProviderLists, lastGoodAround, rememberAround, type AdsbRaw } from "./adsb-fusion";

const RANGE_NM = 38;

type CacheEntry<T> = { at: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return fn().then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

async function fetchJson<T>(url: string, ms = 8000): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Airside/1.0 (passenger aviation companion)", Accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return (await res.json()) as T;
}

const observePhase = createPhaseHistory();

export function toTraffic(raw: AdsbRaw, airport: { lat: number; lon: number; elevationFt?: number }): Traffic | null {
  const hex = (raw.hex ?? "").toLowerCase();
  if (!hex) return null;
  if (isVehicleType(raw.t, raw.category, raw.ownOp)) return null;
  const lat = raw.lat ?? null;
  const lon = raw.lon ?? null;
  const onGround = raw.alt_baro === "ground" || raw.alt_baro === 0;
  const altFt =
    typeof raw.alt_baro === "number" && raw.alt_baro > 0 ? raw.alt_baro : onGround ? 0 : null;
  let distNm = typeof raw.dst === "number" ? raw.dst : null;
  let bearing = typeof raw.dir === "number" ? raw.dir : null;
  if ((distNm == null || bearing == null) && lat != null && lon != null) {
    distNm = haversineNm(airport, { lat, lon });
    bearing = initialBearing(airport, { lat, lon });
  }
  if (distNm == null || distNm > RANGE_NM + 2) return null;
  if (bearing == null) bearing = 0;

  const type = raw.t?.trim() || null;
  const frame = airframeOf(type);
  const callsign = raw.flight?.trim() || null;
  const airline = airlineOf(callsign);
  const year = raw.year?.trim() || null;
  const widebody = isWidebody(type);
  const interesting = isInterestingAircraft(type, year);

  const gsKt = typeof raw.gs === "number" ? raw.gs : null;
  const vertFpm = Number.isFinite(raw.baro_rate) ? raw.baro_rate! : Number.isFinite(raw.geom_rate) ? raw.geom_rate! : null;
  const seenSec = raw._fusion?.ageSec ?? raw.seen_pos ?? raw.seen ?? 0;
  const phase = observePhase(`${airport.lat}|${airport.lon}|${hex}|${callsign}`, { lat: lat ?? undefined, lon: lon ?? undefined, altFt, onGround, gsKt, vertFpm, seenSec, seenAt: Date.now() / 1000 - seenSec, extrapolated: raw.extrapolated ?? raw._fusion?.extrapolated }, { dest: airport }).phase;

  return {
    hex,
    callsign,
    registration: raw.r?.trim() || null,
    type,
    typeName: frame?.name ?? raw.desc ?? type,
    operator: raw.ownOp?.trim() || null,
    airline,
    year,
    lat,
    lon,
    altFt,
    onGround,
    gsKt,
    track: typeof raw.track === "number" ? raw.track : null,
    vertFpm,
    distNm,
    bearing,
    category: raw.category ?? null,
    widebody,
    interesting,
    phase,
    extrapolated: Boolean(raw.extrapolated ?? raw._fusion?.extrapolated),
    seenSec: raw._fusion?.ageSec ?? (typeof raw.seen_pos === "number" ? raw.seen_pos : typeof raw.seen === "number" ? raw.seen : null),
  };
}

async function loadTraffic(icao: string): Promise<Traffic[]> {
  const ap = airportByIcao(icao);
  if (!ap) return [];
  const key = `around:${ap.lat.toFixed(2)}:${ap.lon.toFixed(2)}:${RANGE_NM}`;
  const packs = await fetchAround(ap.lat, ap.lon, RANGE_NM);
  let fused = fuseProviderLists(packs, { airside: true });
  if (!fused.length) fused = lastGoodAround(key) ?? [];
  else rememberAround(key, fused);
  const seen = new Set<string>();
  const list: Traffic[] = [];
  for (const raw of fused) {
    const t = toTraffic(raw, ap);
    if (!t || seen.has(t.hex)) continue;
    seen.add(t.hex);
    list.push(t);
  }
  list.sort((a, b) => {
    if (a.onGround !== b.onGround) return a.onGround ? 1 : -1;
    if (a.interesting !== b.interesting) return a.interesting ? -1 : 1;
    return a.distNm - b.distNm;
  });
  return list;
}

async function loadWeather(icao: string): Promise<FieldSnapshot["weather"]> {
  const empty = {
    metar: null as Metar | null,
    taf: null as Taf | null,
    decoded: null,
    delayHint: "Weather feed is quiet.",
  };
  try {
    const [metars, tafs] = await Promise.all([
      fetchJson<Metar[]>(
        `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`,
        7000,
      ).catch(() => [] as Metar[]),
      fetchJson<Taf[]>(
        `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`,
        7000,
      ).catch(() => [] as Taf[]),
    ]);
    const metar = Array.isArray(metars) ? metars[0] ?? null : null;
    const taf = Array.isArray(tafs) ? tafs[0] ?? null : null;
    const decoded = metar ? decodeMetar(metar) : null;
    return {
      metar,
      taf,
      decoded,
      delayHint: decoded
        ? passengerDelayHint(decoded.category, metar?.wspd, metar?.wgst)
        : empty.delayHint,
    };
  } catch {
    return empty;
  }
}

export async function loadFieldSnapshot(icao: string): Promise<FieldSnapshot> {
  return cached(`field:${icao}`, 9_000, async (): Promise<FieldSnapshot> => {
    let traffic: Traffic[] = [];
    let error: string | null = null;
    try {
      traffic = await loadTraffic(icao);
    } catch {
      error = "Live sky feed is delayed. Weather is still current.";
    }
    const weather = await loadWeather(icao);
    const airborne = traffic.filter((t) => !t.onGround).length;
    const onField = traffic.filter((t) => t.onGround).length;
    const heavies = traffic.filter((t) => t.widebody).length;
    return {
      icao,
      fetchedAt: Date.now(),
      traffic,
      airborne,
      onField,
      heavies,
      weather,
      error,
    };
  });
}

export const getField = createServerFn({ method: "POST" })
  .validator((input: { icao: string }) => {
    const icao = String(input?.icao ?? "").toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao) || !AIRPORT_BY_ICAO[icao]) {
      throw new Error("Unknown field");
    }
    return { icao };
  })
  .handler(async ({ data }) => loadFieldSnapshot(data.icao));
