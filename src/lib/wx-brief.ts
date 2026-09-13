import type { Chop, Hazard, RouteSample } from "./types";
import type { Taf } from "./metar";

/** AWC bbox order is south,west,north,east. Split routes across the dateline. */
export function pirepRouteBounds(path: { lat: number; lon: number }[]): string[] {
  const points = path.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  if (!points.length) return [];
  const south = Math.max(-90, Math.floor(Math.min(...points.map(p => p.lat)) - 2));
  const north = Math.min(90, Math.ceil(Math.max(...points.map(p => p.lat)) + 2));
  const west = Math.min(...points.map(p => p.lon));
  const east = Math.max(...points.map(p => p.lon));
  const pad = 2 / Math.max(0.1, Math.cos(Math.max(Math.abs(south), Math.abs(north)) * Math.PI / 180));
  if (east - west > 180) {
    const positive = points.filter(p => p.lon >= 0);
    const negative = points.filter(p => p.lon < 0);
    return [
      `${south},${Math.max(-180, Math.floor(Math.min(...positive.map(p => p.lon)) - pad))},${north},180`,
      `${south},-180,${north},${Math.min(180, Math.ceil(Math.max(...negative.map(p => p.lon)) + pad))}`,
    ];
  }
  return [`${south},${Math.max(-180, Math.floor(west - pad))},${north},${Math.min(180, Math.ceil(east + pad))}`];
}

export type WxDigest = {
  at: number;
  hash: string;
  worstChop: Chop;
  ride: string;
  convective: boolean;
  pirepCount: number;
  originCat: string;
  destCat: string;
  originTaf: string | null;
  destTaf: string | null;
  corridor: { iata: string; summary: string }[];
  hazardLabels: string[];
};

export type WxBrief = {
  filedAt: number;
  filed: WxDigest;
  live: WxDigest;
  deltas: string[];
  hash: string;
};

const filedWxByFlight = new Map<string, WxDigest>();

export function resetFiledWx() {
  filedWxByFlight.clear();
}

