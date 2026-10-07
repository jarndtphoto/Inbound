import { createServerFn } from "@tanstack/react-start";
import { parseFlightQuery } from "./flight-parse.ts";

export const getGroundBootstrap = createServerFn({ method: "POST" })
  .validator((input: { flight: string }) => {
    const parsed = parseFlightQuery(String(input?.flight ?? ""));
    if (!parsed || parsed.registration) throw new Error("Invalid flight number");
    return { ident: (parsed.iata ?? parsed.callsign).replace(/\s/g, "").toUpperCase() };
  })
  .handler(async ({ data }) => {
    const { flightGroundStateStore } = await import("./flight-ground-state.server.ts");
    const state = await flightGroundStateStore.loadRecent(data.ident);
    if (!state) return null;
    const lastPosition = state.lastPosition && Date.now() / 1000 - state.lastPosition.seenAt <= 120
      ? state.lastPosition
      : null;
    return { ...state, lastPosition };
  });
