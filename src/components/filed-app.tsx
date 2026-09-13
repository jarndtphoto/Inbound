import { briefRide } from "@/lib/brief";
import { composeBrief, logManualRefresh, BRIEF_LOG_LABEL, type CompiledBrief, type RideFacts } from "@/lib/brief-copy";
import { agoLabel, delayPhrase } from "@/lib/format";
import { formatDuration, formatMiles, feetPretty } from "@/lib/geo";
import { storyMatchesQuery } from "@/lib/flight-parse";
import { useFiled } from "@/lib/store";
import { getFlightStory } from "@/lib/story";
import type { Comfort, FlightStory, StageId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RouteMap } from "@/components/route-map";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock, Gauge, Plane, Radio, Search, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, Component, type FormEvent, type ReactNode } from "react";

const FLIGHT_TABS = ["Overview", "Route", "Weather", "Briefing"] as const;

const STAGES: { id: StageId; label: string }[] = [
  { id: "inbound", label: "Inbound" },
  { id: "push", label: "Gate" },
  { id: "taxi", label: "On the move" },
  { id: "ride", label: "Flight" },
  { id: "arrival", label: "Arrival" },
  { id: "gate", label: "At the gate" },
];

const STORY_CACHE_KEY = "filed-story-cache-v8";
const ORIG_MEM_KEY = "filed-orig-sched-v2";

