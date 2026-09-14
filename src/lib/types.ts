import type { DecodedField, Metar, Taf } from "./metar";

export type Traffic = {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  typeName: string | null;
  operator: string | null;
  airline: string | null;
  year: string | null;
  lat: number | null;
  lon: number | null;
  altFt: number | null;
  onGround: boolean;
  gsKt: number | null;
  track: number | null;
  vertFpm: number | null;
  distNm: number;
  bearing: number;
  category: string | null;
  widebody: boolean;
  interesting: boolean;
  phase: "taxi" | "climb" | "cruise" | "descent" | "approach" | "parked";
  extrapolated?: boolean;
  seenSec?: number | null;
};

export type FieldSnapshot = {
  icao: string;
  fetchedAt: number;
  traffic: Traffic[];
  airborne: number;
  onField: number;
  heavies: number;
  weather: {
    metar: Metar | null;
    taf: Taf | null;
    decoded: DecodedField | null;
    delayHint: string;
  };
  error?: string | null;
};

export type LogKind = "sighting" | "trip";

export type LogEntry = {
  id: string;
  kind: LogKind;
  at: number;
  airport: string;
  callsign?: string;
  registration?: string;
  type?: string;
  typeName?: string;
  notes?: string;
  from?: string;
  to?: string;
};

export type TabId = "sky" | "field" | "seat" | "log";

export type StageId = "inbound" | "origin_gate" | "push" | "taxi" | "ride" | "arrival" | "final_approach" | "taxi_in" | "gate";

export type Chop = "smooth" | "light" | "moderate" | "severe";

export type RouteSample = {
  lat: number;
  lon: number;
  frac: number;
  distNm: number;
  remainingNm: number;
  etaMin: number;
  chop: Chop;
  cloud: boolean;
  convective: boolean;
  note: string | null;
  fix: boolean;
};

export type Hazard = {
  id: string;
  kind: "turb" | "convective" | "ice" | "ifr" | "llws" | "pirep";
  chop: Chop;
  label: string;
  detail: string;
  remaining: boolean;
  lat?: number;
  lon?: number;
  source?: "observed" | "advisory" | "forecast";
  validity?: string;
};

export type NasDelay = {
  delayed: boolean;
  type: string | null;
  reason: string;
  avg: string | null;
  min: string | null;
  max: string | null;
  trend: string | null;
};

export type FieldBrief = {
  icao: string;
  iata: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
  tz?: string;
  decoded: DecodedField | null;
  rawMetar: string | null;
  nas: NasDelay | null;
  category: string;
  windDir?: number | null;
  taf?: string | null;
};

export type LiveAircraft = {
  hex: string;
  registration: string | null;
  type: string | null;
  typeName: string | null;
  year: string | null;
  operator: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  track: number | null;
  vertFpm: number | null;
  onGround: boolean;
  phase: Traffic["phase"];
  callsign?: string | null;
  extrapolated?: boolean;
  seenSec?: number | null;
};

export type InboundWatch = {
  callsign: string;
  iata: string;
  type: string | null;
  distNm: number;
  etaMin: number;
  altFt: number | null;
  from: string | null;
  gate: string | null;
  clock: string | null;
  landClock?: string | null;
  gateClock?: string | null;
  taxiing?: boolean;
  locked?: boolean;
  taxiMin?: number | null;
};

export type Comfort = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  label: string;
  summary: string;
  reasons: string[];
  trend?: "up" | "down" | "steady";
  trendWhy?: string | null;
  segments?: Record<StageId, { grade: "A" | "B" | "C" | "D" | "F"; note: string | null }>;
};

export type FlightTimes = {
  push: string | null;
  takeoff: string | null;
  taxiOutMin: number | null;
  land: string | null;
  taxiInMin: number | null;
  taxiOutKind?: "measured" | "posted" | "typical" | "filed" | null;
  taxiInKind?: "measured" | "posted" | "typical" | "filed" | null;
  originGate: string | null;
  destGate: string | null;
  /** Original published push, kept even if the airline rewrites "scheduled". */
  pushWas?: string | null;
  takeoffWas?: string | null;
  landWas?: string | null;
  /** Minutes later than the original push. Negative = early. Null if unknown. */
  delayMin?: number | null;
  arriveDelayMin?: number | null;
  /** Historical typical departure slip for this flight number, minutes. */
  typicalDelayMin?: number | null;
  pushed?: boolean;
  airborne?: boolean;
  pushUnix?: number | null;
  takeoffUnix?: number | null;
  landUnix?: number | null;
  origPushUnix?: number | null;
  origTakeoffUnix?: number | null;
  origLandUnix?: number | null;
  pushKind?: "scheduled" | "estimated" | "actual" | null;
  /** Provenance for an operational push timestamp. Null while push is only scheduled/estimated. */
  pushSource?: "provider_actual" | "track_detected" | "live_detected" | null;
  takeoffKind?: "scheduled" | "estimated" | "actual" | null;
  landKind?: "scheduled" | "estimated" | "actual" | null;
  gateKind?: "scheduled" | "estimated" | "actual" | null;
  gate?: string | null;
  gateUnix?: number | null;
};

export type WxDigest = {
  at: number;
  hash: string;
  worstChop: Chop;
  ride: string;
  convective: boolean;
  pirepCount: number;
  originCat: string;
  destCat: string;
  originTaf: string | null;
  destTaf: string | null;
  corridor: { iata: string; summary: string }[];
  hazardLabels: string[];
};

export type WxBrief = {
  filedAt: number;
  filed: WxDigest;
  live: WxDigest;
  deltas: string[];
  hash: string;
};

export type FlightStory = {
  flightId?: string;
  inboundDiversion?: { source: "flightaware"; reportedAt: number; flightId: string; flight: string; aircraft: string; destination: string | null; originalDestination: string | null; chain: string[] };
  diversion?: { source: "flightaware"; reportedAt: number; originalDestination: string | null; destination: string | null };
  schedule?: { status: "current" | "saved"; confirmedAt: number };
  resume?: import("./flight-resume").FlightResume;
  weatherCoverage?: { failedSources: string[] };
  fetchedAt: number;
  query: string;
  callsign: string;
  iata: string;
  airline: string | null;
  live: boolean;
  currentStage: StageId;
  arrivalStatus?: "airborne" | "landed" | "taxi_in" | "gate";
  providers?: {
    chosenPosition?: string | null;
    chosenPositionAgeSec?: number | null;
    [key: string]: unknown;
  };
  aircraft: LiveAircraft | null;
  origin: FieldBrief;
  dest: FieldBrief;
  route: {
    totalNm: number;
    remainingNm: number;
    flownNm: number;
    etaMin: number;
    progress: number;
    heading: number;
    source: "track" | "direct" | "filed";
    samples: RouteSample[];
    /** Original filed fixes, retained as secondary map reference markers. */
    filedFixes?: Array<{ lat: number; lon: number; label?: string | null }>;
  };
  hazards: Hazard[];
  comfort: Comfort;
  wx?: WxBrief;
  inbound: {
    status: "complete" | "airborne" | "at_field" | "watching" | "unknown";
    headline: string;
    detail: string;
    watch: InboundWatch[];
  };
  times: FlightTimes;
  stages: Record<
    StageId,
    {
      state: "done" | "now" | "next";
      title: string;
      body: string;
      watchouts: string[];
    }
  >;
  error?: string | null;
};

export type LiveCard = {
  callsign: string;
  iata: string;
  airline: string | null;
  from: string;
  to: string;
  fromCity: string;
  toCity: string;
  type: string | null;
  altFt: number | null;
  remainingNm: number | null;
  delayedDest: boolean;
};
