import { formatHoursMinutes, formatMiles } from "./geo.ts";

export type BriefLogKind = "weather" | "schedule" | "stage" | "delay" | "update";

export type BriefLogEntry = {
  at: number;
  kind: BriefLogKind;
  text: string;
};

export const BRIEF_LOG_LABEL: Record<BriefLogKind, string> = {
  weather: "Weather",
  schedule: "Schedule",
  stage: "Trip stage",
  delay: "Delay",
  update: "Update",
};

const LOG_CAP = 24;
const DELAY_JITTER_MIN = 5;
const ARRIVAL_CHANGE_SEC = 15 * 60;

const JARGON =
  /\b(SIGMET|AIRMET|PIREP|G-?AIRMET|METAR|TAF|NAS|OOOI|GDP|AFP|FL\d{2,3}|OUT\/OFF|IFR|LIFR|MVFR|VFR)\b/i;

export type RideFacts = {
  scheduleNote?: string;
  takeoffEstimateExpired?: boolean;
  q: string;
  iata: string;
  airline: string | null;
  fromCity: string;
  fromIata: string;
  toCity: string;
  toIata: string;
  stage: string;
  now: string;
  live: boolean;
  typeName: string | null;
  registration: string | null;
  grade: string;
  label: string;
  summary: string;
  reasons: string[];
  remainingNm: number;
  etaMin: number;
  originWx: string;
  originNas: string;
  destWx: string;
  destNas: string;
  inbound: string;
  inboundHeadline: string;
  inboundDetail: string;
  inboundStatus?: string;
  rideLabel?: string;
  push: string | null;
  pushKind?: string | null;
  pushSource?: "provider_actual" | "track_detected" | "live_detected" | null;
  taxiOutMin: number | null;
  taxiOutKind?: string | null;
  takeoff: string | null;
  takeoffKind?: string | null;
  land: string | null;
  taxiInMin: number | null;
  taxiInKind?: string | null;
  originGate: string | null;
  destGate: string | null;
  delayMin?: number | null;
  pushWas?: string | null;
  typicalDelayMin?: number | null;
  originTaf?: string | null;
  destTaf?: string | null;
  wxHash?: string;
  wxDeltas?: string[];
  filedAt?: number | null;
  worstChop?: string | null;
  corridorWx?: string | null;
  pushUnix?: number | null;
  takeoffUnix?: number | null;
  landUnix?: number | null;
  arriveDelayMin?: number | null;
  convective?: boolean;
  destCat?: string | null;
  originCat?: string | null;
  landKind?: string | null;
  gateKind?: string | null;
  gate?: string | null;
};

export type BriefSegment = {
  id: string;
  label: string;
  body: string;
};

export type BriefSnap = {
  stage: string;
  delay: number | null;
  arriveDelay: number | null;
  taxiOut: number | null;
  taxiOutKind: string | null;
  taxiIn: number | null;
  taxiInKind: string | null;
  ride: string;
  destNas: string;
  originNas: string;
  inbound: string;
  land: string | null;
  takeoff: string | null;
  push: string | null;
  pushKind?: string | null;
  pushSource?: "provider_actual" | "track_detected" | "live_detected" | null;
  takeoffKind?: string | null;
  landKind?: string | null;
  gateKind?: string | null;
  gate?: string | null;
  destGate: string | null;
  wx: string;
  worstChop: string | null;
  convective: boolean;
  destCat: string | null;
  originCat: string | null;
  pushUnix: number | null;
  takeoffUnix: number | null;
  landUnix: number | null;
};

export type CompiledBrief = {
  lead: string;
  aircraft: string | null;
  why: string | null;
  snap: BriefSnap;
  segments: BriefSegment[];
  filedAt?: number | null;
  liveAt?: number | null;
  log: BriefLogEntry[];
};

function clean(s: string) {
  return s.replace(/\s+/g, " ").replace(/\.+/g, ".").trim();
}

function joinSentences(parts: string[]) {
  const out = parts.map((p) => clean(p.replace(/\.+$/, ""))).filter(Boolean);
  if (!out.length) return "";
  return `${out.join(". ")}.`;
}

