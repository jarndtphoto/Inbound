import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";

/** Passenger flight story — live track, ride grade, delays. */
export const getFlightStory = createServerFn({ method: "POST" })
  .validator((input: { q: string; fresh?: boolean; resume?: FlightResume }) => {
    const q = String(input?.q ?? "").trim();
    if (!q) throw new Error("Enter a flight number");
    if (q.length > 16) throw new Error("Flight number is too long");
    return { q, fresh: Boolean(input?.fresh), resume: readFlightResume(input?.resume, q) };
  })
  .handler(async ({ data }) => loadFlightStory(data.q, { fresh: data.fresh, resume: data.resume }));

export const listLiveFlights = createServerFn({ method: "POST" }).handler(async () => loadLiveBoard());