function normFlight(q: string) {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function readCachedStory(q: string): FlightStory | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(STORY_CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { k: string; story: FlightStory; at: number };
    if (parsed.k !== normFlight(q)) return undefined;
    if (Date.now() - parsed.at > 45 * 60_000) return undefined;
    if (!parsed.story?.iata) return undefined;
    return parsed.story;
  } catch {
    return undefined;
  }
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
    localStorage.setItem(STORY_CACHE_KEY, JSON.stringify({ k: normFlight(q), story: slim, at: Date.now() }));
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

const BRIEF_HISTORY_KEY = "inbound-brief-history-v1";
function savedBrief(story: FlightStory): CompiledBrief | null {
  try {
    const entry = JSON.parse(localStorage.getItem(BRIEF_HISTORY_KEY) || "{}")[origMemKey(story)];
    const b = entry?.brief;
    return b && typeof b.lead === "string" && b.snap && Array.isArray(b.log)
      && Array.isArray(b.segments) ? b : null;
  } catch { return null; }
}
function saveBrief(story: FlightStory, brief: CompiledBrief) {
  try {
    const records = JSON.parse(localStorage.getItem(BRIEF_HISTORY_KEY) || "{}");
    records[origMemKey(story)] = { at: Date.now(), brief };
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

function rideLabelOf(story: FlightStory) {
  if (story.currentStage === "arrival" || story.currentStage === "gate" || story.route.remainingNm < 40) {
    return "Smooth";
  }
  const ahead = story.route.samples.filter((s) => s.frac >= story.route.progress);
  if (ahead.some((s) => s.chop === "severe")) return "Severe turbulence";
  if (ahead.some((s) => s.chop === "moderate")) return "Moderate turbulence";
  if (ahead.some((s) => s.chop === "light")) return "Light turbulence";
  return "Smooth";
}

function rideFacts(story: FlightStory, query: string, active: StageId): RideFacts {
  return {
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
    taxiOutMin: story.times?.taxiOutMin ?? null,
    taxiOutKind: story.times?.taxiOutKind ?? null,
    takeoff: story.times?.takeoff ?? null,
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
          style={{ background: "#08090c", color: "#e7eaee", minHeight: "100%" }}
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
  const query = useFiled((s) => s.query);
  const recents = useFiled((s) => s.recents);
  const stagePref = useFiled((s) => s.stage);
  const setQuery = useFiled((s) => s.setQuery);
  const setStage = useFiled((s) => s.setStage);
  const hydrate = useFiled((s) => s.hydrate);
  const [briefPopupOpen, setBriefPopupOpen] = useState(true);
  const [flightTab, setFlightTab] = useState<typeof FLIGHT_TABS[number]>("Overview");
  const [draft, setDraft] = useState("");
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
  const mainRef = useRef<HTMLElement>(null);
  const flightKey = normFlight(query);
  const shellStyle = {
    background: "#08090c",
    color: "#e7eaee",
    height: "100%",
    minHeight: "100%",
  };

  function openFlight(q: string) {
    const next = q.trim();
    if (!next) return;
    briefGen.current += 1;
    setBriefing(null);
    setBriefingFor("");
    setBriefPopupOpen(true);
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

  useEffect(() => {
    if (cacheOk) setDraft(query);
  }, [cacheOk, query]);

  const storyQ = useQuery({
    queryKey: ["story", query],
    queryFn: async () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      const s = await getFlightStory({ data: { q: query, fresh } });
      if (!storyMatchesQuery(s, query)) {
        throw new Error("Could not load that flight. Try another number.");
      }
      const merged = rememberOrigOnClient(s);
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
      if (q.state.fetchStatus === "fetching") return false;
      const s = q.state.data;
      if (!s) return 5_000;
      if (s.live || s.currentStage === "push" || s.currentStage === "taxi") return 3_000;
      if (s.currentStage === "ride" || s.currentStage === "arrival") return 4_000;
      if (s.currentStage === "inbound") return 5_000;
      return 8_000;
    },
    staleTime: 2_500,
    gcTime: 10 * 60_000,
    retry: (count, err) => {
      if (count >= 1) return false;
      const msg = err instanceof Error ? err.message : "";
      if (/Could not load that flight/.test(msg)) return false;
      return true;
    },
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (previousData) => {
      if (storyForQuery(previousData, query)) return previousData;
      return storyForQuery(readCachedStory(query), query);
    },
  });

  const story = storyForQuery(storyQ.data, query);
  const rawStage = String(stagePref === "auto" ? (story?.currentStage ?? "inbound") : stagePref);
  const active: StageId = rawStage === "ground"
    ? "push"
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
      }
      return { ok: true as const, text: local.lead, local, gen, flight };
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
      }
    },
  });

  useEffect(() => {
    briefGen.current += 1;
    setBriefing(null);
    setBriefingFor("");
    lastBriefKey.current = "";
    briefingRef.current = null;
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
    const key = `${story.currentStage}|${story.times?.delayMin ?? ""}|${story.times?.taxiInKind ?? ""}|${story.times?.push ?? ""}|${story.times?.takeoff ?? ""}|${story.times?.gate ?? ""}|${story.times?.taxiOutMin ?? ""}|${story.times?.taxiInMin ?? ""}|${story.times?.originGate ?? ""}|${story.times?.destGate ?? ""}|${story.dest.nas?.reason ?? ""}|${story.inbound.status}|${story.times?.land ?? ""}|${story.wx?.hash ?? ""}`;
    if (key === lastBriefKey.current) return;
    lastBriefKey.current = key;
    const next = composeBrief(rideFacts(story, query, active), briefing);
    if (next !== briefing) {
      briefingRef.current = next;
      setBriefing(next);
    }
  }, [story, briefing, briefingFor, flightKey, query, active]);

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

  function onSearch(e: FormEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    pinDocument();
    mainRef.current?.scrollTo(0, 0);
    if (draft.trim()) openFlight(draft);
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-fg" style={shellStyle}>
      {story && <header className="shrink-0 border-b border-border bg-bg px-4 pt-3 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold">{story.callsign}</p>
              <p className="text-sm text-muted">{story.origin.iata} → {story.dest.iata}</p>
            </div>
            <p className="text-sm font-semibold">{stageHeadline(story)}</p>
          </div>
          <div role="tablist" aria-label="Flight details" className="grid grid-cols-4 gap-1">
            {FLIGHT_TABS.map((tab, index) => <button key={tab} id={`tab-${tab}`} type="button" role="tab"
              aria-selected={flightTab === tab} aria-controls={`panel-${tab}`} tabIndex={flightTab === tab ? 0 : -1}
              className={cn("min-h-11 border-b-2 px-1 py-3 text-sm font-semibold", flightTab === tab ? "border-primary text-fg" : "border-transparent text-muted")}
              onClick={() => { setFlightTab(tab); mainRef.current?.scrollTo(0, 0); }}
              onKeyDown={(e) => {
                const next = e.key === "ArrowRight" ? (index + 1) % 4 : e.key === "ArrowLeft" ? (index + 3) % 4 : e.key === "Home" ? 0 : e.key === "End" ? 3 : -1;
                if (next < 0) return;
                e.preventDefault(); setFlightTab(FLIGHT_TABS[next]);
                document.getElementById(`tab-${FLIGHT_TABS[next]}`)?.focus(); mainRef.current?.scrollTo(0, 0);
              }}>{tab}</button>)}
          </div>
        </div>
      </header>}
      {story && <FlightWelcome open={briefPopupOpen} onClose={() => setBriefPopupOpen(false)} story={story} brief={shownBrief} />}
      <ScreenErrorBoundary>
      <main
        ref={mainRef}
        className={cn("min-h-0 min-w-0 flex-1 overflow-x-hidden overscroll-y-contain px-4 pt-2 lg:px-8 lg:pt-6", flightTab === "Route" ? "overflow-y-hidden" : "overflow-y-auto")}
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
        {storyQ.isError && !story && (
          <div className="mb-4 rounded-md border border-ifr/40 bg-surface px-4 py-3">
            <p className="text-sm text-ifr">
              {(storyQ.error as Error).message || "Could not load that flight. Try another number."}
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
              <FlightHead story={story} fetching={storyQ.isFetching} refreshing={manualBusy} onRefresh={() => void refreshNow()} />
              <div className="mt-5"><RecordCard story={story} /></div>
            </section>
            <section id="panel-Route" role="tabpanel" aria-labelledby="tab-Route" hidden={flightTab !== "Route"} className="h-full min-h-0" style={{ containerType: "size" }}>
              <RouteMap story={story} fixedViewport />
            </section>
            <section id="panel-Weather" role="tabpanel" aria-labelledby="tab-Weather" hidden={flightTab !== "Weather"}>
              <WeatherTimeline story={story} />
            </section>
            <section id="panel-Briefing" role="tabpanel" aria-labelledby="tab-Briefing" hidden={flightTab !== "Briefing"}>
              <BreakdownCard briefing={shownBrief} pending={briefM.isPending} onCompile={() => briefM.mutate()} />
            </section>
          </div>
        )}
        </div>
      </main>
      <footer className="shrink-0 border-t border-border bg-bg px-4 pt-2 pb-2 lg:px-8">
        {recents.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-6xl gap-2 overflow-x-auto" style={{ touchAction: "pan-x" }}>
            {recents.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => openFlight(r)}
                className="h-9 shrink-0 rounded-full border border-border px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg"
              >
                {r}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={onSearch} className="mx-auto flex max-w-6xl gap-2">
          <label className="sr-only" htmlFor="flight-q">
            Flight number
          </label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <input
              id="flight-q"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="AA 1, UA 2814, N105NN"
              autoCapitalize="characters"
              autoCorrect="off"
              enterKeyHint="search"
              suppressHydrationWarning
              className="h-11 w-full rounded-sm border border-border bg-surface pr-3 pl-10 text-sm text-fg placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
            />
          </div>
          <Button type="submit" size="md">
            Track
          </Button>
        </form>
      </footer>
      </ScreenErrorBoundary>
    </div>
  );
}

