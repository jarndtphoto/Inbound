import type { BaggageResult } from "./baggage.server";

export function baggageSummary(result: BaggageResult | null) {
  return result?.status === "posted" && result.carousel ? `Carousel ${result.carousel}` : "Not assigned yet";
}
