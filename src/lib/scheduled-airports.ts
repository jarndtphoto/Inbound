import source from "./scheduled-airports.json";

type ScheduledAirportRow = [
  icao: string,
  name: string,
  city: string,
  lat: number,
  lon: number,
  tz: string,
];

export type ScheduledAirport = {
  iata: string;
  icao: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
  tz: string;
};

const rows = source.airports as unknown as Record<string, ScheduledAirportRow>;

/**
 * Generated from the public-domain OurAirports airports.csv snapshot named in
 * scheduled-airports.json. Only scheduled-service airports with IATA codes are
 * included; time zones are stored as IANA identifiers alongside the snapshot.
 */
export function scheduledAirportByIata(iata: string | null | undefined): ScheduledAirport | null {
  const normalized = String(iata ?? "").trim().toUpperCase();
  const row = rows[normalized];
  if (!row) return null;
  const [icao, name, city, lat, lon, tz] = row;
  return { iata: normalized, icao, name, city, lat, lon, tz };
}