function wheelsDown(story: FlightStory) {
  if (story.currentStage === "gate") return true;
  if (story.times?.landKind === "actual") return true;
  if (story.currentStage === "arrival" && story.aircraft?.onGround) return true;
  return false;
}

function stageHeadline(story: FlightStory) {
  if (story.currentStage === "gate") return "At the gate";
  if (story.currentStage === "arrival" && wheelsDown(story)) return "Landed";
  if (story.currentStage === "push") return story.times?.pushed ? "On the move" : "Gate";
  return STAGES.find((s) => s.id === story.currentStage)?.label ?? story.currentStage;
}

function liveFix(story: FlightStory) {
  const ac = story.aircraft;
  return Boolean(story.live && ac && Number.isFinite(ac.lat) && Number.isFinite(ac.lon));
}

function flightAirborne(story: FlightStory) {
  if (story.currentStage === "ride" || story.currentStage === "arrival") return true;
  if (
    story.currentStage === "push" ||
    story.currentStage === "taxi" ||
    story.currentStage === "inbound" ||
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
  if (wheelsDown(story)) return airline ? `Landed · ${airline}` : "Landed";
  if (air && inAirLive) return airline ? `In the air · ${airline}` : "In the air";
  if (air) return "In the air — live position unavailable right now";
  if (live) return airline ? `On the ground · ${airline}` : "On the ground";
  return airline ?? "";
}

function FlightHead({
  story,
  fetching,
  refreshing,
  onRefresh,
}: {
  story: FlightStory;
  fetching: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const ac = story.aircraft;
  const airborne = flightAirborne(story);
  const down = wheelsDown(story);
  const live = liveFix(story);
  const showAlt = Boolean(live && airborne && ac && !ac.onGround && (ac.altFt || ac.gsKt));
  const showRemaining = !airborne && !down;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-wide text-muted">{headStatus(story)}</p>
          <h2 className="font-display text-display font-semibold leading-none">{story.iata}</h2>
          <p className="mt-2 text-lg text-fg">
            {story.origin.city} <span className="text-muted">{story.origin.iata}</span>
            <span className="mx-2 text-subtle">→</span>
            {story.dest.city} <span className="text-muted">{story.dest.iata}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xs tracking-widest text-muted uppercase">Stage</p>
          <p className="font-display text-2xl font-semibold">
            {stageHeadline(story)}
          </p>
        </div>
      </div>
      <TimesStrip story={story} fetching={fetching} refreshing={refreshing} onRefresh={onRefresh} />
      <dl className={cn("mt-4 grid gap-3", showAlt || showRemaining ? "grid-cols-2" : "grid-cols-1")}>
        <Stat
          icon={Plane}
          label="Aircraft"
          value={ac ? `${ac.typeName ?? ac.type ?? "—"}` : "Unknown"}
          sub={ac?.registration ?? ""}
        />
        {showAlt ? (
          <Stat
            icon={Gauge}
            label="Altitude"
            value={ac?.altFt ? feetPretty(ac.altFt) : "—"}
            sub={ac?.gsKt ? `${Math.round(ac.gsKt)} kt` : ""}
          />
        ) : showRemaining ? (
          <Stat
            icon={Radio}
            label="Remaining"
            value={formatMiles(story.route.remainingNm)}
            sub={formatDuration(story.route.etaMin)}
          />
        ) : null}
      </dl>
    </div>
  );
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
}: {
  title: string;
  time: string | null | undefined;
  kind?: FlightStory["times"]["pushKind"];
  hint?: string | null;
}) {
  const sub = [kindLabel(kind), hint].filter(Boolean).join(" · ");
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
  onRefresh,
}: {
  story: FlightStory;
  fetching: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = story.times;
  const down = wheelsDown(story);
  const airborne = flightAirborne(story) && !down;
  const elapsed = airborne ? elapsedFlight(story) : null;
  const parked = story.currentStage === "gate";
  const delay = t?.delayMin ?? null;
  const late = (delay ?? 0) >= 5;
  const phrase = delayPhrase(delay);
  const landHint = down && !parked
    ? "Taxiing in"
    : t?.landWas && t.landWas !== t.land
      ? `Was ${t.landWas}`
      : null;
  const gateHint = t?.destGate
    ? `Gate ${t.destGate}`
    : parked
      ? "Parked"
      : t?.taxiInMin != null
        ? t.taxiInKind === "measured"
          ? `Taxi in ${t.taxiInMin} min`
          : `Est. taxi in ${t.taxiInMin} min`
        : null;
  const landClock = (
    <ClockCell
      title={down ? "Landed" : "Landing"}
      time={t?.land}
      kind={t?.landKind ?? (t?.land ? "scheduled" : null)}
      hint={landHint}
    />
  );
  const gateClock = (
    <ClockCell
      title={parked ? "At the gate" : "Gate ETA"}
      time={t?.gate}
      kind={t?.gateKind ?? (t?.gate ? "scheduled" : null)}
      hint={gateHint}
    />
  );
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex min-w-0 flex-col gap-3">
        {airborne ? (
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-3">
            <div className="flex aspect-square min-w-0 flex-col justify-center rounded-md border border-border bg-bg p-3 sm:aspect-auto sm:min-h-32">
              <p className="flex items-center gap-1.5 font-mono text-xs tracking-wide text-subtle uppercase">
                <Clock className="size-3 shrink-0" /> Remaining
              </p>
              <p className="mt-1 break-words font-display text-2xl font-semibold leading-none">{formatDuration(story.route.etaMin)}</p>
              <p className="mt-1 break-words text-xs text-muted">{formatMiles(story.route.remainingNm)}</p>
            </div>
            <div className="flex aspect-square min-w-0 flex-col justify-center rounded-md border border-border bg-bg p-3 sm:aspect-auto sm:min-h-32">
              <p className="flex items-center gap-1.5 font-mono text-xs tracking-wide text-subtle uppercase">
                <Clock className="size-3 shrink-0" /> Flown
              </p>
              <p className="mt-1 break-words font-display text-2xl font-semibold leading-none">{elapsed ? formatDuration(elapsed.minutes) : "—"}</p>
              <p className="mt-1 break-words text-xs text-muted">
                {elapsed?.estimated || !liveFix(story) ? "Est. " : "Approx. "}
                {formatMiles(story.route.flownNm)}
              </p>
            </div>
          </div>
        ) : down ? (
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-3">
            {landClock}
            {gateClock}
          </div>
        ) : (
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-3">
            <ClockCell
              title={t?.pushed ? "Departure" : "Est. push"}
              time={t?.push}
              kind={t?.pushKind ?? (t?.pushed ? "actual" : t?.push ? "scheduled" : null)}
              hint={
                late
                  ? [phrase, t?.pushWas ? `Was ${t.pushWas}` : null].filter(Boolean).join(" · ")
                  : t?.originGate
                    ? `Gate ${t.originGate}`
                    : phrase
              }
            />
            <ClockCell
              title="Takeoff"
              time={t?.takeoff}
              kind={t?.takeoffKind ?? (t?.takeoff ? "scheduled" : null)}
              hint={t?.takeoffWas && t.takeoffWas !== t.takeoff ? `Was ${t.takeoffWas}` : null}
            />
          </div>
        )}
        <Freshness at={story.fetchedAt} fetching={fetching} refreshing={refreshing} onRefresh={onRefresh} />
      </div>
      {!down ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {landClock}
          {gateClock}
        </div>
      ) : null}
    </div>
  );
}

