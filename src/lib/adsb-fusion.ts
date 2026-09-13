import { destPoint, haversineNm } from "./geo.ts";

export type ProviderId = "fi" | "lol" | "al";

export type AdsbRaw = {
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
  alt_geom?: number;
  gs?: number;
  spd?: number;
  track?: number;
  baro_rate?: number;
  seen?: number;
  seen_pos?: number;
  dst?: number;
  dir?: number;
  category?: string;
  extrapolated?: boolean;
  _fusion?: { provider: ProviderId; extrapolated: boolean; ageSec: number };
};

export type Observation = {
  hex: string;
  provider: ProviderId;
  lat: number;
  lon: number;
  altBaro: number | "ground" | null;
  gs: number | null;
  track: number | null;
  seen: number;
  receivedAt: number;
  raw: AdsbRaw;
};

export type TrackState = {
  hex: string;
  lat: number;
  lon: number;
  gs: number | null;
  track: number | null;
  altBaro: number | "ground" | null;
  at: number;
  provider: ProviderId;
  extrapolated: boolean;
  raw: AdsbRaw;
};

export const STALE_AIR_SEC = 32;
export const STALE_ENROUTE_SEC = 12 * 60;
export const STALE_GROUND_SEC = 45;
export const TELEPORT_NM = 5;
export const TELEPORT_NM_FAST = 3;
export const GAP_EXTRAPOLATE_SEC = 10;
// A heading and ground speed are not a flight plan. Long straight-line coasts
// routinely put turning or holding aircraft tens of miles from their position.
export const GAP_EXTRAPOLATE_ENROUTE_SEC = 20;
export const STALE_KEEP_SEC = 45;
export const STALE_KEEP_ENROUTE_SEC = 15 * 60;

const UA = "Inbound/1.0 (passenger flight companion)";

export const PROVIDERS: Record<
  ProviderId,
  {
    id: ProviderId;
    timeoutMs: number;
    around: (lat: number, lon: number, dist: number) => string;
    hex: (id: string) => string;
    callsign: (id: string) => string;
    registration: (id: string) => string;
  }
> = {
  fi: {
    id: "fi",
    timeoutMs: 4000,
    around: (lat, lon, dist) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    hex: (id) => `https://opendata.adsb.fi/api/v2/hex/${encodeURIComponent(id)}`,
    callsign: (id) => `https://opendata.adsb.fi/api/v2/callsign/${encodeURIComponent(id)}`,
    registration: (id) => `https://opendata.adsb.fi/api/v2/registration/${encodeURIComponent(id)}`,
  },
  lol: {
    id: "lol",
    timeoutMs: 4000,
    around: (lat, lon, dist) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    hex: (id) => `https://api.adsb.lol/v2/hex/${encodeURIComponent(id)}`,
    callsign: (id) => `https://api.adsb.lol/v2/callsign/${encodeURIComponent(id)}`,
    registration: (id) => `https://api.adsb.lol/v2/registration/${encodeURIComponent(id)}`,
  },
  al: {
    id: "al",
    timeoutMs: 3500,
    around: (lat, lon, dist) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}`,
    hex: (id) => `https://api.airplanes.live/v2/hex/${encodeURIComponent(id)}`,
    callsign: (id) => `https://api.airplanes.live/v2/callsign/${encodeURIComponent(id)}`,
    registration: (id) => `https://api.airplanes.live/v2/reg/${encodeURIComponent(id)}`,
  },
};

const PROVIDER_ORDER: ProviderId[] = ["fi", "lol", "al"];

type Health = { fails: number; until: number; lastOk: number };
const health = new Map<ProviderId, Health>();
const observations = new Map<string, Observation[]>();
const tracks = new Map<string, TrackState>();
const lastAround = new Map<string, { at: number; ac: AdsbRaw[] }>();

export function resetFusion() {
  health.clear();
  observations.clear();
  tracks.clear();
  lastAround.clear();
}

export function providerHealthy(id: ProviderId, now = Date.now()): boolean {
  const h = health.get(id);
  if (!h) return true;
  return now >= h.until;
}

export function markProviderOk(id: ProviderId, now = Date.now()) {
  health.set(id, { fails: 0, until: 0, lastOk: now });
}

export function markProviderFail(id: ProviderId, now = Date.now()) {
  const prev = health.get(id);
  const fails = (prev?.fails ?? 0) + 1;
  const wait = fails === 1 ? 6_000 : fails === 2 ? 15_000 : 40_000;
  health.set(id, { fails, until: now + wait, lastOk: prev?.lastOk ?? 0 });
}

export function acList(data: unknown): AdsbRaw[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { ac?: AdsbRaw[]; aircraft?: AdsbRaw[] };
  const list = d.ac ?? d.aircraft ?? [];
  return Array.isArray(list) ? list : [];
}

