export type AirframeKind = "widebody" | "narrow" | "regional" | "biz" | "ga" | "heli" | "other";

export type Airframe = {
  code: string;
  name: string;
  maker: string;
  kind: AirframeKind;
  note: string;
};

export const AIRFRAMES: Record<string, Airframe> = {
  A319: { code: "A319", name: "Airbus A319", maker: "Airbus", kind: "narrow", note: "Short A320. Quiet, extra pitch in some cabins because the fuselage is short." },
  A320: { code: "A320", name: "Airbus A320", maker: "Airbus", kind: "narrow", note: "The default single-aisle. Sit over the wing for the smoothest ride; last 8 rows feel every bump." },
  A20N: { code: "A20N", name: "Airbus A320neo", maker: "Airbus", kind: "narrow", note: "New-engine A320. Noticeably quieter in back than the older ceo." },
  A321: { code: "A321", name: "Airbus A321", maker: "Airbus", kind: "narrow", note: "Stretched A320. More seats, longer taxi, often used on transcon US routes." },
  A21N: { code: "A21N", name: "Airbus A321neo", maker: "Airbus", kind: "narrow", note: "The US transcon workhorse. Big bins, decent range — LAX–JFK in a narrowbody." },
  A332: { code: "A332", name: "Airbus A330-200", maker: "Airbus", kind: "widebody", note: "Older long-haul twin. Two aisles, real windows, often a quieter upper-deck feel without an upper deck." },
  A333: { code: "A333", name: "Airbus A330-300", maker: "Airbus", kind: "widebody", note: "Stretched A330. Common on Atlantic and Asia runs. Window seats 2–3 ahead of the wing see the engine." },
  A339: { code: "A339", name: "Airbus A330-900", maker: "Airbus", kind: "widebody", note: "A330neo. Modern cabin, big windows, one of the quieter widebodies in the sky right now." },
  A359: { code: "A359", name: "Airbus A350-900", maker: "Airbus", kind: "widebody", note: "Carbon fuselage, huge windows, high cabin humidity. The nicest long-haul frame most people will ever ride." },
  A35K: { code: "A35K", name: "Airbus A350-1000", maker: "Airbus", kind: "widebody", note: "Stretched A350. Same windows and quiet, more cabin. Flagship for BA, Qantas, Virgin Atlantic." },
  A388: { code: "A388", name: "Airbus A380-800", maker: "Airbus", kind: "widebody", note: "The double-decker. Upper deck is quieter and feels like a different airplane. Catch it while you can." },
  A310: { code: "A310", name: "Airbus A310", maker: "Airbus", kind: "widebody", note: "Rare now — mostly cargo. A sighting is worth logging." },
  BCS1: { code: "BCS1", name: "Airbus A220-100", maker: "Airbus", kind: "narrow", note: "Small A220. Unusually large windows and a quiet cabin for a regional-sized jet." },
  BCS3: { code: "BCS3", name: "Airbus A220-300", maker: "Airbus", kind: "narrow", note: "Big windows, extra-wide seats in a 2–3 layout. Feels more premium than the seat map suggests." },
  B737: { code: "B737", name: "Boeing 737-700", maker: "Boeing", kind: "narrow", note: "Short 737. Southwest classic. Sit 2–3 rows ahead of the wing for the best ride." },
  B738: { code: "B738", name: "Boeing 737-800", maker: "Boeing", kind: "narrow", note: "The most common airliner on earth. Rear engine noise, tight bins, still gets you there." },
  B739: { code: "B739", name: "Boeing 737-900", maker: "Boeing", kind: "narrow", note: "Stretched 737 NG. United loves these on longer domestic legs." },
  B38M: { code: "B38M", name: "Boeing 737 MAX 8", maker: "Boeing", kind: "narrow", note: "MAX 8. Sits nose-high on the ground because of the bigger fans. Quieter than the 800 in back." },
  B39M: { code: "B39M", name: "Boeing 737 MAX 9", maker: "Boeing", kind: "narrow", note: "MAX 9. Alaska and United fly a lot of these. Same MAX stance, more cabin." },
  B3XM: { code: "B3XM", name: "Boeing 737 MAX 10", maker: "Boeing", kind: "narrow", note: "Longest MAX. Still rare enough to be interesting at a domestic gate." },
  B752: { code: "B752", name: "Boeing 757-200", maker: "Boeing", kind: "narrow", note: "Hot-rod narrowbody. Steep climb, long legs. Delta and United still run them — log it." },
  B753: { code: "B753", name: "Boeing 757-300", maker: "Boeing", kind: "narrow", note: "The stretch 757. A long tube with a lot of power. Uncommon." },
  B763: { code: "B763", name: "Boeing 767-300", maker: "Boeing", kind: "widebody", note: "Delta’s domestic widebody. 2–3–2 seating means no true middle in economy." },
  B764: { code: "B764", name: "Boeing 767-400", maker: "Boeing", kind: "widebody", note: "Rare stretch 767. Delta has nearly all of them." },
  B772: { code: "B772", name: "Boeing 777-200", maker: "Boeing", kind: "widebody", note: "Classic triple-seven. Big wings, 3–3–3 or 3–4–3. A real long-haul jet." },
  B77L: { code: "B77L", name: "Boeing 777-200LR", maker: "Boeing", kind: "widebody", note: "Ultra long-range 777. Can do 18-hour missions. Winglets, extra tanks." },
  B77W: { code: "B77W", name: "Boeing 777-300ER", maker: "Boeing", kind: "widebody", note: "The long-haul workhorse. Emirates, United, Air France — if it’s a 777, it’s often this." },
  B778: { code: "B778", name: "Boeing 777-8", maker: "Boeing", kind: "widebody", note: "New 777X family. Folding wingtips if you catch one." },
  B779: { code: "B779", name: "Boeing 777-9", maker: "Boeing", kind: "widebody", note: "777-9. Folding wingtips, huge cabin. Still a rare catch." },
  B788: { code: "B788", name: "Boeing 787-8", maker: "Boeing", kind: "widebody", note: "Smallest Dreamliner. Dim windows, high humidity, the cabin that started the plastic-fuselage era." },
  B789: { code: "B789", name: "Boeing 787-9", maker: "Boeing", kind: "widebody", note: "The sweet-spot Dreamliner. Electronic dimming windows, quiet, used on most 787 routes." },
  B78X: { code: "B78X", name: "Boeing 787-10", maker: "Boeing", kind: "widebody", note: "Stretched 787. Same cabin magic, more seats. United and Singapore fly a lot of them." },
  B744: { code: "B744", name: "Boeing 747-400", maker: "Boeing", kind: "widebody", note: "Queen of the skies, mostly gone from passenger service. If you see one, log it." },
  B748: { code: "B748", name: "Boeing 747-8", maker: "Boeing", kind: "widebody", note: "Last passenger 747s — Lufthansa, Korean, Air China. Hump is longer than the 400." },
  E170: { code: "E170", name: "Embraer E170", maker: "Embraer", kind: "regional", note: "Small regional jet. 2–2 seating, no middle seat. Window is a bit low." },
  E75L: { code: "E75L", name: "Embraer E175", maker: "Embraer", kind: "regional", note: "The US regional default. 2–2, extra-long wing. Sit ahead of the wing." },
  E75S: { code: "E75S", name: "Embraer E175", maker: "Embraer", kind: "regional", note: "Short-wing E175. Same 2–2 cabin as the long-wing version." },
  E190: { code: "E190", name: "Embraer E190", maker: "Embraer", kind: "regional", note: "Larger E-Jet. JetBlue and some majors still fly them. 2–2 throughout." },
  E195: { code: "E195", name: "Embraer E195", maker: "Embraer", kind: "regional", note: "Biggest classic E-Jet. Feels like a small mainline cabin." },
  E290: { code: "E290", name: "Embraer E190-E2", maker: "Embraer", kind: "regional", note: "New-gen E-Jet. Quieter, bigger bins, still 2–2." },
  CRJ2: { code: "CRJ2", name: "CRJ-200", maker: "Bombardier", kind: "regional", note: "Tiny CRJ. Loud, low windows, engines on the tail. A shrinking fleet." },
  CRJ7: { code: "CRJ7", name: "CRJ-700", maker: "Bombardier", kind: "regional", note: "Stretched CRJ. Still 2–2. Better than a 200, not an E175." },
  CRJ9: { code: "CRJ9", name: "CRJ-900", maker: "Bombardier", kind: "regional", note: "Long CRJ. Common in Delta and United Express colors." },
  DH8D: { code: "DH8D", name: "Dash 8 Q400", maker: "De Havilland", kind: "regional", note: "Fast turboprop. Loud on climb, great views, often used on short hops and islands." },
  AT76: { code: "AT76", name: "ATR 72-600", maker: "ATR", kind: "regional", note: "High-wing turboprop. Window views are unobstructed — wing is above you." },
  C172: { code: "C172", name: "Cessna 172", maker: "Cessna", kind: "ga", note: "The trainer. If it’s in the pattern, a flight school is nearby." },
  SR22: { code: "SR22", name: "Cirrus SR22", maker: "Cirrus", kind: "ga", note: "The parachute plane. Common around busy GA fields." },
  GLF4: { code: "GLF4", name: "Gulfstream IV", maker: "Gulfstream", kind: "biz", note: "Classic large-cabin bizjet. Long nose, low wing." },
  GLF5: { code: "GLF5", name: "Gulfstream V", maker: "Gulfstream", kind: "biz", note: "Ultra-long-range bizjet. Often a notable catch at a commercial field." },
  GLF6: { code: "GLF6", name: "Gulfstream G650", maker: "Gulfstream", kind: "biz", note: "The flagship Gulfstream. Fast, high, and worth a look." },
  GLEX: { code: "GLEX", name: "Global Express", maker: "Bombardier", kind: "biz", note: "Bombardier’s long-range rival to Gulfstream." },
  CL60: { code: "CL60", name: "Challenger 600", maker: "Bombardier", kind: "biz", note: "Workhorse super-midsize cabin." },
  C56X: { code: "C56X", name: "Citation Excel/XLS", maker: "Cessna", kind: "biz", note: "Small Citation. Common on the GA ramp." },
  E55P: { code: "E55P", name: "Phenom 300", maker: "Embraer", kind: "biz", note: "Light jet. Fast climber, often owner-flown." },
  PC12: { code: "PC12", name: "Pilatus PC-12", maker: "Pilatus", kind: "ga", note: "Single-engine turboprop. Big cargo door, used by owners and regionals." },
  TBM9: { code: "TBM9", name: "Daher TBM 900", maker: "Daher", kind: "ga", note: "Fast single-engine turboprop. Looks like a fighter on the ramp." },
};

