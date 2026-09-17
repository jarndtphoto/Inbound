import { loadAeroFlight } from "./aeroapi.server";
import type { FlightStory } from "./types";

function sameProviderLeg(story: FlightStory, aware: Awaited<ReturnType<typeof loadAeroFlight>>) {
  if (!aware) return false;
  const originMatch = !aware.originIcao || aware.originIcao === story.origin.icao || aware.originIata === story.origin.iata;
  const destMatch = !aware.destIcao || aware.destIcao === story.dest.icao || aware.destIata === story.dest.iata;
  const actual = aware.gateOut?.actual;
  const scheduled = story.times.origPushUnix ?? story.times.pushUnix ?? null;
  const plausibleTime = actual == null || scheduled == null || Math.abs(actual - scheduled) <= 18 * 60 * 60;
  return originMatch && destMatch && plausibleTime;
}

export async function preferFlightAwareActualPush(story: FlightStory): Promise<FlightStory> {
  const aware = await loadAeroFlight(story.callsign);
  const actual = aware?.gateOut?.actual;
  if (!Number.isFinite(actual) || !sameProviderLeg(story, aware)) return story;
  const actualUnix = actual as number;
  const scheduled = story.times.origPushUnix ?? actualUnix;
  const delayRaw = Math.round((actualUnix - scheduled) / 60);
  const delayMin = Math.abs(delayRaw) < 5 ? 0 : delayRaw;
  let push: string;
  try {
    push = new Intl.DateTimeFormat("en-US", {
      timeZone: story.origin.tz,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(actualUnix * 1000);
  } catch {
    push = new Date(actualUnix * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return {
    ...story,
    times: {
      ...story.times,
      pushed: true,
      push,
      pushUnix: actualUnix,
      pushKind: "actual",
      pushSource: "provider_actual",
      delayMin,
    },
    ...(story.resume ? { resume: { ...story.resume, detectedPushUnix: null } } : {}),
  };
}
