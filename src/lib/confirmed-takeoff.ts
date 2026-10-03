import { parseFlightQuery } from "./flight-parse.ts";
import { identityCompatible } from "./flight-data.ts";
import { haversineNm } from "./geo.ts";
import { activeConfirmedTakeoff, mergeConfirmedTakeoff, type ConfirmedTakeoff, type TakeoffRevocation } from "./flight-phase-state-logic.ts";
import type { CanonicalFailure, LegSchedule } from "./flight-identity.ts";
import type { FlightStory } from "./types.ts";

export type TakeoffDiagnostic = { source: ConfirmedTakeoff["source"]; at: number | null; confirmedAt: number; observedAt?: number };
const beforeTakeoff = new Set(["inbound", "origin_gate", "push", "taxi", "takeoff_roll", "Takeoff roll"]);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A route/date failure is never evidence for the selected leg. A live,
 * route-validated schedule-less record may confirm observation, not a clock. */
export type TakeoffEvidenceArgs = {
  schedule: LegSchedule | null; key: string | null; reason: CanonicalFailure | null;
  now: number; deviceOnly?: boolean; groundElevationFt?: number; origin?: { lat: number; lon: number };
  expected: { callsigns: string[]; registration?: string | null; hex?: string | null };
  position?: { callsign?: string | null; registration?: string | null; hex?: string | null;
    lat: number; lon: number; altFt?: number | null; gsKt?: number | null;
    onGround: boolean; extrapolated?: boolean; seenSec?: number; seenAt?: number } | null;
};

function identifiedPosition(args: TakeoffEvidenceArgs): boolean {
  const p = args.position, expected = args.expected;
  if (!p || !identityCompatible(p, expected)) return false;
  const norm = (v?: string | null) => String(v ?? "").replace(/[-\s]/g, "").toUpperCase();
  const ident = parseFlightQuery(p.callsign ?? "")?.callsign;
  return Boolean(ident && expected.callsigns.some(c => parseFlightQuery(c)?.callsign === ident))
    || Boolean(expected.hex && p.hex && norm(expected.hex) === norm(p.hex))
    || Boolean(expected.registration && p.registration && norm(expected.registration) === norm(p.registration));
}

