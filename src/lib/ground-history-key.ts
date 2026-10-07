import type { FlightStory } from "./types.ts";
import { resolveGroundIdentity } from "./ground-position-identity.ts";

type GroundHistoryStory = Pick<FlightStory, "stateKey" | "flightId" | "schedule" | "iata" | "origin" | "dest" | "aircraft" | "resume" | "providers">;

export function groundHistoryLegKey(story: GroundHistoryStory): string | null {
  const route = `${story.origin.iata}:${story.dest.iata}`;
  const date = story.schedule?.serviceDate;
  const previewLeg = story.providers?.previewMode === "fr24-only" && story.flightId ? `fr24:${story.flightId}` : null;
  const leg = previewLeg ?? (story.stateKey?.startsWith("leg:v1:") ? story.stateKey
    : date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${story.iata}:${date}:${route}` : null);
  if (!leg) return null;
  return `${story.providers?.previewMode === "fr24-only" ? `fr24-only:${story.providers.fr24Preview?.sessionId ?? "disabled"}:` : ""}${leg}:${route}`;
}

/** Persist actual surface history only when its service leg is known. */
export function groundHistoryKey(story: GroundHistoryStory): string | null {
  const leg = groundHistoryLegKey(story);
  if (!leg) return null;
  const identity = resolveGroundIdentity({ registration: story.aircraft?.registration, hex: story.aircraft?.hex || null },
    { registration: story.resume?.tail, hex: story.resume?.hex });
  const tail = String(identity.registration ?? "").replace(/[-\s]/g, "").toUpperCase();
  const aircraft = tail ? `tail:${tail}` : `hex:${identity.hex?.replace(/^~+/, "").toLowerCase() ?? "unknown"}`;
  return `${leg}:${aircraft}`;
}
