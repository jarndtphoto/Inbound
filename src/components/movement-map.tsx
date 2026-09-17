import { RouteMap } from "./route-map";
import { getAirportSurface } from "@/lib/airport-surface";
import type { AirportSurface, SurfaceFeature } from "@/lib/airport-surface.server";
import { haversineNm } from "@/lib/geo";
import type { FlightStory } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

const W = 800;
const H = 800;

type TrackPoint = { lat: number; lon: number; at: number };

type GroundMode = {
  kind: "departure" | "arrival";
  airport: FlightStory["origin"];
};

function groundMode(story: FlightStory): GroundMode | null {
  const ac = story.aircraft;
  if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return null;

  const originNm = haversineNm(ac, story.origin);
  const destNm = haversineNm(ac, story.dest);
  const nearestNm = Math.min(originNm, destNm);
  if (nearestNm > 14) return null;

  const altFt = typeof ac.altFt === "number" && Number.isFinite(ac.altFt) ? ac.altFt : null;
  const gsKt = typeof ac.gsKt === "number" && Number.isFinite(ac.gsKt) ? ac.gsKt : null;
  const positionAge = typeof story.providers?.chosenPositionAgeSec === "number"
    ? story.providers.chosenPositionAgeSec
    : null;
  const freshEnough = positionAge == null || positionAge <= 120;

  // Do not require story.live or provider onGround. Those flags can lag while
  // a fresh position already shows the aircraft taxiing on the airport.
  const surfaceLike = ac.onGround
    || (nearestNm <= 4 && (altFt == null || altFt <= 1200) && (gsKt == null || gsKt <= 110))
    || (nearestNm <= 2 && (altFt == null || altFt <= 2500));

  if (!freshEnough || !surfaceLike) return null;
  if (destNm + 1.5 < originNm) return { kind: "arrival", airport: story.dest };
  return { kind: "departure", airport: story.origin };
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
      return [...previous, { lat: ac.lat, lon: ac.lon, at: story.fetchedAt }].slice(-80);
    });
  }, [flightKey, story.fetchedAt, story.aircraft?.lat, story.aircraft?.lon]);
  return trail;
}

function SurfaceShape({ feature, project }: { feature: SurfaceFeature; project: (p: {lat:number;lon:number}) => {x:number;y:number} }) {
  const points = feature.points.map((p) => {
    const q = project(p);
    return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  }).join(" ");
  if (!points) return null;
  if (feature.kind === "apron" || feature.kind === "terminal") {
    return <polygon points={points} className={feature.kind === "terminal" ? "fill-fg/14 stroke-fg/35" : "fill-fg/7 stroke-fg/20"} strokeWidth="1" />;
  }
  if (feature.kind === "runway") {
    return <polyline points={points} className="fill-none stroke-fg/65" strokeWidth="13" strokeLinecap="butt" />;
  }
  if (feature.kind === "taxiway") {
    return <polyline points={points} className="fill-none stroke-accent/55" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />;
  }
  const q = project(feature.points[0]!);
  return <circle cx={q.x} cy={q.y} r={feature.kind === "gate" ? 2.6 : 2} className={feature.kind === "gate" ? "fill-accent" : "fill-muted"} />;
}

