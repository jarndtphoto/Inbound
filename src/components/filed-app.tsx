import { keepRouteGeometry as keepRecentTrackGeometry } from "@/lib/route-continuity";
import { applyTakeoffFloor } from "@/lib/confirmed-takeoff";
import { displayStage, flightAirborne, liveFix, elapsedFlight, flownDistance, remainingFlight, type RemainingFlightPresentation } from "@/lib/flight-presentation";
import { FLIGHT_STAGES as STAGES, stageStepId, statusProgressIndex } from "@/lib/flight-stage";
import { AppearanceControl } from "@/components/appearance-control";
import { inboundDiversionText } from "@/lib/inbound-diversion";
import { TravelerCompanion } from "@/components/traveler-companion";
import { BaggageStatus, useBaggageStatus } from "@/components/baggage-status";
import { baggageSummary } from "@/lib/baggage-copy";
import { flightDepartureDate } from "@/lib/airline-status";
import { storyLegDate } from "@/lib/flight-story-date";
import { isLanded, nextStep } from "@/lib/traveler";
import { briefRide } from "@/lib/brief";
import { briefLogLabel, briefLogText, briefingRefreshOutcome, composeBrief, logManualRefresh, type CompiledBrief, type RideFacts } from "@/lib/brief-copy";
import { agoLabel, delayPhrase, updatedAgoLabel } from "@/lib/format";
import { formatDuration, formatMiles, feetPretty, haversineNm } from "@/lib/geo";
import { parseFlightQuery, storyMatchesQuery } from "@/lib/flight-parse";
import { RESUME_MAX_AGE_MS, resumeFromStory, savedScheduleNote } from "@/lib/flight-resume";
import { useFiled } from "@/lib/store";
import { weatherEventNumber, type RouteWeatherEvent } from "@/lib/weather-events";
import { upcomingWeatherEvents, eventWeatherCopy, eventWeatherSource, flightWeatherSummary, pilotReportTiming } from "@/lib/weather-presentation";
import { scheduledTimes, type ScheduledTimes } from "@/lib/scheduled-times";
import { formatClockTime, timeKindLabel } from "@/lib/presentation-time";
import { formatStoryEventTime } from "@/lib/flight-event-time";
import { FLIGHT_TABS, flightHref, parseFlightLocation, storyMatchesFlightLink, type FlightLocation, type FlightTab } from "@/lib/flight-url";
import { passengerAirportWeather } from "@/lib/passenger-airport-weather";
import { getFlightStory } from "@/lib/story";
import type { Chop, Comfort, FlightStory, PilotReportObservation, StageId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RouteMap } from "@/components/route-map";
import { flightPollingInterval } from "@/lib/flight-polling";
import { dismissWelcomeSummary, shouldOpenWelcomeSummary, welcomeLegKey } from "@/lib/flight-welcome-state";
import { INITIAL_FLIGHT_SEARCH_MS, TEMPORARY_FLIGHT_RETRY_MS, flightStoryQueryKey, flightNotFound, flightSearchCanPoll, flightSearchShouldRetry, stopFlightSearch, flightStoryRequest } from "@/lib/flight-search";
import { WeatherEventMarker } from "@/components/weather-event-marker";
import { sampleWeather } from "@/lib/route-weather-segments";
import { WeatherEventBody, WeatherEventHeadline, WeatherIntensityLabel } from "@/components/weather-event-copy";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Clock, Plane, Map as MapIcon, CloudSun, NotebookText, PanelsTopLeft, House, ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Info } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, Component, type ReactNode } from "react";

const STORY_CACHE_KEY = "filed-story-cache-v9";
const LEGACY_STORY_CACHE_KEY = "filed-story-cache-v8";
const ORIG_MEM_KEY = "filed-orig-sched-v3";

function normFlight(q: string) {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function readCachedStory(q: string): FlightStory | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const key = parseFlightQuery(q)?.callsign ?? normFlight(q);
    const records = JSON.parse(localStorage.getItem(STORY_CACHE_KEY) || "{}");
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORY_CACHE_KEY) || "null");
    const entry = records[key] ?? (legacy && storyMatchesQuery(legacy.story ?? {}, q) ? legacy : undefined);
    if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > RESUME_MAX_AGE_MS) return undefined;
    if (!entry.story?.iata || !storyMatchesQuery(entry.story, q)) return undefined;
    // Untimed reports in an older cache were painted into forecast chop. A
    // fresh story is needed to separate those observations from the forecast.
    if (Array.isArray(entry.story.hazards) && entry.story.hazards.some((hazard: FlightStory["hazards"][number]) => hazard?.kind === "pirep"
      && (typeof hazard.observedAt !== "number" || !Number.isFinite(hazard.observedAt)))) return undefined;
    // Older client caches may have promoted an estimate/actual into orig*.
    // Keep all flight evidence, but rebuild schedule presentation from stamps.
    if (entry.scheduledOnly !== true) return { ...entry.story, times: {
      ...entry.story.times, origPushUnix: null, origTakeoffUnix: null, origLandUnix: null,
      pushWas: null, takeoffWas: null, landWas: null,
    } };
    return entry.story;
  } catch {
    return undefined;
  }
}

export function cachedStorySafeDuringRefreshFailure(story: FlightStory, now = Date.now()) {
  const moving = story.live || story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach" || story.currentStage === "taxi_in";
  const providerAge = story.providers?.chosenPositionAgeSec;
  const aircraftAge = story.aircraft?.seenSec;
  const validAges = [providerAge, aircraftAge].filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  const positionAge = validAges.length ? Math.min(...validAges) : null;
  // Airborne ETA freshness follows the freshest validated aircraft fix. The
  // provider metadata can lag behind a newer aircraft object during handoffs.
  const positionFresh = !moving || (positionAge !== null && positionAge <= 90);
  if (moving) return positionFresh;
  return now - story.fetchedAt <= 45 * 60_000;
}

