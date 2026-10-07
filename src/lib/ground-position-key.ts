export function groundPositionQueryKey(input: {
  stateKey?: string | null;
  flightNumber?: string | null;
  registration?: string | null;
  hex?: string | null;
  airportIata: string;
  movementKind: "departure" | "arrival";
}) {
  return [
    "ground-position-v2",
    input.stateKey || String(input.flightNumber || "").replace(/\s/g, "").toUpperCase(),
    input.airportIata.toUpperCase(),
    input.movementKind,
    String(input.registration ?? "").replace(/[-\s]/g, "").toUpperCase()
      || String(input.hex ?? "").toLowerCase(),
  ] as const;
}