function GroundMovementMap({ story, mode, trail }: { story: FlightStory; mode: GroundMode; trail: TrackPoint[] }) {
  const airport = mode.airport;
  const surfaceQ = useQuery({
    queryKey: ["airport-surface", airport.icao, airport.lat.toFixed(3), airport.lon.toFixed(3)],
    queryFn: () => getAirportSurface({ data: { airport: airport.icao, lat: airport.lat, lon: airport.lon } }),
    staleTime: 12 * 60 * 60_000,
    retry: 1,
  });
  const ac = story.aircraft!;
  const cos = Math.max(0.35, Math.cos(airport.lat * Math.PI / 180));
  const latHalf = 0.068;
  const lonHalf = latHalf / cos;
  const project = (p: {lat:number;lon:number}) => ({
    x: W / 2 + ((p.lon - airport.lon) / lonHalf) * (W / 2 - 28),
    y: H / 2 - ((p.lat - airport.lat) / latHalf) * (H / 2 - 28),
  });
  const features = (surfaceQ.data as AirportSurface | undefined)?.features ?? [];
  const plane = project(ac);
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
          <p className="font-mono text-[11px] tracking-widest text-subtle uppercase">{mode.kind === "departure" ? "Departure ground radar" : "Arrival ground radar"}</p>
          <p className="font-display text-base font-semibold">{airport.iata} · live movement</p>
        </div>
        <div className="text-right font-mono text-[10px] leading-tight text-muted">
          <div>{Math.round(ac.gsKt ?? 0)} kt · {ac.onGround ? "ground" : `${Math.round(ac.altFt ?? 0)} ft`}</div>
          <div>{provider}{age != null ? ` · ${age}s` : ""}</div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full" role="img" aria-label={`${airport.iata} airport surface and live aircraft position`}>
          <rect width={W} height={H} className="fill-bg" />
          <g opacity="0.28">
            {Array.from({length: 9}, (_, i) => <line key={`v-${i}`} x1={i*100} y1="0" x2={i*100} y2={H} className="stroke-fg/15" strokeWidth="1" />)}
            {Array.from({length: 9}, (_, i) => <line key={`h-${i}`} x1="0" y1={i*100} x2={W} y2={i*100} className="stroke-fg/15" strokeWidth="1" />)}
          </g>
          {features.filter((f) => f.kind === "apron").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
          {features.filter((f) => f.kind === "terminal").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
          {features.filter((f) => f.kind === "runway").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
          {features.filter((f) => f.kind === "taxiway").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
          {features.filter((f) => f.kind === "gate" || f.kind === "holding_position").map((f) => <SurfaceShape key={`${f.kind}-${f.id}`} feature={f} project={project} />)}
          {trailPoints ? <polyline points={trailPoints} className="fill-none stroke-accent" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" /> : null}
          <circle cx={plane.x} cy={plane.y} r="16" className="fill-bg stroke-accent" strokeWidth="3" />
          <g transform={`translate(${plane.x} ${plane.y}) rotate(${Number.isFinite(ac.track) ? ac.track : 0})`}>
            <path d="M0 -13 L6 8 L0 5 L-6 8 Z" className="fill-accent" />
          </g>
          <text x={plane.x + 21} y={plane.y - 8} className="fill-fg" fontSize="13" fontWeight="700">{story.iata}</text>
          <text x={plane.x + 21} y={plane.y + 10} className="fill-muted" fontSize="10">{Math.round(ac.gsKt ?? 0)} kt</text>
          <circle cx={W/2} cy={H/2} r="4" className="fill-fg/50" />
        </svg>
        {surfaceQ.isPending ? <div className="absolute bottom-3 left-3 rounded bg-bg/85 px-2 py-1 text-xs text-muted">Loading airport surface…</div> : null}
        {surfaceQ.isError ? <div className="absolute bottom-3 left-3 rounded bg-bg/85 px-2 py-1 text-xs text-muted">Surface detail unavailable · live aircraft position still active</div> : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[10px] leading-tight text-muted">
        <span>Aircraft position follows Inbound's freshest live provider.</span>
        <span className="shrink-0">Airport surface © OpenStreetMap contributors</span>
      </div>
    </div>
  );
}

export function MovementMap({ story }: { story: FlightStory }) {
  const trail = useMovementTrail(story);
  const mode = useMemo(() => groundMode(story), [
    story.aircraft?.onGround,
    story.aircraft?.lat,
    story.aircraft?.lon,
    story.aircraft?.altFt,
    story.aircraft?.gsKt,
    story.origin.lat,
    story.origin.lon,
    story.dest.lat,
    story.dest.lon,
    story.providers?.chosenPositionAgeSec,
  ]);
  if (mode) return <GroundMovementMap story={story} mode={mode} trail={trail} />;
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
