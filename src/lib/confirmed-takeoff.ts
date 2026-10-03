import { parseFlightQuery } from "./flight-parse.ts";
import { identityCompatible } from "./flight-data.ts";
import { mergeConfirmedTakeoff, type ConfirmedTakeoff } from "./flight-phase-state-logic.ts";
import type { CanonicalFailure, LegSchedule } from "./flight-identity.ts";
import type { FlightStory } from "./types.ts";

export type TakeoffDiagnostic = { source: ConfirmedTakeoff["source"]; at: number | null; confirmedAt: number };
const beforeTakeoff = new Set(["inbound", "origin_gate", "push", "taxi", "takeoff_roll", "Takeoff roll"]);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A route/date failure is never evidence for the selected leg. A live,
 * route-validated schedule-less record may confirm observation, not a clock. */
export function confirmTakeoff(args: {
  schedule: LegSchedule | null; key: string | null; reason: CanonicalFailure | null;
  now: number; deviceOnly?: boolean; groundElevationFt?: number;
  expected: { callsigns: string[]; registration?: string | null; hex?: string | null };
  position?: { callsign?: string | null; registration?: string | null; hex?: string | null;
    lat: number; lon: number; altFt?: number | null; gsKt?: number | null;
    onGround: boolean; extrapolated?: boolean; seenSec?: number; seenAt?: number } | null;
}): ConfirmedTakeoff | undefined {
  const { schedule, key, reason, now, position: p, expected } = args;
  if (args.deviceOnly || !key || (reason != null && reason !== "missing_scheduled")) return;
  const actual = schedule?.takeoff?.actual;
  const scheduled = schedule?.gateOut?.scheduled ?? schedule?.takeoff?.scheduled;
  // A provider clock needs the canonical route/service-date validation and
  // a plausible departure window. Device clocks never establish shared truth.
  if (key.startsWith("leg:v1:") && finite(actual) && actual > 0 && actual <= now
    && finite(scheduled) && actual >= scheduled - 6 * 3600 && actual <= scheduled + 30 * 3600)
    return { time: actual, source: "provider_actual", confirmedAt: now };
  if (finite(scheduled) && (now < scheduled - 5 * 60 || now > scheduled + 30 * 3600)) return;
  if (!p || p.extrapolated || p.onGround !== false || !finite(p.lat) || !finite(p.lon)
    || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || !identityCompatible(p, expected)) return;
  const age = finite(p.seenAt) ? now - p.seenAt : p.seenSec;
  if (!finite(age) || age < 0 || age > 45) return;
  const norm = (v?: string | null) => String(v ?? "").replace(/[-\s]/g, "").toUpperCase();
  const ident = parseFlightQuery(p.callsign ?? "")?.callsign;
  const identified = Boolean(ident && expected.callsigns.some(c => parseFlightQuery(c)?.callsign === ident))
    || Boolean(expected.hex && p.hex && norm(expected.hex) === norm(p.hex))
    || Boolean(expected.registration && p.registration && norm(expected.registration) === norm(p.registration));
  if (!identified || !((finite(p.altFt) && p.altFt - (args.groundElevationFt ?? 0) > 500)
    || (finite(p.gsKt) && p.gsKt > 80))) return;
  return { time: null, source: "observed_airborne", confirmedAt: now };
}

export function takeoffFloorStage<T extends string>(stage: T, confirmation?: ConfirmedTakeoff | TakeoffDiagnostic | null): T | "ride" {
  return confirmation && beforeTakeoff.has(stage) ? "ride" : stage;
}
export function takeoffDiagnostic(confirmation?: ConfirmedTakeoff): TakeoffDiagnostic | null {
  return confirmation ? { source: confirmation.source, at: confirmation.time, confirmedAt: confirmation.confirmedAt } : null;
}
export function readTakeoffDiagnostic(value: unknown, now = Date.now() / 1000): ConfirmedTakeoff | undefined {
  if (!value || typeof value !== "object") return;
  const c = value as TakeoffDiagnostic;
  if (!finite(c.confirmedAt) || c.confirmedAt <= 0 || c.confirmedAt > now) return;
  if (c.source === "provider_actual" && finite(c.at) && c.at > 0 && c.at <= now)
    return { source: c.source, time: c.at, confirmedAt: c.confirmedAt };
  if (c.source === "observed_airborne" && c.at === null)
    return { source: c.source, time: null, confirmedAt: c.confirmedAt };
}

/** Presentation only. Evidence must come from this server story or a previous
 * server story with exactly the same key. Never sent back as shared DB truth. */
export function applyTakeoffFloor(story: FlightStory, prior?: { stateKey?: string | null; confirmedTakeoff?: TakeoffDiagnostic | null }): FlightStory {
  const now = story.fetchedAt / 1000;
  const current = readTakeoffDiagnostic(story.confirmedTakeoff, now);
  const previous = story.stateKey && prior?.stateKey === story.stateKey ? readTakeoffDiagnostic(prior.confirmedTakeoff, now) : undefined;
  const confirmation = mergeConfirmedTakeoff(current, previous);
  if (!confirmation || !story.stateKey) return story;
  const stage = takeoffFloorStage(story.currentStage, confirmation);
  return { ...story, confirmedTakeoff: takeoffDiagnostic(confirmation), currentStage: stage,
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