export const AIRLINES: Record<string, string> = {
  UAL: "United",
  AAL: "American",
  DAL: "Delta",
  SWA: "Southwest",
  JBU: "JetBlue",
  ASA: "Alaska",
  FFT: "Frontier",
  NKS: "Spirit",
  SCX: "Sun Country",
  RPA: "Republic",
  SKW: "SkyWest",
  EDV: "Endeavor",
  ENY: "Envoy",
  PDT: "Piedmont",
  JIA: "PSA",
  GJS: "GoJet",
  ASH: "Mesa",
  BAW: "British Airways",
  VIR: "Virgin Atlantic",
  DLH: "Lufthansa",
  AFR: "Air France",
  KLM: "KLM",
  EIN: "Aer Lingus",
  IBE: "Iberia",
  SWR: "Swiss",
  AUA: "Austrian",
  SAS: "SAS",
  FIN: "Finnair",
  TAP: "TAP",
  ICL: "Icelandair",
  UAE: "Emirates",
  QTR: "Qatar",
  ETD: "Etihad",
  SVA: "Saudia",
  THY: "Turkish",
  ELY: "El Al",
  ETH: "Ethiopian",
  SWRX: "Swiss",
  ACA: "Air Canada",
  WJA: "WestJet",
  JAL: "Japan Airlines",
  ANA: "ANA",
  KAL: "Korean Air",
  AAR: "Asiana",
  CPA: "Cathay Pacific",
  SIA: "Singapore",
  PAL: "Philippine",
  QFA: "Qantas",
  ANZ: "Air New Zealand",
  AMX: "Aeromexico",
  AVA: "Avianca",
  CMP: "Copa",
  LAN: "LATAM",
  TAM: "LATAM",
  GLO: "GOL",
  AZU: "Azul",
  CES: "China Eastern",
  CCA: "Air China",
  CSN: "China Southern",
  AIC: "Air India",
  IGO: "IndiGo",
  RYR: "Ryanair",
  EZY: "easyJet",
  WZZ: "Wizz",
  NAX: "Norwegian",
  FDX: "FedEx",
  UPS: "UPS",
  GTI: "Atlas",
  CLX: "Cargolux",
  BOX: "AeroLogic",
  CKS: "Kalitta",
  NCA: "Nippon Cargo",
};