export function seenOf(a: AdsbRaw | Observation | null | undefined): number {
  if (!a) return 999;
  if ("seen" in a && typeof (a as Observation).receivedAt === "number" && "provider" in a) {
    return Number.isFinite((a as Observation).seen) ? (a as Observation).seen : 999;
  }
  const raw = a as AdsbRaw;
  const s = typeof raw.seen_pos === "number" ? raw.seen_pos : typeof raw.seen === "number" ? raw.seen : null;
  return s != null && Number.isFinite(s) ? s : 999;
}

export function coordsOk(lat: unknown, lon: unknown): lat is number {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

function onGroundOf(alt: number | "ground" | null): boolean {
  return alt === "ground" || alt === 0;
}

export function ageOf(obs: Observation, now: number): number {
  return Math.max(0, obs.seen + (now - obs.receivedAt) / 1000);
}

export function isStaleObs(obs: Observation, now: number, airside = false): boolean {
  const age = ageOf(obs, now);
  if (onGroundOf(obs.altBaro)) return age > STALE_GROUND_SEC;
  if (airside) return age > STALE_AIR_SEC;
  const cruise =
    (obs.gs ?? 0) >= 180 ||
    (typeof obs.altBaro === "number" && obs.altBaro > 15_000) ||
    (typeof obs.raw.alt_geom === "number" && obs.raw.alt_geom > 15_000);
  return age > (cruise ? STALE_ENROUTE_SEC : STALE_AIR_SEC);
}

export function isTeleport(
  prev: { lat: number; lon: number; gs: number | null; at: number },
  obs: { lat: number; lon: number; gs: number | null; receivedAt?: number },
  now: number,
): boolean {
  const t1 = obs.receivedAt ?? now;
  const dt = Math.max(0.25, (t1 - prev.at) / 1000);
  const dist = haversineNm(prev, obs);
  if (dt <= 3 && dist > TELEPORT_NM_FAST) return true;
  if (dt <= 6 && dist > TELEPORT_NM) return true;
  const gs = Math.max(prev.gs ?? 0, obs.gs ?? 0, 0);
  const expected = (gs / 3600) * dt;
  const cap = Math.max(TELEPORT_NM, expected * 2.6 + 1.2);
  if (dist > cap && dist > TELEPORT_NM_FAST) return true;
  return false;
}

function completeness(obs: Observation): number {
  let s = 0;
  if (String(obs.raw.flight ?? "").trim()) s += 4;
  if (obs.altBaro != null) s += 2;
  else if (typeof obs.raw.alt_geom === "number" && obs.raw.alt_geom > 0) s += 2;
  if (obs.gs != null) s += 1;
  if (obs.track != null) s += 1;
  if (obs.raw.r) s += 1;
  return s;
}

export function scoreObservation(
  obs: Observation,
  prev: TrackState | null,
  now: number,
  airside = false,
): number | null {
  if (!coordsOk(obs.lat, obs.lon)) return null;
  if (isStaleObs(obs, now, airside)) return null;
  // A projected point is a guess, and must never veto a real provider fix.
  if (prev && !prev.extrapolated && isTeleport(prev, obs, now)) return null;
  const age = ageOf(obs, now);
  let score = 80 - age * 8;
  score += completeness(obs);
  if (prev && !prev.extrapolated) {
    const dist = haversineNm(prev, obs);
    score += Math.max(0, 6 - dist * 4);
  }
  const h = health.get(obs.provider);
  if (h && h.fails > 0 && now < h.until) score -= 12;
  return score;
}

export function rawToObservation(raw: AdsbRaw, provider: ProviderId, receivedAt: number): Observation | null {
  const hex = String(raw.hex ?? "").toLowerCase();
  const lat = raw.lat;
  const lon = raw.lon;
  if (!hex || !coordsOk(lat, lon)) return null;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const alt = raw.alt_baro === "ground" || typeof raw.alt_baro === "number" ? raw.alt_baro : null;
  return {
    hex,
    provider,
    lat,
    lon,
    altBaro: alt,
    gs: typeof raw.gs === "number" ? raw.gs : typeof raw.spd === "number" ? raw.spd : null,
    track: typeof raw.track === "number" ? raw.track : null,
    seen: seenOf(raw),
    receivedAt,
    raw: { ...raw, hex },
  };
}

function rememberObs(obs: Observation) {
  const list = observations.get(obs.hex) ?? [];
  list.push(obs);
  const cut = obs.receivedAt - 90_000;
  const kept = list.filter((o) => o.receivedAt >= cut).slice(-12);
  observations.set(obs.hex, kept);
}

function fusedRaw(obs: Observation, extra: { extrapolated: boolean; ageSec: number; lat: number; lon: number }): AdsbRaw {
  return {
    ...obs.raw,
    hex: obs.hex,
    lat: extra.lat,
    lon: extra.lon,
    extrapolated: extra.extrapolated,
    _fusion: { provider: obs.provider, extrapolated: extra.extrapolated, ageSec: extra.ageSec },
  };
}

function commitTrack(hex: string, raw: AdsbRaw, provider: ProviderId, now: number, extrapolated: boolean): AdsbRaw {
  const state: TrackState = {
    hex,
    lat: raw.lat as number,
    lon: raw.lon as number,
    gs: typeof raw.gs === "number" ? raw.gs : null,
    track: typeof raw.track === "number" ? raw.track : null,
    altBaro: raw.alt_baro === "ground" || typeof raw.alt_baro === "number" ? raw.alt_baro : null,
    at: now,
    provider,
    extrapolated,
    raw,
  };
  tracks.set(hex, state);
  return raw;
}

export function maybeExtrapolate(prev: TrackState, now: number, airside = false): AdsbRaw | null {
  // Do not repeatedly coast a coasted point: doing so resets the gap clock.
  if (prev.extrapolated) return null;
  const dt = (now - prev.at) / 1000;
  if (dt <= 0.15) {
    return { ...prev.raw, extrapolated: false, _fusion: { provider: prev.provider, extrapolated: false, ageSec: 0 } };
  }
  const cruise = !onGroundOf(prev.altBaro) && ((prev.gs ?? 0) >= 180 || (typeof prev.altBaro === "number" && prev.altBaro > 15_000));
  const maxGap = airside || !cruise ? GAP_EXTRAPOLATE_SEC : GAP_EXTRAPOLATE_ENROUTE_SEC;
  if (dt + (prev.raw._fusion?.ageSec ?? 0) > maxGap) return null;
  if (prev.gs == null || prev.gs < 40 || prev.track == null || !Number.isFinite(prev.track)) return null;
  if (onGroundOf(prev.altBaro)) return null;
  const moved = destPoint({ lat: prev.lat, lon: prev.lon }, prev.track, (prev.gs / 3600) * dt);
  const raw: AdsbRaw = {
    ...prev.raw,
    lat: moved.lat,
    lon: moved.lon,
    extrapolated: true,
    _fusion: { provider: prev.provider, extrapolated: true, ageSec: dt },
  };
  return commitTrack(prev.hex, raw, prev.provider, now, true);
}

export function chooseBest(
  hex: string,
  now: number,
  airside = false,
): AdsbRaw | null {
  const list = observations.get(hex) ?? [];
  const prev = tracks.get(hex) ?? null;
  const freshCut = now - 1500;
  let best: { obs: Observation; score: number } | null = null;
  let bestAny: { obs: Observation; score: number } | null = null;
  for (const obs of list) {
    const s = scoreObservation(obs, prev, now, airside);
    if (s == null) continue;
    if (obs.receivedAt >= freshCut && (!best || s > best.score)) best = { obs, score: s };
    if (!bestAny || s > bestAny.score) bestAny = { obs, score: s };
  }
  if (best) {
    const age = ageOf(best.obs, now);
    const raw = fusedRaw(best.obs, { extrapolated: false, ageSec: age, lat: best.obs.lat, lon: best.obs.lon });
    return commitTrack(hex, raw, best.obs.provider, now, false);
  }
  if (prev) {
    const extra = maybeExtrapolate(prev, now, airside);
    if (extra) return extra;
  }
  if (bestAny) {
    const age = ageOf(bestAny.obs, now);
    const raw = fusedRaw(bestAny.obs, { extrapolated: false, ageSec: age, lat: bestAny.obs.lat, lon: bestAny.obs.lon });
    return {
      ...raw,
      _fusion: { provider: bestAny.obs.provider, extrapolated: false, ageSec: age },
    };
  }
  if (prev) {
    const age = (now - prev.at) / 1000 + (prev.raw._fusion?.ageSec ?? 0);
    const keep = airside || onGroundOf(prev.altBaro) ? STALE_KEEP_SEC : STALE_KEEP_ENROUTE_SEC;
    if (age <= keep) {
      return {
        ...prev.raw,
        extrapolated: prev.extrapolated,
        _fusion: { provider: prev.provider, extrapolated: prev.extrapolated, ageSec: age },
      };
    }
  }
  return null;
}

export type ProviderPack = { provider: ProviderId; ac: AdsbRaw[] };

export function fuseProviderLists(packs: ProviderPack[], opts?: { now?: number; airside?: boolean }): AdsbRaw[] {
  const now = opts?.now ?? Date.now();
  const airside = Boolean(opts?.airside);
  const hexes = new Set<string>();
  for (const pack of packs) {
    for (const raw of pack.ac ?? []) {
      const obs = rawToObservation(raw, pack.provider, now);
      if (!obs) continue;
      rememberObs(obs);
      hexes.add(obs.hex);
    }
  }
  if (hexes.size === 0) {
    for (const [hex, prev] of tracks) {
      const keep = airside || onGroundOf(prev.altBaro) ? STALE_KEEP_SEC : STALE_KEEP_ENROUTE_SEC;
      if ((now - prev.at) / 1000 <= keep) hexes.add(hex);
    }
  }
  const out: AdsbRaw[] = [];
  for (const hex of hexes) {
    const chosen = chooseBest(hex, now, airside);
    if (chosen) out.push(chosen);
  }
  return out;
}

export function stickyPick(
  lockedHex: string | null,
  candidates: AdsbRaw[],
  opts: { isExact: (raw: AdsbRaw) => boolean; now?: number },
): AdsbRaw | null {
  if (!candidates.length) return null;
  const now = opts.now ?? Date.now();
  const locked = lockedHex
    ? candidates.find((c) => String(c.hex ?? "").toLowerCase() === lockedHex.toLowerCase())
    : null;
  const exacts = candidates.filter((c) => opts.isExact(c));
  const lockedAge = locked ? (locked._fusion?.ageSec ?? seenOf(locked)) : 999;
  const lockedOk = Boolean(locked && coordsOk(locked.lat, locked.lon) && lockedAge <= STALE_AIR_SEC);
  if (lockedOk) {
    const better = exacts.find((c) => String(c.hex ?? "").toLowerCase() !== lockedHex!.toLowerCase());
    if (!better) return locked!;
    const betterAge = better._fusion?.ageSec ?? seenOf(better);
    if (lockedAge <= 20) return locked!;
    if (betterAge + 4 >= lockedAge) return locked!;
    if (coordsOk(locked!.lat, locked!.lon) && coordsOk(better.lat, better.lon)) {
      const jump = haversineNm(
        { lat: locked!.lat as number, lon: locked!.lon as number },
        { lat: better.lat as number, lon: better.lon as number },
      );
      if (jump > 40) return locked!;
    }
    return better;
  }
  if (exacts.length) return exacts[0];
  if (locked && lockedAge <= STALE_KEEP_SEC) return locked;
  return null;
}

async function fetchJson(url: string, ms: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (res.status === 429) throw new Error("upstream 429");
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

export async function fetchProvider(id: ProviderId, url: string, now = Date.now()): Promise<AdsbRaw[]> {
  if (!providerHealthy(id, now)) return [];
  try {
    const json = await fetchJson(url, PROVIDERS[id].timeoutMs);
    markProviderOk(id, now);
    return acList(json);
  } catch {
    markProviderFail(id, now);
    return [];
  }
}

export async function fetchAround(lat: number, lon: number, dist: number): Promise<ProviderPack[]> {
  const now = Date.now();
  const packs = await Promise.all(
    PROVIDER_ORDER.map(async (id) => ({
      provider: id,
      ac: await fetchProvider(id, PROVIDERS[id].around(lat, lon, dist), now),
    })),
  );
  return packs;
}

export async function fetchByHex(hex: string): Promise<ProviderPack[]> {
  const id = hex.toLowerCase();
  const now = Date.now();
  return Promise.all(
    PROVIDER_ORDER.map(async (p) => ({
      provider: p,
      ac: await fetchProvider(p, PROVIDERS[p].hex(id), now),
    })),
  );
}

export async function fetchByCallsign(callsign: string): Promise<ProviderPack[]> {
  const u = callsign.replace(/\s/g, "").toUpperCase();
  const now = Date.now();
  return Promise.all(
    PROVIDER_ORDER.map(async (p) => ({
      provider: p,
      ac: await fetchProvider(p, PROVIDERS[p].callsign(u), now),
    })),
  );
}

export async function fetchByReg(reg: string): Promise<ProviderPack[]> {
  const u = reg.replace(/[-\s]/g, "").toUpperCase();
  const now = Date.now();
  return Promise.all(
    PROVIDER_ORDER.map(async (p) => ({
      provider: p,
      ac: await fetchProvider(p, PROVIDERS[p].registration(u), now),
    })),
  );
}

export function rememberAround(key: string, ac: AdsbRaw[], now = Date.now()) {
  if (ac.length) lastAround.set(key, { at: now, ac });
}

export function lastGoodAround(key: string, now = Date.now()): AdsbRaw[] | null {
  const hit = lastAround.get(key);
  if (!hit) return null;
  if (now - hit.at > 20_000) return null;
  return hit.ac;
}