function nasLine(raw: string) {
  if (!raw || /no known|n\/a/i.test(raw)) return "";
  return raw.replace(/\.+$/, "").trim();
}

function passengerDelay(raw: string): string {
  const s = nasLine(raw);
  if (!s) return "";
  const u = s.toUpperCase();
  if (/THUNDER|TSRA|TSTM/.test(u)) return "thunderstorms";
  if (/GROUND STOP|\bGS\b/.test(u)) return "flights being held";
  if (/GDP|GROUND DELAY/.test(u)) return "a delay program";
  if (/VOLUME|CAPACITY/.test(u)) return "a busy airport";
  if (/\bSNOW|\bICE|WINTER/.test(u)) return "snow and ice";
  if (/\bFOG\b/.test(u)) return "fog";
  if (/\bWIND/.test(u)) return "wind";
  return s
    .replace(/\b(GDP|GS|AFP|NAS|SIGMET|AIRMET|METAR|TAF)\b/gi, "")
    .replace(/[:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function chopRank(c: string | null | undefined) {
  const k = String(c || "smooth").toLowerCase();
  if (k.includes("severe")) return 3;
  if (k.includes("moderate")) return 2;
  if (k.includes("light")) return 1;
  return 0;
}

function chopWord(c: string | null | undefined) {
  const r = chopRank(c);
  if (r >= 3) return "severe turbulence";
  if (r === 2) return "moderate turbulence";
  if (r === 1) return "light turbulence";
  return "smooth";
}

function chopPhrase(from: string | null | undefined, to: string | null | undefined, worse: boolean) {
  const a = chopWord(from);
  const b = chopWord(to);
  if (a === b) return null;
  if (worse) {
    if (a === "smooth") return `${b.charAt(0).toUpperCase()}${b.slice(1)} ahead`;
    return `Ride was ${a} → now ${b}`;
  }
  if (b === "smooth") return "Turbulence easing — ride looks smooth";
  return `Ride was ${a} → now ${b}`;
}

function minutesLater(prevUnix: number | null, nextUnix: number | null) {
  if (prevUnix == null || nextUnix == null) return null;
  return Math.round((nextUnix - prevUnix) / 60);
}

function snapOf(d: RideFacts): BriefSnap {
  return {
    stage: d.now,
    delay: d.delayMin ?? null,
    arriveDelay: d.arriveDelayMin ?? null,
    taxiOut: d.taxiOutMin ?? null,
    taxiOutKind: d.taxiOutKind ?? null,
    taxiIn: d.taxiInMin ?? null,
    taxiInKind: d.taxiInKind ?? null,
    ride: d.rideLabel ?? "Smooth",
    destNas: nasLine(d.destNas),
    originNas: nasLine(d.originNas),
    inbound: d.inboundStatus ?? d.inboundHeadline,
    land: d.land,
    takeoff: d.takeoff,
    takeoffKind: d.takeoffKind ?? null,
    push: d.push,
    pushKind: d.pushKind ?? null,
    pushSource: d.pushSource ?? null,
    destGate: d.destGate,
    wx: d.wxHash ?? "",
    worstChop: d.worstChop ?? null,
    convective: Boolean(d.convective),
    destCat: d.destCat ?? null,
    originCat: d.originCat ?? null,
    pushUnix: d.pushUnix ?? null,
    takeoffUnix: d.takeoffUnix ?? null,
    landUnix: d.landUnix ?? null,
    landKind: d.landKind ?? null,
    gateKind: d.gateKind ?? null,
    gate: d.gate ?? null,
  };
}

/** Older logs recorded broad stage changes as physical takeoff/landing events. */
export function briefLogText(entry: BriefLogEntry): string {
  if (entry.kind !== "stage") return entry.text;
  if (entry.text === "Taking off") return "In-flight status update";
  if (entry.text === "Landing") return "Arrival status update";
  if (entry.text === "Arriving at the gate") return "At the destination gate";
  return entry.text;
}

function stageLine(stage: string): string | null {
  if (stage === "origin_gate") return "At the origin gate";
  if (stage === "push") return "Pushback";
  if (stage === "taxi") return "Taxiing out";
  if (stage === "ride") return "In flight";
  if (stage === "arrival") return "Arrival";
  if (stage === "final_approach") return "Final approach";
  if (stage === "taxi_in") return "Taxiing in";
  if (stage === "gate") return "At the gate";
  if (stage === "inbound") return "Still waiting on the inbound plane";
  return null;
}

export function diffBriefLog(prev: BriefSnap | undefined, next: BriefSnap, d?: RideFacts): Omit<BriefLogEntry, "at">[] {
  if (!prev) return [];
  const out: Omit<BriefLogEntry, "at">[] = [];

  const pushConfirmed = Boolean(next.push && (next.pushSource || next.pushKind === "actual"));
  const pushBecameActual = pushConfirmed && (!prev.pushSource || prev.push !== next.push);
  const takeoffBecameActual = next.takeoffKind === "actual" && (prev.takeoffKind !== "actual" || prev.takeoff !== next.takeoff);
  const landingBecameActual = next.landKind === "actual" && (prev.landKind !== "actual" || prev.land !== next.land);
  const gateBecameActual = next.gateKind === "actual" && (prev.gateKind !== "actual" || prev.gate !== next.gate);

  if (pushBecameActual) out.push({ kind: "stage", text: `Pushed back at ${next.push}` });
  if (takeoffBecameActual && next.takeoff) out.push({ kind: "stage", text: `Took off at ${next.takeoff}` });
  if (landingBecameActual && next.land) out.push({ kind: "stage", text: `Landed at ${next.land}` });
  if (gateBecameActual && next.gate) out.push({ kind: "stage", text: `At the gate at ${next.gate}` });

  if (prev.stage !== next.stage && !(prev.stage === "arrival" && next.stage === "ride")) {
    const line = stageLine(next.stage);
    const coveredByActual = (next.stage === "push" && pushBecameActual)
      || (next.stage === "ride" && takeoffBecameActual)
      || (next.stage === "gate" && gateBecameActual);
    if (line && !coveredByActual) out.push({ kind: "stage", text: line });
  }

  const delayPrev = prev.delay ?? 0;
  const delayNext = next.delay ?? 0;
  const beforeTakeoff = ["inbound", "origin_gate", "push", "taxi"].includes(next.stage);
  if (beforeTakeoff && delayPrev < DELAY_JITTER_MIN && delayNext >= DELAY_JITTER_MIN) {
    out.push({ kind: "delay", text: `Delay at the airport — about ${delayNext} minutes` });
  } else if (beforeTakeoff && delayNext >= DELAY_JITTER_MIN && Math.abs(delayNext - delayPrev) >= DELAY_JITTER_MIN) {
    out.push({ kind: "delay", text: `Delay is now about ${delayNext} minutes` });
  } else if (beforeTakeoff && delayPrev >= DELAY_JITTER_MIN && delayNext < DELAY_JITTER_MIN) {
    out.push({ kind: "delay", text: "The departure delay has lifted" });
  }

  if (prev.destNas !== next.destNas) {
    if (next.destNas) {
      const why = passengerDelay(next.destNas);
      out.push({
        kind: "delay",
        text: why ? `Delay at the arrival airport — ${why}` : "Delay at the arrival airport",
      });
    } else if (prev.destNas) {
      out.push({ kind: "delay", text: "The arrival delay has lifted" });
    }
  }

  const landed = next.landKind === "actual" || next.stage === "taxi_in" || next.stage === "gate";
  if (!landed && prev.landUnix != null && next.landUnix != null && Math.abs(next.landUnix - prev.landUnix) >= ARRIVAL_CHANGE_SEC) {
    const later = minutesLater(prev.landUnix, next.landUnix);
    if (later != null) {
      out.push({
        kind: "schedule",
        text:
          later > 0
            ? `Arrival now looks about ${later} minutes later`
            : `Arrival now looks about ${Math.abs(later)} minutes earlier`,
      });
    } else if (next.land) {
      out.push({ kind: "schedule", text: `Arrival now looks like ${next.land}` });
    }
  }

  if (prev.taxiOutKind !== "measured" && next.taxiOutKind === "measured" && next.taxiOut != null) {
    out.push({ kind: "schedule", text: `Taxi out was ${next.taxiOut} minutes` });
  }

  if (prev.taxiInKind !== "measured" && next.taxiInKind === "measured" && next.taxiIn != null) {
    out.push({ kind: "schedule", text: `Taxi in was ${next.taxiIn} minutes` });
  }

  // Touchdown ends en-route weather updates.
  if (!landed) {
  const ridePrev = chopRank(prev.worstChop ?? prev.ride);
  const rideNext = chopRank(next.worstChop ?? next.ride);
  if (rideNext !== ridePrev && next.stage !== "arrival" && next.stage !== "gate") {
    const material = Math.max(ridePrev, rideNext) >= 2 || Math.abs(rideNext - ridePrev) >= 2;
    if (material) {
      const line = chopPhrase(prev.worstChop ?? prev.ride, next.worstChop ?? next.ride, rideNext > ridePrev);
      if (line) out.push({ kind: "weather", text: line });
    }
  }

  if (!prev.convective && next.convective) {
    out.push({ kind: "weather", text: "Thunderstorms along the route" });
  } else if (prev.convective && !next.convective) {
    out.push({ kind: "weather", text: "Thunderstorms along the route have eased" });
  }

  if (prev.wx !== next.wx && !out.some((e) => e.kind === "weather")) {
    const extras = (d?.wxDeltas ?? []).map(passengerWxDelta).filter((x): x is string => Boolean(x));
    if (extras[0]) out.push({ kind: "weather", text: extras[0] });
  }

  }
  return out.filter((e) => e.text && !JARGON.test(e.text));
}

function passengerWxDelta(raw: string): string | null {
  const s = String(raw || "");
  if (!s || /\b(?:UNK|unknown|n\/a)\b/i.test(s)) return null;
  if (/thunder|storm/i.test(s) && /drop|ease|off/i.test(s)) return "Thunderstorms along the route have eased";
  if (/thunder|storm/i.test(s)) return "Thunderstorms along the route";
  if (/chop|pirep|turb/i.test(s) && /smooth|drop|ease/i.test(s)) return "Turbulence easing — ride looks smooth";
  if (/severe/i.test(s) && /chop|pirep|turb/i.test(s)) return "Severe turbulence ahead";
  if (/moderate/i.test(s) && /chop|pirep|turb/i.test(s)) return "Moderate turbulence ahead";
  if (/chop|pirep|turb/i.test(s)) return null;
  if (/arrival weather|dest cat|forecast|taf/i.test(s)) return null;
  if (JARGON.test(s)) return null;
  const plain = s.replace(/\.+$/, "").trim();
  if (plain.length > 90) return null;
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

function whyChanged(prev: BriefSnap | undefined, next: BriefSnap, d?: RideFacts): string | null {
  const bits = diffBriefLog(prev, next, d).map((e) => e.text.charAt(0).toLowerCase() + e.text.slice(1));
  if (!bits.length) return null;
  return `Updated because ${bits.join(", and ")}.`;
}

function inboundClause(d: RideFacts) {
  const st = d.inboundStatus ?? "";
  if (st === "complete") return "Inbound is already at the gate.";
  if (st === "at_field") return d.inboundDetail || "Inbound is taxiing in.";
  if (st === "airborne") return d.inboundDetail || d.inboundHeadline || "The inbound aircraft is still in the air.";
  if (d.inboundDetail && !/this is the flight|already happened/i.test(d.inboundDetail)) return d.inboundDetail;
  return "";
}

function delayClause(d: RideFacts) {
  if (d.push && d.pushSource === "provider_actual") return `Gate departure reported at ${d.push}.`;
  if (d.push && (d.pushSource === "live_detected" || d.pushSource === "track_detected")) return `Pushback detected around ${d.push}.`;
  const timing = d.pushKind === "scheduled" ? "Scheduled gate departure" : "Estimated gate departure";
  if (d.delayMin != null && d.delayMin >= 5) {
    return d.push ? `${timing}: ${d.push}, ${d.delayMin} minutes later than scheduled.` : `Departure is estimated to be ${d.delayMin} minutes late.`;
  }
  if (d.push) return `${timing}: ${d.push}.`;
  if (d.typicalDelayMin != null && d.typicalDelayMin >= 25) {
    return `This flight often leaves about ${d.typicalDelayMin} minutes late even when the board still looks on time.`;
  }
  return "";
}

function taxiOutClause(d: RideFacts) {
  if (d.taxiOutMin == null) return "";
  const est = d.taxiOutKind !== "measured";
  const gate = d.originGate ? ` from ${d.originGate}` : "";
  return `${est ? "Estimated taxi out" : "Taxi out"} ${d.taxiOutMin} minutes${gate}.`;
}

function rideClause(d: RideFacts) {
  if (d.now === "arrival" || d.now === "gate") return "";
  const label = d.rideLabel || "Smooth";
  if (label === "Smooth") return "Ride looks smooth.";
  if (label === "Weather coverage incomplete" || label === "Weather coverage unavailable") return `${label}.`;
  return `${label} on the remaining path.`;
}

function destClause(d: RideFacts) {
  const delay = nasLine(d.destNas);
  const land =
    d.landKind === "actual" && d.land
      ? `Landed at ${d.land}`
      : d.land
        ? `Landing around ${d.land}`
        : `Into ${d.toCity}`;
  const gate =
    d.gate && d.now === "gate" && d.gateKind === "actual"
      ? ` At the gate ${d.gate}.`
      : d.gate && (d.now === "arrival" || d.now === "ride")
        ? d.gateKind === "actual"
          ? ` At the gate ${d.gate}.`
          : ` At the gate around ${d.gate}.`
        : "";
  const taf = d.destTaf && !/n\/a/i.test(d.destTaf) ? ` Arrival forecast: ${d.destTaf}.` : "";
  if (delay) return `${land}. ${d.toIata} delay: ${delay}.${gate}${taf}`;
  return `${land}.${gate}${taf}`;
}

function taxiInClause(d: RideFacts) {
  if (d.taxiInMin == null && !d.destGate) return "";
  const gate = d.destGate ? ` to ${d.destGate}` : "";
  if (d.taxiInMin == null) return `Posted gate ${d.destGate}.`;
  if (d.taxiInKind === "measured") return `Taxi in was ${d.taxiInMin} minutes${gate}.`;
  return `Estimated taxi in ${d.taxiInMin} minutes${gate}.`;
}

function composeLead(d: RideFacts) {
  const air = d.airline ?? "This flight";
  const ac = [d.typeName, d.registration].filter(Boolean).join(", ");
  const open = `${air} ${d.iata}, ${d.fromCity} to ${d.toCity}${ac ? `, ${ac}` : ""}.`;
  const stage = d.now;
  const originWx = d.originWx && !/n\/a|missing/i.test(d.originWx) ? d.originWx : "";
  const originNas = nasLine(d.originNas);

  if (stage === "gate") {
    return joinSentences([open, destClause(d), taxiInClause(d) || "You're at the gate."]);
  }

  if (stage === "arrival") {
    const landed = d.landKind === "actual";
    if (landed) {
      return joinSentences([
        open,
        `Landed${d.land ? ` at ${d.land}` : ""}. Taxiing in.`,
        d.gate
          ? d.gateKind === "actual"
            ? `At the gate ${d.gate}.`
            : `At the gate around ${d.gate}.`
          : taxiInClause(d),
      ]);
    }
    return joinSentences([
      open,
      `On the arrival into ${d.toIata}.`,
      destClause(d),
      taxiInClause(d),
    ]);
  }

  if (stage === "ride") {
    const left =
      d.remainingNm > 0
        ? `About ${formatMiles(d.remainingNm)} left, roughly ${formatHoursMinutes(Math.max(1, d.etaMin))}.`
        : "";
    const air = d.live
      ? "You're in the air."
      : "In the air — live position unavailable right now.";
    return joinSentences([open, air, left, rideClause(d), destClause(d), taxiInClause(d)]);
  }

  if (stage === "taxi") {
    return joinSentences([
      open,
      "You're on the move — pushback or taxi before takeoff.",
      d.push && d.pushSource === "provider_actual" ? `Gate departure reported at ${d.push}.`
        : d.push && (d.pushSource === "live_detected" || d.pushSource === "track_detected") ? `Pushback detected around ${d.push}.`
        : d.stage === "taxi" ? "Pushback was already underway when tracking began; the exact time isn't available."
        : "Departure time is not yet confirmed.",
      d.pushKind === "actual" && d.delayMin != null && d.delayMin >= 5 ? `Departure was ${d.delayMin} minutes later than scheduled.` : "",
      d.takeoffEstimateExpired ? "Awaiting updated takeoff time." : d.takeoff ? `Estimated takeoff around ${d.takeoff}.` : "",
      taxiOutClause(d),
      originNas ? `${d.fromIata} delay: ${originNas}.` : "",
      rideClause(d),
      destClause(d),
      taxiInClause(d),
    ]);
  }

  return joinSentences([
    open,
    inboundClause(d),
    delayClause(d),
    taxiOutClause(d),
    originNas ? `${d.fromIata} delay: ${originNas}.` : "",
    originWx && /IFR|LIFR|thunder|snow|fog/i.test(originWx) ? `Departure weather: ${originWx}.` : "",
    d.originTaf && /thunder|fog|snow|ceiling|wind/i.test(d.originTaf) ? `Departure forecast: ${d.originTaf}.` : "",
    rideClause(d),
    destClause(d),
    taxiInClause(d),
  ]);
}

function transientKey(entry: Pick<BriefLogEntry, "kind" | "text">): string | null {
  if (entry.kind === "weather") {
    if (/thunderstorm/i.test(entry.text)) return "weather:storms";
    if (/turbulence|ride was/i.test(entry.text)) return "weather:ride";
  }
  if (entry.kind === "delay") {
    if (/arrival airport/i.test(entry.text)) return "delay:arrival";
    if (/airport|departure delay/i.test(entry.text)) return "delay:departure";
  }
  if (entry.kind === "schedule" && /Arrival now looks/i.test(entry.text)) return "schedule:arrival";
  return null;
}

function curateBriefLog(log: BriefLogEntry[], next: BriefSnap): BriefLogEntry[] {
  const pushed = Boolean(next.pushSource || next.pushKind === "actual");
  const airborne = ["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(next.stage);
  const landed = next.landKind === "actual" || ["taxi_in", "gate"].includes(next.stage);
  let kept = log.map((entry) => entry.kind === "stage" && entry.text === "On the move — pushback and taxi"
    ? { ...entry, text: "Taxiing out" }
    : entry).filter((entry) => {
    const text = entry.text;
    if (entry.kind === "update") return false;
    if (entry.kind === "weather" && /^Light turbulence ahead$/i.test(text)) return false;
    if (/Estimated taxi (?:out|in) is now/i.test(text)) return false;
    if (pushed && /Departure time moved|estimated push|push time moved/i.test(text)) return false;
    if (airborne && entry.kind === "delay" && /Delay at the airport|Delay is now|departure delay/i.test(text)) return false;
    if (airborne && /Takeoff now looks|Estimated taxi out/i.test(text)) return false;
    if (next.takeoffKind === "actual" && entry.kind === "stage" && text === "In flight") return false;
    if (landed && /Arrival now looks|Estimated taxi in/i.test(text)) return false;
    return true;
  });
  const collapsed: BriefLogEntry[] = [];
  for (const entry of kept) {
    const key = transientKey(entry);
    if (!key) {
      collapsed.push(entry);
      continue;
    }
    let priorIndex = -1;
    for (let index = collapsed.length - 1; index >= 0; index -= 1) {
      if (transientKey(collapsed[index]) === key) {
        priorIndex = index;
        break;
      }
    }
    const prior = priorIndex >= 0 ? collapsed[priorIndex] : null;
    const reversed = key === "schedule:arrival" && prior && entry.at - prior.at < 10 * 60_000
      && ((/earlier/i.test(prior.text) && /later/i.test(entry.text)) || (/later/i.test(prior.text) && /earlier/i.test(entry.text)));
    if (priorIndex >= 0) collapsed.splice(priorIndex, 1);
    if (!reversed) collapsed.push(entry);
  }
  return collapsed.slice(-LOG_CAP);
}

function actualEventEntries(d: RideFacts, log: BriefLogEntry[], at: number): BriefLogEntry[] {
  const entries: BriefLogEntry[] = [];
  const add = (text: string, unix?: number | null) => {
    if (!log.some((entry) => entry.kind === "stage" && entry.text === text)) {
      entries.push({ at: unix != null ? unix * 1000 : at, kind: "stage", text });
    }
  };
  if (d.push && (d.pushSource || d.pushKind === "actual")) add(`Pushed back at ${d.push}`, d.pushUnix);
  if (d.takeoff && d.takeoffKind === "actual") add(`Took off at ${d.takeoff}`, d.takeoffUnix);
  if (d.land && d.landKind === "actual") add(`Landed at ${d.land}`, d.landUnix);
  if (d.gate && d.gateKind === "actual") add(`At the gate at ${d.gate}`);
  return entries;
}

function appendLog(log: BriefLogEntry[], added: Omit<BriefLogEntry, "at">[], at: number): BriefLogEntry[] {
  let next = log.slice();
  for (const e of added) {
    const text = clean(e.text).replace(/\.+$/, "");
    if (!text || JARGON.test(text)) continue;
    if (next.some((x) => x.text === text && (e.kind === "stage" || at - x.at < 12 * 60_000))) continue;
    const key = transientKey({ kind: e.kind, text });
    if (key === "schedule:arrival") {
      const prior = [...next].reverse().find((entry) => transientKey(entry) === key);
      const reversed = prior && at - prior.at < 10 * 60_000
        && ((/earlier/i.test(prior.text) && /later/i.test(text)) || (/later/i.test(prior.text) && /earlier/i.test(text)));
      next = next.filter((entry) => transientKey(entry) !== key);
      if (reversed) continue;
    } else if (key) {
      next = next.filter((entry) => transientKey(entry) !== key);
    }
    next.push({ at, kind: e.kind, text });
  }
  if (next.length > LOG_CAP) next = next.slice(-LOG_CAP);
  return next;
}

export function composeBrief(d: RideFacts, previous?: CompiledBrief | null): CompiledBrief {
  const snap = snapOf(d);
  const ac = [d.typeName, d.registration].filter(Boolean).join(" · ") || null;
  const lead = joinSentences([composeLead(d), d.scheduleNote ?? ""]);
  const at = Date.now();
  let seed = curateBriefLog(previous?.log ?? [], snap);
  seed = [...seed, ...actualEventEntries(d, seed, at)].sort((a, b) => a.at - b.at);
  const added = previous?.snap ? diffBriefLog(previous.snap, snap, d) : [];
  const log = curateBriefLog(appendLog(seed, added, at), snap);
  if (previous && added.length === 0 && lead === previous.lead && ac === previous.aircraft
    && JSON.stringify(log) === JSON.stringify(previous.log)) return previous;
  const why = whyChanged(previous?.snap, snap, d);
  return {
    lead,
    aircraft: ac,
    why,
    snap,
    segments: [],
    filedAt: d.filedAt ?? previous?.filedAt ?? null,
    liveAt: at,
    log,
  };
}

export function logManualRefresh(prev: CompiledBrief | null | undefined): CompiledBrief | null {
  if (!prev) return prev ?? null;
  return { ...prev, liveAt: Date.now() };
}

export function briefAsText(b: CompiledBrief): string {
  return [b.lead, b.why].filter(Boolean).join(" ").trim();
}
