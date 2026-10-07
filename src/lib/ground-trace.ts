import { haversineNm } from "./geo.ts";
export type GroundTracePosition = {
  lat: number; lon: number; altFt: number | null; gsKt: number | null; track: number | null;
  onGround: true; seenAt: number; registration: string | null; callsign: string | null; provider: "adsb";
};

/** Trace timestamps are absolute source observations, never the time a cache is read. */
export function parseRecentGroundTrace(
  payload: unknown,
  airport: { lat: number; lon: number },
  identity: { registration: string | null; callsign: string | null },
  now = Date.now(),
): GroundTracePosition | null {
  const value = payload as { timestamp?: number; trace?: unknown[][] } | null;
  const base = typeof value?.timestamp === "number" ? value.timestamp : 0;
  const rows = Array.isArray(value?.trace) ? value.trace : [];
  return rows.flatMap((row) => {
    const offset = typeof row?.[0] === "number" ? row[0] : 0;
    const lat = row?.[1], lon = row?.[2], altRaw = row?.[3], gsRaw = row?.[4], trackRaw = row?.[5];
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    const seenAt = base + offset;
    const ageSec = now / 1000 - seenAt;
    if (!Number.isFinite(ageSec) || ageSec < -10 || ageSec > 120) return [];
    const gsKt = typeof gsRaw === "number" ? gsRaw : null;
    const ground = altRaw === "ground" || altRaw === 0 || altRaw === "0"
      || (typeof altRaw === "number" && altRaw <= 50 && (gsKt ?? 999) <= 80);
    if (!ground || haversineNm({ lat, lon }, airport) > 20) return [];
    return [{
      lat, lon, altFt: typeof altRaw === "number" && altRaw > 0 ? altRaw : 0, gsKt,
      track: typeof trackRaw === "number" && trackRaw >= 0 && trackRaw <= 360 ? trackRaw : null,
      onGround: true as const, seenAt, ...identity, provider: "adsb" as const,
    }];
  }).sort((a, b) => b.seenAt - a.seenAt)[0] ?? null;
}