export function hasOriginSurfaceFix(args: TakeoffEvidenceArgs): boolean {
  const p = args.position;
  if (!p || !args.origin || p.extrapolated || p.onGround !== true || !identifiedPosition(args)
    || !finite(p.lat) || !finite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return false;
  const age = finite(p.seenAt) ? args.now - p.seenAt : p.seenSec;
  return finite(age) && age >= 0 && age <= 60 && haversineNm(p, args.origin) <= 15;
}

export function confirmTakeoff(args: TakeoffEvidenceArgs): ConfirmedTakeoff | undefined {
  const { schedule, key, reason, now, position: p } = args;
  if (args.deviceOnly || !key || (reason != null && reason !== "missing_scheduled")) return;
  const actual = schedule?.takeoff?.actual;
  const scheduled = schedule?.gateOut?.scheduled ?? schedule?.takeoff?.scheduled;
  // A provider clock needs the canonical route/service-date validation and
  // a plausible departure window. Device clocks never establish shared truth.
  const provider = key.startsWith("leg:v1:") && finite(actual) && actual > 0 && actual <= now
    && finite(scheduled) && actual >= scheduled - 6 * 3600 && actual <= scheduled + 30 * 3600 && !hasOriginSurfaceFix(args)
    ? { time: actual, source: "provider_actual" as const, confirmedAt: now } : undefined;
  if (finite(scheduled) && (now < scheduled - 5 * 60 || now > scheduled + 30 * 3600)) return provider;
  if (!p || p.extrapolated || p.onGround !== false || !finite(p.lat) || !finite(p.lon)
    || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || !identifiedPosition(args)) return provider;
  const age = finite(p.seenAt) ? now - p.seenAt : p.seenSec;
  if (!finite(age) || age < 0 || age > 45 || !((finite(p.altFt) && p.altFt - (args.groundElevationFt ?? 0) > 500)
    || (finite(p.gsKt) && p.gsKt > 80))) return provider;
  return mergeConfirmedTakeoff(provider, { time: null, source: "observed_airborne", confirmedAt: now });
}

/** Revoke only provider-only evidence in the first ten minutes. Keep the
 * tombstone even on later polls, so an old provider/legacy/CAS copy cannot relatch. */
export function reconcileTakeoff(prior: ConfirmedTakeoff | undefined, args: TakeoffEvidenceArgs): ConfirmedTakeoff | undefined {
  let next = mergeConfirmedTakeoff(prior, confirmTakeoff(args));
  if (!hasOriginSurfaceFix(args)) return next;
  const active = activeConfirmedTakeoff(next);
  if (active?.source === "observed_airborne" || active?.observedAt != null) return next;
  if (active?.time != null && args.now - active.time > 10 * 60) return next;
  const provider = active ?? confirmTakeoff({ ...args, position: null });
  if (provider?.source === "provider_actual" && provider.time != null) {
    const revocation = { time: provider.time, at: args.now };
    next = mergeConfirmedTakeoff(next, { ...provider, revocations: [revocation] });
  }
  return next;
}

export function readTakeoffRevocations(value: unknown, now: number): TakeoffRevocation[] {
  return Array.isArray(value) ? value.slice(0, 32).filter(r => r && finite(r.time) && r.time > 0
    && r.time <= now && finite(r.at) && r.at >= r.time && r.at <= now)
    .map(r => ({ time: r.time, at: r.at })) : [];
}

export function takeoffFloorStage<T extends string>(stage: T, confirmation?: ConfirmedTakeoff | TakeoffDiagnostic | null): T | "ride" {
  return confirmation && beforeTakeoff.has(stage) ? "ride" : stage;
}
export function takeoffDiagnostic(confirmation?: ConfirmedTakeoff): TakeoffDiagnostic | null {
  const c = activeConfirmedTakeoff(confirmation);
  return c ? { source: c.source, at: c.time, confirmedAt: c.confirmedAt, ...(c.observedAt != null ? { observedAt: c.observedAt } : {}) } : null;
}
export function readTakeoffDiagnostic(value: unknown, now = Date.now() / 1000): ConfirmedTakeoff | undefined {
  if (!value || typeof value !== "object") return;
  const c = value as TakeoffDiagnostic;
  if (!finite(c.confirmedAt) || c.confirmedAt <= 0 || c.confirmedAt > now) return;
  if (c.source === "provider_actual" && finite(c.at) && c.at > 0 && c.at <= now)
    return { source: c.source, time: c.at, confirmedAt: c.confirmedAt,
      ...(finite(c.observedAt) && c.observedAt > 0 && c.observedAt <= now ? { observedAt: c.observedAt } : {}) };
  if (c.source === "observed_airborne" && c.at === null)
    return { source: c.source, time: null, confirmedAt: c.confirmedAt };
}

/** Presentation only. Evidence must come from this server story or a previous
 * server story with exactly the same key. Never sent back as shared DB truth. */
export function applyTakeoffFloor(story: FlightStory, prior?: { stateKey?: string | null; confirmedTakeoff?: TakeoffDiagnostic | null; takeoffRevocations?: TakeoffRevocation[] }): FlightStory {
  const now = story.fetchedAt / 1000;
  const current = readTakeoffDiagnostic(story.confirmedTakeoff, now);
  const previous = story.stateKey && prior?.stateKey === story.stateKey ? readTakeoffDiagnostic(prior.confirmedTakeoff, now) : undefined;
  let evidence = mergeConfirmedTakeoff(current, previous);
  const revocations = [...readTakeoffRevocations(story.takeoffRevocations, now),
    ...(story.stateKey && prior?.stateKey === story.stateKey ? readTakeoffRevocations(prior.takeoffRevocations, now) : [])];
  for (const r of revocations) evidence = mergeConfirmedTakeoff(evidence,
    { time: r.time, source: "provider_actual", confirmedAt: r.at, revocations: [r] });
  const confirmation = activeConfirmedTakeoff(evidence);
  if (!story.stateKey) return story;
  if (!confirmation) return evidence?.revocations?.length ? { ...story,
    confirmedTakeoff: null, takeoffRevocations: evidence.revocations } : story;
  const stage = takeoffFloorStage(story.currentStage, confirmation);
  return { ...story, confirmedTakeoff: takeoffDiagnostic(confirmation), takeoffRevocations: evidence?.revocations, currentStage: stage,
    takeoffFloorApplied: Boolean(story.takeoffFloorApplied || stage !== story.currentStage),
    selectedStageReason: stage !== story.currentStage ? "confirmed_takeoff_floor" : story.selectedStageReason,
    times: { ...story.times, airborne: true, ...(confirmation.time != null ? {
      takeoffUnix: confirmation.time, takeoffKind: "actual" as const,
      takeoff: new Date(confirmation.time * 1000).toLocaleTimeString("en-US", { timeZone: story.origin.tz ?? "UTC", hour: "numeric", minute: "2-digit" }),
    } : {}) },
    stages: stage === story.currentStage ? story.stages : Object.fromEntries(Object.entries(story.stages ?? {}).map(([id, detail]) =>
      [id, { ...detail, state: id === "ride" ? "now" : beforeTakeoff.has(id) ? "done" : detail.state }])) as FlightStory["stages"],
  };
}