function Freshness({
  at,
  fetching,
  refreshing,
  onRefresh,
}: {
  at: number;
  fetching: boolean;
  refreshing: boolean;
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
        {refreshing ? "Updating…" : agoLabel(at, false)}
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
    <div className="rounded-md border border-border bg-bg px-3 py-2">
      <p className="flex items-center gap-1.5 font-mono text-xs tracking-widest text-subtle uppercase">
        <Icon className="size-3" />
        {label}
      </p>
      <p className="mt-1 flex items-center gap-1 font-display text-lg font-semibold leading-tight">
        {value}
        <TrendArrow trend={trend} />
      </p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function recordRows(story: FlightStory): { label: string; value: string }[] {
  const t = story.times;
  const arriving =
    story.currentStage === "arrival" ||
    story.currentStage === "gate" ||
    story.route.remainingNm < 40;
  const rows: { label: string; value: string }[] = [];
  const beforeDeparture = story.currentStage === "inbound" || story.currentStage === "push";
  if (beforeDeparture) {
    rows.push({ label: "Inbound aircraft", value: story.inbound.headline });
    const inbound = story.inbound.watch[0];
    if (inbound) rows.push({ label: "Inbound flight", value: [inbound.iata, inbound.from ? `from ${inbound.from}` : null].filter(Boolean).join(" · ") });
  }
  if (t.originGate) rows.push({ label: "Departure gate", value: t.originGate });
  if (t.pushed && t.push) rows.push({ label: "Departure", value: `${t.push} · ${t.pushKind === "actual" ? "Reported" : "First observed; approximate"}` });
  if (t.destGate) rows.push({ label: "Arrival gate", value: t.destGate });

  if ((t?.delayMin ?? 0) >= 5) {
    rows.push({
      label: "Delay",
      value: `${t!.delayMin} min`,
    });
  } else if (story.origin.nas?.delayed) {
    rows.push({ label: "Delay", value: story.origin.nas.reason });
  }
  if (t?.taxiOutMin != null) {
    const up =
      story.currentStage === "ride" ||
      story.currentStage === "arrival" ||
      story.currentStage === "gate";
    rows.push({
      label: "Taxi out",
      value: up && t.taxiOutKind === "measured" ? `${t.taxiOutMin} min` : `Est. ${t.taxiOutMin} min`,
    });
  }
  if (!arriving) {
    const ahead = story.route.samples.filter((s) => s.frac >= story.route.progress);
    let ride = "Smooth";
    if (ahead.some((s) => s.chop === "severe")) ride = "Severe turbulence";
    else if (ahead.some((s) => s.chop === "moderate")) ride = "Moderate turbulence";
    else if (ahead.some((s) => s.chop === "light")) ride = "Light turbulence";
    if (ahead.some((s) => s.convective)) ride = `${ride} · thunderstorms`;
    rows.push({ label: "Ride", value: ride });
  }
  if (story.dest.nas?.delayed) {
    rows.push({ label: "Arrival delay", value: story.dest.nas.reason });
  }
  if (story.dest.category === "IFR" || story.dest.category === "LIFR") {
    rows.push({ label: "Arrival", value: `Low weather into ${story.dest.iata}` });
  }
  if (t?.taxiInMin != null) {
    rows.push({
      label: "Taxi in",
      value: t.taxiInKind === "measured" ? `${t.taxiInMin} min` : `Est. ${t.taxiInMin} min`,
    });
  }
  if (story.origin.category === "IFR" || story.origin.category === "LIFR") {
    rows.push({ label: "Origin", value: `Low weather at ${story.origin.iata}` });
  }
  if (!rows.length) rows.push({ label: "Notes", value: "No delay or turbulence flagged." });
  return rows;
}

function RecordCard({ story }: { story: FlightStory }) {
  const rows = recordRows(story);
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-3">
      <p className="font-mono text-xs tracking-widest text-subtle uppercase">Record</p>
      <dl className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 font-mono text-xs tracking-wide text-muted uppercase">{r.label}</dt>
            <dd className="min-w-0 text-right text-sm leading-snug text-fg">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BreakdownCard({
  briefing,
  pending,
  onCompile,
}: {
  briefing: CompiledBrief | null;
  pending: boolean;
  onCompile: () => void;
}) {
  const asOf = briefing?.filedAt
    ? new Date(briefing.filedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
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
            <p className="font-mono text-xs tracking-wide text-subtle uppercase">Briefing as of {asOf}</p>
          ) : null}
          <p className="text-sm leading-relaxed text-fg whitespace-pre-wrap">{briefing.lead}</p>
          {log.length > 0 ? (
            <div className="border-t border-border pt-3">
              <p className="font-mono text-xs tracking-widest text-subtle uppercase">Updates</p>
              <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                {log.map((entry, i) => (
                  <li key={`${entry.at}-${i}`} className="text-sm leading-snug">
                    <p className="font-mono text-[11px] tracking-wide text-subtle uppercase">
                      {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      {" · "}
                      {BRIEF_LOG_LABEL[entry.kind]}
                    </p>
                    <p className="text-muted">{entry.text}.</p>
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
  if (stage === "push") {
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
            label="Departure"
            value={times.pushed ? times.push ?? "Awaiting confirmation" : "Awaiting departure"}
            sub={times.pushed && times.pushKind === "actual" ? "Gate departure reported" : "Movement time not confirmed"}
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
  if (stage === "arrival") {
    return (
      <WxBlock
        label={story.dest.iata}
        cat={story.dest.category}
        decoded={story.dest.decoded?.summary ?? "Weather missing"}
      />
    );
  }
  if (stage === "gate") {
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
    if (story.currentStage === "arrival" || story.currentStage === "gate" || story.route.remainingNm < 40) {
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


function WeatherTimeline({ story }: { story: FlightStory }) {
  const airborne = story.currentStage === "ride" || story.currentStage === "arrival";
  const landed = story.times.landKind === "actual" || story.currentStage === "gate";
  const takeoff = story.times.takeoffUnix;
  const landing = story.times.landUnix;
  const duration = takeoff && landing && landing > takeoff ? (landing - takeoff) / 60 : null;
  const elapsed = story.times.takeoffKind === "actual" && takeoff
    ? Math.max(0, (story.fetchedAt / 1000 - takeoff) / 60) : null;
  const samples = story.route.samples.filter(s => !airborne || s.frac >= story.route.progress);
  const groups: { label: string; note: string | null; start: typeof samples[number]; end: typeof samples[number] }[] = [];
  for (const sample of samples) {
    const label = [sample.convective ? "Thunderstorm advisory or forecast" : null,
      sample.chop !== "smooth" ? `${sample.chop} turbulence indicated` : null,
      sample.cloud ? "Clouds indicated" : null].filter(Boolean).join(" · ") || "No conditions flagged in available data";
    const prev = groups[groups.length - 1];
    if (prev && prev.label === label && prev.note === sample.note) prev.end = sample;
    else groups.push({ label, note: sample.note, start: sample, end: sample });
  }
  const timeLabel = (group: typeof groups[number]) => {
    const from = airborne ? group.start.etaMin : duration == null ? null : group.start.frac * duration;
    const to = airborne ? group.end.etaMin : duration == null ? null : group.end.frac * duration;
    if (from == null || to == null) return "Timing unavailable";
    const range = `${Math.round(from)}${Math.round(to) > Math.round(from) ? `–${Math.round(to)}` : ""} min`;
    return airborne ? `In approximately ${range}${elapsed == null ? "" : ` · around ${Math.round(elapsed + from)} min into flight`}` : `Approximately ${range} after takeoff`;
  };
  const fieldCard = (field: FlightStory["origin"], title: string) => <article className="rounded-xl border border-border bg-surface p-4">
    <p className="text-sm text-muted">{title}</p>
    <h3 className="mt-1 text-lg font-semibold">{field.iata} · {field.category || "Unavailable"}</h3>
    <p className="mt-3 text-sm leading-relaxed">{field.decoded?.summary || "Current observation unavailable."}</p>
    <p className="mt-3 text-sm leading-relaxed">Forecast: {field.taf || "Unavailable."}</p>
    <details className="mt-3 text-sm"><summary className="cursor-pointer py-2">Observation source · METAR</summary><p className="break-words font-mono text-muted">{field.rawMetar || "Observation unavailable."}</p></details>
  </article>;
  return <div className="space-y-4">
    <div><h2 className="text-xl font-semibold">Weather through your flight</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">Timing is approximate and changes with the route and speed. Advisories describe possible conditions, not guaranteed encounters. Unflagged areas may have incomplete coverage.</p>
      <p className="mt-2 text-xs text-muted">Flight data fetched {new Date(story.fetchedAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}. Weather observation and advisory times are shown in their source details.</p>
    </div>
    {fieldCard(story.origin, "Takeoff · departure conditions")}
    <h3 className="text-lg font-semibold">{landed ? "Route weather" : airborne ? "Ahead on your route" : "Along your planned route"}</h3>
    {landed ? <p className="text-sm text-muted">Flight has landed. A historical weather timeline was not recorded.</p> : groups.length ? <ol className="space-y-3">
      {groups.map((g, i) => <li key={i} className="rounded-xl border border-border bg-surface p-4">
        <p className="flex items-center gap-2 text-sm text-muted"><Clock className="size-4 shrink-0" />{timeLabel(g)}</p>
        <p className="mt-2 font-semibold">{g.label}</p>
        {g.note && <p className="mt-2 text-sm text-muted">{g.note}</p>}
      </li>)}
    </ol> : <p className="text-sm text-muted">Route weather data unavailable.</p>}
    {fieldCard(story.dest, "Landing · arrival conditions")}
    <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer py-2">Advisory sources and valid times</summary>
      {story.hazards.filter(h => h.remaining).map(h => <div key={h.id} className="mt-3 text-sm"><p className="font-semibold">{h.label}</p><p className="text-muted">{h.validity || "Validity time unavailable"}</p><p className="mt-1 text-muted">{h.detail}</p></div>)}
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
    className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5 text-fg backdrop:bg-black/70">
    <div className="flex items-start justify-between gap-3">
      <h2 className="text-xl font-semibold" id="flight-welcome-title">Important information about your flight</h2>
      <button type="button" autoFocus aria-label="Close flight briefing" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-xl">×</button>
    </div>
    <p className="mt-2 text-sm text-muted">{story.iata || story.callsign} · {story.origin.iata} → {story.dest.iata}</p>
    <div className="mt-4 space-y-3 text-sm leading-relaxed">
      <p>{brief?.lead || "The briefing is being prepared. Current flight information is below."}</p>
      {(story.times.delayMin ?? 0) >= 5 && <p><strong>Departure delay:</strong> {story.times.delayMin} minutes.</p>}
      {(story.currentStage === "inbound" || story.currentStage === "push") && <p><strong>Inbound aircraft:</strong> {story.inbound.detail || story.inbound.headline}</p>}
      {story.hazards.some(h => h.remaining) && <p><strong>Route weather:</strong> {[...new Set(story.hazards.filter(h => h.remaining).map(h => h.label))].join(" · ")}</p>}
      {story.origin.nas?.delayed && <p><strong>Departure airport:</strong> {story.origin.nas.reason}</p>}
      {story.dest.nas?.delayed && <p><strong>Arrival airport:</strong> {story.dest.nas.reason}</p>}
    </div>
    <p className="mt-4 text-xs text-muted">Data as of {new Date(story.fetchedAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}. Estimates may change. Full details remain in Briefing and Weather.</p>
  </dialog>;
}
