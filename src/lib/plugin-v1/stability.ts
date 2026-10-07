import { compareRank, type RankedCandidate } from "./ranking";

export type StableSlot = { cardId: string; pickedAtMs: number };
export type NearbyStabilityState = { viewKey: string; collectionVersion: number; slots: StableSlot[]; inactiveExpiresAtMs: number };
export const INCUMBENT_HOLD_MS = 90000;
export const REPLACEMENT_MARGIN = 20;
export const RANKING_RETENTION_MS = 3600000;

/** Successful collection updates only. Outage reads must retain, not re-rank. */
export function updateStableView(previous: NearbyStabilityState | null, input: {
  viewKey: string; collectionVersion: number; nowMs: number; successfulCollection: boolean; ranked: readonly RankedCandidate[];
}): NearbyStabilityState | null {
  const { viewKey, collectionVersion, nowMs, successfulCollection } = input;
  if (!viewKey || !Number.isSafeInteger(collectionVersion) || collectionVersion < 1 || !Number.isFinite(nowMs)) throw new RangeError("Invalid stability update");
  const prior = previous?.viewKey === viewKey && previous.inactiveExpiresAtMs > nowMs ? previous : null;
  if (!successfulCollection || prior && collectionVersion <= prior.collectionVersion) {
    return prior ? { ...structuredClone(prior), inactiveExpiresAtMs: nowMs + RANKING_RETENTION_MS } : null;
  }
  const ranked = [...input.ranked].sort(compareRank);
  if (new Set(ranked.map(r => r.candidate.cardId)).size !== ranked.length) throw new RangeError("Duplicate ranked card IDs");
  const byId = new Map(ranked.map(r => [r.candidate.cardId, r]));
  const slots = prior ? prior.slots.filter(s => byId.has(s.cardId)).map(s => ({ ...s })) : [];
  const picked = new Set(slots.map(s => s.cardId));
  for (const r of ranked) {
    if (slots.length >= 5) break;
    if (!picked.has(r.candidate.cardId)) { slots.push({ cardId: r.candidate.cardId, pickedAtMs: nowMs }); picked.add(r.candidate.cardId); }
  }
  const challenger = ranked.find(r => !picked.has(r.candidate.cardId));
  const replaceable = slots.filter(s => nowMs - s.pickedAtMs >= INCUMBENT_HOLD_MS)
    .sort((a, b) => compareRank(byId.get(b.cardId)!, byId.get(a.cardId)!));
  const worst = replaceable[0];
  if (challenger && worst && challenger.score >= byId.get(worst.cardId)!.score + REPLACEMENT_MARGIN) {
    const index = slots.findIndex(s => s.cardId === worst.cardId);
    slots[index] = { cardId: challenger.candidate.cardId, pickedAtMs: nowMs };
  }
  return { viewKey, collectionVersion, slots, inactiveExpiresAtMs: nowMs + RANKING_RETENTION_MS };
}
/** Limits are presentation prefixes, not independent rankings. */
export function stablePrefix(state: NearbyStabilityState | null, limit = 4): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError("Limit must be 1–5");
  return (state?.slots ?? []).slice(0, limit).map(s => s.cardId);
}
