export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let k = start; k < raw.length; k++) {
    const ch = raw[k]!;
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, k + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function faAltFt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v > 1000 ? v : v * 100;
}

// "Departed" can mean off-block / taxi-out, before wheels-up.
export function hasAirborneStatus(status: string | null | undefined): boolean {
  return /^(airborne|en[ -]?route|climbed)$/i.test(status?.trim() ?? "");
}

export function hasAirborneEvidence(aware: {
  status?: string | null;
  takeoff?: { actual?: number | null; estimated?: number | null; scheduled?: number | null } | null;
  landing?: { actual?: number | null } | null;
} | null, now = Date.now() / 1000): boolean {
  if (!aware || aware.landing?.actual) return false;
  const takeoff = aware.takeoff?.actual;
  if (typeof takeoff === "number" && Number.isFinite(takeoff)) return takeoff > 0 && takeoff <= now + 30;
  // Providers can label a flight airborne at gate departure. Estimated clocks
  // are not wheels-up evidence; fresh aircraft observations are checked separately.
  return false;
}

export function timeFracOf(aware: {
  status?: string | null;
  takeoff?: { actual?: number | null; estimated?: number | null; scheduled?: number | null } | null;
  landing?: { actual?: number | null; estimated?: number | null; scheduled?: number | null } | null;
  gateOut?: { actual?: number | null } | null;
}): number {
  const air = hasAirborneStatus(aware?.status);
  const to = aware?.takeoff?.actual
    ?? (air ? (aware?.takeoff?.estimated ?? aware?.takeoff?.scheduled ?? aware?.gateOut?.actual) : null);
  if (!to) return 0;
  if (aware.landing?.actual) return 1;
  const ld = aware.landing?.estimated ?? aware.landing?.scheduled;
  const now = Date.now() / 1e3;
  if (now + 30 < to) return 0;
  if (!ld || ld <= to) return Math.max(0.04, Math.min(0.92, (now - to) / 7200));
  return Math.max(0.02, Math.min(0.98, (now - to) / (ld - to)));
}

type FaTrackPt = {
  t?: number;
  lat?: number;
  lon?: number;
  alt?: number | null;
  gs?: number | null;
  track?: number | null;
  ground?: boolean;
};

export function liveFromAware(aware: {
  hex?: string | null;
  ident?: string | null;
  tail?: string | null;
  type?: string | null;
  gsKt?: number | null;
  heading?: number | null;
  altFt?: number | null;
  faTrack?: FaTrackPt[] | null;
} | null): {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  track: number | null;
  onGround: boolean;
  phase: string;
  extrapolated: boolean;
  seenSec: number;
} | null {
  if (!aware) return null;
  const pts = Array.isArray(aware.faTrack) ? aware.faTrack : [];
  let last: FaTrackPt | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    if (p && typeof p.lat === "number" && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lon === "number" && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 && typeof p.t === "number" && Number.isFinite(p.t) && p.t > 0 && p.t <= Date.now() / 1000 + 30) {
      last = p;
      break;
    }
  }
  if (!last || typeof last.lat !== "number" || typeof last.lon !== "number") return null;
  const now = Date.now() / 1e3;
  const age = Math.max(0, now - last.t!);
  if (age > 20 * 60) return null;
  let lat = last.lat;
  let lon = last.lon;
  const gs = last.gs ?? aware.gsKt ?? null;
  const hdg = last.track ?? aware.heading ?? null;
  const altFt = last.alt ?? aware.altFt ?? null;
  const onGround = Boolean(last.ground) || ((altFt == null || altFt < 50) && (gs == null || gs < 40));
  return {
    hex: String(aware.hex || "").toLowerCase(),
    callsign: String(aware.ident || "").replace(/\s/g, "").toUpperCase() || null,
    registration: aware.tail ?? null,
    type: aware.type ?? null,
    lat,
    lon,
    altFt,
    gsKt: gs,
    track: hdg,
    onGround,
    phase: onGround ? ((gs ?? 0) >= 2 ? "taxi" : "parked") : ((altFt ?? 0) < 10000 ? "climb" : "cruise"),
    extrapolated: false,
    seenSec: age,
  };
}
