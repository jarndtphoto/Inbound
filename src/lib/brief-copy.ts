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

const LOG_CAP = 80;
const DELAY_JITTER_MIN = 5;
const CLOCK_JITTER_SEC = 4 * 60;
const TAXI_JITTER_MIN = 3;

const JARGON =
  /\b(SIGMET|AIRMET|PIREP|G-?AIRMET|METAR|TAF|NAS|OOOI|GDP|AFP|FL\d{2,3}|OUT\/OFF|IFR|LIFR|MVFR|VFR)\b/i;

export type RideFacts = {
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
  taxiOutMin: number | null;
  taxiOutKind?: string | null;
  takeoff: string | null;
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

function clockMoved(prevUnix: number | null, nextUnix: number | null) {
  if (prevUnix == null || nextUnix == null) return false;
  return Math.abs(nextUnix - prevUnix) >= CLOCK_JITTER_SEC;
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
    push: d.push,
    destGate: d.destGate,
    wx: d.wxHash ?? "",
    worstChop: d.worstChop ?? null,
    convective: Boolean(d.convective),
    destCat: d.destCat ?? null,
    originCat: d.originCat ?? null,
    pushUnix: d.pushUnix ?? null,
    takeoffUnix: d.takeoffUnix ?? null,
    landUnix: d.landUnix ?? null,
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
  if (stage === "push") return "Plane is at the gate";
  if (stage === "taxi") return "On the move — pushback and taxi";
  if (stage === "ride") return "In flight";
  if (stage === "arrival") return "Approaching destination";
  if (stage === "gate") return "At the destination gate";
  if (stage === "inbound") return "Still waiting on the inbound plane";
  return null;
}

export function diffBriefLog(prev: BriefSnap | undefined, next: BriefSnap, d?: RideFacts): Omit<BriefLogEntry, "at">[] {
  if (!prev) return [];
  const out: Omit<BriefLogEntry, "at">[] = [];

  if (prev.stage !== next.stage && !(prev.stage === "arrival" && next.stage === "ride")) {
    const line = stageLine(next.stage);
    if (line) out.push({ kind: "stage", text: line });
  }

  const delayPrev = prev.delay ?? 0;
  const delayNext = next.delay ?? 0;
  if (delayPrev < DELAY_JITTER_MIN && delayNext >= DELAY_JITTER_MIN) {
    out.push({ kind: "delay", text: `Delay at the airport — about ${delayNext} minutes` });
  } else if (delayNext >= DELAY_JITTER_MIN && Math.abs(delayNext - delayPrev) >= DELAY_JITTER_MIN) {
    out.push({ kind: "delay", text: `Delay is now about ${delayNext} minutes` });
  } else if (delayPrev >= DELAY_JITTER_MIN && delayNext < DELAY_JITTER_MIN) {
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

  if (clockMoved(prev.landUnix, next.landUnix)) {
    const later = minutesLater(prev.landUnix, next.landUnix);
    if (later != null && Math.abs(later) >= 5) {
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
  } else if (!prev.landUnix && !next.landUnix && prev.land && next.land && prev.land !== next.land) {
    out.push({ kind: "schedule", text: `Arrival now looks like ${next.land}` });
  }

  if (clockMoved(prev.pushUnix, next.pushUnix) && next.push) {
    out.push({ kind: "schedule", text: `Departure time moved to ${next.push}` });
  } else if (!prev.pushUnix && !next.pushUnix && prev.push && next.push && prev.push !== next.push) {
    out.push({ kind: "schedule", text: `Departure time moved to ${next.push}` });
  }

  if (clockMoved(prev.takeoffUnix, next.takeoffUnix) && next.takeoff && next.stage !== "ride" && next.stage !== "arrival" && next.stage !== "gate") {
    out.push({ kind: "schedule", text: `Takeoff now looks like ${next.takeoff}` });
  }

  if (prev.taxiOutKind !== "measured" && next.taxiOutKind === "measured" && next.taxiOut != null) {
    out.push({ kind: "schedule", text: `Taxi out was ${next.taxiOut} minutes` });
  } else if (
    prev.taxiOut != null &&
    next.taxiOut != null &&
    Math.abs(next.taxiOut - prev.taxiOut) >= TAXI_JITTER_MIN &&
    next.stage !== "ride" &&
    next.stage !== "arrival" &&
    next.stage !== "gate"
  ) {
    out.push({ kind: "schedule", text: `Estimated taxi out is now ${next.taxiOut} minutes` });
  }

  if (prev.taxiInKind !== "measured" && next.taxiInKind === "measured" && next.taxiIn != null) {
    out.push({ kind: "schedule", text: `Taxi in was ${next.taxiIn} minutes` });
  } else if (
    prev.taxiIn != null &&
    next.taxiIn != null &&
    Math.abs(next.taxiIn - prev.taxiIn) >= TAXI_JITTER_MIN &&
    next.stage !== "gate"
  ) {
    out.push({ kind: "schedule", text: `Estimated taxi in is now ${next.taxiIn} minutes` });
  }

  // Touchdown ends en-route and departure weather updates; preserve existing history.
  const landed = next.stage === "gate" || d?.landKind === "actual";
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
  if (/chop|pirep|turb/i.test(s)) return "Light turbulence ahead";
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
  if (d.push && d.pushKind === "actual") return `Gate departure reported at ${d.push}.`;
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
      d.push && d.pushKind === "actual" ? `Gate departure reported at ${d.push}.`
        : d.push && d.pushKind === "estimated" ? `Movement first observed around ${d.push}; this time is approximate.`
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

function appendLog(log: BriefLogEntry[], added: Omit<BriefLogEntry, "at">[], at: number): BriefLogEntry[] {
  let next = log.slice();
  for (const e of added) {
    const text = clean(e.text).replace(/\.+$/, "");
    if (!text || JARGON.test(text)) continue;
    if (next.slice(-6).some((x) => x.text === text && at - x.at < 12 * 60_000)) continue;
    next.push({ at, kind: e.kind, text });
  }
  if (next.length > LOG_CAP) next = next.slice(-LOG_CAP);
  return next;
}

export function composeBrief(d: RideFacts, previous?: CompiledBrief | null): CompiledBrief {
  const snap = snapOf(d);
  const ac = [d.typeName, d.registration].filter(Boolean).join(" · ") || null;
  const lead = composeLead(d);
  const at = Date.now();
  const seed: BriefLogEntry[] = previous?.log?.length
    ? previous.log
    : [{ at, kind: "update", text: "Filed briefing is up" }];
  const added = previous?.snap ? diffBriefLog(previous.snap, snap, d) : [];
  if (previous && added.length === 0 && lead === previous.lead && ac === previous.aircraft) return previous;
  const log = appendLog(seed, added, at);
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
  const at = Date.now();
  const last = prev.log[prev.log.length - 1];
  if (last?.kind === "update" && last.text === "Manual refresh" && at - last.at < 20_000) {
    return { ...prev, liveAt: at };
  }
  return {
    ...prev,
    liveAt: at,
    log: appendLog(prev.log, [{ kind: "update", text: "Manual refresh" }], at),
  };
}

export function briefAsText(b: CompiledBrief): string {
  return [b.lead, b.why].filter(Boolean).join(" ").trim();
}
