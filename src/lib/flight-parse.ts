import { AIRLINES } from "./aircraft";

export const IATA_TO_ICAO: Record<string, string> = {
  UA: "UAL",
  AA: "AAL",
  DL: "DAL",
  WN: "SWA",
  B6: "JBU",
  AS: "ASA",
  F9: "FFT",
  NK: "NKS",
  SY: "SCX",
  HA: "HAL",
  B0: "LLX",
  BA: "BAW",
  VS: "VIR",
  LH: "DLH",
  AF: "AFR",
  KL: "KLM",
  EI: "EIN",
  IB: "IBE",
  LX: "SWR",
  OS: "AUA",
  SK: "SAS",
  AY: "FIN",
  TP: "TAP",
  FI: "ICL",
  EK: "UAE",
  QR: "QTR",
  EY: "ETD",
  SV: "SVA",
  TK: "THY",
  LY: "ELY",
  ET: "ETH",
  AC: "ACA",
  WS: "WJA",
  JL: "JAL",
  NH: "ANA",
  KE: "KAL",
  OZ: "AAR",
  CX: "CPA",
  SQ: "SIA",
  PR: "PAL",
  QF: "QFA",
  NZ: "ANZ",
  AM: "AMX",
  AV: "AVA",
  CM: "CMP",
  LA: "LAN",
  AI: "AIC",
  FR: "RYR",
  U2: "EZY",
};

export type ParsedFlight = {
  callsign: string;
  iata: string | null;
  registration: string | null;
};

export function parseFlightQuery(raw: string): ParsedFlight | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;

  if (/^N[0-9]{1,5}[A-Z]{0,2}$/.test(s)) {
    return { callsign: s, iata: null, registration: s };
  }

  const icaoNum = s.match(/^([A-Z]{3})(\d{1,4}[A-Z]?)$/);
  if (icaoNum && (AIRLINES[icaoNum[1]] || IATA_TO_ICAO[icaoNum[1].slice(0, 2)])) {
    const icao = AIRLINES[icaoNum[1]] ? icaoNum[1] : IATA_TO_ICAO[icaoNum[1].slice(0, 2)];
    if (icao && AIRLINES[icao]) {
      const num = icaoNum[2];
      const iataLetter = Object.entries(IATA_TO_ICAO).find(([, v]) => v === icao)?.[0];
      return {
        callsign: `${icao}${num}`,
        iata: iataLetter ? `${iataLetter}${num}` : null,
        registration: null,
      };
    }
  }

  const iataNum = s.match(/^([A-Z]{2})(\d{1,4}[A-Z]?)$/);
  if (iataNum && IATA_TO_ICAO[iataNum[1]]) {
    const icao = IATA_TO_ICAO[iataNum[1]];
    return {
      callsign: `${icao}${iataNum[2]}`,
      iata: `${iataNum[1]}${iataNum[2]}`,
      registration: null,
    };
  }

  return null;
}

export function displayIata(callsign: string, iata: string | null): string {
  if (iata) {
    const m = iata.match(/^([A-Z]{2})(\d.*)$/);
    if (m) return `${m[1]} ${m[2]}`;
    return iata;
  }
  const m = callsign.match(/^([A-Z]{3})(\d.*)$/);
  if (!m) return callsign;
  const letter = Object.entries(IATA_TO_ICAO).find(([, v]) => v === m[1])?.[0];
  return letter ? `${letter} ${m[2]}` : `${m[1]} ${m[2]}`;
}

function compactIdent(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** True when a loaded story is actually the flight the passenger asked for. */
export function storyMatchesQuery(
  story: { iata?: string | null; callsign?: string | null; query?: string | null },
  q: string,
): boolean {
  const want = parseFlightQuery(q);
  if (!want) return false;
  if (story.query && compactIdent(story.query) === compactIdent(q)) return true;
  const have =
    parseFlightQuery(story.iata ?? "") ?? parseFlightQuery(story.callsign ?? "");
  if (have && have.callsign === want.callsign) return true;
  const nq = compactIdent(q);
  if (story.iata && compactIdent(story.iata) === nq) return true;
  if (story.callsign && compactIdent(story.callsign) === nq) return true;
  if (want.iata && story.iata && compactIdent(story.iata) === compactIdent(want.iata)) return true;
  return false;
}
