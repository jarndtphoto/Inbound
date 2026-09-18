import { inboundDiversionText } from "@/lib/inbound-diversion";
import { TravelerCompanion } from "@/components/traveler-companion";
import { BaggageStatus, useBaggageStatus } from "@/components/baggage-status";
import { baggageSummary } from "@/lib/baggage-copy";
import { flightDepartureDate } from "@/lib/airline-status";
import { isLanded, nextStep } from "@/lib/traveler";
import { briefRide } from "@/lib/brief";
import { briefLogLabel, briefLogText, briefingRefreshOutcome, composeBrief, logManualRefresh, type CompiledBrief, type RideFacts } from "@/lib/brief-copy";
import { agoLabel, delayPhrase } from "@/lib/format";
import { formatDuration, formatMiles, feetPretty } from "@/lib/geo";
import { parseFlightQuery, storyMatchesQuery } from "@/lib/flight-parse";
import { RESUME_MAX_AGE_MS, resumeFromStory, savedScheduleNote } from "@/lib/flight-resume";
import { useFiled } from "@/lib/store";
import { routeWeatherEvents, type RouteWeatherEvent } from "@/lib/weather-events";
import { passengerWeatherCopy } from "@/lib/weather-card-copy";
import { passengerAirportWeather } from "@/lib/passenger-airport-weather";
import { getFlightStory } from "@/lib/story";
import { getGroundPosition } from "@/lib/ground-position";
import type { Comfort, FlightStory, StageId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RouteMap } from "@/components/route-map";
import { WeatherEventBody, WeatherEventHeadline } from "@/components/weather-event-copy";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock, Gauge, Plane, Map as MapIcon, CloudSun, NotebookText, PanelsTopLeft, House, ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, Component, type ReactNode } from "react";

const FLIGHT_TABS = ["Overview", "Route", "Weather", "Briefing"] as const;

const STAGES: { id: StageId; label: string }[] = [
  { id: "inbound", label: "Inbound" },
  { id: "origin_gate", label: "At gate" },
  { id: "push", label: "Pushback" },
  { id: "taxi", label: "Taxiing out" },
  { id: "ride", label: "Flight" },
  { id: "arrival", label: "Arrival" },
  { id: "final_approach", label: "Final approach" },
  { id: "taxi_in", label: "Taxiing in" },
  { id: "gate", label: "At the gate" },
];

const STORY_CACHE_KEY = "filed-story-cache-v9";
const LEGACY_STORY_CACHE_KEY = "filed-story-cache-v8";
const ORIG_MEM_KEY = "filed-orig-sched-v2";

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
    return entry.story;
  } catch {
    return undefined;
  }
}

