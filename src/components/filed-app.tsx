import { briefRide } from "@/lib/brief";
import { composeBrief, type CompiledBrief, type RideFacts } from "@/lib/brief-copy";
import { agoLabel, delayPhrase } from "@/lib/format";
import { formatDuration, formatNm, feetPretty } from "@/lib/geo";
import { storyMatchesQuery } from "@/lib/flight-parse";
import { useFiled } from "@/lib/store";
import { getFlightStory } from "@/lib/story";
import type { Comfort, FlightStory, StageId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RouteMap } from "@/components/route-map";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock, Gauge, Plane, Radio, Search, ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, Component, type FormEvent, type ReactNode } from "react";

const STAGES: { id: StageId; label: string }[] = [
  { id: "inbound", label: "Inbound" },
  { id: "push", label: "Gate" },
  { id: "taxi", label: "Taxi" },
  { id: "ride", label: "Flight" },
  { id: "arrival", label: "Arrival" },
  { id: "gate", label: "Parked" },
];

const STORY_CACHE_KEY = "filed-story-cache-v6";
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
    const slim: FlightStory = {
      ...story,
      route: { ...story.route, samples: story.route.samples.slice(0, 80) },
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
  if (ahead.some((s) => s.chop === "severe")) return "Severe chop";
  if (ahead.some((s) => s.chop === "moderate")) return "Moderate chop";
  if (ahead.some((s) => s.chop === "light")) return "Light chop";
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
    live: story.live,
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
  };
}

