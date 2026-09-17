import { env } from "./env.server";
import type { BaggageLeg, BaggageResult } from "./baggage.server";

const CIRIUM_ROOT = "https://api.flightstats.com/flex/flightstatus/rest/v2/json";

type CiriumStatus = {
  carrierFsCode?: string;
  flightNumber?: string | number;
  departureAirportFsCode?: string;
  arrivalAirportFsCode?: string;
  airportResources?: {
    arrivalTerminal?: string | null;
    arrivalGate?: string | null;
    baggage?: string | null;
  };
};

type CiriumResponse = { flightStatuses?: CiriumStatus[] };

function clean(value: unknown, max: number) {
  const text = String(value ?? "").trim();
  return text && text.length <= max && /^[A-Za-z0-9 -]+$/.test(text) ? text : undefined;
}

export function parseCiriumBaggage(payload: CiriumResponse, leg: BaggageLeg, checkedAt: number): BaggageResult {
  const match = leg.flight.toUpperCase().match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (!match) return { status: "unavailable", checkedAt };
  const [, carrier, number] = match;
  const matches = (payload.flightStatuses ?? []).filter((status) =>
    String(status.carrierFsCode ?? "").toUpperCase() === carrier
    && String(status.flightNumber ?? "").toUpperCase() === number
    && String(status.departureAirportFsCode ?? "").toUpperCase() === leg.origin
    && String(status.arrivalAirportFsCode ?? "").toUpperCase() === leg.destination,
  );
  if (matches.length !== 1) return { status: "unavailable", checkedAt };
  const resources = matches[0].airportResources ?? {};
  const carousel = clean(resources.baggage, 16);
  const terminal = clean(resources.arrivalTerminal, 12);
  return {
    status: carousel ? "posted" : "not-posted",
    ...(carousel ? { carousel } : {}),
    ...(terminal ? { terminal } : {}),
    checkedAt,
    sourceName: "Cirium FlightStats",
  };
}

export async function loadCiriumBaggage(leg: BaggageLeg): Promise<BaggageResult | null> {
  const appId = env("CIRIUM_APP_ID");
  const appKey = env("CIRIUM_APP_KEY");
  if (!appId || !appKey) return null;

  const match = leg.flight.toUpperCase().match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (!match) return null;
  const [, carrier, number] = match;
  const [year, month, day] = leg.date.split("-");
  const url = `${CIRIUM_ROOT}/flight/status/${encodeURIComponent(carrier)}/${encodeURIComponent(number)}/dep/${year}/${Number(month)}/${Number(day)}?airport=${encodeURIComponent(leg.origin)}&codeType=IATA`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json", appId, appKey },
    });
    if (!response.ok) return null;
    const payload = await response.json() as CiriumResponse;
    const result = parseCiriumBaggage(payload, leg, Date.now());
    return result.status === "unavailable" ? null : result;
  } catch {
    return null;
  }
}
