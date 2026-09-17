import { RouteMap } from "./route-map";
import { getAirportSurface } from "@/lib/airport-surface";
import type { AirportSurface, SurfaceFeature } from "@/lib/airport-surface.server";
import { haversineNm } from "@/lib/geo";
import type { FlightStory } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

const W = 800;
const H = 800;

type TrackPoint = { lat: number; lon: number; at: number };
type View = { scale: number; x: number; y: number };
type MapTab = "departure" | "flight" | "arrival";
type AircraftSnapshot = NonNullable<FlightStory["aircraft"]>;

type GroundMode = {
  kind: "departure" | "arrival";
  airport: FlightStory["origin"];
};

function clampView(v: View): View {
  const scale = Math.max(1, Math.min(8, v.scale));
  if (scale <= 1.001) return { scale: 1, x: 0, y: 0 };
  return {
    scale,
    x: Math.min(0, Math.max(W - W * scale, v.x)),
    y: Math.min(0, Math.max(H - H * scale, v.y)),
  };
}

function useGroundZoom(resetKey: string) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pinchRef = useRef<{ distance: number; view: View; mx: number; my: number } | null>(null);
  const dragRef = useRef<{ cx: number; cy: number; x: number; y: number } | null>(null);

  useEffect(() => setView({ scale: 1, x: 0, y: 0 }), [resetKey]);

  const toSvg = (el: HTMLElement, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    return { x: ((cx - r.left) / Math.max(1, r.width)) * W, y: ((cy - r.top) / Math.max(1, r.height)) * H };
  };

  const zoomAt = (factor: number, mx = W / 2, my = H / 2) => {
    const current = viewRef.current;
    const nextScale = Math.max(1, Math.min(8, current.scale * factor));
    setView(clampView({
      scale: nextScale,
      x: mx - ((mx - current.x) * nextScale) / current.scale,
      y: my - ((my - current.y) * nextScale) / current.scale,
    }));
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const mid = toSvg(el, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        pinchRef.current = { distance: Math.max(1, distance(a, b)), view: viewRef.current, mx: mid.x, my: mid.y };
        dragRef.current = null;
      } else if (e.touches.length === 1 && viewRef.current.scale > 1.01) {
        const t = e.touches[0]!;
        dragRef.current = { cx: t.clientX, cy: t.clientY, x: viewRef.current.x, y: viewRef.current.y };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2 && pinchRef.current) {
        e.preventDefault();
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const p = pinchRef.current;
        const factor = distance(a, b) / p.distance;
        const nextScale = Math.max(1, Math.min(8, p.view.scale * factor));
        const mid = toSvg(el, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        setView(clampView({
          scale: nextScale,
          x: mid.x - ((p.mx - p.view.x) * nextScale) / p.view.scale,
          y: mid.y - ((p.my - p.view.y) * nextScale) / p.view.scale,
        }));
      } else if (e.touches.length === 1 && dragRef.current && viewRef.current.scale > 1.01) {
        e.preventDefault();
        const t = e.touches[0]!;
        const r = el.getBoundingClientRect();
        setView(clampView({
          scale: viewRef.current.scale,
          x: dragRef.current.x + ((t.clientX - dragRef.current.cx) / Math.max(1, r.width)) * W,
          y: dragRef.current.y + ((t.clientY - dragRef.current.cy) / Math.max(1, r.height)) * H,
        }));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null;
      if (e.touches.length === 0) dragRef.current = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  return {
    boxRef,
    view,
    zoomIn: () => zoomAt(1.6),
    zoomOut: () => zoomAt(1 / 1.6),
    reset: () => setView({ scale: 1, x: 0, y: 0 }),
  };
}

function useMovementTrail(story: FlightStory) {
  const [trail, setTrail] = useState<TrackPoint[]>([]);
  const flightKey = `${story.iata}:${story.origin.iata}:${story.dest.iata}`;
  useEffect(() => setTrail([]), [flightKey]);
  useEffect(() => {
    const ac = story.aircraft;
    if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return;
    setTrail((previous) => {
      const last = previous.at(-1);
      if (last && haversineNm(last, ac) < 0.008 && story.fetchedAt - last.at < 20_000) return previous;
      return [...previous, { lat: ac.lat, lon: ac.lon, at: story.fetchedAt }].slice(-120);
    });
  }, [flightKey, story.fetchedAt, story.aircraft?.lat, story.aircraft?.lon]);
  return trail;
}

function SurfaceShape({ feature, project }: { feature: SurfaceFeature; project: (p: { lat: number; lon: number }) => { x: number; y: number } }) {
  if (feature.points.length < 2) return null;
  const points = feature.points.map((p) => {
    const q = project(p);
    return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  }).join(" ");
  if (feature.kind === "apron" || feature.kind === "terminal") {
    return <polygon points={points} className={feature.kind === "terminal" ? "fill-fg/14 stroke-fg/35" : "fill-fg/7 stroke-fg/20"} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
  }
  if (feature.kind === "runway") {
    return <polyline points={points} className="fill-none stroke-fg/65" strokeWidth="7" strokeLinecap="butt" vectorEffect="non-scaling-stroke" />;
  }
  if (feature.kind === "taxiway") {
    return <polyline points={points} className="fill-none stroke-accent/55" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
  }
  return null;
}

function GroundMovementMap({
  story,
  mode,
  trail,
  aircraft,
  frozen = false,
}: {
  story: FlightStory;
  mode: GroundMode;
  trail: TrackPoint[];
  aircraft: AircraftSnapshot | null;
  frozen?: boolean;
}) {
  const airport = mode.airport;
  const surfaceQ = useQuery({
    queryKey: ["airport-surface", airport.icao, airport.lat.toFixed(3), airport.lon.toFixed(3)],
    queryFn: () => getAirportSurface({ data: { airport: airport.icao, lat: airport.lat, lon: airport.lon } }),
    staleTime: 12 * 60 * 60_000,
    retry: 1,
  });
  const zoom = useGroundZoom(`${story.iata}:${airport.iata}:${mode.kind}`);
  const cos = Math.max(0.35, Math.cos(airport.lat * Math.PI / 180));
  const latHalf = 0.068;
  const lonHalf = latHalf / cos;
  const project = (p: { lat: number; lon: number }) => ({
    x: W / 2 + ((p.lon - airport.lon) / lonHalf) * (W / 2 - 28),
    y: H / 2 - ((p.lat - airport.lat) / latHalf) * (H / 2 - 28),
  });
  const features = (surfaceQ.data as AirportSurface | undefined)?.features ?? [];
  const taxiwayLabels = useMemo(() => {
    const unique = new Map<string, SurfaceFeature>();
    for (const feature of features) {
      if (feature.kind !== "taxiway" || feature.points.length < 2) continue;
      const label = (feature.ref || feature.name || "").trim();
      if (!label || unique.has(label)) continue;
      unique.set(label, feature);
    }
    return [...unique.entries()].slice(0, 120);
  }, [features]);
  const plane = aircraft ? project(aircraft) : null;
  const trailPoints = trail
    .filter((p) => haversineNm(p, airport) < 15)
    .map((p) => { const q = project(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; })
    .join(" ");
  const provider = typeof story.providers?.chosenPosition === "string" ? story.providers.chosenPosition : "live position";
  const age = typeof story.providers?.chosenPositionAgeSec === "number" ? Math.max(0, Math.round(story.providers.chosenPositionAgeSec)) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-subtle uppercase">{mode.kind === "departure" ? "Departure ground" : "Arrival ground"}</p>
          <p className="font-display text-base font-semibold">{airport.iata} · {frozen ? "last ground position" : aircraft ? "live movement" : "airport surface"}</p>
        </div>
        <div className="text-right font-mono text-[10px] leading-tight text-muted">
          {aircraft ? <div>{Math.round(aircraft.gsKt ?? 0)} kt · {frozen ? "frozen" : aircraft.onGround ? "ground" : `${Math.round(aircraft.altFt ?? 0)} ft`}</div> : <div>Awaiting aircraft</div>}
          <div>{frozen ? "last known ground fix" : `${provider}${age != null ? ` · ${age}s` : ""}`}</div>
        </div>
      </div>
      <div ref={zoom.boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-bg" style={{ touchAction: "none" }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full" role="img" aria-label={`${airport.iata} airport surface${aircraft ? " and aircraft position" : ""}`}>
          <rect width={W} height={H} className="fill-bg" />
          <g transform={`translate(${zoom.view.x} ${zoom.view.y}) scale(${zoom.view.scale})`}>
            <g opacity="0.12">
              {Array.from({ length: 9 }, (_, i) => <line key={`v-${i}`} x1={i * 100} y1="0" x2={i * 100} y2={H} className="stroke-fg/15" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
              {Array.from({ length: 9 }, (_, i) => <line key={`h-${i}`} x1="0" y1={i * 100} x2={W} y2={i * 100} className="stroke-fg/15" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
            </g>
            {features.filter((f) => f.kind === "apron").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
            {features.filter((f) => f.kind === "terminal").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
            {features.filter((f) => f.kind === "runway").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
            {features.filter((f) => f.kind === "taxiway").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
            {zoom.view.scale >= 2.2 ? taxiwayLabels.map(([label, feature]) => {
              const point = feature.points[Math.floor(feature.points.length / 2)]!;
              const q = project(point);
              return (
                <g key={`taxi-label-${label}`} transform={`translate(${q.x} ${q.y}) scale(${1 / zoom.view.scale})`}>
                  <rect x="-9" y="-9" width={Math.max(18, label.length * 7 + 10)} height="18" rx="5" className="fill-bg/90 stroke-border" strokeWidth="1" />
                  <text x="-4" y="4" className="fill-fg" fontSize="10" fontWeight="700">{label}</text>
                </g>
              );
            }) : null}
            {trailPoints ? <polyline points={trailPoints} className="fill-none stroke-accent" strokeWidth={4 / zoom.view.scale} strokeLinecap="round" strokeLinejoin="round" opacity="0.72" /> : null}
            {plane && aircraft ? (
              <>
                <circle cx={plane.x} cy={plane.y} r={16 / zoom.view.scale} className="fill-bg stroke-accent" strokeWidth={3 / zoom.view.scale} />
                <g transform={`translate(${plane.x} ${plane.y}) scale(${1 / zoom.view.scale}) rotate(${Number.isFinite(aircraft.track) ? aircraft.track : 0})`}>
                  <path d="M0 -13 L6 8 L0 5 L-6 8 Z" className="fill-accent" />
                </g>
                <g transform={`translate(${plane.x} ${plane.y}) scale(${1 / zoom.view.scale})`}>
                  <text x="21" y="-8" className="fill-fg" fontSize="13" fontWeight="700">{story.iata}</text>
                  <text x="21" y="10" className="fill-muted" fontSize="10">{frozen ? "last known" : `${Math.round(aircraft.gsKt ?? 0)} kt`}</text>
                </g>
              </>
            ) : null}
          </g>
        </svg>
        {!aircraft ? <div className="absolute top-3 left-3 rounded bg-bg/90 px-3 py-2 text-xs text-muted">No ground position captured yet.</div> : null}
        {frozen ? <div className="absolute top-3 left-3 rounded bg-bg/90 px-3 py-2 text-xs text-muted">Aircraft has departed · showing last known departure-ground position.</div> : null}
        <div className="absolute bottom-3 right-3 flex gap-2">
          <button type="button" onClick={zoom.zoomIn} className="flex size-11 items-center justify-center rounded-md border border-border bg-surface text-xl font-semibold">+</button>
          <button type="button" onClick={zoom.zoomOut} disabled={zoom.view.scale <= 1.01} className="flex size-11 items-center justify-center rounded-md border border-border bg-surface text-xl font-semibold disabled:opacity-40">−</button>
        </div>
        {zoom.view.scale > 1.01 ? <button type="button" onClick={zoom.reset} className="absolute bottom-3 left-3 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium">Reset</button> : null}
        {surfaceQ.isPending ? <div className="absolute top-14 left-3 rounded bg-bg/85 px-2 py-1 text-xs text-muted">Loading airport surface…</div> : null}
        {surfaceQ.isError ? <div className="absolute top-14 left-3 rounded bg-bg/85 px-2 py-1 text-xs text-muted">Surface detail unavailable.</div> : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[10px] leading-tight text-muted">
        <span>Pinch to zoom · drag to pan</span>
        <span className="shrink-0">Airport surface © OpenStreetMap contributors</span>
      </div>
    </div>
  );
}

function FlightRadar({ story }: { story: FlightStory }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-x border-t border-border bg-surface px-3 py-2">
        <div>
          <p className="font-mono text-[11px] tracking-widest text-subtle uppercase">Flight radar</p>
          <p className="font-display text-base font-semibold">{story.origin.iata} → {story.dest.iata}</p>
        </div>
        <p className="font-mono text-[10px] text-muted">{story.aircraft?.gsKt ? `${Math.round(story.aircraft.gsKt)} kt` : "Live route"}</p>
      </div>
      <div className="min-h-0 flex-1"><RouteMap story={story} fixedViewport /></div>
    </div>
  );
}

function initialTab(story: FlightStory): MapTab {
  if (story.currentStage === "taxi_in" || story.currentStage === "gate") return "arrival";
  if (story.currentStage === "origin_gate" || story.currentStage === "push" || story.currentStage === "taxi") return "departure";
  return "flight";
}

export function MovementMap({ story }: { story: FlightStory }) {
  const trail = useMovementTrail(story);
  const flightKey = `${story.iata}:${story.origin.iata}:${story.dest.iata}`;
  const [tab, setTab] = useState<MapTab>(() => initialTab(story));
  const [lastDeparture, setLastDeparture] = useState<AircraftSnapshot | null>(null);
  const [lastArrival, setLastArrival] = useState<AircraftSnapshot | null>(null);

  useEffect(() => {
    setTab(initialTab(story));
    setLastDeparture(null);
    setLastArrival(null);
  }, [flightKey]);

  useEffect(() => {
    const ac = story.aircraft;
    if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return;
    const age = typeof story.providers?.chosenPositionAgeSec === "number" ? story.providers.chosenPositionAgeSec : null;
    if (age != null && age > 120) return;

    const originNm = haversineNm(ac, story.origin);
    const destNm = haversineNm(ac, story.dest);
    const altFt = typeof ac.altFt === "number" && Number.isFinite(ac.altFt) ? ac.altFt : null;
    const gsKt = typeof ac.gsKt === "number" && Number.isFinite(ac.gsKt) ? ac.gsKt : null;

    const departureSurfaceLike = originNm <= 6 && (
      ac.onGround === true ||
      ((altFt == null || altFt <= 1200) && (gsKt == null || gsKt <= 165))
    );
    if (departureSurfaceLike) setLastDeparture({ ...ac });

    const arrivalSurfaceLike = destNm <= 6 && (
      ac.onGround === true ||
      story.currentStage === "taxi_in" ||
      story.currentStage === "gate"
    );
    if (arrivalSurfaceLike) setLastArrival({ ...ac });
  }, [
    flightKey,
    story.fetchedAt,
    story.currentStage,
    story.aircraft?.lat,
    story.aircraft?.lon,
    story.aircraft?.altFt,
    story.aircraft?.gsKt,
    story.aircraft?.onGround,
    story.providers?.chosenPositionAgeSec,
  ]);

  const current = story.aircraft && Number.isFinite(story.aircraft.lat) && Number.isFinite(story.aircraft.lon)
    ? story.aircraft
    : null;
  const currentOriginNm = current ? haversineNm(current, story.origin) : Infinity;
  const currentDestNm = current ? haversineNm(current, story.dest) : Infinity;
  const departureLive = Boolean(current && currentOriginNm <= 6 && (
    current.onGround === true ||
    ((current.altFt == null || current.altFt <= 1200) && (current.gsKt == null || current.gsKt <= 165))
  ));
  const arrivalLive = Boolean(current && currentDestNm <= 6 && (
    current.onGround === true || story.currentStage === "taxi_in" || story.currentStage === "gate"
  ));

  const departureAircraft = departureLive ? current : lastDeparture;
  const arrivalAircraft = arrivalLive ? current : lastArrival;
  const departureTrail = trail.filter((p) => haversineNm(p, story.origin) < 15);
  const arrivalTrail = trail.filter((p) => haversineNm(p, story.dest) < 15);

  const tabs: Array<{ id: MapTab; label: string }> = [
    { id: "departure", label: `${story.origin.iata} Ground` },
    { id: "flight", label: "Flight" },
    { id: "arrival", label: `${story.dest.iata} Ground` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface p-1" role="tablist" aria-label="Flight map views">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`min-h-10 rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors ${tab === item.id ? "bg-accent text-accent-fg" : "text-muted"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "departure" ? (
          <GroundMovementMap
            story={story}
            mode={{ kind: "departure", airport: story.origin }}
            trail={departureTrail}
            aircraft={departureAircraft}
            frozen={!departureLive && Boolean(lastDeparture)}
          />
        ) : tab === "arrival" ? (
          <GroundMovementMap
            story={story}
            mode={{ kind: "arrival", airport: story.dest }}
            trail={arrivalTrail}
            aircraft={arrivalAircraft}
            frozen={!arrivalLive && Boolean(lastArrival)}
          />
        ) : (
          <FlightRadar story={story} />
        )}
      </div>
    </div>
  );
}
