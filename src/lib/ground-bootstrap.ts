import { createServerFn } from "@tanstack/react-start";
import type { GroundStateScope } from "./flight-ground-state.server.ts";
import { parseFlightQuery } from "./flight-parse.ts";

export const getGroundBootstrap = createServerFn({ method: "POST" })
  .validator((input: { flight: string } & GroundStateScope) => {
    const parsed = parseFlightQuery(String(input?.flight ?? ""));
    if (!parsed || parsed.registration) throw new Error("Invalid flight number");
    if (!/^leg:v1:/.test(input.landKey) || !/^\d{4}-\d{2}-\d{2}$/.test(input.serviceDate ?? "")
      || !/^[A-Z]{3}$/.test(input.originIata) || !/^[A-Z]{3}$/.test(input.destIata)) throw new Error("Invalid flight leg");
    return { ...input, ident: (parsed.iata ?? parsed.callsign).replace(/\s/g, "").toUpperCase() };
  })
  .handler(async ({ data }) => {
    const { flightGroundStateStore } = await import("./flight-ground-state.server.ts");
    const state = await flightGroundStateStore.loadRecent(data.ident, data);
    if (!state) return null;
    const lastPosition = state.lastPosition && Date.now() / 1000 - state.lastPosition.seenAt >= -10
      && Date.now() / 1000 - state.lastPosition.seenAt <= 120
      ? state.lastPosition
      : null;
    return { ...state, lastPosition };
  });
