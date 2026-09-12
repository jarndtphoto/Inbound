import { formatHoursMinutes } from "./geo";

export type RideFacts = {
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
};

export type BriefSegment = {
  id: string;
  label: string;
  body: string;
};

export type BriefSnap = {
  stage: string;
  delay: number | null;
  taxiOut: number | null;
  taxiIn: number | null;
  taxiInKind: string | null;
  ride: string;
  destNas: string;
  inbound: string;
  land: string | null;
  wx: string;
};

export type CompiledBrief = {
  lead: string;
  aircraft: string | null;
  why: string | null;
  snap: BriefSnap;
  segments: BriefSegment[];
  filedAt?: number | null;
  liveAt?: number | null;
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

function snapOf(d: RideFacts): BriefSnap {
  return {
    stage: d.now,
    delay: d.delayMin ?? null,
    taxiOut: d.taxiOutMin ?? null,
    taxiIn: d.taxiInMin ?? null,
    taxiInKind: d.taxiInKind ?? null,
    ride: d.rideLabel ?? "Smooth",
    destNas: nasLine(d.destNas),
    inbound: d.inboundStatus ?? d.inboundHeadline,
    land: d.land,
    wx: d.wxHash ?? "",
  };
}

function whyChanged(prev: BriefSnap | undefined, next: BriefSnap, d?: RideFacts): string | null {
  if (!prev) return null;
  const bits: string[] = [];
  if (prev.stage !== next.stage) {
    if (next.stage === "ride") bits.push("you're off the ground — inbound is done and this is now an airborne brief");
    else if (next.stage === "arrival") bits.push("you're on the arrival, so high-altitude chop drops out");
    else if (next.stage === "gate") bits.push("you're at the gate, so taxi times are actual");
    else if (next.stage === "push") bits.push("you're at the gate waiting on push");
    else if (next.stage === "taxi") bits.push("they've left the gate and taxi has started");
  }
  if (prev.delay != null && next.delay != null && Math.abs(next.delay - prev.delay) >= 5) {
    bits.push(`the push delay moved to ${next.delay} minutes`);
  } else if ((prev.delay ?? 0) < 5 && (next.delay ?? 0) >= 5) {
    bits.push(`a ${next.delay}-minute push delay showed up`);
  }
  if (prev.ride !== next.ride && next.stage !== "arrival" && next.stage !== "gate") {
    bits.push(`the ride call changed to ${next.ride.toLowerCase()}`);
  }
  if (prev.destNas !== next.destNas) {
    bits.push(next.destNas ? `arrival delay is now ${next.destNas}` : "the arrival delay program dropped off");
  }
  if (prev.taxiInKind !== "measured" && next.taxiInKind === "measured") {
    bits.push(`taxi in is now the actual ${next.taxiIn} minutes`);
  } else if (prev.taxiIn !== next.taxiIn && next.taxiIn != null && next.stage !== "gate") {
    bits.push(`estimated taxi in moved to ${next.taxiIn} minutes`);
  }
  if (prev.land && next.land && prev.land !== next.land) {
    bits.push(`landing time moved to ${next.land}`);
  }
  if (prev.inbound !== next.inbound && (next.stage === "inbound" || next.stage === "push")) {
    bits.push("the inbound status changed");
  }
  if (prev.wx !== next.wx) {
    const extra = (d?.wxDeltas ?? []).filter(Boolean);
    if (extra.length) bits.push(extra.join(", and "));
    else bits.push("the remaining-route weather changed");
  }
  if (!bits.length) return null;
  const text = bits.join(", and ");
  return `Updated because ${text}.`;
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
  if (d.delayMin != null && d.delayMin >= 5) {
    return d.push ? `Push is ${d.delayMin} minutes late at ${d.push}.` : `Push is ${d.delayMin} minutes late.`;
  }
  if (d.push) return `Push is ${d.push}.`;
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
  return `${label} on the remaining path.`;
}

function destClause(d: RideFacts) {
  const delay = nasLine(d.destNas);
  const land = d.land ? `Landing around ${d.land}` : `Into ${d.toCity}`;
  const taf = d.destTaf && !/n\/a/i.test(d.destTaf) ? ` Arrival forecast: ${d.destTaf}.` : "";
  if (delay) return `${land}. ${d.toIata} delay: ${delay}.${taf}`;
  return `${land}.${taf}`;
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
        ? `About ${Math.round(d.remainingNm)} miles left, roughly ${formatHoursMinutes(Math.max(1, d.etaMin))}.`
        : "";
    return joinSentences([open, "You're airborne.", left, rideClause(d), destClause(d), taxiInClause(d)]);
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

export function composeBrief(d: RideFacts, previous?: CompiledBrief | null): CompiledBrief {
  const snap = snapOf(d);
  const ac = [d.typeName, d.registration].filter(Boolean).join(" · ") || null;
  const lead = composeLead(d);
  const why = whyChanged(previous?.snap, snap, d);
  return {
    lead,
    aircraft: ac,
    why,
    snap,
    segments: [],
    filedAt: d.filedAt ?? previous?.filedAt ?? null,
    liveAt: Date.now(),
  };
}

export function briefAsText(b: CompiledBrief): string {
  return [b.lead, b.why].filter(Boolean).join(" ").trim();
}