export function airframeOf(code?: string | null): Airframe | null {
  if (!code) return null;
  return AIRFRAMES[code.trim().toUpperCase()] ?? null;
}

export function airlineOf(callsign?: string | null): string | null {
  if (!callsign) return null;
  const cs = callsign.trim().toUpperCase();
  const prefix3 = cs.slice(0, 3);
  if (AIRLINES[prefix3] && /[0-9]/.test(cs.slice(3))) return AIRLINES[prefix3];
  const prefix2 = cs.slice(0, 2);
  // IATA-looking codes sometimes leak into ADS-B
  const iata: Record<string, string> = {
    UA: "United",
    AA: "American",
    DL: "Delta",
    WN: "Southwest",
    B6: "JetBlue",
    AS: "Alaska",
    F9: "Frontier",
    NK: "Spirit",
    BA: "British Airways",
    LH: "Lufthansa",
    AF: "Air France",
    KL: "KLM",
    EK: "Emirates",
    QR: "Qatar",
    AC: "Air Canada",
    NH: "ANA",
    JL: "Japan Airlines",
  };
  if (iata[prefix2] && /[0-9]/.test(cs.slice(2))) return iata[prefix2];
  return null;
}

export function isWidebody(code?: string | null): boolean {
  return airframeOf(code)?.kind === "widebody";
}

export function isVehicleType(code?: string | null, category?: string | null, operator?: string | null): boolean {
  const t = (code ?? "").toUpperCase();
  const cat = (category ?? "").toUpperCase();
  const op = (operator ?? "").toUpperCase();
  if (t === "SERV" || t === "GRND" || t === "GNDT") return true;
  if (cat.startsWith("C")) return true;
  if (op.includes("AIRPORT") || op.includes("DEPT OF AVIATION") || op.includes("DEPARTMENT OF AVIATION")) {
    return true;
  }
  return false;
}
