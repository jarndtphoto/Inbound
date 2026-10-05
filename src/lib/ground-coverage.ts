const LIMITED_DEPARTURE_GROUND_COVERAGE = new Set(["MCO", "TPA", "PHX"]);

export type GroundCoverageNotice = {
  headline: string;
  detail: string;
};

export function groundCoverageNotice(args: {
  kind: "departure" | "arrival";
  airportIata: string;
  hasReliableLiveGroundPosition: boolean;
}): GroundCoverageNotice | null {
  const airport = args.airportIata.trim().toUpperCase();
  if (args.kind !== "departure" || args.hasReliableLiveGroundPosition
    || !LIMITED_DEPARTURE_GROUND_COVERAGE.has(airport)) return null;
  return {
    headline: `Ground tracking may be limited at ${airport}.`,
    detail: "Position and taxi-stage updates can lag until the aircraft is airborne.",
  };
}