export function cachedStorySafeDuringRefreshFailure(story: FlightStory, now = Date.now()) {
  const moving = story.live || story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach" || story.currentStage === "taxi_in";
  const positionAge = story.providers?.chosenPositionAgeSec;
  const positionFresh = !moving || (typeof positionAge === "number" && positionAge <= 60);
  return positionFresh && now - story.fetchedAt <= (moving ? 15_000 : 45 * 60_000);
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
    records[key] = { story: slim, at: Date.now() };
    const recent = Object.entries(records).filter(([, value]) =>
      Date.now() - (value as { at: number }).at <= RESUME_MAX_AGE_MS
    ).sort((a, b) => (b[1] as { at: number }).at - (a[1] as { at: number }).at).slice(0, 8);
    localStorage.setItem(STORY_CACHE_KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch {
    /* quota */
  }
}

type OrigMem = {
  pushUnix: number;
  pushClock: string;
  takeoffUnix: number | null;
  takeoffClock: string | null;
  landUnix: number | null;
  landClock: string | null;
};

function origMemKey(story: FlightStory) {
  const u = story.times?.origPushUnix ?? story.times?.pushUnix;
  const day =
    u != null
      ? new Date(u * 1000).toISOString().slice(0, 10)
      : new Date(story.fetchedAt).toISOString().slice(0, 10);
  return `${normFlight(story.callsign)}:${story.origin.iata}:${story.dest.iata}:${day}`;
}

const BRIEF_HISTORY_KEY = "inbound-brief-history-v2";

function briefHistoryKey(story: FlightStory) {
  const instance = story.flightId?.trim();
  if (instance) return `${instance}:${story.origin.iata}:${story.dest.iata}`;
  const u = story.times?.origPushUnix ?? story.times?.pushUnix ?? story.times?.takeoffUnix;
  const day = u != null
    ? new Date(u * 1000).toISOString().slice(0, 10)
    : new Date(story.fetchedAt).toISOString().slice(0, 10);
  return `${normFlight(story.callsign)}:${story.origin.iata}:${story.dest.iata}:${day}`;
}

function savedBrief(story: FlightStory): CompiledBrief | null {
  try {
    const entry = JSON.parse(localStorage.getItem(BRIEF_HISTORY_KEY) || "{}")[briefHistoryKey(story)];
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

function rememberOrigOnClient(story: FlightStory): FlightStory {
  if (typeof window === "undefined") return story;
  const t = story.times;
  const pushUnix = t?.pushUnix ?? null;
  if (pushUnix == null || !t?.push) return story;
  let all: Record<string, OrigMem> = {};
  try {
    all = JSON.parse(localStorage.getItem(ORIG_MEM_KEY) || "{}") as Record<string, OrigMem>;
  } catch {
    all = {};
  }
  const k = origMemKey(story);
  const prev = all[k];
  const seedPush = t.origPushUnix ?? pushUnix;
  let origPushUnix = prev?.pushUnix != null ? Math.min(prev.pushUnix, seedPush) : seedPush;
  if (Math.abs(pushUnix - origPushUnix) > 8 * 3600) origPushUnix = seedPush;
  const origPushClock =
    prev && prev.pushUnix <= origPushUnix ? prev.pushClock : t.pushWas || t.push;
  const seedTakeoff = t.origTakeoffUnix ?? t.takeoffUnix ?? null;
  let origTakeoffUnix =
    prev?.takeoffUnix != null && seedTakeoff != null
      ? Math.min(prev.takeoffUnix, seedTakeoff)
      : (prev?.takeoffUnix ?? seedTakeoff);
  if (origTakeoffUnix != null && t.takeoffUnix != null && Math.abs(t.takeoffUnix - origTakeoffUnix) > 8 * 3600) {
    origTakeoffUnix = seedTakeoff;
  }
  const origTakeoffClock =
    prev && origTakeoffUnix != null && prev.takeoffUnix === origTakeoffUnix
      ? prev.takeoffClock
      : t.takeoffWas || t.takeoff || null;
  const seedLand = t.origLandUnix ?? t.landUnix ?? null;
  let origLandUnix =
    prev?.landUnix != null && seedLand != null ? Math.min(prev.landUnix, seedLand) : (prev?.landUnix ?? seedLand);
  if (origLandUnix != null && t.landUnix != null && Math.abs(t.landUnix - origLandUnix) > 8 * 3600) {
    origLandUnix = seedLand;
  }
  const origLandClock =
    prev && origLandUnix != null && prev.landUnix === origLandUnix ? prev.landClock : t.landWas || t.land || null;
  all[k] = {
    pushUnix: origPushUnix,
    pushClock: origPushClock,
    takeoffUnix: origTakeoffUnix,
    takeoffClock: origTakeoffClock,
    landUnix: origLandUnix,
    landClock: origLandClock,
  };
  try {
    localStorage.setItem(ORIG_MEM_KEY, JSON.stringify(all));
  } catch {
    /* quota */
  }
  let delayMin = Math.round((pushUnix - origPushUnix) / 60);
  if (delayMin > 8 * 60 || delayMin < -90) delayMin = 0;
  let arriveDelayMin =
    t.landUnix != null && origLandUnix != null ? Math.round((t.landUnix - origLandUnix) / 60) : (t.arriveDelayMin ?? null);
  if (arriveDelayMin != null && (arriveDelayMin > 8 * 60 || arriveDelayMin < -90)) arriveDelayMin = 0;
  const late = delayMin >= 5;
  const arriveLate = arriveDelayMin != null && arriveDelayMin >= 5;
  return {
    ...story,
    times: {
      ...t,
      origPushUnix,
      origTakeoffUnix,
      origLandUnix,
      delayMin: Math.abs(delayMin) < 5 ? 0 : delayMin,
      arriveDelayMin:
        arriveDelayMin == null ? t.arriveDelayMin ?? null : Math.abs(arriveDelayMin) < 5 ? 0 : arriveDelayMin,
      pushWas: late && origPushClock !== t.push ? origPushClock : late ? origPushClock : null,
      takeoffWas: late ? origTakeoffClock : null,
      landWas: arriveLate ? origLandClock : null,
    },
  };
}

function isUsableStory(s: FlightStory | undefined): s is FlightStory {
  return Boolean(s?.iata && s.origin && s.dest && s.comfort && s.stages?.inbound && s.route?.samples);
}

function storyForQuery(s: FlightStory | undefined, q: string): FlightStory | undefined {
  return isUsableStory(s) && storyMatchesQuery(s, q) ? s : undefined;
}

const TRACK_ROUTE_HOLD_MS = 20 * 60_000;

function keepRecentTrackGeometry(incoming: FlightStory, saved: FlightStory | undefined): FlightStory {
  if (!saved || incoming.route.source === "track" || saved.route.source !== "track") return incoming;
  if (incoming.origin.iata !== saved.origin.iata || incoming.dest.iata !== saved.dest.iata) return incoming;
  if (incoming.flightId && saved.flightId && incoming.flightId !== saved.flightId) return incoming;
  if (Date.now() - saved.fetchedAt > TRACK_ROUTE_HOLD_MS) return incoming;
  if (!["ride", "arrival", "final_approach"].includes(incoming.currentStage)) return incoming;
  const oldSamples = saved.route.samples ?? [];
  const freshSamples = incoming.route.samples ?? [];
  if (oldSamples.length < 8 || freshSamples.length < 2) return incoming;

  const samples = oldSamples.map((old) => {
    let best = freshSamples[0]!;
    let delta = Math.abs(best.frac - old.frac);
    for (let i = 1; i < freshSamples.length; i++) {
      const candidate = freshSamples[i]!;
      const d = Math.abs(candidate.frac - old.frac);
      if (d < delta) {
        best = candidate;
        delta = d;
      }
    }
    return { ...best, lat: old.lat, lon: old.lon, frac: old.frac };
  });

  return {
    ...incoming,
    route: {
      ...incoming.route,
      source: "track",
      samples,
      filedFixes: incoming.route.filedFixes ?? saved.route.filedFixes,
    },
  };
}

function rideLabelOf(story: FlightStory) {
  const ahead = story.route.samples.filter((s) => s.frac >= story.route.progress);
  if (ahead.some((s) => s.chop === "severe")) return "Severe turbulence";
  if (ahead.some((s) => s.chop === "moderate")) return "Moderate turbulence";
  if (ahead.some((s) => s.chop === "light")) return "Light turbulence";
  if (!story.weatherCoverage) return "Weather coverage unavailable";
  if (story.weatherCoverage.failedSources.length) return "Weather coverage incomplete";
  return "Smooth";
}

function takeoffEstimateExpired(story: FlightStory) {
  return ["inbound", "origin_gate", "push", "taxi"].includes(story.currentStage)
    && story.times.takeoffKind !== "actual"
    && story.times.takeoffUnix != null
    && story.times.takeoffUnix <= story.fetchedAt / 1000;
}

function rideFacts(story: FlightStory, query: string, active: StageId): RideFacts {
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
    worstChop: story.wx?.live?.worstChop ?? null,
    corridorWx: story.wx?.live?.corridor?.map((c) => `${c.iata} ${c.summary}`).join("; ") ?? null,
    inbound: `${story.inbound?.headline ?? ""}. ${story.inbound?.detail ?? ""}`.replace(/^\.\s*/, "").trim(),
    inboundHeadline: story.inbound?.headline ?? "",
    inboundDetail: story.inbound?.detail ?? "",
    inboundStatus: story.inbound?.status,
    rideLabel: rideLabelOf(story),
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
  const [ready, setReady] = useState(false);
  const [entered, setEntered] = useState(false);
  const [page, setPage] = useState<"home" | "flight">("home");
  const [theme, setTheme] = useState<"sunset" | "sunrise">("sunrise");
  const [themeSettingsOpen, setThemeSettingsOpen] = useState(false);
  const [flight, setFlight] = useState("");
  const recents = useFiled(s => s.recents);
  const hydrate = useFiled(s => s.hydrate);
  const setQuery = useFiled(s => s.setQuery);
  useEffect(() => {
    hydrate();
    let saved: "sunset" | "sunrise" = "sunrise";
    try { if (localStorage.getItem("inbound-theme") === "sunset") saved = "sunset"; } catch { /* storage optional */ }
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
    setReady(true);
  }, [hydrate]);
  const chooseTheme = (next: "sunset" | "sunrise") => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("inbound-theme", next); } catch { /* storage optional */ }
  };
  const start = (value: string) => {
    const q = value.trim();
    if (!q) return;
    setQuery(q);
    setPage("flight");
  };
  if (!entered) return <main className="inbound-welcome">
    <div className="inbound-welcome-content">
      <img className="inbound-welcome-art" src="/inbound-welcome.svg" alt="An aircraft approaching a runway through a glowing gold halo" width={768} height={768} fetchPriority="high" />
      <h1 className="font-display text-6xl">Inbound</h1>
      <p className="inbound-welcome-tagline">Your all in one flight information app</p>
      <p className="inbound-welcome-description">From your gate to your destination.</p>
      <button type="button" className="inbound-welcome-button" disabled={!ready} onClick={() => setEntered(true)}>
        {ready ? "Track my flight" : "Preparing your journey…"}
      </button>
    </div>
  </main>;
  if (page === "flight") return <FlightPages onHome={() => setPage("home")} />;
  return <main className="h-dvh overflow-hidden bg-bg px-5 pt-safe pb-safe text-fg sm:px-8">
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 py-3 sm:py-5">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold"><Plane className="h-5 w-5 text-accent" aria-hidden="true" /> Inbound</span>
        <button type="button" onClick={() => setThemeSettingsOpen(true)} className="rounded-lg border border-border px-4 py-2.5 text-sm font-semibold">Theme settings</button>
      </header>

      <section className="flex min-h-0 flex-1 flex-col justify-center rounded-2xl border border-border bg-surface p-5 sm:p-8">
        <p className="text-sm font-medium text-muted">Live flight tracking from gate to gate</p>
        <h1 className="mt-2 font-display text-4xl leading-[0.95] sm:text-6xl">Know what’s happening<br />with your flight.</h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted sm:text-base">Follow the aircraft, see the route and weather ahead, and stay current as the flight moves.</p>
        <form className="mt-5 space-y-2.5" onSubmit={e => { e.preventDefault(); start(flight); }}>
          <label htmlFor="home-flight" className="block text-sm font-semibold">Flight number</label>
          <input id="home-flight" required maxLength={16} value={flight} onChange={e => setFlight(e.target.value)} placeholder="For example, AA1114" autoCapitalize="characters" autoComplete="off" spellCheck={false} className="w-full rounded-xl border border-border bg-bg px-4 py-3.5 text-lg outline-none focus:ring-2 focus:ring-accent" />
          <button type="submit" disabled={!flight.trim()} className="w-full rounded-xl bg-accent px-5 py-3.5 font-semibold text-accent-fg disabled:opacity-50">Track my flight →</button>
        </form>
      </section>

      {recents.length > 0 && <section className="shrink-0" aria-label="Recent flights">
        <div className="mb-2 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">Recent flights</h2><span className="text-xs text-muted">Tap to reopen</span></div>
        <div className="grid grid-cols-3 gap-2">{recents.slice(0, 3).map(q => <button key={q} type="button" onClick={() => start(q)} className="min-w-0 truncate rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-semibold">{q}</button>)}</div>
      </section>}

      {themeSettingsOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-5 py-safe" role="presentation" onMouseDown={e => { if (e.currentTarget === e.target) setThemeSettingsOpen(false); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="theme-settings-title" className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 text-fg shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div><h2 id="theme-settings-title" className="text-xl font-semibold">Theme settings</h2><p className="mt-1 text-sm text-muted">Choose how Inbound looks on this device.</p></div>
            <button type="button" aria-label="Close theme settings" onClick={() => setThemeSettingsOpen(false)} className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border text-xl">×</button>
          </div>
          <fieldset className="mt-5"><legend className="sr-only">Appearance</legend><div className="grid grid-cols-2 gap-3">
            {(["sunrise", "sunset"] as const).map(mode => <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => chooseTheme(mode)} className={cn("rounded-xl border-2 p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent", theme === mode ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : "")} style={{ background: mode === "sunrise" ? "#fff3ce" : "#172238", color: mode === "sunrise" ? "#30230c" : "#f4f6ff", borderColor: mode === "sunrise" ? "#ad7415" : "#748cb5" }}>
              <span aria-hidden="true" className="mb-3 block text-2xl">{mode === "sunset" ? "☾" : "☀"}</span>
              <span className="block font-semibold">{mode === "sunset" ? "Sunset" : "Sunrise"}</span>
              <span className="mt-1 block text-sm">{mode === "sunset" ? "Dark & calm" : "Light & bright"}</span>
              <span className="mt-3 block text-xs font-semibold">{theme === mode ? "✓ Selected" : "Choose theme"}</span>
            </button>)}
          </div></fieldset>
          <p className="mt-4 text-xs text-muted">Your preference is saved on this device and used throughout the app.</p>
        </section>
      </div>}
    </div>
  </main>;
}

