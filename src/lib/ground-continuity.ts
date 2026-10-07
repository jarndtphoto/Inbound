import { haversineNm } from "./geo.ts";
import { groundObservationAge } from "./ground-story-position.ts";

export type GroundDisplayFix = {
  lat: number; lon: number; altFt: number | null; gsKt: number | null;
  track: number | null; onGround: boolean; seenAt: number;
  registration: string | null; callsign: string | null; provider?: string | null;
};
export type GroundContinuity = {
  legKey: string; airportIata: string; movementKind: "departure" | "arrival";
  registration: string | null; hex: string | null; fix: GroundDisplayFix;
};
type Identity = { registration?: string | null; hex?: string | null };
const reg = (value?: string | null) => String(value ?? "").replace(/[-\s]/g, "").toUpperCase();
const hex = (value?: string | null) => String(value ?? "").replace(/^~+/, "").toLowerCase();

export function compatibleGroundIdentity(current: Identity, saved: Identity) {
  const currentReg = reg(current.registration), savedReg = reg(saved.registration);
  const currentHex = hex(current.hex), savedHex = hex(saved.hex);
  if (currentReg && savedReg && currentReg !== savedReg) return false;
  if (currentHex && savedHex && currentHex !== savedHex) return false;
  // Missing identity in a later story is a gap, not a reassignment. Explicit
  // known identity must still match at least one saved aircraft identifier.
  return !(currentReg || currentHex) || Boolean((currentReg && currentReg === savedReg) || (currentHex && currentHex === savedHex));
}

export function compatibleGroundContinuity(entry: GroundContinuity | undefined, scope: {
  legKey: string | null; airportIata: string; movementKind: "departure" | "arrival";
  lat: number; lon: number; identity: Identity;
}): GroundContinuity | null {
  if (!entry || !scope.legKey || entry.legKey !== scope.legKey || entry.airportIata !== scope.airportIata
    || entry.movementKind !== scope.movementKind || !compatibleGroundIdentity(scope.identity, entry)
    || !Number.isFinite(entry.fix.lat) || !Number.isFinite(entry.fix.lon) || haversineNm(entry.fix, scope) > 20) return null;
  return entry;
}

export function retainedGroundFix(entry: GroundContinuity | null, nowMs = Date.now()): GroundDisplayFix | null {
  const age = groundObservationAge(entry?.fix.seenAt, nowMs);
  return entry && age != null && age <= 120 ? entry.fix : null;
}

export function retainNewestGroundFix(previous: GroundContinuity | undefined, next: GroundContinuity): GroundContinuity {
  if (previous && previous.legKey === next.legKey && previous.airportIata === next.airportIata
    && previous.movementKind === next.movementKind && compatibleGroundIdentity(next, previous)
    && previous.fix.seenAt >= next.fix.seenAt) return previous;
  return next;
}