export function worseChop(a: Chop, b: Chop): Chop {
  const rank: Record<Chop, number> = { smooth: 0, light: 1, moderate: 2, severe: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/** Estimate sample altitude along the remaining filed track. */
export function sampleAltFt(frac: number, remainingNm: number, liveAlt: number | null | undefined): number {
  const cruise = liveAlt != null && liveAlt > 18_000 ? liveAlt : 35_000;
  if (remainingNm < 6) return Math.min(2_000, liveAlt ?? 2_000);
  if (remainingNm < 25) return 6_000;
  if (remainingNm < 55) return 12_000;
  if (remainingNm < 90) return 18_000;
  if (frac < 0.04) return 5_000;
  if (frac < 0.1) return 16_000;
  if (frac < 0.16) return 26_000;
  return cruise;
}

/** Match a route sample to the advisory's actual or forecast validity window. */
export function advisoryValidAt(properties: Record<string, unknown> | null | undefined, atUnix: number): boolean {
  if (!properties || !Number.isFinite(atUnix)) return true;
  const parse = (value: unknown): number | null => {
    if (typeof value !== "string") return null;
    const compact = value.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/);
    const millis = Date.parse(compact
      ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:00Z`
      : value);
    return Number.isFinite(millis) ? millis / 1000 : null;
  };
  const from = parse(properties.validTimeFrom);
  const to = parse(properties.validTimeTo);
  if (from != null || to != null) return (from == null || atUnix >= from) && (to == null || atUnix <= to);
  const forecast = parse(properties.validTime);
  if (forecast == null) return true;
  // G-AIRMETs are three-hourly snapshots; TCF is a shorter valid-hour forecast.
  const tolerance = properties.data === "tcf" ? 60 * 60 : 90 * 60;
  return Math.abs(atUnix - forecast) <= tolerance;
}

/** G-AIRMET top/base are usually flight levels ("210") or "SFC". */
export function bandFt(base: unknown, top: unknown): { lo: number; hi: number } {
  const parse = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const s = String(v).toUpperCase().trim();
    if (s === "SFC" || s === "GND" || s === "SURFACE") return 0;
    const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
    if (!Number.isFinite(n)) return null;
    if (n <= 600) return n * 100;
    return n;
  };
  return { lo: parse(base) ?? 0, hi: parse(top) ?? 45_000 };
}

export function altOverlaps(sampleAlt: number, lo: number, hi: number, pad = 2_000): boolean {
  return sampleAlt >= lo - pad && sampleAlt <= hi + pad;
}

export function gairmetChop(hazard: string, severity?: string | null): Chop | null {
  const h = String(hazard || "").toUpperCase();
  const sev = String(severity || "").toUpperCase();
  let fromSev: Chop | null = null;
  if (sev.includes("SEV") || sev.includes("EXT")) fromSev = "severe";
  else if (sev.includes("MOD")) fromSev = "moderate";
  else if (sev.includes("LGT") || sev.includes("ISOL") || sev.includes("LIGHT")) fromSev = "light";
  if (h === "TURB-HI") return fromSev ?? "moderate";
  if (h === "TURB-LO") return fromSev ?? "light";
  if (h === "LLWS") return "light";
  return null;
}

/** High-alt AIRMET/SIGMET should not paint the arrival at 3,000 ft. */
export function gairmetApplies(hazard: string, props: { base?: unknown; top?: unknown } | null | undefined, sampleAlt: number): boolean {
  const h = String(hazard || "").toUpperCase();
  if (h === "LLWS") return sampleAlt <= 4_000;
  if (h === "IFR" || h === "MT_OBSC") return sampleAlt <= 12_000;
  const { lo, hi } = bandFt(props?.base, props?.top);
  if (h === "TURB-HI" && (lo > 0 || hi < 45_000)) return altOverlaps(sampleAlt, lo || 18_000, hi);
  if (h === "TURB-LO" && (lo > 0 || hi < 45_000 || String(props?.base || "").toUpperCase() === "SFC")) {
    return altOverlaps(sampleAlt, lo, hi || 18_000);
  }
  if (h === "TURB-HI") return sampleAlt >= 16_000;
  if (h === "TURB-LO") return sampleAlt <= 20_000;
  return altOverlaps(sampleAlt, lo, hi);
}

export function pirepChop(tb: string): Chop | null {
  const t = (tb ?? "").toUpperCase();
  if (!t) return null;
  if (t.includes("SEV") || t.includes("EXT")) return "severe";
  if (t.includes("MOD")) return "moderate";
  if (t.includes("LGT") || t.includes("LIGHT")) return "light";
  return null;
}

export function pirepAltFt(props: Record<string, unknown> | null | undefined, raw = ""): number | null {
  const p = props ?? {};
  const candidates = [p.fltLvl, p.fltlvl, p.fltlvl1, p.altitude, p.alt, p.fl];
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const s = String(c).toUpperCase();
    if (s === "SFC") return 0;
    const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
    if (!Number.isFinite(n)) continue;
    if (n <= 600) return n * 100;
    return n;
  }
  const m = String(raw).toUpperCase().match(/\bFL?\s?(\d{2,3})\b/);
  if (m) return parseInt(m[1], 10) * 100;
  return null;
}

export function pirepMatchesSample(
  pirep: { lat: number; lon: number; altFt: number | null },
  sample: { lat: number; lon: number; altFt: number },
  distNm: number,
  maxNm = 42,
  altPad = 8_000,
): boolean {
  if (distNm > maxNm) return false;
  if (pirep.altFt == null) return distNm <= Math.min(28, maxNm);
  return Math.abs(pirep.altFt - sample.altFt) <= altPad;
}

export function rideFromChop(chop: Chop, storms: boolean): string {
  let ride = "Smooth ride";
  if (chop === "severe") ride = "Severe chop";
  else if (chop === "moderate") ride = "Moderate chop";
  else if (chop === "light") ride = "Light chop";
  if (storms) ride = `${ride}. Storms on the path`;
  return ride;
}

export function wxHashOf(d: Omit<WxDigest, "at" | "hash">): string {
  return [
    d.worstChop,
    d.convective ? "ts" : "clear",
    `p${d.pirepCount}`,
    d.originCat,
    d.destCat,
    d.originTaf ?? "",
    d.destTaf ?? "",
    d.hazardLabels.slice(0, 8).join(","),
  ].join("|");
}

export function digestWx(args: {
  samples: Pick<RouteSample, "chop" | "convective" | "frac">[];
  hazards: Pick<Hazard, "kind" | "chop" | "label" | "remaining">[];
  originCat: string;
  destCat: string;
  originTaf?: string | null;
  destTaf?: string | null;
  corridor?: { iata: string; summary: string }[];
  progress?: number;
  at?: number;
}): WxDigest {
  const progress = args.progress ?? 0;
  const ahead = args.samples.filter((s) => s.frac >= progress);
  const worst = ahead.reduce((acc, s) => worseChop(acc, s.chop), "smooth" as Chop);
  const convective = ahead.some((s) => s.convective);
  const remainingHaz = args.hazards.filter((h) => h.remaining);
  const pirepCount = remainingHaz.filter((h) => h.kind === "pirep").length;
  const hazardLabels = [...new Set(remainingHaz.map((h) => h.label))].slice(0, 8);
  const body = {
    worstChop: worst,
    ride: rideFromChop(worst, convective),
    convective,
    pirepCount,
    originCat: args.originCat,
    destCat: args.destCat,
    originTaf: args.originTaf ?? null,
    destTaf: args.destTaf ?? null,
    corridor: args.corridor ?? [],
    hazardLabels,
  };
  return { at: args.at ?? Date.now(), hash: wxHashOf(body), ...body };
}

export function rememberFiledWx(key: string, live: WxDigest): WxDigest {
  const prev = filedWxByFlight.get(key);
  if (prev) return prev;
  filedWxByFlight.set(key, live);
  return live;
}

export function wxDeltas(filed: WxDigest, live: WxDigest): string[] {
  const bits: string[] = [];
  if (filed.worstChop !== live.worstChop) {
    bits.push(`ride call moved from ${filed.ride.split(".")[0].toLowerCase()} to ${live.ride.split(".")[0].toLowerCase()}`);
  }
  if (!filed.convective && live.convective) bits.push("thunderstorms now clip the remaining path");
  if (filed.convective && !live.convective) bits.push("the storm SIGMET dropped off the remaining path");
  if (live.pirepCount > filed.pirepCount) bits.push("a new chop PIREP showed up on the remaining route");
  if (filed.originCat !== live.originCat) bits.push(`departure weather is now ${live.originCat}`);
  if (filed.destCat !== live.destCat) bits.push(`arrival weather is now ${live.destCat}`);
  if ((filed.destTaf ?? "") !== (live.destTaf ?? "") && live.destTaf) bits.push("the arrival TAF changed");
  const newHaz = live.hazardLabels.filter((l) => !filed.hazardLabels.includes(l));
  if (newHaz.length) bits.push(newHaz[0].toLowerCase());
  return bits.slice(0, 3);
}

export function decodeTafPassenger(taf: Taf | null | undefined, whenUnix?: number | null): string | null {
  try {
    if (!taf) return null;
    const fcsts = Array.isArray(taf.fcsts) ? taf.fcsts : [];
    const when = whenUnix ?? Date.now() / 1e3;
    const active = fcsts.filter((f) => (f.timeFrom ?? 0) <= when && (f.timeTo ?? Infinity) > when);
    const next = fcsts.find((f) => (f.timeFrom ?? 0) > when);
    if (fcsts.length && !active.length && !next) return null;
    const covering = active[0] ?? next ?? null;
    const relevant = active.length ? active : covering ? [covering] : [];
    const bits: string[] = [];
    const raw = String(taf.rawTAF ?? "").toUpperCase();
    const wx = relevant.map((f) => String(f.wxString ?? "")).join(" ").toUpperCase();
    const blob = fcsts.length ? wx : raw;
    if (/\b(?:VC)?TS[A-Z]*\b|TEMPO[^\n]{0,40}TS|PROB\d{2}[^\n]{0,40}TS/.test(blob)) bits.push("thunderstorms in the forecast");
    else if (/\bFG\b|\bBR\b/.test(wx) || (!fcsts.length && /TEMPO[^\n]{0,30}(FG|BR)/.test(raw))) bits.push("fog or mist");
    else if (/\bSN\b|BLSN/.test(blob)) bits.push("snow");
    else if (/\bRA\b|\bSHRA\b/.test(wx)) bits.push("rain");
    const vis = covering?.visib;
    if (vis != null) {
      const n = parseFloat(String(vis).replace("+", ""));
      if (Number.isFinite(n) && n <= 3 && !String(vis).includes("+")) bits.push(`visibility about ${n} mile${n === 1 ? "" : "s"}`);
    }
    const clouds = Array.isArray(covering?.clouds) ? covering.clouds : [];
    const ceil = clouds
      .filter((c) => c.base && ["BKN", "OVC", "VV"].includes(c.cover))
      .map((c) => c.base as number)
      .sort((a, b) => a - b)[0];
    if (ceil != null && ceil < 1000) bits.push(`ceiling ${ceil} ft`);
    else if (ceil != null && ceil < 3000) bits.push(`ceiling around ${ceil} ft`);
    const spd = covering?.wspd;
    const gst = covering?.wgst;
    if ((gst ?? 0) >= 25 || (spd ?? 0) >= 20) bits.push(gst ? `wind ${spd} gusting ${gst} kt` : `wind ${spd} kt`);
    if (relevant.some((f) => f.fcstChange === "TEMPO")) bits.push("temporary conditions possible");
    if (covering?.probability && covering.probability >= 30) bits.push(`${covering.probability}% chance`);
    if (!bits.length) {
      if (/SKC|CLR|NSC|SCT2/.test(raw) && !/BKN00|OVC00|FG|TS/.test(raw)) return "No significant weather indicated in the forecast";
      return null;
    }
    return bits.slice(0, 3).join(", ");
  } catch {
    return null;
  }
}

export function corridorStations<T extends { iata: string; lat: number; lon: number }>(
  path: { lat: number; lon: number }[],
  originIata: string,
  destIata: string,
  airports: T[],
  distNm: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number,
): T[] {
  if (path.length < 3) return [];
  const hits: { ap: T; d: number; idx: number }[] = [];
  for (const ap of airports) {
    if (ap.iata === originIata || ap.iata === destIata) continue;
    let best = Infinity;
    let idx = 0;
    for (let i = 0; i < path.length; i++) {
      const d = distNm(path[i], ap);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    if (best < 48) hits.push({ ap, d: best, idx });
  }
  hits.sort((a, b) => a.idx - b.idx);
  const picked: T[] = [];
  let lastIdx = -99;
  for (const h of hits) {
    if (h.idx - lastIdx < path.length / 6 && picked.length) continue;
    picked.push(h.ap);
    lastIdx = h.idx;
    if (picked.length >= 3) break;
  }
  return picked;
}
