import { createServerFn } from "@tanstack/react-start";

type GroundTimingEvent = "page_open" | "story_loaded" | "ground_query_sent" | "first_fix_shown";

export const logGroundTiming = createServerFn({ method: "POST" })
  .validator((input: {
    event: GroundTimingEvent;
    flight: string;
    atMs: number;
    airport?: string | null;
    movement?: "departure" | "arrival" | null;
    source?: string | null;
    ageSec?: number | null;
  }) => {
    const event = input?.event;
    if (!["page_open", "story_loaded", "ground_query_sent", "first_fix_shown"].includes(event)) {
      throw new Error("Invalid ground timing event");
    }
    const flight = String(input?.flight ?? "").replace(/\s/g, "").toUpperCase().slice(0, 16);
    const atMs = Number(input?.atMs);
    if (!flight || !Number.isFinite(atMs)) throw new Error("Invalid ground timing event");
    const airport = String(input?.airport ?? "").toUpperCase();
    const movement = input?.movement === "departure" || input?.movement === "arrival" ? input.movement : null;
    const source = typeof input?.source === "string" ? input.source.slice(0, 32) : null;
    const ageSec = typeof input?.ageSec === "number" && Number.isFinite(input.ageSec) ? input.ageSec : null;
    return { event, flight, atMs, airport: /^[A-Z]{3}$/.test(airport) ? airport : null, movement, source, ageSec };
  })
  .handler(({ data }) => {
    console.info("[ground-ttfp]", JSON.stringify(data));
    return { ok: true as const };
  });
