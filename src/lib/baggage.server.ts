export type BaggageLeg = { flight: string; origin: string; destination: string; date: string };
export type BaggageResult = {
  status: "posted" | "not-posted" | "unavailable";
  carousel?: string;
  terminal?: string;
  checkedAt: number;
  sourceName?: string;
  sourceUrl?: string;
};

const HNL_BOARD_URL = "https://tracker.flightview.com/FVAccess3/tools/fids/fidsDefault.asp?accCustId=HawaiiAirports&fidsId=20002&fidsInit=arrivals&fidsApt=HNL";
const HNL_PUBLIC_URL = "https://airports.hawaii.gov/hnl/flights/";
const LAX_BOARD_URL = "https://www.flylax.com/lax-baggage-claim";
const ALASKA_STATUS_ROOT = "https://www.alaskaair.com/status";

type CachedHtml = { html: string; at: number };
const htmlCache = new Map<string, CachedHtml>();
const htmlPending = new Map<string, Promise<CachedHtml>>();

function cleanCell(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function validCarousel(value: string) {
  return !value || /^[A-Za-z0-9 -]{1,16}$/.test(value);
}

function validTerminal(value: string) {
  return /^[A-Za-z0-9 -]{1,12}$/.test(value);
}

async function fetchBoard(key: string, url: string, recognizable: (html: string) => boolean): Promise<CachedHtml> {
  const hit = htmlCache.get(key);
  if (hit && Date.now() >= hit.at && Date.now() - hit.at <= 120000) return hit;
  const existing = htmlPending.get(key);
  if (existing) return existing;
  const request = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error("Baggage board unavailable");
    const html = await response.text();
    if (html.length > 4000000 || !recognizable(html)) throw new Error("Unrecognized baggage board");
    const value = { html, at: Date.now() };
    htmlCache.set(key, value);
    return value;
  })().finally(() => htmlPending.delete(key));
  htmlPending.set(key, request);
  return request;
}

/** Read the HNL FlightView board without executing its embedded scripts. */
export function parseBaggage(html: string, leg: BaggageLeg, checkedAt: number): BaggageResult {
  const matches: BaggageResult[] = [];
  for (const row of html.split(/<div\s+role="row"/).slice(1)) {
    const metadata = row.match(/\{fn:'([^']+)',al:'([^']+)',alname:'[^']*',depdate:'(\d{8})',deptime:'\d{4}',status:'[^']*',depap:'([^']+)'[^}]*?arrap:'([^']+)',arrterm:'([^']*)'/);
    if (!metadata) continue;
    const [, number, airline, date, origin, destination, terminal] = metadata;
    if (airline + number !== leg.flight || date !== leg.date.replaceAll("-", "") || origin !== leg.origin || destination !== leg.destination) continue;
    const cell = row.match(/<div\s+role="cell"\s+class="[^"]*\bc11\b[^"]*">([\s\S]*?)<\/div>/);
    if (!cell) continue;
    const carousel = cleanCell(cell[1]);
    if (!validCarousel(carousel)) continue;
    matches.push({ status: carousel ? "posted" : "not-posted", ...(carousel ? { carousel } : {}), ...(validTerminal(terminal) ? { terminal } : {}), checkedAt });
  }
  return matches.length === 1 ? matches[0] : { status: "unavailable", checkedAt };
}

/** Parse LAX's public baggage-claim table. We fail closed on ambiguous rows. */
export function parseLaxBaggage(html: string, leg: BaggageLeg, checkedAt: number): BaggageResult {
  const target = leg.flight.toUpperCase().replace(/\s/g, "");
  const matches: BaggageResult[] = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanCell(m[1]));
    if (cells.length < 4) continue;
    const rowFlights = cells.flatMap((cell) => cell.toUpperCase().match(/\b[A-Z0-9]{2}\s*\d{1,4}[A-Z]?\b/g) ?? []).map((v) => v.replace(/\s/g, ""));
    if (!rowFlights.includes(target)) continue;
    const terminal = cells[cells.length - 2] ?? "";
    const carousel = cells[cells.length - 1] ?? "";
    if (!validCarousel(carousel) || (terminal && !validTerminal(terminal))) continue;
    matches.push({ status: carousel ? "posted" : "not-posted", ...(carousel ? { carousel } : {}), ...(terminal ? { terminal } : {}), checkedAt });
  }
  return matches.length === 1 ? matches[0] : { status: "unavailable", checkedAt };
}

/**
 * Alaska publishes carousel information on its anonymous flight-status pages.
 * Some Alaska flight numbers operate multiple segments in one day, so we only
 * accept a page with exactly one carousel occurrence and both requested airport
 * codes present. Anything ambiguous fails closed.
 */
export function parseAlaskaBaggage(html: string, leg: BaggageLeg, checkedAt: number): BaggageResult {
  const text = cleanCell(html);
  if (!new RegExp(`\\(${leg.origin}\\)`, "i").test(text) || !new RegExp(`\\(${leg.destination}\\)`, "i").test(text)) {
    return { status: "unavailable", checkedAt };
  }
  const carousels = [...text.matchAll(/\bCarousel\s+([A-Za-z0-9-]{1,16})\b/gi)].map((m) => m[1]);
  if (carousels.length !== 1 || !validCarousel(carousels[0])) return { status: "unavailable", checkedAt };
  const terminals = [...text.matchAll(/\bTerminal\s+([A-Za-z0-9-]{1,12})\b/gi)].map((m) => m[1]);
  const terminal = terminals.length === 1 && validTerminal(terminals[0]) ? terminals[0] : undefined;
  return { status: "posted", carousel: carousels[0], ...(terminal ? { terminal } : {}), checkedAt };
}

function withSource(result: BaggageResult, sourceName: string, sourceUrl: string): BaggageResult {
  return result.status === "unavailable" ? result : { ...result, sourceName, sourceUrl };
}

function alaskaStatusUrl(leg: BaggageLeg) {
  const number = leg.flight.toUpperCase().match(/^AS(\d{1,4})$/)?.[1];
  return number ? `${ALASKA_STATUS_ROOT}/${number}/${leg.date}` : null;
}

export async function loadBaggage(leg: BaggageLeg): Promise<BaggageResult> {
  try {
    if (leg.destination === "HNL") {
      const board = await fetchBoard("HNL", HNL_BOARD_URL, (html) => html.includes('role="row"'));
      const airportResult = withSource(parseBaggage(board.html, leg, board.at), "Honolulu airport arrivals board", HNL_PUBLIC_URL);
      if (airportResult.status !== "unavailable") return airportResult;
    }
    if (leg.destination === "LAX") {
      const board = await fetchBoard("LAX", LAX_BOARD_URL, (html) => /baggage/i.test(html) && /carousel/i.test(html));
      const airportResult = withSource(parseLaxBaggage(board.html, leg, board.at), "LAX baggage claim", LAX_BOARD_URL);
      if (airportResult.status !== "unavailable") return airportResult;
    }

    const alaskaUrl = alaskaStatusUrl(leg);
    if (alaskaUrl) {
      const board = await fetchBoard(`AS:${leg.flight}:${leg.date}`, alaskaUrl, (html) => /flight status/i.test(html) && /carousel/i.test(html));
      return withSource(parseAlaskaBaggage(board.html, leg, board.at), "Alaska Airlines flight status", alaskaUrl);
    }

    return { status: "unavailable", checkedAt: Date.now() };
  } catch {
    return { status: "unavailable", checkedAt: Date.now() };
  }
}
