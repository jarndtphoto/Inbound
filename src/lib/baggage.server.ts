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
const FLIGHTVIEW_ROOT = "https://www.flightview.com/flight-tracker";
const FLIGHTVIEW_BAGGAGE_AIRPORTS = new Set(["LAX", "ORD", "MDW", "MCO"]);

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
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Inbound/1.0 (passenger flight companion)",
      },
    });
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
 * Parse an exact OAG/FlightView flight page. We only accept baggage from the
 * Arrival section after confirming the requested origin and destination are on
 * that page. A missing baggage field is treated as not posted, never guessed.
 */
export function parseFlightViewBaggage(html: string, leg: BaggageLeg, checkedAt: number): BaggageResult {
  const text = cleanCell(html);
  const departureIndex = text.search(/\bDeparture\b/i);
  const arrivalIndex = text.search(/\bArrival\b/i);
  const detailsIndex = text.search(/\bFlight Details\b/i);
  if (departureIndex < 0 || arrivalIndex <= departureIndex) return { status: "unavailable", checkedAt };

  const departure = text.slice(departureIndex, arrivalIndex);
  const arrival = text.slice(arrivalIndex, detailsIndex > arrivalIndex ? detailsIndex : undefined);
  const originMatch = new RegExp(`(?:\\(|\\b)${leg.origin}(?:\\)|\\b)`, "i").test(departure);
  const destinationMatch = new RegExp(`(?:\\(|\\b)${leg.destination}(?:\\)|\\b)`, "i").test(arrival);
  if (!originMatch || !destinationMatch) return { status: "unavailable", checkedAt };

  const baggageMatches = [...arrival.matchAll(/\bBaggage\s*:\s*([A-Za-z0-9 -]{1,16}?)(?=\s+(?:More airport info|Flight Details|Terminal|Gate|Scheduled Time|At Gate Time|$))/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (baggageMatches.length > 1) return { status: "unavailable", checkedAt };

  const terminalMatches = [...arrival.matchAll(/\bTerminal\s*:\s*([A-Za-z0-9 -]{1,12}?)(?=\s+(?:Gate|Baggage|More airport info|Scheduled Time|At Gate Time|$))/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const terminal = terminalMatches.length === 1 && validTerminal(terminalMatches[0]) ? terminalMatches[0] : undefined;
  const carousel = baggageMatches[0] ?? "";
  if (!validCarousel(carousel)) return { status: "unavailable", checkedAt };
  return { status: carousel ? "posted" : "not-posted", ...(carousel ? { carousel } : {}), ...(terminal ? { terminal } : {}), checkedAt };
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

function flightViewStatusUrl(leg: BaggageLeg) {
  const match = leg.flight.toUpperCase().match(/^([A-Z0-9]{2})(\d{1,4})$/);
  if (!match) return null;
  const [, airline, number] = match;
  return `${FLIGHTVIEW_ROOT}/${airline}/${number}?date=${encodeURIComponent(leg.date)}&depapt=${encodeURIComponent(leg.origin)}`;
}

async function tryHnl(leg: BaggageLeg): Promise<BaggageResult | null> {
  if (leg.destination !== "HNL") return null;
  try {
    const board = await fetchBoard("HNL", HNL_BOARD_URL, (html) => html.includes('role="row"'));
    const result = withSource(parseBaggage(board.html, leg, board.at), "Honolulu airport arrivals board", HNL_PUBLIC_URL);
    return result.status === "unavailable" ? null : result;
  } catch {
    return null;
  }
}

async function tryLaxBoard(leg: BaggageLeg): Promise<BaggageResult | null> {
  if (leg.destination !== "LAX") return null;
  try {
    const board = await fetchBoard("LAX", LAX_BOARD_URL, (html) => /baggage/i.test(html) && /carousel/i.test(html));
    const result = withSource(parseLaxBaggage(board.html, leg, board.at), "LAX baggage claim", LAX_BOARD_URL);
    return result.status === "unavailable" ? null : result;
  } catch {
    return null;
  }
}

async function tryFlightView(leg: BaggageLeg): Promise<BaggageResult | null> {
  if (!FLIGHTVIEW_BAGGAGE_AIRPORTS.has(leg.destination)) return null;
  const flightViewUrl = flightViewStatusUrl(leg);
  if (!flightViewUrl) return null;
  try {
    const page = await fetchBoard(`FV:${leg.flight}:${leg.origin}:${leg.destination}:${leg.date}`, flightViewUrl, (html) => /flight status/i.test(html) && /arrival/i.test(html));
    const result = withSource(parseFlightViewBaggage(page.html, leg, page.at), "FlightView by OAG", flightViewUrl);
    return result.status === "unavailable" ? null : result;
  } catch {
    return null;
  }
}

async function tryAlaska(leg: BaggageLeg): Promise<BaggageResult | null> {
  const alaskaUrl = alaskaStatusUrl(leg);
  if (!alaskaUrl) return null;
  try {
    const board = await fetchBoard(`AS:${leg.flight}:${leg.date}`, alaskaUrl, (html) => /flight status/i.test(html) && /carousel/i.test(html));
    const result = withSource(parseAlaskaBaggage(board.html, leg, board.at), "Alaska Airlines flight status", alaskaUrl);
    return result.status === "unavailable" ? null : result;
  } catch {
    return null;
  }
}

export async function loadBaggage(leg: BaggageLeg): Promise<BaggageResult> {
  const hnl = await tryHnl(leg);
  if (hnl) return hnl;

  const lax = await tryLaxBoard(leg);
  if (lax) return lax;

  const flightView = await tryFlightView(leg);
  if (flightView) return flightView;

  const alaska = await tryAlaska(leg);
  if (alaska) return alaska;

  return { status: "unavailable", checkedAt: Date.now() };
}
