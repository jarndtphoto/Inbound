import { livePositionAgeSec } from "./flight-presentation.ts";
import type { FlightStory } from "./types.ts";

export type SharedAircraftPosition = Partial<NonNullable<FlightStory["aircraft"]>> & {
  lat: number;
  lon: number;
  seenAt: number;
  provider: string | null;
};

export function storyAircraftPosition(story: FlightStory, nowMs = Date.now()): SharedAircraftPosition | null {
  const aircraft = story.aircraft;
  if (!aircraft || !Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) return null;
  const explicitSeenAt = story.providers?.chosenPositionSeenAt;
  const aircraftSeenAt = (aircraft as typeof aircraft & { seenAt?: number | null }).seenAt;
  const age = livePositionAgeSec(story, nowMs);
  const seenAt = typeof explicitSeenAt === "number" && Number.isFinite(explicitSeenAt)
    ? explicitSeenAt
    : typeof aircraftSeenAt === "number" && Number.isFinite(aircraftSeenAt)
      ? aircraftSeenAt
      : age != null ? nowMs / 1000 - age : null;
  if (seenAt == null || !Number.isFinite(seenAt)) return null;
  return {
    ...aircraft,
    seenAt,
    provider: story.providers?.chosenPosition ?? null,
  };
}

export function newestAircraftPosition(
  ...positions: Array<SharedAircraftPosition | null | undefined>
): SharedAircraftPosition | null {
  let newest: SharedAircraftPosition | null = null;
  for (const position of positions) {
    if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)
      || !Number.isFinite(position.seenAt)) continue;
    if (!newest || position.seenAt > newest.seenAt) newest = position;
  }
  return newest;
}

export function storyWithSharedAircraftPosition(
  story: FlightStory,
  position: SharedAircraftPosition | null,
  nowMs = Date.now(),
): FlightStory {
  if (!position) return story;
  const ageSec = Math.max(0, nowMs / 1000 - position.seenAt);
  return {
    ...story,
    live: ageSec <= 60 && !position.extrapolated,
    aircraft: {
      hex: story.aircraft?.hex ?? position.hex ?? "",
      registration: story.aircraft?.registration ?? position.registration ?? null,
      type: story.aircraft?.type ?? position.type ?? null,
      typeName: story.aircraft?.typeName ?? position.typeName ?? position.type ?? null,
      year: story.aircraft?.year ?? position.year ?? null,
      operator: story.aircraft?.operator ?? position.operator ?? null,
      altFt: position.altFt ?? story.aircraft?.altFt ?? null,
      gsKt: position.gsKt ?? story.aircraft?.gsKt ?? null,
      track: position.track ?? story.aircraft?.track ?? null,
      vertFpm: position.vertFpm ?? story.aircraft?.vertFpm ?? null,
      onGround: position.onGround ?? story.aircraft?.onGround ?? false,
      phase: position.phase ?? story.aircraft?.phase ?? "parked",
      ...(story.aircraft ?? {}),
      ...position,
      seenSec: ageSec,
    },
    providers: {
      ...story.providers,
      chosenPosition: position.provider,
      chosenPositionSeenAt: position.seenAt,
      chosenPositionAgeSec: ageSec,
    },
  };
}
