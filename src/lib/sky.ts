import { createServerFn } from "@tanstack/react-start";
import { AIRPORT_BY_ICAO, airportByIcao } from "./airports";
import { airframeOf, airlineOf, isVehicleType, isWidebody } from "./aircraft";
import { haversineNm, initialBearing } from "./geo";
import { decodeMetar, passengerDelayHint, type Metar, type Taf } from "./metar";
import type { FieldSnapshot, Traffic } from "./types";

const UA = "Airside/1.0 (passenger aviation companion)";
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
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return (await res.json()) as T;
}

type AdsbAc = {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  ownOp?: string;
  year?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  baro_rate?: number;
  dst?: number;
  dir?: number;
  category?: string;
};

function phaseOf(ac: {
  onGround: boolean;
  gsKt: number | null;
  altFt: number | null;
  vertFpm: number | null;
}): Traffic["phase"] {
  if (ac.onGround) return (ac.gsKt ?? 0) > 8 ? "taxi" : "parked";
  const v = ac.vertFpm ?? 0;
  const alt = ac.altFt ?? 0;
  if (v < -400 && alt < 8000) return "approach";
  if (v < -250) return "descent";
  if (v > 400 && alt < 12000) return "climb";
  return "cruise";
}

function toTraffic(raw: AdsbAc, airport: { lat: number; lon: number }): Traffic | null {
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
  const yearNum = year ? Number(year) : null;
  const widebody = isWidebody(type);
  const kind = frame?.kind;
  const interesting =
    widebody ||
    kind === "biz" ||
    type === "A388" ||
    type === "B744" ||
    type === "B748" ||
    type === "B752" ||
    type === "B753" ||
    (yearNum != null &&
      yearNum >= new Date().getUTCFullYear() - 1 &&
      kind !== "ga" &&
      kind !== "heli" &&
      kind !== "other");

  const gsKt = typeof raw.gs === "number" ? raw.gs : null;
  const vertFpm = typeof raw.baro_rate === "number" ? raw.baro_rate : null;

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
    phase: phaseOf({ onGround, gsKt, altFt, vertFpm }),
  };
}

async function loadTraffic(icao: string): Promise<Traffic[]> {
  const ap = airportByIcao(icao);
  if (!ap) return [];
  const url = `https://opendata.adsb.fi/api/v2/lat/${ap.lat}/lon/${ap.lon}/dist/${RANGE_NM}`;
  const data = await fetchJson<{ aircraft?: AdsbAc[] }>(url, 9000);
  const seen = new Set<string>();
  const list: Traffic[] = [];
  for (const raw of data.aircraft ?? []) {
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
  return cached(`field:${icao}`, 12_000, async (): Promise<FieldSnapshot> => {
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