function writeCachedStory(q: string, story: FlightStory) {
  try {
    const samples = story.route.samples;
    let slimSamples = samples;
    if (samples.length > 96) {
      slimSamples = [samples[0]!];
      const last = samples[samples.length - 1]!;
      const step = (samples.length - 1) / 94;
      for (let i = 1; i < 94; i++) slimSamples.push(samples[Math.round(i * step)]!);
      slimSamples.push(last);
    }
    const slim: FlightStory = {
      ...story,
      route: { ...story.route, samples: slimSamples },
    };
    const key = parseFlightQuery(q)?.callsign ?? normFlight(q);
    const records = JSON.parse(localStorage.getItem(STORY_CACHE_KEY) || "{}");
    records[key] = { story: slim, at: Date.now(), scheduledOnly: true };
    const recent = Object.entries(records).filter(([, value]) =>
      Date.now() - (value as { at: number }).at <= RESUME_MAX_AGE_MS
    ).sort((a, b) => (b[1] as { at: number }).at - (a[1] as { at: number }).at).slice(0, 8);
    localStorage.setItem(STORY_CACHE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    /* quota */
  }
}

function origMemKey(story: FlightStory) {
  if (story.stateKey) return story.stateKey;
  const day = storyLegDate(story) ?? new Date(story.fetchedAt).toISOString().slice(0, 10);
  return `${normFlight(story.callsign)}:${story.origin.iata}:${story.dest.iata}:${day}`;
}

const BRIEF_HISTORY_KEY = "inbound-brief-history-v2";

function briefHistoryKey(story: FlightStory, legacy = false) {
  if (!legacy && story.stateKey) return story.stateKey;
  const instance = story.flightId?.trim();
  if (instance) return `${instance}:${story.origin.iata}:${story.dest.iata}`;
  const day = storyLegDate(legacy ? { ...story, stateKey: null } : story) ?? new Date(story.fetchedAt).toISOString().slice(0, 10);
  return `${normFlight(story.callsign)}:${story.origin.iata}:${story.dest.iata}:${day}`;
}

function savedBrief(story: FlightStory): CompiledBrief | null {
  try {
    const records = JSON.parse(localStorage.getItem(BRIEF_HISTORY_KEY) || "{}");
    const entry = records[briefHistoryKey(story)] ?? records[briefHistoryKey(story, true)];
    const b = entry?.brief;
    return b && typeof b.lead === "string" && b.snap && Array.isArray(b.log)
      && Array.isArray(b.segments) ? b : null;
  } catch { return null; }
}
function saveBrief(story: FlightStory, brief: CompiledBrief) {
  try {
    const records = JSON.parse(localStorage.getItem(BRIEF_HISTORY_KEY) || "{}");
    records[briefHistoryKey(story)] = { at: Date.now(), brief };
    const latest = Object.entries(records).sort((a, b) =>
      (b[1] as {at: number}).at - (a[1] as {at: number}).at).slice(0, 30);
    localStorage.setItem(BRIEF_HISTORY_KEY, JSON.stringify(Object.fromEntries(latest)));
  } catch { /* Storage can be unavailable; live tracking still works. */ }
}

function clientSchedules(story: FlightStory) {
  let previous: ScheduledTimes | undefined;
  try { previous = JSON.parse(localStorage.getItem(ORIG_MEM_KEY) || "{}")[origMemKey(story)]; } catch { /* Unavailable storage or SSR. */ }
  return scheduledTimes(story, previous);
}

function rememberOrigOnClient(story: FlightStory): FlightStory {
  let all: Record<string, ScheduledTimes> = {};
  try { all = JSON.parse(localStorage.getItem(ORIG_MEM_KEY) || "{}"); } catch { /* Unavailable storage. */ }
  const k = origMemKey(story);
  const original = clientSchedules(story);
  all[k] = original;
  try { localStorage.setItem(ORIG_MEM_KEY, JSON.stringify(all)); } catch { /* quota */ }
  const t = story.times;
  const slip = (posted: number | null | undefined, scheduled: number | null) => {
    if (posted == null || scheduled == null) return null;
    const minutes = Math.round((posted - scheduled) / 60);
    return minutes > 480 || minutes < -90 || Math.abs(minutes) < 5 ? 0 : minutes;
  };
  const delayMin = slip(t.pushUnix, original.pushUnix);
  const arriveDelayMin = slip(t.landUnix, original.landUnix);
  return { ...story, times: {
    ...t, origPushUnix: original.pushUnix, origTakeoffUnix: original.takeoffUnix, origLandUnix: original.landUnix,
    delayMin: delayMin ?? t.delayMin, arriveDelayMin: arriveDelayMin ?? t.arriveDelayMin,
    push: formatStoryEventTime(story, t.pushUnix, story.origin.tz) ?? t.push,
    takeoff: formatStoryEventTime(story, t.takeoffUnix, story.origin.tz) ?? t.takeoff,
    land: formatStoryEventTime(story, t.landUnix, story.dest.tz) ?? t.land,
    gate: formatStoryEventTime(story, t.gateUnix, story.dest.tz) ?? t.gate,
    pushWas: (delayMin ?? 0) >= 5 ? formatStoryEventTime(story, original.pushUnix, story.origin.tz) : null,
    takeoffWas: (delayMin ?? 0) >= 5 ? formatStoryEventTime(story, original.takeoffUnix, story.origin.tz) : null,
    landWas: (arriveDelayMin ?? 0) >= 5 ? formatStoryEventTime(story, original.landUnix, story.dest.tz) : null,
  } };
}

function isUsableStory(s: FlightStory | undefined): s is FlightStory {
  return Boolean(s?.iata && s.origin && s.dest && s.comfort && s.stages?.inbound && s.route?.samples);
}

function storyForQuery(s: FlightStory | undefined, q: string, date?: string | null): FlightStory | undefined {
  return isUsableStory(s) && storyMatchesFlightLink(s, q, date) ? s : undefined;
}

function rideLabelOf(story: FlightStory) {
  return flightWeatherSummary(story);
}

function takeoffEstimateExpired(story: FlightStory) {
  return ["inbound", "origin_gate", "push", "taxi"].includes(story.currentStage)
    && story.times.takeoffKind !== "actual"
    && story.times.takeoffUnix != null
    && story.times.takeoffUnix <= story.fetchedAt / 1000;
}

function rideFacts(story: FlightStory, query: string, active: StageId): RideFacts {
  const weatherSummary = rideLabelOf(story);
  const chopRanks: Record<Chop, number> = { smooth: 0, light: 1, moderate: 2, severe: 3 };
  const worstChop = story.wx?.live?.worstChop ?? story.route.samples
    .filter((sample) => sample.frac >= story.route.progress)
    .reduce((worst, sample) => chopRanks[sample.chop] > chopRanks[worst] ? sample.chop : worst, "smooth" as Chop);
  return {
    scheduleNote: story.schedule?.status === "saved" ? savedScheduleNote(story.schedule.confirmedAt) : undefined,
    q: query,
    iata: story.iata,
    airline: story.airline,
    fromCity: story.origin.city,
    fromIata: story.origin.iata,
    toCity: story.dest.city,
    toIata: story.dest.iata,
    stage: active,
    now: story.currentStage,
    live: liveFix(story),
    typeName: story.aircraft?.typeName ?? null,
    registration: story.aircraft?.registration ?? null,
    grade: story.comfort.grade,
    label: story.comfort.label,
    summary: story.comfort.summary,
    reasons: story.comfort.reasons ?? [],
    remainingNm: story.route.remainingNm,
    etaMin: story.route.etaMin,
    originWx: story.origin.decoded?.summary ?? "n/a",
    originNas: story.origin.nas?.reason ?? "n/a",
    destWx: story.dest.decoded?.summary ?? "n/a",
    destNas: story.dest.nas?.reason ?? "n/a",
    originTaf: story.origin.taf ?? null,
    destTaf: story.dest.taf ?? null,
    wxHash: story.wx?.hash ?? "",
    wxDeltas: story.wx?.deltas ?? [],
    filedAt: story.wx?.filedAt ?? null,
    worstChop,
    corridorWx: story.wx?.live?.corridor?.map((c) => `${c.iata} ${c.summary}`).join("; ") ?? null,
    inbound: `${story.inbound?.headline ?? ""}. ${story.inbound?.detail ?? ""}`.replace(/^\.\s*/, "").trim(),
    inboundHeadline: story.inbound?.headline ?? "",
    inboundDetail: story.inbound?.detail ?? "",
    inboundStatus: story.inbound?.status,
    rideLabel: weatherSummary,
    weatherSummary,
    push: story.times?.push ?? null,
    pushKind: story.times?.pushKind ?? null,
    pushSource: story.times?.pushSource ?? null,
    taxiOutMin: story.times?.taxiOutMin ?? null,
    taxiOutKind: story.times?.taxiOutKind ?? null,
    takeoff: takeoffEstimateExpired(story) ? null : story.times?.takeoff ?? null,
    takeoffKind: story.times?.takeoffKind ?? null,
    takeoffEstimateExpired: takeoffEstimateExpired(story),
    land: story.times?.land ?? null,
    taxiInMin: story.times?.taxiInMin ?? null,
    taxiInKind: story.times?.taxiInKind ?? null,
    originGate: story.times?.originGate ?? null,
    destGate: story.times?.destGate ?? null,
    delayMin: story.times?.delayMin ?? null,
    pushWas: story.times?.pushWas ?? null,
    typicalDelayMin: story.times?.typicalDelayMin ?? null,
    pushUnix: story.times?.pushUnix ?? null,
    takeoffUnix: story.times?.takeoffUnix ?? null,
    landUnix: story.times?.landUnix ?? null,
    gateUnix: story.times?.gateUnix ?? null,
    arriveDelayMin: story.times?.arriveDelayMin ?? null,
    convective: Boolean(story.wx?.live?.convective),
    destCat: story.dest.decoded?.category ?? story.wx?.live?.destCat ?? null,
    originCat: story.origin.decoded?.category ?? story.wx?.live?.originCat ?? null,
    landKind: story.times?.landKind ?? null,
    gateKind: story.times?.gateKind ?? null,
    gate: story.times?.gate ?? null,
  };
}

function pinDocument() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

class ScreenErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (this.state.err) {
      return (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16"
          style={{ background: "var(--color-bg)", color: "var(--color-fg)", minHeight: "100%" }}
        >
          <p className="max-w-sm text-center text-sm text-muted">Could not load this screen. Try another flight.</p>
          <button
            type="button"
            className="rounded-sm border border-border bg-surface px-3 py-2 text-sm text-fg"
            onClick={() => this.setState({ err: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function FiledApp() {
  const history = useRouter().history;
  const initialLocation = useRef<FlightLocation | null>(null);
  if (!initialLocation.current) initialLocation.current = parseFlightLocation(history.location.href);
  const initial = initialLocation.current;
  const [ready, setReady] = useState(false);
  const [entered, setEntered] = useState(initial.kind !== "landing");
  const [location, setLocation] = useState<FlightLocation>(initial);
  const [flight, setFlight] = useState(initial.kind === "landing" ? "" : initial.flight);
  const recents = useFiled(s => s.recents);
  const hydrate = useFiled(s => s.hydrate);
  const setQuery = useFiled(s => s.setQuery);

  const applyLocation = (next: FlightLocation) => {
    setLocation(next);
    setEntered(true);
    if (next.kind === "flight") {
      setFlight(next.flight);
      setQuery(next.flight);
    } else if (next.kind === "invalid") {
      setFlight(next.flight);
    }
  };

  useLayoutEffect(() => {
    hydrate();
    if (initial.kind === "flight") setQuery(initial.flight);
    setReady(true);
  }, [hydrate, initial, setQuery]);

  useEffect(() => history.subscribe(({ location: next, action }) => {
    // PUSH/REPLACE are applied synchronously by the handlers below. Browser
    // traversal is derived only from the URL, never stale history.state.
    if (action.type === "PUSH" || action.type === "REPLACE") return;
    applyLocation(parseFlightLocation(next.href));
  }), [history, setQuery]);

  const start = (value: string, mode: "push" | "replace" = "push") => {
    const parsed = parseFlightLocation(flightHref(value));
    if (parsed.kind !== "flight") {
      setFlight(value);
      setLocation({ kind: "invalid", flight: value.trim().toUpperCase(), reason: "invalid_flight" });
      setEntered(true);
      return;
    }
    const next = { ...parsed, tab: "Overview" as const, date: null };
    setFlight(next.flight);
    setQuery(next.flight);
    setLocation(next);
    setEntered(true);
    const existingState = history.location.state as { inboundFromSearch?: boolean };
    const state = { ...history.location.state, inboundFlightQuery: next.flight,
      inboundFromSearch: mode === "push" || Boolean(existingState.inboundFromSearch) };
    if (mode === "replace") history.replace(flightHref(next.flight), state);
    else history.push(flightHref(next.flight), state);
  };

  const changeTab = (tab: FlightTab) => {
    if (location.kind !== "flight") return;
    const current = parseFlightLocation(history.location.href);
    const date = current.kind === "flight" ? current.date : location.date;
    setLocation({ ...location, tab });
    history.replace(flightHref(location.flight, tab, date), history.location.state);
  };

  const publishLegDate = (date: string) => {
    if (location.kind !== "flight") return;
    const current = parseFlightLocation(history.location.href);
    if (current.kind !== "flight" || current.date) return;
    // Do not update local selection here: changing a query key after the first
    // successful load would start a duplicate request. Reload/POP will enforce
    // this reliable leg date from the URL.
    history.replace(flightHref(location.flight, location.tab, date), history.location.state);
  };

  const onHome = () => {
    const state = history.location.state as { inboundFromSearch?: boolean };
    if (state.inboundFromSearch) {
      history.back();
      return;
    }
    const nextState = { ...history.location.state, inboundFlightQuery: undefined, inboundFromSearch: undefined };
    history.replace("/", nextState);
    setLocation({ kind: "landing" });
    setEntered(true);
  };

  if (!entered) return <main className="inbound-welcome inbound-redesign">
    <header className="journey-header header-without-brand"><AppearanceControl /></header>
    <div className="inbound-welcome-content">
      <Plane className="welcome-plane" aria-hidden="true" />
      <h1>Inbound</h1>
      <p className="inbound-welcome-tagline">Your flight, from gate to gate.</p>
      <p className="inbound-welcome-description">Follow your aircraft. Know what’s ahead.</p>
      <button type="button" className="home-submit" disabled={!ready} onClick={() => setEntered(true)}>
        {ready ? "Track my flight" : "Preparing your journey…"}
      </button>
    </div>
  </main>;

  if (location.kind === "flight") {
    if (!ready) return <main className="inbound-home inbound-redesign">
      <header className="journey-header header-without-brand"><AppearanceControl /></header>
      <div className="home-content"><p className="text-sm text-muted">Preparing {location.flight}…</p></div>
    </main>;
    return <FlightPages
      key={`${location.flight}|${location.date ?? "current"}`}
      query={location.flight}
      linkedDate={location.date}
      flightTab={location.tab}
      onTabChange={changeTab}
      onLegDate={publishLegDate}
      onOpenFlight={(next) => start(next, "replace")}
      onSearch={(next) => start(next, "replace")}
      onHome={onHome}
    />;
  }

  const invalidMessage = location.kind === "invalid"
    ? location.reason === "invalid_date"
      ? `This ${location.flight || "flight"} link is no longer available. Search for the flight again.`
      : `We couldn't find ${location.flight || "that flight"}. Check the flight number.`
    : null;
  return <main className="inbound-home inbound-redesign">
    <header className="journey-header header-without-brand"><AppearanceControl /></header>
    <div className="home-content">
      <section className="home-search">
        <p className="home-eyebrow">Live flight tracking</p>
        <h1>Know what’s happening with your flight.</h1>
        <p className="home-description">Follow the aircraft, see the route and weather ahead, and stay current as the flight moves.</p>
        {invalidMessage ? <p role="alert" className="mb-4 rounded-md border border-ifr/40 bg-surface px-4 py-3 text-sm text-ifr">{invalidMessage}</p> : null}
        <form onSubmit={e => { e.preventDefault(); start(flight); }}>
          <label htmlFor="home-flight">Flight number</label>
          <input id="home-flight" required maxLength={16} value={flight} onChange={e => setFlight(e.target.value)} placeholder="For example, AA1114" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          <button type="submit" className="home-submit" disabled={!flight.trim()}>Track my flight →</button>
        </form>
      </section>
      {recents.length > 0 && <section className="home-recents" aria-label="Recent flights">
        <div><h2>Recent flights</h2><span>Tap to reopen</span></div>
        {recents.slice(0, 3).map(q => <button key={q} type="button" onClick={() => start(q)}><strong>{q}</strong><span aria-hidden="true">→</span></button>)}
      </section>}
    </div>
  </main>;
}

function FlightPages({ query, linkedDate, flightTab, onTabChange, onLegDate, onOpenFlight, onSearch, onHome }: {
  query: string;
  linkedDate: string | null;
  flightTab: FlightTab;
  onTabChange: (tab: FlightTab) => void;
  onLegDate: (date: string) => void;
  onOpenFlight: (query: string) => void;
  onSearch: (query: string) => void;
  onHome: () => void;
}) {
  const queryClient = useQueryClient();
  const stagePref = useFiled((s) => s.stage);
  const setStage = useFiled((s) => s.setStage);
  const [briefPopupOpen, setBriefPopupOpen] = useState(false);
  const [briefing, setBriefing] = useState<CompiledBrief | null>(null);
  const [briefingFor, setBriefingFor] = useState("");
  const [cacheOk, setCacheOk] = useState(false);
  const [stillLooking, setStillLooking] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [errorSearch, setErrorSearch] = useState(query);
  const leavingRef = useRef(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [pullPx, setPullPx] = useState(0);
  const [manualBusy, setManualBusy] = useState(false);
  // A newly opened flight must bypass the short server/story cache once so
  // the first visible stage/position is current. Routine polling can resume
  // normal cache behavior after this initial fresh request.
  const freshRef = useRef(true);
  const refreshingRef = useRef(false);
  const pullPxRef = useRef(0);
  const briefGen = useRef(0);
  const lastBriefKey = useRef("");
  const briefingRef = useRef<CompiledBrief | null>(null);
  const manualBriefBase = useRef<CompiledBrief | null>(null);
  const [briefFeedback, setBriefFeedback] = useState<"no_change" | "failed" | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const publishedLegDate = useRef<string | null>(null);
  const flightKey = normFlight(query);
  const storyQueryKey = flightStoryQueryKey(query, linkedDate);
  const shellStyle = {
    background: "var(--color-bg)",
    color: "var(--color-fg)",
    height: "100%",
    minHeight: "100%",
  };

  function openFlight(q: string) {
    const next = q.trim();
    if (!next) return;
    briefGen.current += 1;
    setBriefing(null);
    setBriefingFor("");
    setBriefPopupOpen(false);
    onOpenFlight(next);
  }

  useLayoutEffect(() => {
    setCacheOk(true);
  }, []);

  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover",
    );
  }, []);

  const storyQ = useQuery({
    queryKey: storyQueryKey,
    queryFn: async ({ client, signal }) => {
      if (leavingRef.current) throw new DOMException("Left flight search", "AbortError");
      const fresh = freshRef.current;
      freshRef.current = false;
      const saved = storyForQuery(client.getQueryData<FlightStory>(storyQueryKey), query, linkedDate)
        ?? storyForQuery(readCachedStory(query), query, linkedDate);
      const resume = resumeFromStory(saved, query);
      const s = await flightStoryRequest(signal, (requestSignal) =>
        getFlightStory({ data: { q: query, fresh, resume }, signal: requestSignal }),
      ).catch((error) => {
        if (!signal.aborted) console.error("[Inbound flight request]", error instanceof Error ? error.message : String(error));
        throw error;
      });
      signal.throwIfAborted();
      if (!storyMatchesQuery(s, query)) {
        throw new Error(`[flight_not_found] ${query} does not match the returned flight.`);
      }
      if (linkedDate && flightDepartureDate(s) !== linkedDate) {
        throw new Error(`[flight_not_found] ${query} does not match the linked flight date.`);
      }
      const merged = keepRecentTrackGeometry(
        rememberOrigOnClient(applyTakeoffFloor(s, saved)),
        storyForQuery(saved, query, linkedDate),
      );
      writeCachedStory(query, merged);
      return merged;
    },
    // Seed saved data once; failed requests must remain errors, not successful
    // cache reads. React Query retains the last good story during a failure.
    initialData: () => {
      const cached = storyForQuery(readCachedStory(query), query, linkedDate);
      return cached ? rememberOrigOnClient(cached) : undefined;
    },
    initialDataUpdatedAt: 0,
    enabled: (q) => cacheOk && query.length > 0
      && flightSearchCanPoll(q.state.data, q.state.error, leavingRef.current, q.state.fetchFailureCount),
    refetchInterval: (q) => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
      if (!flightSearchCanPoll(q.state.data, q.state.error, leavingRef.current, q.state.fetchFailureCount)) return false;
      if (q.state.fetchStatus === "fetching") return false;
      const s = q.state.data;
      if (q.state.status === "error") return /HTTP 402\b/.test(String(q.state.error?.message ?? "")) ? 60_000 : 15_000;
      if (!s) return false; // The bounded retryer owns initial search attempts.
      return flightPollingInterval(s);
    },
    staleTime: 2_500,
    gcTime: 10 * 60_000,
    retry: (count, err) => {
      if (leavingRef.current || flightNotFound(err)) return false;
      if (!storyForQuery(queryClient.getQueryData(storyQueryKey), query, linkedDate))
        return flightSearchShouldRetry(count, err, leavingRef.current);
      if (count >= 2 || /HTTP 402\b/.test(err instanceof Error ? err.message : "")) return false;
      return true;
    },
    retryDelay: (attempt) => storyForQuery(queryClient.getQueryData(storyQueryKey), query, linkedDate)
      ? Math.min(2_000 * 2 ** attempt, 8_000) : TEMPORARY_FLIGHT_RETRY_MS,
    // Reopening/searching a flight must make one network request even when
    // React Query still has a very recent copy from the previous screen.
    refetchOnMount: "always",
    refetchOnWindowFocus: (q) => Boolean(q.state.data) && flightSearchCanPoll(q.state.data, q.state.error, leavingRef.current, q.state.fetchFailureCount),
    refetchOnReconnect: (q) => Boolean(q.state.data) && flightSearchCanPoll(q.state.data, q.state.error, leavingRef.current, q.state.fetchFailureCount),
    placeholderData: (previousData) => {
      if (storyForQuery(previousData, query, linkedDate)) return previousData;
      return storyForQuery(readCachedStory(query), query, linkedDate);
    },
  });

  const story = storyForQuery(storyQ.data, query, linkedDate);
  const remaining = story ? remainingFlight(story) : null;
  const restoringSavedData = Boolean(story && storyQ.dataUpdatedAt === 0);
  useEffect(() => () => stopFlightSearch(queryClient, query, linkedDate), [queryClient, query, linkedDate]);
  useEffect(() => {
    if (!cacheOk || story || storyQ.isError || stillLooking) return;
    const timer = window.setTimeout(() => {
      if (storyForQuery(queryClient.getQueryData(storyQueryKey), query, linkedDate)) return;
      setStillLooking(true);
    }, INITIAL_FLIGHT_SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [cacheOk, query, linkedDate, queryClient, searchAttempt, Boolean(story), storyQ.isError, stillLooking]);

  useEffect(() => {
    if (!story || linkedDate) return;
    const date = flightDepartureDate(story);
    if (!date || publishedLegDate.current === date) return;
    publishedLegDate.current = date;
    onLegDate(date);
  }, [linkedDate, onLegDate, story]);

  function leaveFlight() {
    leavingRef.current = true;
    briefGen.current += 1;
    stopFlightSearch(queryClient, query, linkedDate);
    onHome();
  }
  function trySearchAgain() {
    setStillLooking(false);
    setSearchAttempt((attempt) => attempt + 1);
    void queryClient.cancelQueries({ queryKey: storyQueryKey, exact: true }).then(() => storyQ.refetch());
  }

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible" || !query) return;
      if (!storyQ.data && storyQ.failureCount > 0) return;
      if (!flightSearchCanPoll(storyQ.data, storyQ.error, leavingRef.current, storyQ.failureCount)) return;
      if (Date.now() - storyQ.dataUpdatedAt > 2_500) void storyQ.refetch();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [query, storyQ.dataUpdatedAt, storyQ.data, storyQ.error, storyQ.refetch, storyQ.failureCount]);

  useEffect(() => {
    if (storyQ.dataUpdatedAt > 0) setRefreshErr(null);
  }, [query, storyQ.dataUpdatedAt]);

  const active = stageStepId(stagePref === "auto" ? (story ? displayStage(story) : "inbound") : stagePref);
  const shownBrief = briefing && briefingFor === flightKey ? briefing : null;
  const welcomeKey = story ? welcomeLegKey(story, linkedDate) : "";
  const welcomeSessionKeyRef = useRef("");
  briefingRef.current = shownBrief;

  useEffect(() => {
    if (!story || !welcomeKey || welcomeSessionKeyRef.current === welcomeKey) return;
    welcomeSessionKeyRef.current = welcomeKey;
    const existingBrief = shownBrief ?? savedBrief(story);
    if (shouldOpenWelcomeSummary(story, existingBrief, { legDate: linkedDate })) setBriefPopupOpen(true);
    // Evaluate the welcome modal once per viewed flight. Briefing/weather can
    // continue updating in-place, but asynchronous enrichment must not reopen
    // a modal the passenger already dismissed 10–20 seconds earlier.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcomeKey]);

  function closeWelcome() {
    if (story) {
      const currentBrief = composeBrief(rideFacts(story, query, active), shownBrief ?? savedBrief(story));
      dismissWelcomeSummary(story, currentBrief, Date.now(), { legDate: linkedDate });
    }
    setBriefPopupOpen(false);
  }

  const briefM = useMutation({
    mutationFn: async () => {
      if (!story) return { ok: true as const, text: "Load a flight first.", gen: briefGen.current, flight: flightKey };
      const gen = briefGen.current;
      const flight = flightKey;
      const facts = rideFacts(story, query, active);
      const local = composeBrief(facts, briefingRef.current ?? savedBrief(story));
      try {
        const remote = await briefRide({ data: facts });
        if (remote && "ok" in remote && remote.ok && remote.text?.trim()) {
          return { ok: true as const, text: remote.text.trim(), local, gen, flight };
        }
      } catch {
        /* local is the brief */
        return { ok: true as const, text: local.lead, local, gen, flight, remoteFailed: true as const };
      }
      return { ok: true as const, text: local.lead, local, gen, flight, remoteFailed: false as const };
    },
    onMutate: () => {
      if (!story) return;
      setBriefingFor(flightKey);
      const next = composeBrief(rideFacts(story, query, active), briefingRef.current ?? savedBrief(story));
      briefingRef.current = next;
      setBriefing(next);
    },
    onSuccess: (data) => {
      if (data.gen !== briefGen.current) return;
      if (data.flight !== flightKey) return;
      if (data?.ok && data.local) {
        const remote = (data.text ?? "").trim();
        const dump = /\bInbound\.\s/.test(remote) || /\bGround\.\s/.test(remote) || remote.length > 900;
        let lead = remote && !dump ? remote : data.local.lead;
        let why = data.local.why;
        const m = lead.match(/Updated because[^.]*\./i);
        if (m) {
          lead = lead.replace(m[0], "").replace(/\s+/g, " ").trim();
          why = m[0].trim();
        }
        setBriefingFor(data.flight);
        const next = {
          ...data.local,
          lead,
          why,
          snap: data.local.snap,
          log: data.local.log ?? briefingRef.current?.log ?? [],
        };
        briefingRef.current = next;
        setBriefing(next);
        const base = manualBriefBase.current;
        if (base) {
          const outcome = briefingRefreshOutcome(base, next, Boolean(data.remoteFailed));
          setBriefFeedback(outcome === "updated" ? null : outcome);
          manualBriefBase.current = null;
        }
      }
    },
    onError: () => {
      if (manualBriefBase.current) setBriefFeedback("failed");
      manualBriefBase.current = null;
    },
  });

  useEffect(() => {
    briefGen.current += 1;
    setBriefing(null);
    setBriefingFor("");
    lastBriefKey.current = "";
    briefingRef.current = null;
    manualBriefBase.current = null;
    setBriefFeedback(null);
    briefM.reset();
    setStage("auto");
    setRefreshErr(null);
    setPullPx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the flight changes
  }, [flightKey]);

  useEffect(() => {
    if (!story || briefingFor === flightKey) return;
    briefM.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first compile when the story arrives
  }, [story, flightKey]);

  useEffect(() => {
    if (!story || !briefing || briefingFor !== flightKey) return;
    const key = `${takeoffEstimateExpired(story)}|${story.weatherCoverage?.failedSources.join(",") ?? "unknown"}|${story.aircraft?.registration ?? ""}|${story.live}|${Math.round(story.route.etaMin)}|${Math.round(story.route.remainingNm / 10)}|${story.currentStage}|${story.times?.delayMin ?? ""}|${story.times?.pushKind ?? ""}|${story.times?.pushSource ?? ""}|${story.times?.takeoffKind ?? ""}|${story.times?.landKind ?? ""}|${story.times?.gateKind ?? ""}|${story.times?.taxiInKind ?? ""}|${story.times?.push ?? ""}|${story.times?.takeoff ?? ""}|${story.times?.gate ?? ""}|${story.times?.taxiOutMin ?? ""}|${story.times?.taxiInMin ?? ""}|${story.times?.originGate ?? ""}|${story.times?.destGate ?? ""}|${story.origin.nas?.reason ?? ""}|${story.dest.nas?.reason ?? ""}|${story.inbound.status}|${story.times?.land ?? ""}|${story.wx?.hash ?? ""}|${flightWeatherSummary(story)}`;
    if (key === lastBriefKey.current) return;
    lastBriefKey.current = key;
    const next = composeBrief(rideFacts(story, query, active), briefing);
    if (next !== briefing) {
      if (briefingRefreshOutcome(briefing, next) === "updated") setBriefFeedback(null);
      briefingRef.current = next;
      setBriefing(next);
    }
  }, [story, briefing, briefingFor, flightKey, query, active]);

  function updateBriefing() {
    if (shownBrief) manualBriefBase.current = shownBrief;
    setBriefFeedback(null);
    briefM.mutate();
  }

  useEffect(() => {
    if (story && briefing && briefingFor === flightKey) saveBrief(story, briefing);
  }, [story, briefing, briefingFor, flightKey]);

  async function refreshNow() {
    if (!query || refreshingRef.current) return;
    refreshingRef.current = true;
    setManualBusy(true);
    setRefreshErr(null);
    freshRef.current = true;
    pullPxRef.current = 44;
    setPullPx(44);
    let settled = false;
    const failsafe = window.setTimeout(() => {
      if (settled) return;
      refreshingRef.current = false;
      setManualBusy(false);
      pullPxRef.current = 0;
      setPullPx(0);
      setRefreshErr("Couldn't update right now — try again.");
    }, 14_000);
    try {
      await storyQ.refetch({ throwOnError: true });
      setBriefing((b) => {
        if (!b) return b;
        const next = logManualRefresh(b);
        briefingRef.current = next;
        return next;
      });
    } catch {
      setRefreshErr("Couldn't update right now — try again.");
    } finally {
      settled = true;
      window.clearTimeout(failsafe);
      refreshingRef.current = false;
      setManualBusy(false);
      pullPxRef.current = 0;
      setPullPx(0);
    }
  }

  useEffect(() => {
    const el = mainRef.current;
    if (!el || flightTab === "Route") return;
    let startY = 0;
    let startX = 0;
    let pulling = false;
    const onStart = (e: TouchEvent) => {
      if (!story || refreshingRef.current) return;
      if (el.scrollTop > 2) return;
      const t = e.touches[0];
      if (!t) return;
      startY = t.clientY;
      startX = t.clientX;
      pulling = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling || refreshingRef.current) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = t.clientX - startX;
      if (dy < 8 || Math.abs(dx) > 28 || el.scrollTop > 2) {
        if (dy <= 0) {
          pullPxRef.current = 0;
          setPullPx(0);
        }
        return;
      }
      e.preventDefault();
      const next = Math.min(88, dy * 0.42);
      pullPxRef.current = next;
      setPullPx(next);
    };
    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      const px = pullPxRef.current;
      if (px >= 52) {
        void refreshNow();
        return;
      }
      pullPxRef.current = 0;
      setPullPx(0);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [story, query, flightTab]);

  return (
    <div className={cn("pwa-flight-shell", "inbound-redesign", "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-fg")} style={shellStyle}>
      <header className="journey-header"><div className="flex min-w-0 items-center gap-2"><button type="button" aria-label="Back to search" onClick={leaveFlight} className="flex size-11 shrink-0 items-center justify-center rounded-md text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><ChevronLeft className="size-6" aria-hidden="true" /></button>{story ? <p><Plane aria-hidden="true" /><strong>{story.iata}</strong><span>{story.origin.iata} → {story.dest.iata}</span></p> : <p>{query || "Preparing your flight…"}</p>}</div><AppearanceControl /></header>
      {story && <FlightWelcome open={briefPopupOpen} onClose={closeWelcome} story={story} brief={shownBrief} />}
      <ScreenErrorBoundary>
      <main
        ref={mainRef}
        className={cn("journey-main min-h-0 min-w-0 flex-1 overflow-x-hidden overscroll-y-contain px-4 pt-1 lg:px-8 lg:pt-4", flightTab === "Route" ? "overflow-y-hidden" : "overflow-y-auto")}
      >
        <div className={cn("journey-content mx-auto min-w-0 max-w-6xl overflow-x-hidden", flightTab === "Route" ? "flex h-full flex-col pb-2" : "pb-6")}>
        {story ? (
          <div
            className="flex flex-col items-center justify-end overflow-hidden text-muted"
            style={{ height: pullPx, transition: pullPx === 0 || manualBusy ? "height 160ms ease" : "none" }}
            aria-hidden={pullPx < 8}
          >
            <span className="flex items-center gap-1.5 pb-1 font-mono text-[11px] tracking-wide">
              <RefreshCw className={cn("size-3.5", manualBusy && "animate-spin")} />
              {manualBusy ? "Updating…" : pullPx >= 52 ? "Release to update" : "Pull to update"}
            </span>
          </div>
        ) : null}
        {(refreshErr || storyQ.isError) && story ? (
          <div role="status" className="mb-3 rounded-md border border-ifr/40 bg-surface px-4 py-2">
            <p className="text-sm text-ifr">
              {storyQ.isError
                ? `Live update failed — showing saved flight data. Position, stage, and times may be out of date. ${flightNotFound(storyQ.error) ? "Use Refresh to try again." : "Retrying automatically."}`
                : refreshErr}
            </p>
          </div>
        ) : null}
        {story?.schedule?.status === "saved" && !storyQ.isError && !refreshErr ? (
          <div role="status" className="mb-3 rounded-md border border-border bg-surface px-4 py-2 text-sm text-fg">
            {savedScheduleNote(story.schedule.confirmedAt)}
          </div>
        ) : null}
        {(storyQ.isError || storyQ.failureCount > 0) && !story && (
          <div role="alert" className="mb-4 rounded-md border border-ifr/40 bg-surface px-4 py-3">
            <p className="text-sm text-ifr">
              {flightNotFound(storyQ.error ?? storyQ.failureReason)
                ? `We couldn't find ${query}. Check the flight number.`
                : "Flight data is temporarily unavailable."}
            </p>
            {!flightNotFound(storyQ.error ?? storyQ.failureReason) && storyQ.isFetching && <p className="mt-1 text-sm text-muted">We’ll try again shortly.</p>}
            <form className="mt-3" onSubmit={(event) => { event.preventDefault(); onSearch(errorSearch); }}>
              <label className="text-sm font-semibold" htmlFor="flight-error-search">Flight number</label>
              <div className="mt-2 flex flex-wrap gap-2">
                <input id="flight-error-search" required maxLength={16} value={errorSearch} onChange={(event) => setErrorSearch(event.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-fg" />
                <Button type="submit">Search</Button>
              </div>
            </form>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={leaveFlight}>Back to search</Button>
              <Button type="button" variant="secondary" onClick={trySearchAgain}>Try again</Button>
            </div>
          </div>
        )}

        {!story && !storyQ.isError && storyQ.failureCount === 0 && <Skeleton query={query || "the flight"} onHome={leaveFlight} slow={stillLooking} />}

        {story && (
          <div key={normFlight(query)} className={cn("journey-body min-w-0", flightTab === "Route" && "min-h-0 flex-1")}>
            <div className="journey-map journey-map-expanded" hidden={flightTab !== "Route"}><RouteMap story={story} fixedViewport active={flightTab === "Route"} remaining={remaining ?? undefined} />{(story.route?.samples?.length ?? 0) < 2 && <p className="map-unavailable">Route map unavailable</p>}</div>
            <section className="journey-panel" id="panel-Overview" role="tabpanel" aria-labelledby="tab-Overview" hidden={flightTab !== "Overview"}>
              <FlightHead story={story} remaining={remaining ?? undefined} restored={restoringSavedData} failed={storyQ.isError || Boolean(refreshErr)} fetching={storyQ.isFetching} refreshing={manualBusy} onRefresh={() => void refreshNow()} />
              <OverviewDetails story={story} timing={<TimesStrip story={story} remaining={remaining ?? undefined} failed={storyQ.isError || Boolean(refreshErr)} />} />
              <TravelerCompanion story={story} failed={storyQ.isError || Boolean(refreshErr)} onTrackInbound={openFlight} />
            </section>
            <section id="panel-Route" role="tabpanel" aria-labelledby="tab-Route" hidden={flightTab !== "Route"} className="h-full min-h-0" style={{ containerType: "size" }}>
              <p className="sr-only">Interactive flight map above. Use the map controls to zoom or reset.</p>
            </section>
            <section id="panel-Weather" role="tabpanel" aria-labelledby="tab-Weather" hidden={flightTab !== "Weather"}>
              <WeatherTimeline story={story} />
            </section>
            <section id="panel-Briefing" role="tabpanel" aria-labelledby="tab-Briefing" hidden={flightTab !== "Briefing"}>
              <BreakdownCard briefing={shownBrief} pending={briefM.isPending} feedback={briefFeedback} onCompile={updateBriefing} />
            </section>
          </div>
        )}
        </div>
      </main>
      {story ? <nav aria-label="Flight pages" className="pwa-bottom-nav shrink-0 border-t border-border bg-bg/95 px-2 pt-0.5 backdrop-blur lg:px-6">
        <div className="mx-auto grid max-w-2xl grid-cols-5 gap-0.5">
          <button type="button" aria-label="Home — flight search" onClick={leaveFlight}
            className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-semibold text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <House className="size-4.5" aria-hidden="true" /><span>Home</span>
          </button>
          {FLIGHT_TABS.map((tab, index) => {
            const Icon = tab === "Overview" ? PanelsTopLeft : tab === "Route" ? MapIcon : tab === "Weather" ? CloudSun : NotebookText;
            const label = tab === "Route" ? "Map" : tab;
            return <button key={tab} id={`tab-${tab}`} type="button"
              aria-current={flightTab === tab ? "page" : undefined} aria-controls={`panel-${tab}`}
              className={cn("flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-semibold transition-colors", flightTab === tab ? "bg-surface-2 text-fg" : "text-muted")}
              onClick={() => { onTabChange(tab); mainRef.current?.scrollTo(0, 0); }}
              onKeyDown={(e) => {
                const next = e.key === "ArrowRight" ? (index + 1) % 4 : e.key === "ArrowLeft" ? (index + 3) % 4 : e.key === "Home" ? 0 : e.key === "End" ? 3 : -1;
                if (next < 0) return;
                e.preventDefault(); onTabChange(FLIGHT_TABS[next]);
                document.getElementById(`tab-${FLIGHT_TABS[next]}`)?.focus(); mainRef.current?.scrollTo(0, 0);
              }}><Icon className="size-4.5" aria-hidden="true" /><span>{label}</span></button>;
          })}
        </div>
      </nav> : null}
      </ScreenErrorBoundary>
    </div>
  );
}

function wheelsDown(story: FlightStory) {
  if (story.currentStage === "gate" || story.currentStage === "taxi_in") return true;
  if (story.times?.landKind === "actual") return true;
  if (story.currentStage === "arrival" && story.aircraft?.onGround) return true;
  return false;
}

function departureUpdateDelayed(story: FlightStory, nowMs = Date.now()) {
  if (displayStage(story) !== "origin_gate") return false;
  if (story.times?.pushKind === "actual") return false;
  const pushAt = story.times?.pushUnix;
  if (typeof pushAt !== "number" || !Number.isFinite(pushAt)) return false;
  const ageSec = typeof story.providers?.chosenPositionAgeSec === "number"
    ? story.providers.chosenPositionAgeSec
    : typeof story.aircraft?.seenSec === "number"
      ? story.aircraft.seenSec
      : null;
  const freshPosition = Boolean(
    story.aircraft
    && Number.isFinite(story.aircraft.lat)
    && Number.isFinite(story.aircraft.lon)
    && ageSec != null
    && ageSec <= 45
  );
  return !freshPosition && nowMs / 1000 - pushAt >= 10 * 60;
}

function stageHeadline(story: FlightStory) {
  const stage = displayStage(story);
  if (stage === "gate") return "At the gate";
  if (stage === "taxi_in") return "Taxiing in";
  if (stage === "final_approach") return "Final approach";
  if (stage === "arrival" && wheelsDown(story)) return "Landed";
  if (stage === "origin_gate") return departureUpdateDelayed(story) ? "Departure update delayed" : "At the gate";
  if (stage === "push") return "Pushback";
  if (stage === "taxi") return "Taxiing out";
  if (stage === "takeoff_roll") return "Takeoff roll";
  return STAGES.find((s) => s.id === stage)?.label ?? stage;
}

function headStatus(story: FlightStory, remaining = remainingFlight(story)) {
  const airline = story.airline;
  const air = flightAirborne(story);
  const live = liveFix(story);
  const inAirLive = Boolean(live && story.aircraft && !story.aircraft.onGround && !remaining.estimated);
  if (story.currentStage === "gate") return airline ?? "Parked";
  if (story.currentStage === "taxi_in") return airline ? `Taxiing in · ${airline}` : "Taxiing in";
  if (wheelsDown(story)) return airline ? `Landed · ${airline}` : "Landed";
  if (story.currentStage === "origin_gate") {
    if (departureUpdateDelayed(story)) return airline ? `Movement not confirmed · ${airline}` : "Movement not confirmed";
    return airline ? `At the gate · ${airline}` : "At the gate";
  }
  if (story.currentStage === "push") return airline ? `Pushback · ${airline}` : "Pushback";
  if (story.currentStage === "taxi") return airline ? `Taxiing out · ${airline}` : "Taxiing out";
  if (story.currentStage === "takeoff_roll") return airline ? `Takeoff roll · ${airline}` : "Takeoff roll";
  if (air && inAirLive) return airline ?? "";
  if (air) return "In the air — live position unavailable right now";
  if (live) return airline ? `On the ground · ${airline}` : "On the ground";
  return airline ?? "";
}

const STATUS_PROGRESS = ["Gate", "Pushback", "Taxi", "Flight", "Landing", "Gate"] as const;

function FlightStatusProgress({ story }: { story: FlightStory }) {
  const active = statusProgressIndex(displayStage(story));
  const labels = departureUpdateDelayed(story)
    ? (["Status", ...STATUS_PROGRESS.slice(1)] as const)
    : STATUS_PROGRESS;
  return (
    <div className="flight-progress mt-4" aria-label={`Flight progress: ${labels[active]}`}>
      <div className="grid grid-cols-6 gap-1">
        {labels.map((label, index) => {
          const complete = index < active;
          const current = index === active;
          return (
            <div key={`${label}-${index}`} className="min-w-0 text-center">
              <div className={cn(
                "progress-dot mx-auto h-1.5 w-full rounded-full",
                complete || current ? "bg-accent" : "bg-border",
                current && "progress-current ring-2 ring-accent/20 ring-offset-1 ring-offset-surface",
              )} />
              <p className={cn(
                "mt-1 truncate font-mono text-[9px] tracking-wide uppercase",
                current ? "font-semibold text-fg" : complete ? "text-muted" : "text-subtle",
              )}>{label}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusCard({
  title,
  value,
  detail,
  prominent = false,
}: {
  title: string;
  value: string | null | undefined;
  detail?: string | null;
  prominent?: boolean;
}) {
  return (
    <div className={cn("timing-value", prominent && "timing-value-prominent")}>
      <p className="timing-label">{title}</p>
      <p className={cn("timing-number", /\b(?:AM|PM)\b/.test(value ?? "") && "timing-number-clock")}>{value ?? "—"}</p>
      {detail ? <p className="timing-detail">{detail}</p> : null}
    </div>
  );
}

function FlightHead({
  story,
  remaining,
  fetching,
  refreshing,
  restored = false,
  failed = false,
  onRefresh,
}: {
  story: FlightStory;
  remaining?: RemainingFlightPresentation;
  fetching: boolean;
  refreshing: boolean;
  restored?: boolean;
  failed?: boolean;
  onRefresh: () => void;
}) {
  const gateMatch = story.times.gate?.match(/^(.*?)\s+([A-Z]{2,5}|GMT[+-]\d+(?::\d+)?)(\s+\+\d+)?$/);
  const gateClock = gateMatch?.[1] ?? story.times.gate ?? "—";
  const gateZone = gateMatch ? `${gateMatch[2]}${gateMatch[3] ?? ""}` : "";
  return (
    <div className="flight-summary rounded-xl border border-border bg-surface p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="summary-airline text-sm text-muted">{headStatus(story, remaining)}</p>
          <h2 className="summary-stage font-display font-semibold leading-none">{displayStage(story) === "ride" ? "In flight" : stageHeadline(story)}</h2>
        </div>
        <div className="max-w-36 text-right">
          <p className="text-xs text-muted">{story.times.gateKind === "actual" ? "ARRIVED" : "ARRIVES"}</p>
          <p className="summary-arrival font-display font-semibold leading-tight">{gateClock}</p>
          <p className="text-xs text-muted">{gateZone}</p>
          <p className="text-xs text-muted">{kindLabel(story.times.gateKind) || "Time unavailable"}</p>
        </div>
        <p className="summary-route col-span-2 text-sm text-muted">
          {story.origin.city} <span className="text-muted">{story.origin.iata}</span>
          <span className="mx-2 text-subtle">→</span>
          {story.dest.city} <span className="text-muted">{story.dest.iata}</span>
        </p>
      </div>
      <FlightStatusProgress story={story} />
      <Freshness failed={failed} partial={story.schedule?.status === "saved"} restored={restored} at={story.fetchedAt} fetching={fetching} refreshing={refreshing} onRefresh={onRefresh} />
    </div>
  );
}

type OverviewDetailKey = "flight" | "aircraft" | "airports" | "baggage";
const CLOSED_OVERVIEW_DETAILS: Record<OverviewDetailKey, boolean> = { flight: false, aircraft: false, airports: false, baggage: false };

function plannedDuration(story: FlightStory) {
  const schedule = clientSchedules(story);
  const start = schedule.takeoffUnix;
  const end = schedule.landUnix;
  return start != null && end != null && end > start ? formatDuration((end - start) / 60) : null;
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-1.5 text-sm"><dt className="text-muted">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
}

function OverviewDisclosure({
  id,
  title,
  summary,
  open,
  onToggle,
  prominent = false,
  children,
}: {
  id: OverviewDetailKey;
  title: string;
  summary: string;
  open: boolean;
  onToggle: (id: OverviewDetailKey) => void;
  prominent?: boolean;
  children: ReactNode;
}) {
  const panelId = `overview-${id}-details`;
  return <div className={cn("border-b border-border last:border-b-0", prominent && "-mx-2 rounded-lg bg-accent/8 px-2")}>
    <button
      type="button"
      className="flex min-h-16 w-full items-center justify-between gap-3 py-3 text-left"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => onToggle(id)}
    >
      <span className="min-w-0"><span className="block font-semibold">{title}</span><span className="mt-0.5 block truncate text-sm text-muted">{summary}</span></span>
      <ChevronDown className={cn("size-5 shrink-0 text-muted transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
    </button>
    <div className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className="overflow-hidden"><div id={panelId} aria-hidden={!open} className="pb-4">{children}</div></div>
    </div>
  </div>;
}

function OverviewDetails({ story, timing }: { story: FlightStory; timing: ReactNode }) {
  const storageKey = `inbound-overview-details:${origMemKey(story)}`;
  const baggageProminent = wheelsDown(story);
  const arrivalOpenedAfterLanding = useRef(false);
  const [open, setOpen] = useState<Record<OverviewDetailKey, boolean>>(() => ({ ...CLOSED_OVERVIEW_DETAILS, baggage: baggageProminent }));
  useEffect(() => {
    let next = { ...CLOSED_OVERVIEW_DETAILS };
    let openedAfterLanding = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved) {
        next = { flight: Boolean(saved.flight), aircraft: Boolean(saved.aircraft), airports: Boolean(saved.airports), baggage: Boolean(saved.baggage) };
        openedAfterLanding = Boolean(saved.arrivalOpenedAfterLanding);
      }
    } catch { /* Secondary detail state is optional. */ }
    if (baggageProminent && !openedAfterLanding) {
      next.baggage = true;
      openedAfterLanding = true;
      try { sessionStorage.setItem(storageKey, JSON.stringify({ ...next, arrivalOpenedAfterLanding: true })); } catch { /* Storage can be unavailable. */ }
    }
    arrivalOpenedAfterLanding.current = openedAfterLanding;
    setOpen(next);
  }, [storageKey, baggageProminent]);
  const toggle = (key: OverviewDetailKey) => setOpen((current) => {
    const next = { ...current, [key]: !current[key] };
    try { sessionStorage.setItem(storageKey, JSON.stringify({ ...next, arrivalOpenedAfterLanding: arrivalOpenedAfterLanding.current })); } catch { /* Storage can be unavailable. */ }
    return next;
  });
  const ac = story.aircraft;
  const aircraftSummary = [ac?.typeName ?? ac?.type ?? "Aircraft details unavailable", ac?.registration].filter(Boolean).join(" · ");
  const originStop = [story.origin.iata, story.times.originGate ? `Gate ${story.times.originGate}` : null].filter(Boolean).join(" ");
  const destStop = [story.dest.iata, story.times.destGate ? `Gate ${story.times.destGate}` : null].filter(Boolean).join(" ");
  const baggage = useBaggageStatus({flight:story.iata.replace(/\s/g, ""),origin:story.origin.iata,destination:story.dest.iata,date:flightDepartureDate(story)});
  const arrivalSummary = [
    baggage.result?.terminal ? `Terminal ${baggage.result.terminal}` : null,
    story.times.destGate ? `Gate ${story.times.destGate}` : "Gate not assigned",
    baggage.result?.status === "posted" && baggage.result.carousel ? `Carousel ${baggage.result.carousel}` : "Baggage not assigned yet",
  ].filter(Boolean).join(" · ");
  const schedule = clientSchedules(story);
  const scheduledPush = formatStoryEventTime(story, schedule.pushUnix, story.origin.tz);
  const scheduledTakeoff = formatStoryEventTime(story, schedule.takeoffUnix, story.origin.tz);
  const pushActualLabel = story.times.pushSource === "provider_actual" ? "Actual"
    : story.times.pushSource === "live_detected" || story.times.pushSource === "track_detected" ? "Detected"
      : story.times.pushKind !== "scheduled" ? timeKindLabel(story.times.pushKind) : null;
  const takeoffActualLabel = story.times.takeoffKind !== "scheduled" ? timeKindLabel(story.times.takeoffKind) : null;
  return <section className="overview-details mt-4 rounded-xl border border-border bg-surface px-4" aria-label="More flight information">
    {timing}
    <OverviewDisclosure id="baggage" title="Arrival" summary={arrivalSummary} open={open.baggage} onToggle={toggle} prominent={baggageProminent}>
      <dl className="arrival-details"><div><dt>Terminal</dt><dd>{baggage.result?.terminal ?? "—"}</dd><p>{story.dest.city} ({story.dest.iata})</p></div><div><dt>Gate</dt><dd>{story.times.destGate ?? "—"}</dd><p>{story.times.destGate ? "Arrival gate" : "Not assigned"}</p></div><div><dt>Baggage</dt><dd>{baggage.result?.status === "posted" && baggage.result.carousel ? baggage.result.carousel : "—"}</dd><p>{baggage.result?.status === "posted" && baggage.result.carousel ? "Assigned carousel" : baggageSummary(baggage.result)}</p></div></dl>
      <BaggageStatus state={baggage} showAssignment={false} />
    </OverviewDisclosure>
    <OverviewDisclosure id="flight" title="Flight details" summary={`${story.iata} · ${story.origin.iata} → ${story.dest.iata}`} open={open.flight} onToggle={toggle}>
      <dl>
        <DetailRow label="Airline" value={story.airline} />
        <DetailRow label="Flight" value={story.iata} />
        <DetailRow label="Route" value={`${story.origin.city} (${story.origin.iata}) → ${story.dest.city} (${story.dest.iata})`} />
        <div className="mt-2 border-t border-border pt-2"><h3 className="font-semibold">Pushback</h3>
          <DetailRow label="Scheduled" value={scheduledPush} />
          {pushActualLabel ? <DetailRow label={pushActualLabel} value={story.times.push} /> : null}
        </div>
        <div className="mt-2 border-t border-border pt-2"><h3 className="font-semibold">Takeoff</h3>
          <DetailRow label="Scheduled" value={scheduledTakeoff} />
          {takeoffActualLabel ? <DetailRow label={takeoffActualLabel} value={story.times.takeoff} /> : null}
        </div>
        <DetailRow label="Scheduled landing" value={formatStoryEventTime(story, schedule.landUnix, story.dest.tz)} />
        {story.times.landKind !== "scheduled" && <DetailRow label={timeKindLabel(story.times.landKind, "landing")} value={story.times.land} />}
        <DetailRow label={timeKindLabel(story.times.gateKind, "gate arrival")} value={story.times.gate} />
        <DetailRow label="Planned flight time" value={plannedDuration(story)} />
      </dl>
    </OverviewDisclosure>
    <OverviewDisclosure id="aircraft" title="Aircraft" summary={aircraftSummary} open={open.aircraft} onToggle={toggle}>
      <dl>
        <DetailRow label="Model" value={ac?.typeName ?? ac?.type} />
        <DetailRow label="Registration" value={ac?.registration} />
        <DetailRow label="Aircraft year" value={ac?.year} />
        <DetailRow label="Operator" value={ac?.operator} />
      </dl>
    </OverviewDisclosure>
    <OverviewDisclosure id="airports" title="Airport details" summary={`${originStop} → ${destStop}`} open={open.airports} onToggle={toggle}>
      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-label="Departure airport details"><h3 className="font-semibold">Departure · {story.origin.iata}</h3><dl className="mt-1"><DetailRow label="Gate" value={story.times.originGate ?? "Not assigned"} /><DetailRow label="Pushback" value={story.times.push} /><DetailRow label="Weather" value={passengerAirportWeather(story.origin.decoded, story.origin.rawMetar)} /></dl></section>
        <section aria-label="Arrival airport details"><h3 className="font-semibold">Arrival · {story.dest.iata}</h3><dl className="mt-1"><DetailRow label="Gate" value={story.times.destGate ?? "Not assigned"} /><DetailRow label={timeKindLabel(story.times.gateKind, "gate arrival")} value={story.times.gate} /><DetailRow label="Weather" value={passengerAirportWeather(story.dest.decoded, story.dest.rawMetar)} /></dl></section>
      </div>
    </OverviewDisclosure>
  </section>;
}

function kindLabel(kind: FlightStory["times"]["pushKind"]) {
  return timeKindLabel(kind);
}

function ClockCell({
  title,
  time,
  kind,
  hint,
  source,
}: {
  title: string;
  time: string | null | undefined;
  kind?: FlightStory["times"]["pushKind"];
  hint?: string | null;
  source?: FlightStory["times"]["pushSource"];
}) {
  const sourceLabel = source === "live_detected" || source === "track_detected" ? "Detected" : source === "provider_actual" ? "Actual" : kindLabel(kind);
  const sub = [sourceLabel, hint].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs tracking-widest text-subtle uppercase">{title}</p>
      <p className="mt-1 font-display text-xl font-semibold leading-none">{time ?? "—"}</p>
      <p className="mt-1 text-xs text-muted">{sub || "\u00a0"}</p>
    </div>
  );
}

function TimesStrip({ story, remaining = remainingFlight(story), failed = false }: { story: FlightStory; remaining?: RemainingFlightPresentation; failed?: boolean }) {
  const t = story.times;
  const down = wheelsDown(story);
  const shownStage = displayStage(story);
  const airborne = (shownStage === "ride" || shownStage === "arrival" || shownStage === "final_approach") && !down;
  const ac = story.aircraft;
  const showLiveFlight = Boolean(liveFix(story) && flightAirborne(story) && ac && !ac.onGround && (ac.altFt || ac.gsKt));
  const elapsed = airborne ? elapsedFlight(story) : null;
  const flown = airborne ? flownDistance(story) : null;
  const parked = story.currentStage === "gate";
  const delay = t?.delayMin ?? null;
  const late = (delay ?? 0) >= 5;
  const phrase = delayPhrase(delay);
  const takeoffExpired = takeoffEstimateExpired(story);

  const pushDetail = [
    t?.pushSource === "provider_actual" ? "Actual" : t?.pushSource === "live_detected" || t?.pushSource === "track_detected" ? "Detected" : kindLabel(t?.pushKind),
    late ? phrase : null,
    t?.originGate ? `Gate ${t.originGate}` : null,
  ].filter(Boolean).join(" · ");

  const takeoffDetail = takeoffExpired
    ? "Waiting for a new estimate"
    : [kindLabel(t?.takeoffKind), t?.takeoffWas && t.takeoffWas !== t.takeoff ? `Was ${t.takeoffWas}` : null].filter(Boolean).join(" · ");

  const landingDetail = [
    kindLabel(t?.landKind),
    down && story.currentStage === "taxi_in" ? "Taxiing in" : down && !parked ? "Rollout" : null,
    t?.landWas && t.landWas !== t.land ? `Was ${t.landWas}` : null,
  ].filter(Boolean).join(" · ");

  const gateDetail = [
    kindLabel(t?.gateKind),
    t?.destGate ? `Gate ${t.destGate}` : null,
    parked ? "Parked" : t?.taxiInMin != null
      ? t.taxiInKind === "measured" ? `Taxi in ${t.taxiInMin} min` : `Est. taxi in ${t.taxiInMin} min`
      : null,
  ].filter(Boolean).join(" · ");

  const preDepartureTakeoffPrimary = shownStage === "push" || shownStage === "taxi" || shownStage === "takeoff_roll";

  return (
    <section className="flight-times" aria-label="Live timing and position">
      <div className="flex min-w-0 flex-col gap-3">
        {airborne ? (
          <div className="timing-values">
            <StatusCard
              prominent
              title="Remaining"
              value={remaining.text ?? "Updating…"}
              detail={remaining.estimated ? [remaining.minutes != null ? "Estimated" : null, remaining.gapNote].filter(Boolean).join(" · ") : formatMiles(story.route.remainingNm)}
            />
            <StatusCard
              title="Flown"
              value={elapsed ? `${elapsed.approximate ? "Approx. " : elapsed.estimated ? "Est. " : ""}${formatDuration(elapsed.minutes)}` : "—"}
              detail={flown ? `Approx. ${flown.nm * 1.15078 < 1 ? "less than 1 mile" : formatMiles(flown.nm)}` : "Distance unavailable"}
            />
          </div>
        ) : down ? (
          <div className="timing-values">
            <StatusCard
              prominent
              title={parked ? "At the gate" : "Gate ETA"}
              value={t?.gate}
              detail={gateDetail}
            />
            <StatusCard
              title="Landed"
              value={t?.land}
              detail={landingDetail}
            />
          </div>
        ) : (
          <div className="timing-values">
            {preDepartureTakeoffPrimary ? (
              <>
                <StatusCard
                  prominent
                  title="Takeoff"
                  value={takeoffExpired ? "Updating…" : t?.takeoff}
                  detail={takeoffDetail}
                />
                <StatusCard
                  title={t?.pushed ? "Pushback" : "Est. pushback"}
                  value={t?.push}
                  detail={pushDetail}
                />
              </>
            ) : (
              <>
                <StatusCard
                  prominent
                  title={t?.pushed ? "Pushback" : "Est. pushback"}
                  value={t?.push}
                  detail={pushDetail}
                />
                <StatusCard
                  title="Takeoff"
                  value={takeoffExpired ? "Updating…" : t?.takeoff}
                  detail={takeoffDetail}
                />
              </>
            )}
          </div>
        )}

        {showLiveFlight ? (
          <div className="timing-values">
            <StatusCard title="Altitude" value={ac?.altFt != null ? feetPretty(ac.altFt) : "—"} />
            <StatusCard title="Speed" value={ac?.gsKt != null ? `${Math.round(ac.gsKt)} kt` : "—"} />
          </div>
        ) : null}

      </div>
    </section>
  );
}

function Freshness({
  at,
  fetching,
  refreshing,
  restored = false,
  failed = false,
  partial = false,
  onRefresh,
}: {
  at: number;
  fetching: boolean;
  refreshing: boolean;
  restored?: boolean;
  failed?: boolean;
  partial?: boolean;
  onRefresh: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 4000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flight-freshness flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-border bg-surface px-2.5 font-mono text-xs tracking-wide text-fg disabled:opacity-60"
      >
        <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        {refreshing ? "Updating…" : "Refresh"}
      </button>
      <p className="font-mono text-xs tracking-widest text-muted uppercase">
        {restored
          ? `${updatedAgoLabel(at)} · ${fetching || refreshing ? "refreshing" : failed ? "refresh delayed" : "waiting to refresh"}`
          : refreshing
            ? "Updating…"
            : failed
              ? `${updatedAgoLabel(at)} · update delayed`
              : partial
                ? "Schedule delayed · " + (Date.now() - at < 8000 ? "other feeds just checked" : agoLabel(at, false))
                : agoLabel(at, false)}
      </p>
    </div>
  );
}

function TrendArrow({ trend }: { trend?: Comfort["trend"] }) {
  if (trend === "up") {
    return <ArrowUp className="size-4 shrink-0 text-vfr" strokeWidth={2.75} aria-label="Grade improving" />;
  }
  if (trend === "down") {
    return <ArrowDown className="size-4 shrink-0 text-ifr" strokeWidth={2.75} aria-label="Grade worsening" />;
  }
  return null;
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  trend,
}: {
  icon: typeof Plane;
  label: string;
  value: string;
  sub?: string;
  trend?: Comfort["trend"];
}) {
  return (
    <div className="rounded-md border border-border bg-bg px-3 py-1.5">
      <p className="flex items-center gap-1.5 font-mono text-xs tracking-widest text-subtle uppercase">
        <Icon className="size-3" />
        {label}
      </p>
      <p className="mt-0.5 flex items-center gap-1 font-display text-lg font-semibold leading-tight">
        {value}
        <TrendArrow trend={trend} />
      </p>
      {sub ? <p className="text-xs leading-tight text-muted">{sub}</p> : null}
    </div>
  );
}

function BreakdownCard({
  briefing,
  pending,
  feedback,
  onCompile,
}: {
  briefing: CompiledBrief | null;
  pending: boolean;
  feedback: "no_change" | "failed" | null;
  onCompile: () => void;
}) {
  const asOf = briefing?.liveAt
    ? formatClockTime(briefing.liveAt)
    : null;
  const log = briefing?.log ?? [];
  return (
    <div className="briefing-panel">
      <h2 className="text-xl font-semibold">Briefing</h2>
      {asOf ? <p className="mt-1 text-sm text-muted">Updated {asOf}</p> : null}
      {!briefing && (
        <p className="mt-1 text-sm text-muted">
          One brief before you push — then it updates as the trip changes.
        </p>
      )}
      {briefing && (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-fg whitespace-pre-wrap">{briefing.lead}</p>
          {log.length > 0 ? (
            <div className="border-t border-border pt-3">
              <p className="text-base font-semibold">Updates</p>
              <ol className="briefing-timeline mt-2">
                {log.map((entry, i) => (
                  <li key={`${entry.at}-${i}`} className="text-sm leading-snug">
                    <p className="text-xs text-muted">
                      {formatClockTime(entry.at)}
                      {" · "}
                      {briefLogLabel(entry)}
                    </p>
                    <p className="mt-1">{briefLogText(entry)}.</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      )}
      <Button type="button" className="home-submit mt-4 w-full" disabled={pending} onClick={onCompile}>
        {pending ? "Updating…" : briefing ? "Update briefing" : "Compile briefing"}
      </Button>
      {feedback === "no_change" ? <p role="status" className="mt-2 text-center text-sm text-muted">No new updates right now.</p> : null}
      {feedback === "failed" ? <p role="alert" className="mt-2 text-center text-sm text-ifr">We couldn’t refresh the briefing. Try again.</p> : null}
    </div>
  );
}

function StagePager({
  story,
  active,
  onChange,
}: {
  story: FlightStory;
  active: StageId;
  onChange: (s: StageId) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef({ x: 0, y: 0, dx: 0, axis: null as null | "x" | "y" });
  const [width, setWidth] = useState(0);
  const [dx, setDx] = useState(0);
  const [sliding, setSliding] = useState(false);
  const index = STAGES.findIndex((s) => s.id === stageStepId(active));
  const card = width * 0.92;
  const gap = 12;
  const pad = Math.max(0, (width - card) / 2);
  const tx = pad - index * (card + gap) + dx;
  const indexRef = useRef(index);
  const cardRef = useRef(card);
  const onChangeRef = useRef(onChange);
  indexRef.current = index;
  cardRef.current = card;
  onChangeRef.current = onChange;
  const activeRef = useRef(active);
  activeRef.current = active;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      drag.current = { x: t.clientX, y: t.clientY, dx: 0, axis: null };
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const mx = t.clientX - drag.current.x;
      const my = t.clientY - drag.current.y;
      if (!drag.current.axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        drag.current.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
        if (drag.current.axis === "x") setSliding(true);
      }
      if (drag.current.axis !== "x") return;
      e.preventDefault();
      drag.current.dx = mx;
      setDx(mx);
    };
    const onEnd = () => {
      const axis = drag.current.axis;
      const mx = drag.current.dx;
      drag.current = { x: 0, y: 0, dx: 0, axis: null };
      setSliding(false);
      setDx(0);
      if (axis !== "x") return;
      const step = cardRef.current + 12;
      const i = indexRef.current;
      let next = i;
      if (mx < -Math.max(40, step * 0.16)) next = Math.min(STAGES.length - 1, i + 1);
      else if (mx > Math.max(40, step * 0.16)) next = Math.max(0, i - 1);
      const id = STAGES[next]?.id;
      if (id && id !== activeRef.current) onChangeRef.current(id);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    <div className="mt-4 min-w-0">
      <div ref={box} className="min-w-0 overflow-hidden" style={{ touchAction: "pan-y" }}>
      <div
        className="flex"
        style={{
          gap,
          width: width ? card * STAGES.length + gap * (STAGES.length - 1) : "100%",
          transform: `translate3d(${tx}px,0,0)`,
          transition: sliding ? "none" : "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {STAGES.map((s) => {
          const st = story.stages?.[s.id];
          const on = active === s.id;
          return (
            <div key={s.id} className="shrink-0" style={{ width: width ? card : "92%" }}>
              <StageBody
                story={story}
                stage={s.id}
                badge={st?.state === "now" ? "Now" : st?.state === "done" ? "Done" : "Next"}
                current={on}
              />
            </div>
          );
        })}
      </div>
      </div>
      <div className="mt-3 flex items-center justify-center gap-3">
        <button
          type="button"
          aria-label="Previous stage"
          disabled={index <= 0}
          onClick={() => {
            const id = STAGES[index - 1]?.id;
            if (id) onChange(id);
          }}
          className="flex size-8 items-center justify-center rounded-full border border-border text-fg disabled:opacity-25"
        >
          <ChevronLeft className="size-4" strokeWidth={2.5} />
        </button>
        <div className="flex items-center gap-2">
          {STAGES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              aria-label={s.label}
              onClick={() => onChange(s.id)}
              className={cn(
                "rounded-full transition-all",
                i === index ? "h-2 w-5 bg-fg" : "size-2 bg-subtle",
              )}
            />
          ))}
        </div>
        <button
          type="button"
          aria-label="Next stage"
          disabled={index >= STAGES.length - 1}
          onClick={() => {
            const id = STAGES[index + 1]?.id;
            if (id) onChange(id);
          }}
          className="flex size-8 items-center justify-center rounded-full border border-border text-fg disabled:opacity-25"
        >
          <ChevronRight className="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function StageBody({
  story,
  stage,
  badge,
  current,
}: {
  story: FlightStory;
  stage: StageId;
  badge?: string;
  current?: boolean;
}) {
  const s = story.stages?.[stageStepId(stage)];
  const extra = useMemo(() => extraFor(story, stage), [story, stage]);
  if (!s) return null;
  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-4",
        current ? "border-fg" : "border-border",
      )}
    >
      <p className="font-mono text-xs tracking-widest text-muted uppercase">
        {badge ? `${badge} · ` : ""}
        {STAGES.find((x) => x.id === stage)?.label ?? stage}
      </p>
      <h3 className="font-display text-title font-semibold">{s.title}</h3>
      {s.body ? <p className="mt-2 text-sm leading-relaxed text-fg">{s.body}</p> : null}
      {s.watchouts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {s.watchouts.map((w) => (
            <li key={w} className="border-l-2 border-accent/50 pl-3 text-sm text-muted">
              {w}
            </li>
          ))}
        </ul>
      )}
      {extra}
    </article>
  );
}

function extraFor(story: FlightStory, stage: StageId) {
  const times = story.times ?? {
    push: null,
    takeoff: null,
    taxiOutMin: null,
    land: null,
    taxiInMin: null,
    originGate: null,
    destGate: null,
  };
  if (stage === "origin_gate" || stage === "push") {
    return (
      <>
        <dl className="mt-4 grid grid-cols-1 gap-2">
          <TimeChip
            label="Push"
            value={times.push ?? "—"}
            sub={kindLabel(times.pushKind ?? (times.pushed ? "actual" : times.push ? "scheduled" : null))}
            late={(times.delayMin ?? 0) >= 15}
          />
          <TimeChip
            label="Gate"
            value={times.originGate ?? "—"}
          />
        </dl>
      </>
    );
  }
  if (stage === "taxi") {
    return (
      <>
        <dl className="mt-4 grid grid-cols-1 gap-2">
          <TimeChip
            label="Pushback"
            value={times.pushed ? times.push ?? "Awaiting confirmation" : "Awaiting departure"}
            sub={times.pushSource === "provider_actual" ? "Gate departure reported"
              : times.pushSource === "live_detected" || times.pushSource === "track_detected" ? "Pushback detected from live movement"
              : times.pushed ? "Earlier pushback time unavailable" : "Awaiting movement"}
          />
          <TimeChip
            label="Taxi out"
            value={times.taxiOutMin == null ? "—" : `${times.taxiOutMin} min`}
            sub={times.taxiOutKind === "measured" ? "Measured" : "Estimated"}
          />
          <TimeChip
            label="Wheels up"
            value={times.takeoff ?? "—"}
            sub={kindLabel(times.takeoffKind ?? (times.airborne ? "actual" : times.takeoff ? "scheduled" : null))}
          />
        </dl>
      </>
    );
  }
  if (stage === "inbound") {
    const w = story.inbound.watch[0];
    if (!w || w.locked) return null;
    return (
      <div className="mt-4 rounded-md border border-border bg-bg px-3 py-3">
        <p className="font-mono text-xs tracking-widest text-subtle uppercase">Inbound tail</p>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <p className="font-display text-xl font-semibold">{w.iata}</p>
          <p className="font-mono text-xs text-muted">{w.type ?? ""}</p>
        </div>
        {w.from ? <p className="mt-1 text-sm text-muted">From {w.from}</p> : null}
        {(w.landClock || w.gateClock || w.taxiing) && (
        <dl className="mt-3 grid grid-cols-2 gap-2">
          <TimeChip
            label="Landed"
            value={w.landClock ?? "—"}
          />
          <TimeChip
            label={w.locked ? "At gate" : "Taxi in"}
            value={
              w.locked
                ? (w.gateClock ?? "—")
                : w.taxiing
                  ? w.etaMin
                    ? formatDuration(w.etaMin)
                    : "Taxiing"
                  : (w.clock ?? "—")
            }
          />
        </dl>
        )}
      </div>
    );
  }
  if (stage === "arrival" || stage === "final_approach") {
    return (
      <WxBlock
        label={story.dest.iata}
        cat={story.dest.category}
        decoded={story.dest.decoded?.summary ?? "Weather missing"}
      />
    );
  }
  if (stage === "taxi_in" || stage === "gate") {
    if (!times.destGate && times.taxiInMin == null) return null;
    return (
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <TimeChip label="Posted gate" value={times.destGate ?? "—"} sub={story.dest.iata} />
        <TimeChip
          label="Taxi in"
          value={
            times.taxiInMin == null
              ? "—"
              : times.taxiInKind === "measured"
                ? `${times.taxiInMin} min`
                : `Est. ${times.taxiInMin} min`
          }
        />
      </dl>
    );
  }
  if (stage === "ride") {
    if (story.currentStage === "arrival" || story.currentStage === "final_approach" || story.currentStage === "taxi_in" || story.currentStage === "gate" || story.route.remainingNm < 40) {
      return null;
    }
    const now = Date.now();
    const aheadEvents = upcomingWeatherEvents(story.route.samples, story.route.progress, now)
      .filter((event) => event.startEtaMin > 2 && (event.key.startsWith("turbulence:") || event.key === "storms"));
    const firstBumps = aheadEvents.find((event) => event.key.startsWith("turbulence:"));
    const firstStorms = aheadEvents.find((event) => event.key === "storms");
    const events = aheadEvents.filter((event) => event === firstBumps || event === firstStorms);
    if (!events.length) return null;
    return (
      <ul className="mt-3 space-y-1.5">
        {events.map((event) => {
          const copy = eventWeatherCopy(event, story.dest.city || story.dest.iata);
          return <li key={`${event.source}:${event.key}:${event.startFrac}`} className="text-sm text-muted">
            <div className="flex justify-between gap-3"><span>{copy.mapLabel}</span><span className="shrink-0 font-mono text-xs">{event.source === "observed" ? "Area in " : "in "}{formatDuration(event.startEtaMin)}</span></div>
            <p className="mt-1 text-xs">{eventWeatherSource(event)}</p>
            <PilotReports reports={event.pilotReports} now={now} showSource={event.source !== "observed"} />
          </li>;
        })}
      </ul>
    );
  }
  return null;
}

function TimeChip({
  label,
  value,
  sub,
  late,
}: {
  label: string;
  value: string;
  sub?: string;
  late?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-bg px-3 py-2">
      <p className="font-mono text-xs tracking-widest text-subtle uppercase">{label}</p>
      <p className={cn("mt-1 break-words font-display text-lg font-semibold leading-tight", late ? "text-mvfr" : "text-fg")}>
        {value}
      </p>
      {sub ? <p className="text-xs leading-snug text-muted">{sub}</p> : null}
    </div>
  );
}

function WxBlock({
  label,
  cat,
  decoded,
}: {
  label: string;
  cat: string;
  decoded: string;
}) {
  return (
    <div className="mt-4 grid gap-2">
      <p className="font-mono text-xs tracking-widest text-subtle uppercase">
        {label} {cat}
      </p>
      <p className="text-sm text-muted">{decoded}</p>
    </div>
  );
}

function Skeleton({ query, onHome, slow = false }: { query: string; onHome: () => void; slow?: boolean }) {
  const label = query.trim() || "the flight";
  return (
    <div className="flight-loading" role="status">
      <RefreshCw className="size-6 animate-spin text-accent" aria-hidden="true" />
      <h2>{slow ? "Still looking…" : `Getting ${label}`}</h2>
      <p>{slow ? `We're still checking ${label}'s flight information.` : "Getting times, weather, and the map…"}</p>
      <button type="button" onClick={onHome} className="min-h-11 px-3 text-sm font-semibold text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Cancel</button>
      <dl><div><dt>Times</dt><dd>Scheduled and estimated clocks load with the flight.</dd></div><div><dt>Briefing</dt><dd>Ride notes appear as soon as weather is in.</dd></div></dl>
    </div>
  );
}


function technicalWeatherProducts(text: string | null | undefined) {
  const matches = String(text || "").toUpperCase().match(/G-AIRMET|AIRMET|SIGMET|PIREP|CWA|TCF|METAR|TAF/g) || [];
  return [...new Set(matches)].join(" · ");
}

function passengerWeatherSource(text: string | null | undefined, kind?: FlightStory["hazards"][number]["kind"]) {
  const value = String(text || "").toUpperCase();
  if (kind === "pirep" || value.includes("PIREP") || value.includes("REPORTED")) return "Reported by another aircraft";
  if (value.includes("CWA")) return "Air traffic weather advisory";
  if (value.includes("TCF")) return "Thunderstorm forecast";
  if (value.includes("SIGMET")) return "Official aviation weather alert";
  if (value.includes("AIRMET")) return "Aviation weather advisory";
  if (value.includes("TAF")) return "Airport forecast";
  if (value.includes("METAR")) return "Current airport weather";
  return "Route weather forecast";
}

function PilotReports({ reports, now, showSource = true }: { reports?: PilotReportObservation[]; now: number; showSource?: boolean }) {
  const timedReports = (reports ?? []).flatMap((report) => {
    const timing = pilotReportTiming(report.observedAt, now);
    return timing ? [{ report, timing }] : [];
  });
  if (!timedReports.length) return null;
  return <ul className="mt-3 space-y-3 text-sm text-muted">
    {timedReports.map(({ report, timing }) => <li key={`${report.id}:${report.observedAt}`}>
      {showSource && <p className="font-medium text-fg">Reported by another aircraft</p>}
      <p>{timing}</p>
      <p className="mt-1">{report.detail}</p>
    </li>)}
  </ul>;
}

function WeatherTimeline({ story }: { story: FlightStory }) {
  const now = Date.now();
  const airborne = story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach";
  const landed = isLanded(story);
  const takeoff = story.times.takeoffUnix;
  const landing = story.times.landUnix;
  const duration = takeoff && landing && landing > takeoff ? (landing - takeoff) / 60 : null;
  const samples = story.route.samples;
  const visibleGroups = upcomingWeatherEvents(samples, story.route.progress, now);
  const displayedWeather = flightWeatherSummary(story, now);
  const remainingHazards = story.hazards.filter((hazard) => hazard.remaining
    && (hazard.kind !== "pirep" || Boolean(pilotReportTiming(hazard.observedAt, now))));

  const timeLabel = (group: RouteWeatherEvent) => {
    if (group.source === "observed") return group.startEtaMin < 1
      ? "You’re passing this reported area around now"
      : `You’ll pass this area in about ${formatDuration(group.startEtaMin)}`;
    const from = airborne ? group.startEtaMin : duration == null ? null : group.startFrac * duration;
    const to = airborne ? group.endEtaMin : duration == null ? null : group.endFrac * duration;
    if (from == null || to == null) return "Timing unavailable";
    const formatMinutes = (value: number) => {
      const minutes = Math.max(0, Math.round(value));
      const hours = Math.floor(minutes / 60);
      return hours ? `${hours} ${hours === 1 ? "hour" : "hours"}${minutes % 60 ? ` ${minutes % 60} ${minutes % 60 === 1 ? "minute" : "minutes"}` : ""}` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    };
    const start = airborne
      ? from < 1 ? "Around now" : `About ${formatMinutes(from)} ahead`
      : from < 1 ? "Around takeoff" : `About ${formatMinutes(from)} after takeoff`;
    const span = Math.round(to - from);
    const intoFlight = airborne && story.times.airborne && takeoff ? Math.max(0, (story.fetchedAt / 1000 - takeoff) / 60) + from : from;
    return <span>{start}{airborne && <span className="block">Around {formatMinutes(intoFlight)} into flight</span>}{span > 0 && <span className="block">{group.gaps ? "Intermittent areas over about " : "Continues for about "}{formatMinutes(span)}</span>}</span>;
  };
  const fieldCard = (field: FlightStory["origin"], title: string) => <article className="weather-section">
    <h3 className="text-lg font-semibold">{title.split(" · ")[0]} · {field.iata}</h3>
    <p className="mt-1 text-sm text-muted">{title.split(" · ")[1]}</p>
    <p className="mt-3 text-sm leading-relaxed">{field.decoded?.summary || "Current observation unavailable."}</p>
    <p className="mt-3 text-sm leading-relaxed">Forecast: {field.taf || "Unavailable."}</p>
    <details className="weather-disclosure mt-3 text-sm"><summary><span>Current airport weather <span className="text-xs text-muted">· METAR</span></span><ChevronDown className="size-5 shrink-0 text-muted" aria-hidden="true" /></summary><p className="break-words font-mono text-muted">{field.rawMetar || "Observation unavailable."}</p></details>
  </article>;
  return <div className="weather-timeline">
    <div className="weather-heading"><h2 className="text-xl font-semibold">Weather through your flight</h2></div>
    {!landed && <p className="text-sm font-medium">{displayedWeather}</p>}
    {!landed && fieldCard(story.origin, "Takeoff · departure conditions")}
    {(!story.weatherCoverage || story.weatherCoverage.failedSources.length > 0) && <p role="status" className="weather-coverage text-sm text-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>Weather coverage is incomplete. Missing feeds do not mean smooth conditions. {story.weatherCoverage?.failedSources.join(" · ")}</span></p>}
    <h3 className="weather-route-heading text-lg font-semibold">{landed ? "Route weather" : airborne ? "Ahead on your route" : "Along your planned route"}</h3>
    {landed ? <p className="text-sm text-muted">Flight has landed. A historical weather timeline was not recorded.</p> : visibleGroups.length ? <ol className="weather-events">
      {visibleGroups.map((g, i) => {
        const copy = eventWeatherCopy(g, story.dest.city || story.dest.iata);
        const title = copy.headline;
        const source = eventWeatherSource(g);
        const reported = g.source === "observed";
        const technical = technicalWeatherProducts(g.note);
        return <li key={i} className="weather-section">
          <div className="weather-event-heading">
            <svg className="weather-event-number" viewBox="-13 -13 26 26" role="img" aria-label={g.key.startsWith("turbulence:") ? `Weather marker ${weatherEventNumber(visibleGroups, g)}` : g.key === "storms" ? "Thunderstorm marker" : "Cloud marker"}>
              <WeatherEventMarker eventNumber={weatherEventNumber(visibleGroups, g)} entry={g.start} x={0} y={0} kind={sampleWeather(g.start).kind} band={sampleWeather(g.start).band} label={copy.mapLabel} />
            </svg>
            <WeatherEventHeadline copy={copy} />
          </div>
          {g.key.startsWith("turbulence:") && <p className="mt-1 text-sm"><WeatherIntensityLabel intensity={g.key.slice(11)} band={g.intensities.length === 1 && g.intensities[0] === "light-moderate" ? "light" : undefined} /> {reported ? "bumps reported" : "turbulence"}</p>}
          <p className="mt-2 flex items-center gap-2 text-sm font-medium"><Clock className="size-4 shrink-0" />{timeLabel(g)}</p>
          <WeatherEventBody copy={copy} />
          {!reported && g.gaps && <p className="mt-2 text-sm text-muted">This may come and go briefly along the highlighted stretch.</p>}
          {!reported && <p className="mt-3 text-sm font-medium">{source}{technical ? <span className="ml-1 text-xs font-normal text-muted">· {technical}</span> : null}</p>}
          <PilotReports reports={g.pilotReports} now={now} showSource={!reported} />
          {(reported || g.start.convective || g.start.chop !== "smooth" || g.start.cloud) && <figure className="mt-3">
            <div className="weather-event-map pointer-events-none h-80 overflow-hidden rounded-md" aria-label={title}>
              <RouteMap story={story} fixedViewport weatherPreview={{ reported, pilotReports: g.pilotReports, intensityBand: g.intensities.length === 1 && g.intensities[0] === "light-moderate" ? "light" : undefined, intensity: g.key.startsWith("turbulence:") ? g.key.slice(11) : undefined, eventNumber: weatherEventNumber(visibleGroups, g), label: copy.mapLabel, startFrac: g.startFrac, endFrac: g.endFrac, startEtaMin: g.startEtaMin, endEtaMin: g.endEtaMin, ranges: g.ranges }} />
            </div>
            <figcaption className="mt-2 text-xs text-muted">{reported ? "Highlighted: the reported area along the route. A report describes another aircraft’s recent experience; conditions may change before this flight reaches the area." : "Highlighted: where these conditions overlap the route. Radar colors show recent precipitation; conditions may change before the flight reaches this area."} {story.live ? "Aircraft shown when within this view." : "Live aircraft position unavailable."}</figcaption>
          </figure>}
          {g.note && <details className="weather-disclosure mt-2 text-sm text-muted"><summary><span>Technical details</span><ChevronDown className="size-5 shrink-0 text-muted" aria-hidden="true" /></summary><p>{g.note}</p></details>}
        </li>;
      })}
    </ol> : <p className="text-sm text-muted">{samples.length ? "No significant conditions flagged in the available route forecast. This does not guarantee a smooth ride." : "Route weather data unavailable."}</p>}
    {fieldCard(story.dest, "Landing · arrival conditions")}
    <details className="weather-disclosure weather-sources"><summary><span>Weather sources and timing</span><ChevronDown className="size-5 shrink-0 text-muted" aria-hidden="true" /></summary>
      <div className="mt-3 space-y-2 text-sm text-muted">
        <p>Timing is approximate and changes with the route and speed. Advisories describe possible conditions, not guaranteed encounters. Aircraft reports describe recent observations, not forecasts. Unflagged areas may have incomplete coverage.</p>
        <p className="text-xs">Flight data fetched {formatClockTime(story.fetchedAt)}. Weather observation and advisory times are shown in their source details.</p>
      </div>
      {remainingHazards.map(h => {
        const technical = technicalWeatherProducts(`${h.label} ${h.detail}`);
        const timing = h.kind === "pirep" ? pilotReportTiming(h.observedAt, now) : h.validity || "Timing unavailable";
        return <div key={h.id} className="mt-3 text-sm"><p className="font-semibold">{passengerWeatherSource(`${h.label} ${h.detail}`, h.kind)}</p>{technical && <p className="text-xs text-muted">{technical}</p>}<p className="text-muted">{timing}</p><p className="mt-1 text-muted">{h.detail}</p></div>;
      })}
      {!remainingHazards.length && <p className="mt-3 text-sm text-muted">No remaining advisories or recent aircraft reports returned. This does not establish complete weather coverage.</p>}
    </details>
  </div>;
}


function FlightWelcome({ open, onClose, story, brief }: { open: boolean; onClose: () => void; story: FlightStory; brief: CompiledBrief | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const displayedWeather = flightWeatherSummary(story);
  const otherWeatherWarnings = [...new Set(story.hazards
    .filter((hazard) => hazard.remaining && (hazard.kind === "ice" || hazard.kind === "llws" || hazard.kind === "ifr"))
    .map((hazard) => hazard.label))];
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);
  return <dialog aria-labelledby="flight-welcome-title" ref={ref} onCancel={onClose} onClose={onClose}
    className="fixed left-1/2 top-1/2 m-0 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-5 text-fg backdrop:bg-black/70"
    style={{ maxHeight: "calc(100dvh - max(2rem, env(safe-area-inset-top, 0px)) - max(2rem, env(safe-area-inset-bottom, 0px)))" }}>
    <div className="flex items-start justify-between gap-3">
      <h2 className="text-xl font-semibold" id="flight-welcome-title">Important information about your flight</h2>
      <button type="button" autoFocus aria-label="Close flight briefing" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-xl">×</button>
    </div>
    <p className="mt-2 text-sm text-muted">{story.iata || story.callsign} · {story.origin.iata} → {story.dest.iata}</p>
    <div className="mt-4 space-y-3 text-sm leading-relaxed">
      {story.inboundDiversion && <p><strong>Inbound aircraft was diverted:</strong> {inboundDiversionText(story.inboundDiversion)}</p>}
      <p>{story.diversion ? nextStep(story, story.fetchedAt).title + ". " + nextStep(story, story.fetchedAt).body : brief?.lead || "The briefing is being prepared. Current flight information is below."}</p>
      {(story.times.delayMin ?? 0) >= 5 && <p><strong>Departure delay:</strong> {story.times.delayMin} minutes.</p>}
      {(story.currentStage === "inbound" || story.currentStage === "push") && <p><strong>Inbound aircraft:</strong> {story.inbound.detail || story.inbound.headline}</p>}
      {!isLanded(story) && <p><strong>Route weather:</strong> {displayedWeather}</p>}
      {!isLanded(story) && otherWeatherWarnings.length > 0 && <p><strong>Weather alerts:</strong> {otherWeatherWarnings.join(" · ")}</p>}
      {!isLanded(story) && story.origin.nas?.delayed && <p><strong>Departure airport:</strong> {story.origin.nas.reason}</p>}
      {story.dest.nas?.delayed && <p><strong>Arrival airport:</strong> {story.dest.nas.reason}</p>}
    </div>
    <p className="mt-4 text-xs text-muted">Data as of {formatClockTime(story.fetchedAt)}. Estimates may change. Full details remain in Briefing and Weather.</p>
  </dialog>;
}