function FlightPages({ onHome }: { onHome: () => void }) {
  const query = useFiled((s) => s.query);
  const stagePref = useFiled((s) => s.stage);
  const setQuery = useFiled((s) => s.setQuery);
  const setStage = useFiled((s) => s.setStage);
  const hydrate = useFiled((s) => s.hydrate);
  const [briefPopupOpen, setBriefPopupOpen] = useState(false);
  const openedBriefings = useRef(new Set<string>());
  const [flightTab, setFlightTab] = useState<typeof FLIGHT_TABS[number]>("Overview");
  const [briefing, setBriefing] = useState<CompiledBrief | null>(null);
  const [briefingFor, setBriefingFor] = useState("");
  const [cacheOk, setCacheOk] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [pullPx, setPullPx] = useState(0);
  const [manualBusy, setManualBusy] = useState(false);
  const freshRef = useRef(false);
  const refreshingRef = useRef(false);
  const pullPxRef = useRef(0);
  const briefGen = useRef(0);
  const lastBriefKey = useRef("");
  const briefingRef = useRef<CompiledBrief | null>(null);
  const manualBriefBase = useRef<CompiledBrief | null>(null);
  const [briefFeedback, setBriefFeedback] = useState<"no_change" | "failed" | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const flightKey = normFlight(query);
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
    setFlightTab("Overview");
    setQuery(next);
  }

  useLayoutEffect(() => {
    hydrate();
    setCacheOk(true);
  }, [hydrate]);

  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no",
    );
  }, []);

  const storyQ = useQuery({
    queryKey: ["story", query],
    queryFn: async ({ client }) => {
      const fresh = freshRef.current;
      freshRef.current = false;
      const saved = storyForQuery(client.getQueryData<FlightStory>(["story", query]), query) ?? readCachedStory(query);
      const resume = resumeFromStory(saved, query);
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      const s = await Promise.race([
        getFlightStory({ data: { q: query, fresh, resume } }),
        new Promise<never>((_, reject) => {
          requestTimer = setTimeout(() => reject(new Error("Flight data request timed out. Please try again.")), 35_000);
        }),
      ]).catch((error) => {
        console.error("[Inbound flight request]", error instanceof Error ? error.message : String(error));
        throw error;
      }).finally(() => clearTimeout(requestTimer));
      if (!storyMatchesQuery(s, query)) {
        throw new Error("Could not load that flight. Try another number.");
      }
      const merged = keepRecentTrackGeometry(
        rememberOrigOnClient(s),
        storyForQuery(saved, query),
      );
      writeCachedStory(query, merged);
      return merged;
    },
    // Seed saved data once; failed requests must remain errors, not successful
    // cache reads. React Query retains the last good story during a failure.
    initialData: () => {
      const cached = storyForQuery(readCachedStory(query), query);
      return cached ? rememberOrigOnClient(cached) : undefined;
    },
    initialDataUpdatedAt: 0,
    enabled: cacheOk && query.length > 0,
    refetchInterval: (q) => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
      if (q.state.fetchStatus === "fetching") return false;
      const s = q.state.data;
      if (q.state.status === "error") return /HTTP 402\b/.test(String(q.state.error?.message ?? "")) ? 60_000 : 15_000;
      if (!s) return 5_000;
      if (s.live || s.currentStage === "push" || s.currentStage === "taxi") return 3_000;
      if (s.currentStage === "ride" || s.currentStage === "arrival" || s.currentStage === "final_approach" || s.currentStage === "taxi_in") return 4_000;
      if (s.currentStage === "inbound") return 5_000;
      return 8_000;
    },
    staleTime: 2_500,
    gcTime: 10 * 60_000,
    retry: (count, err) => {
      if (count >= 2 || /HTTP 402\b/.test(err instanceof Error ? err.message : "")) return false;
      const msg = err instanceof Error ? err.message : "";
      if (/Try another number|Enter a flight number|Flight number is too long/i.test(msg)) return false;
      return true;
    },
    retryDelay: (attempt) => Math.min(2_000 * 2 ** attempt, 8_000),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (previousData) => {
      if (storyForQuery(previousData, query)) return previousData;
      return storyForQuery(readCachedStory(query), query);
    },
  });

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible" || !query) return;
      if (Date.now() - storyQ.dataUpdatedAt > 2_500) void storyQ.refetch();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [query, storyQ.dataUpdatedAt, storyQ.refetch]);

  useEffect(() => {
    if (storyQ.dataUpdatedAt > 0) setRefreshErr(null);
  }, [query, storyQ.dataUpdatedAt]);

  const baseStory = storyForQuery(storyQ.data, query);
  const groundStoryQ = useQuery({
    queryKey: [
      "ground-position",
      baseStory?.flightId ?? baseStory?.iata ?? normFlight(query),
      baseStory?.origin.iata ?? "",
      baseStory?.aircraft?.registration ?? "",
      baseStory?.aircraft?.callsign ?? baseStory?.callsign ?? "",
    ],
    queryFn: () => getGroundPosition({ data: {
      callsign: baseStory?.aircraft?.callsign ?? baseStory?.callsign ?? null,
      registration: baseStory?.aircraft?.registration ?? null,
      airportLat: baseStory!.origin.lat,
      airportLon: baseStory!.origin.lon,
    } }),
    enabled: Boolean(baseStory
      && ["inbound", "origin_gate", "push", "taxi"].includes(String(baseStory.currentStage))
      && baseStory.times?.landKind !== "actual"),
    refetchInterval: 2_500,
    staleTime: 1_000,
    gcTime: 60_000,
    retry: false,
  });
  const fastGround = groundStoryQ.data;
  const fastGroundAge = fastGround?.seenAt ? Math.max(0, Date.now() / 1000 - fastGround.seenAt) : Infinity;
  const story = baseStory && fastGround && fastGroundAge <= 30
    ? {
        ...baseStory,
        live: true,
        aircraft: {
          ...(baseStory.aircraft ?? {
            hex: "",
            registration: null,
            type: null,
            typeName: null,
            year: null,
            operator: null,
            vertFpm: null,
            phase: "parked" as const,
          }),
          lat: fastGround.lat,
          lon: fastGround.lon,
          altFt: fastGround.altFt ?? 0,
          gsKt: fastGround.gsKt ?? 0,
          track: fastGround.track ?? baseStory.aircraft?.track ?? null,
          onGround: fastGround.onGround,
          phase: fastGround.onGround ? ((fastGround.gsKt ?? 0) > 5 ? "taxi" as const : "parked" as const) : "cruise" as const,
          registration: fastGround.registration ?? baseStory.aircraft?.registration ?? null,
          callsign: fastGround.callsign ?? baseStory.aircraft?.callsign ?? null,
          extrapolated: false,
          seenSec: fastGroundAge,
        },
        currentStage: fastGround.onGround && (fastGround.gsKt ?? 0) >= 1
          && ["inbound", "origin_gate", "push"].includes(String(baseStory.currentStage))
          ? "taxi" as const
          : baseStory.currentStage,
        providers: {
          ...baseStory.providers,
          chosenPosition: "fr24",
          chosenPositionSeenAt: fastGround.seenAt,
          chosenPositionAgeSec: fastGroundAge,
          surfaceTelemetryStale: false,
        },
      }
    : baseStory;
  useEffect(() => {
    if (!story) return;
    const key = normFlight(query);
    if (!openedBriefings.current.has(key)) {
      openedBriefings.current.add(key);
      setBriefPopupOpen(true);
    }
  }, [query, story?.times.origPushUnix, story?.times.pushUnix, Boolean(story)]);
  const rawStage = String(stagePref === "auto" ? (story?.currentStage ?? "inbound") : stagePref);
  const active: StageId = rawStage === "ground"
    ? "origin_gate"
    : STAGES.some((s) => s.id === rawStage)
      ? (rawStage as StageId)
      : "inbound";
  const shownBrief = briefing && briefingFor === flightKey ? briefing : null;
  briefingRef.current = shownBrief;

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
    const key = `${takeoffEstimateExpired(story)}|${story.weatherCoverage?.failedSources.join(",") ?? "unknown"}|${story.aircraft?.registration ?? ""}|${story.live}|${Math.round(story.route.etaMin)}|${Math.round(story.route.remainingNm / 10)}|${story.currentStage}|${story.times?.delayMin ?? ""}|${story.times?.taxiInKind ?? ""}|${story.times?.push ?? ""}|${story.times?.takeoff ?? ""}|${story.times?.gate ?? ""}|${story.times?.taxiOutMin ?? ""}|${story.times?.taxiInMin ?? ""}|${story.times?.originGate ?? ""}|${story.times?.destGate ?? ""}|${story.dest.nas?.reason ?? ""}|${story.inbound.status}|${story.times?.land ?? ""}|${story.wx?.hash ?? ""}`;
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
    <div className="pwa-flight-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-fg" style={shellStyle}>
      {story && <FlightWelcome open={briefPopupOpen} onClose={() => setBriefPopupOpen(false)} story={story} brief={shownBrief} />}
      <ScreenErrorBoundary>
      <main
        ref={mainRef}
        className={cn("min-h-0 min-w-0 flex-1 overflow-x-hidden overscroll-y-contain px-4 pt-1 lg:px-8 lg:pt-4", flightTab === "Route" ? "overflow-y-hidden" : "overflow-y-auto")}
      >
        <div className={cn("mx-auto min-w-0 max-w-6xl overflow-x-hidden", flightTab === "Route" ? "flex h-full flex-col pb-2" : "pb-6")}>
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
                ? "Live update failed — showing saved flight data. Position, stage, and times may be out of date. Retrying automatically."
                : refreshErr}
            </p>
          </div>
        ) : null}
        {story?.schedule?.status === "saved" && !storyQ.isError && !refreshErr ? (
          <div role="status" className="mb-3 rounded-md border border-border bg-surface px-4 py-2 text-sm text-fg">
            {savedScheduleNote(story.schedule.confirmedAt)}
          </div>
        ) : null}
        {storyQ.isError && !story && (
          <div className="mb-4 rounded-md border border-ifr/40 bg-surface px-4 py-3">
            <p className="text-sm text-ifr">
              {"We couldn’t get this flight’s latest information. We’ll retry automatically, or you can try again below."}
            </p>
            <Button type="button" variant="secondary" className="mt-3" onClick={() => void storyQ.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {!story && !storyQ.isError && <Skeleton query={query || "the flight"} />}

        {story && (
          <div key={normFlight(query)} className={cn("min-w-0", flightTab === "Route" && "min-h-0 flex-1")}>
            <section id="panel-Overview" role="tabpanel" aria-labelledby="tab-Overview" hidden={flightTab !== "Overview"}>
              <FlightHead story={story} failed={storyQ.isError || Boolean(refreshErr)} fetching={storyQ.isFetching} refreshing={manualBusy} onRefresh={() => void refreshNow()} />
              <TravelerCompanion story={story} failed={storyQ.isError || Boolean(refreshErr)} onTrackInbound={openFlight} />
              <OverviewDetails story={story} />
            </section>
            <section id="panel-Route" role="tabpanel" aria-labelledby="tab-Route" hidden={flightTab !== "Route"} className="h-full min-h-0" style={{ containerType: "size" }}>
              <RouteMap story={story} fixedViewport />
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
          <button type="button" aria-label="Home — flight search" onClick={onHome}
            className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-semibold text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <House className="size-4.5" aria-hidden="true" /><span>Home</span>
          </button>
          {FLIGHT_TABS.map((tab, index) => {
            const Icon = tab === "Overview" ? PanelsTopLeft : tab === "Route" ? MapIcon : tab === "Weather" ? CloudSun : NotebookText;
            const label = tab === "Route" ? "Map" : tab;
            return <button key={tab} id={`tab-${tab}`} type="button"
              aria-current={flightTab === tab ? "page" : undefined} aria-controls={`panel-${tab}`}
              className={cn("flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-semibold transition-colors", flightTab === tab ? "bg-surface-2 text-fg" : "text-muted")}
              onClick={() => { setFlightTab(tab); mainRef.current?.scrollTo(0, 0); }}
              onKeyDown={(e) => {
                const next = e.key === "ArrowRight" ? (index + 1) % 4 : e.key === "ArrowLeft" ? (index + 3) % 4 : e.key === "Home" ? 0 : e.key === "End" ? 3 : -1;
                if (next < 0) return;
                e.preventDefault(); setFlightTab(FLIGHT_TABS[next]);
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

function displayStage(story: FlightStory): StageId {
  const ac = story.aircraft;
  const positionAge = story.providers?.chosenPositionAgeSec;
  const freshGroundAtOrigin = Boolean(
    ac &&
    ac.onGround === true &&
    Number.isFinite(ac.lat) &&
    Number.isFinite(ac.lon) &&
    typeof positionAge === "number" &&
    positionAge <= 30 &&
    haversineNm(ac, story.origin) < 12 &&
    story.times?.landKind !== "actual" &&
    story.currentStage !== "taxi_in" &&
    story.currentStage !== "gate"
  );

  // Presentation guard only: never tell the passenger the flight is airborne
  // while a fresh live fix still has the aircraft on the departure airport.
  if (freshGroundAtOrigin && (
    story.currentStage === "ride" ||
    story.currentStage === "arrival" ||
    story.currentStage === "final_approach"
  )) {
    if (story.times?.pushed || (ac?.gsKt ?? 0) >= 3) return "taxi";
    return "origin_gate";
  }
  return story.currentStage;
}

function stageHeadline(story: FlightStory) {
  const stage = displayStage(story);
  if (stage === "gate") return "At the gate";
  if (stage === "taxi_in") return "Taxiing in";
  if (stage === "final_approach") return "Final approach";
  if (stage === "arrival" && wheelsDown(story)) return "Landed";
  if (stage === "origin_gate") return "At the gate";
  if (stage === "push") return "Pushback";
  if (stage === "taxi") return "Taxiing out";
  return STAGES.find((s) => s.id === stage)?.label ?? stage;
}

function liveFix(story: FlightStory) {
  const ac = story.aircraft;
  return Boolean(story.live && ac && Number.isFinite(ac.lat) && Number.isFinite(ac.lon));
}

function flightAirborne(story: FlightStory) {
  if (story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach") return true;
  if (
    story.currentStage === "origin_gate" ||
    story.currentStage === "push" ||
    story.currentStage === "taxi" ||
    story.currentStage === "inbound" ||
    story.currentStage === "taxi_in" ||
    story.currentStage === "gate"
  ) {
    return false;
  }
  return Boolean(story.times?.airborne);
}

function elapsedFlight(story: FlightStory) {
  const takeoff = story.times?.takeoffUnix;
  const now = story.fetchedAt / 1000;
  if (!flightAirborne(story) || takeoff == null || !Number.isFinite(takeoff) || takeoff > now) return null;
  return {
    minutes: (now - takeoff) / 60,
    estimated: story.times?.takeoffKind !== "actual",
  };
}

function headStatus(story: FlightStory) {
  const airline = story.airline;
  const air = flightAirborne(story);
  const live = liveFix(story);
  const inAirLive = Boolean(live && story.aircraft && !story.aircraft.onGround);
  if (story.currentStage === "gate") return airline ?? "Parked";
  if (story.currentStage === "taxi_in") return airline ? `Taxiing in · ${airline}` : "Taxiing in";
  if (wheelsDown(story)) return airline ? `Landed · ${airline}` : "Landed";
  if (story.currentStage === "origin_gate") return airline ? `At the gate · ${airline}` : "At the gate";
  if (story.currentStage === "push") return airline ? `Pushback · ${airline}` : "Pushback";
  if (story.currentStage === "taxi") return airline ? `Taxiing out · ${airline}` : "Taxiing out";
  if (story.currentStage === "final_approach") return airline ? `Final approach · ${airline}` : "Final approach";
  if (air && inAirLive) return airline ? `In the air · ${airline}` : "In the air";
  if (air) return "In the air — live position unavailable right now";
  if (live) return airline ? `On the ground · ${airline}` : "On the ground";
  return airline ?? "";
}

const STATUS_PROGRESS = ["Gate", "Pushback", "Taxi", "Flight", "Landing", "Gate"] as const;

function statusProgressIndex(stage: StageId) {
  if (stage === "push") return 1;
  if (stage === "taxi") return 2;
  if (stage === "ride") return 3;
  if (stage === "arrival" || stage === "final_approach") return 4;
  if (stage === "taxi_in" || stage === "gate") return 5;
  return 0;
}

function FlightStatusProgress({ story }: { story: FlightStory }) {
  const active = statusProgressIndex(displayStage(story));
  return (
    <div className="mt-4" aria-label={`Flight progress: ${STATUS_PROGRESS[active]}`}>
      <div className="grid grid-cols-6 gap-1">
        {STATUS_PROGRESS.map((label, index) => {
          const complete = index < active;
          const current = index === active;
          return (
            <div key={`${label}-${index}`} className="min-w-0 text-center">
              <div className={cn(
                "mx-auto h-1.5 w-full rounded-full",
                complete || current ? "bg-accent" : "bg-border",
                current && "ring-2 ring-accent/20 ring-offset-1 ring-offset-surface",
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
    <div className={cn(
      "min-w-0 rounded-md border border-border bg-bg",
      prominent ? "flex min-h-28 flex-col justify-center px-4 py-3" : "flex min-h-20 flex-col justify-center px-3 py-2",
    )}>
      <p className="font-mono text-xs tracking-widest text-subtle uppercase">{title}</p>
      <p className={cn(
        "mt-1 break-words font-display font-semibold leading-none",
        prominent ? "text-3xl" : "text-xl",
      )}>{value ?? "—"}</p>
      {detail ? <p className={cn("mt-1 text-muted", prominent ? "text-sm" : "text-xs")}>{detail}</p> : null}
    </div>
  );
}

function FlightHead({
  story,
  fetching,
  refreshing,
  failed = false,
  onRefresh,
}: {
  story: FlightStory;
  fetching: boolean;
  refreshing: boolean;
  failed?: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-wide text-muted">{headStatus(story)}</p>
          <h2 className="font-display text-[clamp(1.8rem,7vw,4.25rem)] font-semibold leading-none">{story.iata}</h2>
        </div>
        <div className="max-w-36 text-right">
          <p className="font-mono text-xs tracking-widest text-muted uppercase">Stage</p>
          <p className="font-display text-xl font-semibold leading-tight sm:text-2xl">{stageHeadline(story)}</p>
        </div>
        <p className="col-span-2 text-lg text-fg">
          {story.origin.city} <span className="text-muted">{story.origin.iata}</span>
          <span className="mx-2 text-subtle">→</span>
          {story.dest.city} <span className="text-muted">{story.dest.iata}</span>
        </p>
      </div>
      <FlightStatusProgress story={story} />
      <TimesStrip failed={failed} story={story} fetching={fetching} refreshing={refreshing} onRefresh={onRefresh} />
    </div>
  );
}

type OverviewDetailKey = "flight" | "aircraft" | "airports" | "baggage";
const CLOSED_OVERVIEW_DETAILS: Record<OverviewDetailKey, boolean> = { flight: false, aircraft: false, airports: false, baggage: false };

function formatLocalUnix(unix: number | null | undefined, timeZone?: string) {
  if (unix == null || !Number.isFinite(unix)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(unix * 1000);
  } catch {
    return new Date(unix * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

function plannedDuration(story: FlightStory) {
  const start = story.times.origTakeoffUnix ?? story.times.takeoffUnix;
  const end = story.times.origLandUnix ?? story.times.landUnix;
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

function OverviewDetails({ story }: { story: FlightStory }) {
  const storageKey = `inbound-overview-details:${origMemKey(story)}`;
  const [open, setOpen] = useState<Record<OverviewDetailKey, boolean>>(CLOSED_OVERVIEW_DETAILS);
  useEffect(() => {
    setOpen(CLOSED_OVERVIEW_DETAILS);
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved) setOpen({ flight: Boolean(saved.flight), aircraft: Boolean(saved.aircraft), airports: Boolean(saved.airports), baggage: Boolean(saved.baggage) });
    } catch { /* Secondary detail state is optional. */ }
  }, [storageKey]);
  const toggle = (key: OverviewDetailKey) => setOpen((current) => {
    const next = { ...current, [key]: !current[key] };
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
    return next;
  });
  const ac = story.aircraft;
  const aircraftSummary = [ac?.typeName ?? ac?.type ?? "Aircraft details unavailable", ac?.registration].filter(Boolean).join(" · ");
  const originStop = [story.origin.iata, story.times.originGate ? `Gate ${story.times.originGate}` : null].filter(Boolean).join(" ");
  const destStop = [story.dest.iata, story.times.destGate ? `Gate ${story.times.destGate}` : null].filter(Boolean).join(" ");
  const baggage = useBaggageStatus({flight:story.iata.replace(/\s/g, ""),origin:story.origin.iata,destination:story.dest.iata,date:flightDepartureDate(story)});
  const baggageProminent = wheelsDown(story);
  const scheduledPush = formatLocalUnix(story.times.origPushUnix, story.origin.tz) ?? story.times.pushWas;
  const scheduledTakeoff = formatLocalUnix(story.times.origTakeoffUnix, story.origin.tz) ?? story.times.takeoffWas;
  const pushActualLabel = story.times.pushSource === "provider_actual" ? "Actual"
    : story.times.pushSource === "live_detected" || story.times.pushSource === "track_detected" ? "Detected"
      : story.times.pushKind === "estimated" ? "Estimated" : null;
  const takeoffActualLabel = story.times.takeoffKind === "actual" ? "Actual"
    : story.times.takeoffKind === "estimated" ? "Estimated" : null;
  return <section className="mt-4 rounded-xl border border-border bg-surface px-4" aria-label="More flight information">
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
        <DetailRow label="Scheduled landing" value={formatLocalUnix(story.times.origLandUnix, story.dest.tz) ?? story.times.landWas} />
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
        <section aria-label="Arrival airport details"><h3 className="font-semibold">Arrival · {story.dest.iata}</h3><dl className="mt-1"><DetailRow label="Gate" value={story.times.destGate ?? "Not assigned"} /><DetailRow label="Gate arrival" value={story.times.gate} /><DetailRow label="Weather" value={passengerAirportWeather(story.dest.decoded, story.dest.rawMetar)} /></dl></section>
      </div>
    </OverviewDisclosure>
    <OverviewDisclosure id="baggage" title="Baggage" summary={baggageSummary(baggage.result)} open={open.baggage} onToggle={toggle} prominent={baggageProminent}>
      <BaggageStatus state={baggage} />
    </OverviewDisclosure>
  </section>;
}

function kindLabel(kind: FlightStory["times"]["pushKind"]) {
  if (kind === "actual") return "Actual";
  if (kind === "estimated") return "Estimated";
  if (kind === "scheduled") return "Scheduled";
  return "";
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

function TimesStrip({
  story,
  fetching,
  refreshing,
  failed = false,
  onRefresh,
}: {
  story: FlightStory;
  fetching: boolean;
  refreshing: boolean;
  failed?: boolean;
  onRefresh: () => void;
}) {
  const t = story.times;
  const down = wheelsDown(story);
  const shownStage = displayStage(story);
  const airborne = (shownStage === "ride" || shownStage === "arrival" || shownStage === "final_approach") && !down;
  const ac = story.aircraft;
  const showLiveFlight = Boolean(liveFix(story) && flightAirborne(story) && ac && !ac.onGround && (ac.altFt || ac.gsKt));
  const elapsed = airborne ? elapsedFlight(story) : null;
  const liveFresh = cachedStorySafeDuringRefreshFailure(story);
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

  const preDepartureTakeoffPrimary = shownStage === "push" || shownStage === "taxi";

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex min-w-0 flex-col gap-3">
        {airborne ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)] gap-3">
            <StatusCard
              prominent
              title="Remaining"
              value={liveFresh ? formatDuration(story.route.etaMin) : "Updating…"}
              detail={liveFresh ? formatMiles(story.route.remainingNm) : "Live position is stale"}
            />
            <StatusCard
              title="Flown"
              value={elapsed ? formatDuration(elapsed.minutes) : "—"}
              detail={`${elapsed?.estimated || !liveFix(story) ? "Est. " : "Approx. "}${formatMiles(story.route.flownNm)}`}
            />
          </div>
        ) : down ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)] gap-3">
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
          <div className="grid min-w-0 grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)] gap-3">
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
          <dl className="grid grid-cols-1 gap-3">
            <Stat
              icon={Gauge}
              label="Live flight"
              value={ac?.altFt ? feetPretty(ac.altFt) : "—"}
              sub={ac?.gsKt ? `${Math.round(ac.gsKt)} kt` : ""}
            />
          </dl>
        ) : null}

        <Freshness failed={failed} partial={story.schedule?.status === "saved"} at={story.fetchedAt} fetching={fetching} refreshing={refreshing} onRefresh={onRefresh} />
      </div>
    </div>
  );
}

function Freshness({
  at,
  fetching,
  refreshing,
  failed = false,
  partial = false,
  onRefresh,
}: {
  at: number;
  fetching: boolean;
  refreshing: boolean;
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
    <div className="flex flex-col items-end gap-1.5">
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
        {refreshing ? "Updating…" : failed ? "Update delayed · showing saved data" : partial ? "Schedule delayed · " + (Date.now() - at < 8000 ? "other feeds just checked" : agoLabel(at, false)) : agoLabel(at, false)}
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
    ? new Date(briefing.liveAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  const log = briefing?.log ?? [];
  return (
    <div className="mt-4 rounded-xl border border-accent/35 bg-surface p-4">
      <p className="font-mono text-xs tracking-widest text-muted uppercase">Briefing</p>
      <h3 className="font-display text-title font-semibold text-balance">
        {briefing ? "Briefing" : "Brief the whole flight"}
      </h3>
      {!briefing && (
        <p className="mt-1 text-sm text-muted">
          One brief before you push — then it updates as the trip changes.
        </p>
      )}
      {briefing && (
        <div className="mt-3 space-y-3">
          {asOf ? (
            <p className="font-mono text-xs tracking-wide text-subtle uppercase">Briefing updated {asOf}</p>
          ) : null}
          <p className="text-sm leading-relaxed text-fg whitespace-pre-wrap">{briefing.lead}</p>
          {log.length > 0 ? (
            <div className="border-t border-border pt-3">
              <p className="font-mono text-xs tracking-widest text-subtle uppercase">Updates</p>
              <ol className="mt-2 space-y-2">
                {log.map((entry, i) => (
                  <li key={`${entry.at}-${i}`} className="text-sm leading-snug">
                    <p className="font-mono text-[11px] tracking-wide text-subtle uppercase">
                      {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      {" · "}
                      {briefLogLabel(entry)}
                    </p>
                    <p className="text-muted">{briefLogText(entry)}.</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      )}
      <Button type="button" className="mt-4 w-full" disabled={pending} onClick={onCompile}>
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
  const index = Math.max(0, STAGES.findIndex((s) => s.id === active));
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
  const s = story.stages?.[stage];
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
    const ahead = story.route.samples.filter((s) => s.frac >= story.route.progress && s.etaMin > 2);
    const chop = ahead.find((s) => s.chop !== "smooth" && !s.convective);
    const storm = ahead.find((s) => s.convective);
    const rows: { label: string; eta: number }[] = [];
    if (chop) {
      rows.push({
        label: chop.chop === "light" ? "Light chop" : chop.chop === "moderate" ? "Moderate chop" : "Severe chop",
        eta: chop.etaMin,
      });
    }
    if (storm) rows.push({ label: "Storms", eta: storm.etaMin });
    if (!rows.length) return null;
    return (
      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-3 text-sm text-muted">
            <span>{r.label}</span>
            <span className="shrink-0 font-mono text-xs">in {formatDuration(r.eta)}</span>
          </li>
        ))}
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

function Skeleton({ query }: { query: string }) {
  const label = query.trim() || "the flight";
  return (
    <div>
      <p className="mb-3 flex items-center gap-2 font-mono text-xs tracking-widest text-muted uppercase">
        <RefreshCw className="size-3.5 animate-spin text-accent" />
        Getting {label}
      </p>
      <div className="grid min-w-0 gap-5 lg:grid-cols-12">
        <section className="min-w-0 lg:col-span-7">
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="font-mono text-xs tracking-wide text-muted">Live position</p>
            <h2 className="font-display text-display font-semibold leading-none">{label}</h2>
            <p className="mt-3 text-sm text-muted">Getting times, weather, and the map…</p>
          </div>
          <div className="mt-4 flex h-64 items-center justify-center rounded-xl border border-border bg-surface-2">
            <p className="text-sm text-muted">Loading map…</p>
          </div>
        </section>
        <section className="min-w-0 lg:col-span-5">
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="font-mono text-xs tracking-widest text-subtle uppercase">Times</p>
            <p className="mt-3 text-sm text-muted">Scheduled and estimated clocks load with the flight.</p>
          </div>
          <div className="mt-4 rounded-xl border border-border bg-surface p-4">
            <p className="font-mono text-xs tracking-widest text-subtle uppercase">Briefing</p>
            <p className="mt-3 text-sm text-muted">Ride notes appear as soon as weather is in.</p>
          </div>
        </section>
      </div>
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

function WeatherTimeline({ story }: { story: FlightStory }) {
  const airborne = story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach";
  const landed = story.times.landKind === "actual" || story.currentStage === "gate";
  const takeoff = story.times.takeoffUnix;
  const landing = story.times.landUnix;
  const duration = takeoff && landing && landing > takeoff ? (landing - takeoff) / 60 : null;
  const samples = story.route.samples.filter(s => !airborne || s.frac >= story.route.progress);
  const visibleGroups = routeWeatherEvents(samples, story.route.progress);

  const timeLabel = (group: RouteWeatherEvent) => {
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
  const fieldCard = (field: FlightStory["origin"], title: string) => <article className="rounded-xl border border-border bg-surface p-4">
    <p className="text-sm text-muted">{title}</p>
    <h3 className="mt-1 text-lg font-semibold">{field.iata}</h3>
    <p className="mt-3 text-sm leading-relaxed">{field.decoded?.summary || "Current observation unavailable."}</p>
    <p className="mt-3 text-sm leading-relaxed">Forecast: {field.taf || "Unavailable."}</p>
    <details className="mt-3 text-sm"><summary className="cursor-pointer py-2">Current airport weather <span className="text-xs text-muted">· METAR</span></summary><p className="break-words font-mono text-muted">{field.rawMetar || "Observation unavailable."}</p></details>
  </article>;
  return <div className="space-y-4">
    <div><h2 className="text-xl font-semibold">Weather through your flight</h2></div>
    {!landed && fieldCard(story.origin, "Takeoff · departure conditions")}
    {(!story.weatherCoverage || story.weatherCoverage.failedSources.length > 0) && <p role="status" className="rounded-xl border border-border p-4 text-sm">Weather coverage is incomplete. Missing feeds do not mean smooth conditions. {story.weatherCoverage?.failedSources.join(" · ")}</p>}
    <h3 className="text-lg font-semibold">{landed ? "Route weather" : airborne ? "Ahead on your route" : "Along your planned route"}</h3>
    {landed ? <p className="text-sm text-muted">Flight has landed. A historical weather timeline was not recorded.</p> : visibleGroups.length ? <ol className="space-y-3">
      {visibleGroups.map((g, i) => {
        const copy = passengerWeatherCopy(g.start, g.endFrac >= 0.85, story.dest.city || story.dest.iata, g.key);
        const title = copy.headline;
        const source = passengerWeatherSource(g.note);
        const technical = technicalWeatherProducts(g.note);
        return <li key={i} className="rounded-xl border border-border bg-surface p-4">
          <WeatherEventHeadline copy={copy} />
          <p className="mt-2 flex items-center gap-2 text-sm font-medium"><Clock className="size-4 shrink-0" />{timeLabel(g)}</p>
          <WeatherEventBody copy={copy} />
          {g.gaps && <p className="mt-2 text-sm text-muted">This may come and go briefly along the highlighted stretch.</p>}
          <p className="mt-3 text-sm font-medium">{source}{technical ? <span className="ml-1 text-xs font-normal text-muted">· {technical}</span> : null}</p>
          {(g.start.convective || g.start.chop !== "smooth" || g.start.cloud) && <figure className="mt-3">
            <div className="pointer-events-none h-80 overflow-hidden rounded-xl" aria-label={title}>
              <RouteMap story={story} fixedViewport weatherPreview={{ eventNumber: i + 1, label: copy.mapLabel, startFrac: g.startFrac, endFrac: g.endFrac, startEtaMin: g.startEtaMin, endEtaMin: g.endEtaMin, ranges: g.ranges }} />
            </div>
            <figcaption className="mt-2 text-xs text-muted">Highlighted: where these conditions overlap the route. Radar colors show recent precipitation; conditions may change before the flight reaches this area. {story.live ? "Aircraft shown when within this view." : "Live aircraft position unavailable."}</figcaption>
          </figure>}
          {g.note && <details className="mt-2 text-sm text-muted"><summary className="cursor-pointer py-2">Technical details</summary><p>{g.note}</p></details>}
        </li>;
      })}
    </ol> : <p className="text-sm text-muted">{samples.length ? "No significant conditions flagged in the available route forecast. This does not guarantee a smooth ride." : "Route weather data unavailable."}</p>}
    {fieldCard(story.dest, "Landing · arrival conditions")}
    <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer py-2">Weather sources and timing</summary>
      <div className="mt-3 space-y-2 text-sm text-muted">
        <p>Timing is approximate and changes with the route and speed. Advisories describe possible conditions, not guaranteed encounters. Unflagged areas may have incomplete coverage.</p>
        <p className="text-xs">Flight data fetched {new Date(story.fetchedAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}. Weather observation and advisory times are shown in their source details.</p>
      </div>
      {story.hazards.filter(h => h.remaining).map(h => {
        const technical = technicalWeatherProducts(`${h.label} ${h.detail}`);
        return <div key={h.id} className="mt-3 text-sm"><p className="font-semibold">{passengerWeatherSource(`${h.label} ${h.detail}`, h.kind)}</p>{technical && <p className="text-xs text-muted">{technical}</p>}<p className="text-muted">{h.validity || "Timing unavailable"}</p><p className="mt-1 text-muted">{h.detail}</p></div>;
      })}
      {!story.hazards.some(h => h.remaining) && <p className="mt-3 text-sm text-muted">No remaining advisories returned. This does not establish complete weather coverage.</p>}
    </details>
  </div>;
}


function FlightWelcome({ open, onClose, story, brief }: { open: boolean; onClose: () => void; story: FlightStory; brief: CompiledBrief | null }) {
  const ref = useRef<HTMLDialogElement>(null);
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
      {!isLanded(story) && story.hazards.some(h => h.remaining) && <p><strong>Route weather:</strong> {[...new Set(story.hazards.filter(h => h.remaining).map(h => h.label))].join(" · ")}</p>}
      {!isLanded(story) && story.origin.nas?.delayed && <p><strong>Departure airport:</strong> {story.origin.nas.reason}</p>}
      {story.dest.nas?.delayed && <p><strong>Arrival airport:</strong> {story.dest.nas.reason}</p>}
    </div>
    <p className="mt-4 text-xs text-muted">Data as of {new Date(story.fetchedAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}. Estimates may change. Full details remain in Briefing and Weather.</p>
  </dialog>;
}
