import { haversineNm, type Coord } from "./geo.ts";
import type { Traffic } from "./types.ts";

export type PhaseSample = { seenAt: number; altFt?: number | null; vertFpm?: number | null; onGround?: boolean | null; lat?: number; lon?: number };
export type PhaseContext = { origin?: Coord & { elevationFt?: number }; dest?: Coord & { elevationFt?: number }; history?: PhaseSample[]; groundTaxiKt?: number };
type Aircraft = Partial<PhaseSample> & { gsKt?: number | null; extrapolated?: boolean; seenSec?: number | null; phaseVertFpm?: number | null };

/** Route geometry prevents a departure descent from becoming an arrival. */
export function destinationContext(ac: Aircraft, context: PhaseContext): boolean {
  if (!context.dest || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return false;
  const here = ac as Coord, toDest = haversineNm(here, context.dest);
  const fromOrigin = context.origin ? haversineNm(here, context.origin) : Infinity;
  return (fromOrigin > 15 || toDest < fromOrigin)
    && (toDest <= 40 || (toDest <= 100 && toDest < fromOrigin));
}

/** Raw rates remain display measurements; phase needs >=30s of evidence.
 * Repeated timestamps, stale/extrapolated fixes and turbulence do not confirm it. */
export function verticalTrend(ac: Aircraft, history: PhaseSample[] = []) {
  const none = { phaseVertFpm: null as number | null, phaseRateWindowSec: 0, phaseRateSource: null as "altitude-delta" | "sustained-provider" | null };
  if (ac.onGround || ac.extrapolated || (ac.seenSec ?? 0) > 60 || !Number.isFinite(ac.seenAt)) return none;
  const now = ac.seenAt!;
  const recent = history.filter(p => !p.onGround && Number.isFinite(p.seenAt) && now - p.seenAt >= 0 && now - p.seenAt <= 120
    && (!Number.isFinite(p.lat) || !Number.isFinite(ac.lat) || haversineNm(p as Coord, ac as Coord) <= 30))
    .sort((a, b) => b.seenAt - a.seenAt);
  const prior = recent.find(p => now - p.seenAt >= 30 && Number.isFinite(p.altFt));
  if (prior && Number.isFinite(ac.altFt)) {
    const span = now - prior.seenAt;
    const rate = (ac.altFt! - prior.altFt!) * 60 / span;
    // Altitude evidence wins when a provider rate disagrees with net movement.
    return { phaseVertFpm: Math.abs(rate) >= 300 ? rate : null, phaseRateWindowSec: span, phaseRateSource: "altitude-delta" as const };
  }
  const rates = [...recent, ac as PhaseSample].filter(p => Number.isFinite(p.vertFpm));
  const span = rates.length ? now - Math.min(...rates.map(p => p.seenAt)) : 0;
  if (rates.length >= 2 && span >= 30 && Number.isFinite(ac.vertFpm) && Math.abs(ac.vertFpm!) >= 300
    && rates.every(p => Math.sign(p.vertFpm!) === Math.sign(ac.vertFpm!) && Math.abs(p.vertFpm!) >= 300))
    return { phaseVertFpm: rates.reduce((n, p) => n + p.vertFpm!, 0) / rates.length, phaseRateWindowSec: span, phaseRateSource: "sustained-provider" as const };
  return none;
}

/** One phase definition shared by provider adapters, stories and traffic. */
export function phaseOf(ac: Aircraft, context: PhaseContext = {}): Traffic["phase"] {
  if (ac.onGround) return (ac.gsKt ?? 0) > (context.groundTaxiKt ?? 8) ? "taxi" : "parked";
  const rate = ac.phaseVertFpm === undefined ? verticalTrend(ac, context.history).phaseVertFpm : ac.phaseVertFpm;
  const arriving = destinationContext(ac, context);
  const field = arriving ? context.dest : context.origin;
  const agl = ac.altFt == null ? null : ac.altFt - (field?.elevationFt ?? 0);
  if (rate != null && rate <= -300) return arriving && agl != null && agl < 8000 ? "approach" : "descent";
  if (rate != null && rate >= 300) return "climb";
  if (context.origin && Number.isFinite(ac.lat) && agl != null && agl < 12000
    && haversineNm(ac as Coord, context.origin) <= 50 && !arriving) return "climb";
  return "cruise";
}

/** Bounded warm-poll evidence, supplemented by existing tracks on cold starts. */
export function createPhaseHistory() {
  const samples = new Map<string, PhaseSample[]>();
  return (key: string, ac: Aircraft, context: PhaseContext = {}) => {
    const history = [...samples.get(key) ?? [], ...context.history ?? []];
    const trend = verticalTrend(ac, history);
    if (Number.isFinite(ac.seenAt) && !ac.extrapolated && (ac.seenSec ?? 0) <= 60) {
      const kept = history.filter(p => ac.seenAt! - p.seenAt >= 0 && ac.seenAt! - p.seenAt <= 120 && p.seenAt !== ac.seenAt);
      kept.push({ seenAt: ac.seenAt!, altFt: ac.altFt, vertFpm: ac.vertFpm, onGround: ac.onGround, lat: ac.lat, lon: ac.lon });
      const unique = [...new Map(kept.map(p => [p.seenAt, p])).values()].sort((a, b) => a.seenAt - b.seenAt).slice(-64);
      if (!samples.has(key) && samples.size >= 1000) samples.delete(samples.keys().next().value!);
      samples.set(key, unique);
    }
    return { ...trend, phase: phaseOf({ ...ac, ...trend }, context) };
  };
}
