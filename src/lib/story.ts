import { flightFailureCode, flightFailureDetail } from "./flight-diagnostics";
import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";

/** Passenger flight story — live track, ride grade, delays. */
export const getFlightStory = createServerFn({ method: "POST" })
  .validator((input: { q: string; fresh?: boolean }) => {
    const q = String(input?.q ?? "").trim();
    if (!q) throw new Error("Enter a flight number");
    if (q.length > 16) throw new Error("Flight number is too long");
    return { q, fresh: Boolean(input?.fresh) };
  })
  .handler(async ({ data }) => {
    const reference = crypto.randomUUID();
    const started = Date.now();
    console.info("[flight.lookup]", { event: "start", reference });
    try {
      const story = await loadFlightStory(data.q, { fresh: data.fresh });
      console.info("[flight.lookup]", { event: "success", reference, elapsedMs: Date.now() - started });
      return story;
    } catch (error) {
      const code = flightFailureCode(error);
      console.error("[flight.lookup]", {
        event: "failure", reference, elapsedMs: Date.now() - started,
        code, detail: flightFailureDetail(error),
      });
      throw new Error(code + " ref=" + reference);
    }
  });

export const listLiveFlights = createServerFn({ method: "POST" }).handler(async () => loadLiveBoard());
