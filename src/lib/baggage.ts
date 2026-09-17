import { createServerFn } from "@tanstack/react-start";
import { loadBaggage, type BaggageLeg } from "./baggage.server";

export const getBaggage = createServerFn({ method: "POST" })
  .validator((input: BaggageLeg) => {
    if (!input
      || !/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(input.flight)
      || !/^[A-Z]{3}$/.test(input.origin)
      || !/^[A-Z]{3}$/.test(input.destination)
      || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Invalid baggage flight");
    return { flight: input.flight, origin: input.origin, destination: input.destination, date: input.date };
  })
  .handler(({ data }) => loadBaggage(data));