function pinDocument() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function SplashScreen() {
  return (
    <div
      className="flex flex-col items-center justify-center overflow-hidden px-8"
      style={{
        position: "fixed",
        inset: 0,
        background: "#08090c",
        color: "#e7eaee",
        zIndex: 50,
      }}
    >
      <div className="max-w-[16rem] text-center">
        <svg viewBox="0 0 32 32" className="mx-auto size-8" aria-hidden>
          <path d="M4 16h12" fill="none" stroke="currentColor" className="text-accent" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M14 9.5 26 16 14 22.5" fill="none" stroke="currentColor" className="text-fg" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1 className="font-display mt-4 text-4xl font-semibold tracking-tight">Inbound</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Your all-in-one flight information app.
        </p>
      </div>
    </div>
  );
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
          className="flex flex-1 items-center justify-center px-6 py-16"
          style={{ background: "#08090c", color: "#e7eaee", minHeight: "100%" }}
        >
          <p className="max-w-sm text-center text-sm text-muted">Could not load this screen. Try another flight.</p>
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
  const [draft, setDraft] = useState("");
  const [briefing, setBriefing] = useState<CompiledBrief | null>(null);
  const [briefingFor, setBriefingFor] = useState("");
  const [cacheOk, setCacheOk] = useState(false);
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return sessionStorage.getItem("inbound-booted") !== "1";
    } catch {
      return true;
    }
  });
  const splashAt = useRef(Date.now());
  const briefGen = useRef(0);
  const lastBriefKey = useRef("");
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
    setQuery(next);
  }

  useEffect(() => {
    hydrate();
    setCacheOk(true);
  }, [hydrate]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setShowSplash(false);
      try {
        sessionStorage.setItem("inbound-booted", "1");
      } catch {
        /* private mode */
      }
    }, 1400);
    return () => window.clearTimeout(t);
  }, []);

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
      try {
        const s = await getFlightStory({ data: { q: query } });
        if (!storyMatchesQuery(s, query)) {
          const cached = readCachedStory(query);
          if (cached && storyMatchesQuery(cached, query)) return rememberOrigOnClient(cached);
          throw new Error("Could not load that flight. Try another number.");
        }
        const merged = rememberOrigOnClient(s);
        writeCachedStory(query, merged);
        return merged;
      } catch (err) {
        const cached = readCachedStory(query);
        if (cached && storyMatchesQuery(cached, query)) return rememberOrigOnClient(cached);
        throw err;
      }
    },
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
    staleTime: 1_500,
    gcTime: 10 * 60_000,
    retry: 2,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (previousData) => {
      if (storyForQuery(previousData, query)) return previousData;
      if (!cacheOk) return undefined;
      return storyForQuery(readCachedStory(query), query);
    },
  });

  const story = storyForQuery(storyQ.data, query);
  const bootReady = cacheOk && (query.length === 0 || Boolean(story) || storyQ.isError || storyQ.isFetched);
  useEffect(() => {
    if (!bootReady || !showSplash) return;
    const wait = Math.max(400, 1400 - (Date.now() - splashAt.current));
    const t = window.setTimeout(() => setShowSplash(false), wait);
    return () => window.clearTimeout(t);
  }, [bootReady, showSplash]);
  const rawStage = String(stagePref === "auto" ? (story?.currentStage ?? "inbound") : stagePref);
  const active: StageId = rawStage === "ground"
    ? "push"
    : STAGES.some((s) => s.id === rawStage)
      ? (rawStage as StageId)
      : "inbound";
  const shownBrief = briefing && briefingFor === flightKey ? briefing : null;

  const briefM = useMutation({
    mutationFn: async () => {
      if (!story) return { ok: true as const, text: "Load a flight first.", gen: briefGen.current, flight: flightKey };
      const gen = briefGen.current;
      const flight = flightKey;
      const facts = rideFacts(story, query, active);
      const local = composeBrief(facts);
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
      setBriefing(composeBrief(rideFacts(story, query, active), briefing));
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
        setBriefing({
          ...data.local,
          lead,
          why,
          snap: data.local.snap,
        });
      }
    },
  });

  useEffect(() => {
    briefGen.current += 1;
    setBriefing(null);
    setBriefingFor("");
    lastBriefKey.current = "";
    briefM.reset();
    setStage("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the flight changes
  }, [flightKey]);

  useEffect(() => {
    if (!story || !briefing || briefingFor !== flightKey) return;
    const key = `${story.currentStage}|${story.times?.delayMin ?? ""}|${story.times?.taxiInKind ?? ""}|${story.dest.nas?.reason ?? ""}|${story.inbound.status}|${story.times?.land ?? ""}`;
    if (key === lastBriefKey.current) return;
    lastBriefKey.current = key;
    const next = composeBrief(rideFacts(story, query, active), briefing);
    if (next.why) setBriefing(next);
  }, [story, briefing, briefingFor, flightKey, query, active]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    pinDocument();
    mainRef.current?.scrollTo(0, 0);
    if (draft.trim()) openFlight(draft);
  }

  if (showSplash) {
    return <SplashScreen />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg text-fg" style={shellStyle}>
      <ScreenErrorBoundary>
      <main
        ref={mainRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 pt-2 lg:px-8 lg:pt-6"
      >
        <div className="mx-auto min-w-0 max-w-6xl overflow-x-hidden pb-6">
        {storyQ.isError && !story && cacheOk && (
          <div className="mb-4 rounded-md border border-ifr/40 bg-surface px-4 py-3">
            <p className="text-sm text-ifr">
              {(storyQ.error as Error).message || "Could not load that flight. Try another number."}
            </p>
            <Button type="button" variant="secondary" className="mt-3" onClick={() => void storyQ.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {(!cacheOk || (!story && !storyQ.isError)) && <Skeleton query={cacheOk ? query : "the flight"} />}

        {cacheOk && story && (
          <div key={normFlight(query)} className="grid min-w-0 gap-5 lg:grid-cols-12">
            <section className="min-w-0 lg:col-span-7">
              <FlightHead story={story} fetching={storyQ.isFetching} />
              <div className="mt-4">
                <RouteMap story={story} />
              </div>
            </section>

            <section className="min-w-0 overflow-x-hidden lg:col-span-5">
              <RecordCard story={story} />
              <StagePager story={story} active={active} onChange={(id) => setStage(id)} />
              <BreakdownCard
                briefing={shownBrief}
                pending={briefM.isPending}
                onCompile={() => briefM.mutate()}
              />
            </section>
          </div>
        )}
        </div>
      </main>
      <footer className="shrink-0 border-t border-border bg-bg px-4 pt-2 pb-2 lg:px-8">
        {cacheOk && recents.length > 0 && (
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

function FlightHead({ story, fetching }: { story: FlightStory; fetching: boolean }) {
  const ac = story.aircraft;
  const airborne =
    story.currentStage === "ride" ||
    story.currentStage === "arrival" ||
    Boolean(story.times?.airborne && story.currentStage !== "push" && story.currentStage !== "taxi" && story.currentStage !== "inbound");
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-widest text-muted uppercase">
            {story.live ? "Live" : "Not broadcasting"} · {story.airline ?? "Airline"}
          </p>
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
            {STAGES.find((s) => s.id === story.currentStage)?.label ?? story.currentStage}
          </p>
        </div>
      </div>
      <TimesStrip story={story} fetching={fetching} />
      <dl className={cn("mt-4 grid gap-3", airborne ? "grid-cols-2" : "grid-cols-3")}>
        <Stat
          icon={Plane}
          label="Aircraft"
          value={ac ? `${ac.typeName ?? ac.type ?? "—"}` : "Unknown"}
          sub={ac?.registration ?? "No ADS-B yet"}
        />
        <Stat
          icon={Gauge}
          label="Altitude"
          value={ac?.altFt ? feetPretty(ac.altFt) : "—"}
          sub={ac?.gsKt ? `${Math.round(ac.gsKt)} kt` : "—"}
        />
        {!airborne ? (
          <Stat
            icon={Radio}
            label="Remaining"
            value={formatNm(story.route.remainingNm)}
            sub={formatDuration(story.route.etaMin)}
          />
        ) : null}
      </dl>
    </div>
  );
}

function TimesStrip({ story, fetching }: { story: FlightStory; fetching: boolean }) {
  const t = story.times;
  const airborne =
    story.currentStage === "ride" ||
    story.currentStage === "arrival" ||
    Boolean(t?.airborne && story.currentStage !== "push" && story.currentStage !== "taxi" && story.currentStage !== "inbound");
  if (story.currentStage === "gate" && t?.airborne) {
    return (
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
        <div>
          <p className="flex items-center gap-1.5 font-mono text-xs tracking-widest text-subtle uppercase">
            <Clock className="size-3" />
            Landed
          </p>
          <p className="mt-1 font-display text-2xl font-semibold leading-none">{t?.land ?? "—"}</p>
          <p className="mt-1 text-xs text-muted">
            {t?.destGate ? `Gate ${t.destGate}` : story.dest.iata}
            {t?.taxiInMin != null ? ` · Taxi in ${t.taxiInKind === "measured" ? `${t.taxiInMin} min` : `est. ${t.taxiInMin} min`}` : ""}
          </p>
        </div>
        <Freshness at={story.fetchedAt} fetching={fetching} />
      </div>
    );
  }
  if (airborne) {
    const remaining = formatDuration(story.route.etaMin);
    const dist = formatNm(story.route.remainingNm);
    return (
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
        <div>
          <p className="flex items-center gap-1.5 font-mono text-xs tracking-widest text-subtle uppercase">
            <Clock className="size-3" />
            Remaining
          </p>
          <p className="mt-1 font-display text-2xl font-semibold leading-none">{remaining}</p>
          <p className="mt-1 text-xs text-muted">
            {dist}
            {t?.land ? ` · Land ${t.land}` : ""}
          </p>
        </div>
        <Freshness at={story.fetchedAt} fetching={fetching} />
      </div>
    );
  }
  const delay = t?.delayMin ?? null;
  const late = (delay ?? 0) >= 5;
  const phrase = delayPhrase(delay);
  const tone = late ? ((delay ?? 0) >= 40 ? "text-ifr" : "text-mvfr") : "text-fg";
  return (
    <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
      <div>
        <p className="flex items-center gap-1.5 font-mono text-xs tracking-widest text-subtle uppercase">
          <Clock className="size-3" />
          {t?.pushed ? "Pushed" : "Posted push"}
        </p>
        <p className={cn("mt-1 font-display text-2xl font-semibold leading-none", tone)}>
          {t?.push ?? "—"}
          {phrase ? (
            <span className="ml-2 text-lg">{phrase}</span>
          ) : t?.push ? (
            <span className="ml-2 text-lg text-muted">On time</span>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-muted">
          {late && t?.pushWas ? `Was ${t.pushWas}` : t?.originGate ? `Gate ${t.originGate}` : "Airline posted time"}
          {t?.takeoff
            ? ` · ${t.airborne || story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "gate" ? "Wheels up" : "Est. wheels up"} ${t.takeoff}`
            : ""}
        </p>
      </div>
      <Freshness at={story.fetchedAt} fetching={fetching} />
    </div>
  );
}

function Freshness({ at, fetching }: { at: number; fetching: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 4000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <p className="font-mono text-xs tracking-widest text-muted uppercase">
      {agoLabel(at, fetching)}
    </p>
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
  sub: string;
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
    if (ahead.some((s) => s.chop === "severe")) ride = "Severe chop";
    else if (ahead.some((s) => s.chop === "moderate")) ride = "Moderate chop";
    else if (ahead.some((s) => s.chop === "light")) ride = "Light chop";
    if (ahead.some((s) => s.convective)) ride = `${ride} · storms`;
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
  if (!rows.length) rows.push({ label: "Notes", value: "No delay or chop flagged." });
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
          <p className="text-sm leading-relaxed text-fg whitespace-pre-wrap">{briefing.lead}</p>
          {briefing.why ? <p className="text-sm leading-relaxed text-muted">{briefing.why}</p> : null}
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
        <dl className="mt-4 grid grid-cols-2 gap-2">
          <TimeChip
            label="Push"
            value={times.push ?? "—"}
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
        <dl className="mt-4 grid grid-cols-2 gap-2">
          <TimeChip
            label="Taxi out"
            value={
              times.taxiOutMin == null
                ? "—"
                : times.taxiOutKind === "measured" &&
                    (story.currentStage === "ride" ||
                      story.currentStage === "arrival" ||
                      story.currentStage === "gate")
                  ? `${times.taxiOutMin} min`
                  : `Est. ${times.taxiOutMin} min`
            }
          />
          <TimeChip
            label="Wheels up"
            value={
              times.takeoff == null
                ? "—"
                : times.airborne ||
                    story.currentStage === "ride" ||
                    story.currentStage === "arrival" ||
                    story.currentStage === "gate"
                  ? times.takeoff
                  : `Est. ${times.takeoff}`
            }
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
    <div className="rounded-md border border-border bg-bg px-3 py-2">
      <p className="font-mono text-xs tracking-widest text-subtle uppercase">{label}</p>
      <p className={cn("mt-1 font-display text-lg font-semibold leading-tight", late ? "text-mvfr" : "text-fg")}>
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
  return (
    <div>
      <p className="mb-3 font-mono text-xs tracking-widest text-muted uppercase">
        Pulling {query} off the live feed
      </p>
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="h-80 animate-pulse rounded-xl border border-border bg-surface lg:col-span-7" />
        <div className="h-80 animate-pulse rounded-xl border border-border bg-surface lg:col-span-5" />
      </div>
    </div>
  );
}
