import { cToF, compass16 } from "./geo";

export type Cloud = { cover: string; base?: number | null };

export type Metar = {
  icaoId: string;
  rawOb: string;
  temp?: number;
  dewp?: number;
  wdir?: number | string;
  wspd?: number;
  wgst?: number;
  visib?: string | number;
  altim?: number;
  cover?: string;
  clouds?: Cloud[];
  fltCat?: string;
  obsTime?: number;
  reportTime?: string;
  wxString?: string | null;
  name?: string;
};

export type Taf = {
  icaoId: string;
  rawTAF: string;
  fcsts?: Array<{
    wdir?: number;
    wspd?: number;
    visib?: string | number;
    clouds?: Cloud[];
    wxString?: string | null;
    timeFrom?: number;
    timeTo?: number;
    fcstChange?: string | null;
    probability?: number | null;
    wgst?: number | null;
  }>;
};

export type DecodedField = {
  category: "VFR" | "MVFR" | "IFR" | "LIFR" | "UNK";
  categoryLabel: string;
  wind: string;
  vis: string;
  ceiling: string;
  temp: string;
  wx: string;
  summary: string;
};

function categoryOf(code?: string): DecodedField["category"] {
  const c = (code ?? "").toUpperCase();
  if (c === "VFR" || c === "MVFR" || c === "IFR" || c === "LIFR") return c;
  return "UNK";
}

function categoryLabel(cat: DecodedField["category"]): string {
  switch (cat) {
    case "VFR":
      return "Good visibility and higher cloud ceilings";
    case "MVFR":
      return "Lower clouds or reduced visibility";
    case "IFR":
      return "Low clouds or limited visibility";
    case "LIFR":
      return "Very low clouds or very limited visibility";
    default:
      return "Category unknown";
  }
}

function ceilingFt(clouds?: Cloud[]): number | null {
  if (!clouds?.length) return null;
  const layered = clouds
    .filter((c) => c.base && ["BKN", "OVC", "VV"].includes(c.cover))
    .map((c) => c.base as number)
    .sort((a, b) => a - b);
  return layered[0] ?? null;
}

function visText(visib?: string | number): string {
  if (visib == null) return "Visibility not reported";
  const s = String(visib);
  if (s.includes("+") || Number(s) >= 10) return "Clear visibility, 10 miles or more";
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return `Visibility ${s}`;
  if (n <= 1) return `Low visibility, about ${n} mile${n === 1 ? "" : "s"}`;
  return `Visibility about ${n} miles`;
}

function windText(dir?: number | string, spd?: number, gst?: number): string {
  if (spd == null) return "Wind not reported";
  if (spd === 0 || dir === "VRB" && spd < 3) return "Calm";
  if (dir === "VRB") return `Variable wind at ${spd} kt`;
  const d = typeof dir === "number" ? dir : Number(dir);
  if (!Number.isFinite(d) || spd < 1) return "Calm";
  const from = compass16(d);
  const gust = gst && gst > spd + 3 ? `, gusting ${gst}` : "";
  const feel =
    spd < 6 ? "Light breeze" : spd < 12 ? "Moderate breeze" : spd < 20 ? "Breezy" : "Strong wind";
  return `${feel} from the ${from} at ${spd} kt${gust}`;
}

function tempText(temp?: number, dewp?: number): string {
  if (temp == null) return "Temperature not reported";
  const f = Math.round(cToF(temp));
  const c = Math.round(temp);
  let extra = "";
  if (dewp != null && temp - dewp <= 2 && temp > 0) extra = " — humid, possible haze or low cloud";
  if (dewp != null && temp - dewp <= 1 && temp <= 3) extra = " — near fog";
  return `${c}°C / ${f}°F${extra}`;
}

function ceilingText(clouds?: Cloud[], cover?: string): string {
  const c = ceilingFt(clouds);
  if (c == null) {
    if (!clouds?.length || cover === "CLR" || cover === "SKC") return "Sky clear of significant cloud";
    const few = clouds[0];
    if (few?.base) return `${({ FEW: "A few clouds", SCT: "Scattered clouds" } as Record<string, string>)[few.cover] ?? "Clouds"} at ${few.base.toLocaleString("en-US")} ft — no solid ceiling`;
    return "No solid ceiling";
  }
  if (c < 500) return `Ceiling very low, ${c.toLocaleString("en-US")} ft`;
  if (c < 1000) return `Low ceiling at ${c.toLocaleString("en-US")} ft`;
  if (c < 3000) return `Ceiling around ${c.toLocaleString("en-US")} ft`;
  return `Ceiling ${c.toLocaleString("en-US")} ft`;
}

export function decodeMetar(m: Metar): DecodedField {
  const category = categoryOf(m.fltCat);
  const wind = windText(m.wdir, m.wspd, m.wgst);
  const vis = visText(m.visib);
  const ceiling = ceilingText(m.clouds, m.cover);
  const temp = tempText(m.temp, m.dewp);
  const wx = m.wxString?.trim() ? m.wxString.trim() : "No significant weather reported";
  const summary = `${categoryLabel(category)}. ${wind}. ${vis}. ${ceiling}.`;
  return {
    category,
    categoryLabel: categoryLabel(category),
    wind,
    vis,
    ceiling,
    temp,
    wx,
    summary,
  };
}

export function passengerDelayHint(cat: DecodedField["category"], wspd?: number, wgst?: number): string {
  const gusty = (wgst ?? 0) >= 25 || (wspd ?? 0) >= 22;
  if (cat === "LIFR") return "Plan for holding, long taxis, and a real chance of a miss. Build slack.";
  if (cat === "IFR") return "Arrivals slow down. A 40-minute delay can appear without the board changing.";
  if (cat === "MVFR" && gusty) return "Crosswinds plus a lower ceiling — go-arounds and runway changes show up.";
  if (gusty) return "Gusty. Expect a firm landing and some taxi delays if they swap runways.";
  if (cat === "MVFR") return "A little weather. Most flights go; a few run late.";
  return "Weather isn’t the problem today. If you’re delayed, it’s the inbound aircraft or the crowd.";
}
