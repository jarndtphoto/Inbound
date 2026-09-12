import { formatDuration, formatNm, haversineNm } from "@/lib/geo";
import { useFiled } from "@/lib/store";
import type { Chop, FlightStory, RouteSample } from "@/lib/types";
import { latToTileY, pickRadarTiles, tileXToLon, tileYToLat } from "@/lib/radar-tiles";
import { WORLD_COUNTRY_RINGS } from "@/lib/world-country-lines";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CloudRain } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const W = 800;
const H = 800;
const PAD = 40;

function chopClass(c: Chop, past: boolean) {
  if (past) return "stroke-muted/40";
  if (c === "severe" || c === "moderate") return "stroke-ifr";
  if (c === "light") return "stroke-mvfr";
  return "stroke-accent";
}

function mercX(lon: number) {
  return (lon + 180) / 360;
}
function mercY(lat: number) {
  return latToTileY(Math.max(-85, Math.min(85, lat)), 0);
}

function projectBox(minLon: number, maxLon: number, minLat: number, maxLat: number) {
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  let x0 = mercX(minLon);
  let x1 = mercX(maxLon);
  let y0 = mercY(maxLat);
  let y1 = mercY(minLat);
  if (x1 <= x0) x1 = x0 + 1e-6;
  if (y1 <= y0) y1 = y0 + 1e-6;
  const boxAspect = innerW / innerH;
  const geoAspect = (x1 - x0) / (y1 - y0);
  if (geoAspect > boxAspect) {
    const extra = ((x1 - x0) / boxAspect - (y1 - y0)) / 2;
    y0 -= extra;
    y1 += extra;
  } else {
    const extra = ((y1 - y0) * boxAspect - (x1 - x0)) / 2;
    x0 -= extra;
    x1 += extra;
  }
  const scale = innerW / (x1 - x0);
  return {
    minLon: tileXToLon(x0, 0),
    maxLon: tileXToLon(x1, 0),
    minLat: tileYToLat(y1, 0),
    maxLat: tileYToLat(y0, 0),
    sx: (lon: number) => PAD + (mercX(lon) - x0) * scale,
    sy: (lat: number) => PAD + (mercY(lat) - y0) * scale,
  };
}

type RadarMaps = {
  host: string;
  radar: { past?: { time: number; path: string }[] };
};

function RadarLayer({
  minLon,
  maxLon,
  minLat,
  maxLat,
  sx,
  sy,
}: {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  sx: (lon: number) => number;
  sy: (lat: number) => number;
}) {
  const q = useQuery({
    queryKey: ["radar-maps"],
    queryFn: async () => {
      const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
      if (!res.ok) throw new Error("radar unavailable");
      return (await res.json()) as RadarMaps;
    },
    staleTime: 5 * 60_000,
    enabled: true,
  });

  const frame = q.data?.radar.past?.at(-1);
  if (!frame || !q.data) return null;

  const picked = pickRadarTiles(minLon, maxLon, minLat, maxLat);
  const tiles = picked
    .map((t) => {
      const west = tileXToLon(t.x, t.z);
      const east = tileXToLon(t.x + 1, t.z);
      const north = tileYToLat(t.y, t.z);
      const south = tileYToLat(t.y + 1, t.z);
      const w = sx(east) - sx(west);
      const h = sy(south) - sy(north);
      if (w <= 1 || h <= 1) return null;
      return {
        key: `${t.z}-${t.x}-${t.y}`,
        href: `${q.data!.host}${frame.path}/256/${t.z}/${t.x}/${t.y}/2/1_1.png`,
        x: sx(west),
        y: sy(north),
        w,
        h,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t != null);

  return (
    <g opacity="0.55">
      {tiles.map((t) => (
        <image key={t.key} href={t.href} x={t.x} y={t.y} width={t.w} height={t.h} preserveAspectRatio="none" />
      ))}
    </g>
  );
}

function clampView(next: { s: number; x: number; y: number }) {
  const s = Math.min(5, Math.max(1, next.s));
  if (s <= 1.001) return { s: 1, x: 0, y: 0 };
  const minX = W - W * s;
  const minY = H - H * s;
  return {
    s,
    x: Math.min(0, Math.max(minX, next.x)),
    y: Math.min(0, Math.max(minY, next.y)),
  };
}

function useMapBoxZoom(resetKey: string) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pinchRef = useRef<{
    d: number;
    s: number;
    x: number;
    y: number;
    mx: number;
    my: number;
  } | null>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const reset = useCallback(() => setView({ s: 1, x: 0, y: 0 }), []);

  const toSvg = (el: HTMLElement, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    return {
      mx: ((cx - r.left) / Math.max(1, r.width)) * W,
      my: ((cy - r.top) / Math.max(1, r.height)) * H,
    };
  };

  const zoomBy = useCallback((factor: number) => {
    const { s, x, y } = viewRef.current;
    const ns = Math.min(5, Math.max(1, s * factor));
    const cx = W / 2;
    const cy = H / 2;
    setView(
      clampView({
        s: ns,
        x: cx - ((cx - x) * ns) / s,
        y: cy - ((cy - y) * ns) / s,
      }),
    );
  }, []);

  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
  }, [resetKey]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    const apply = (next: { s: number; x: number; y: number }) => setView(clampView(next));

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { s, x, y } = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0018);
      const ns = Math.min(5, Math.max(1, s * factor));
      const { mx, my } = toSvg(el, e.clientX, e.clientY);
      apply({
        s: ns,
        x: mx - ((mx - x) * ns) / s,
        y: my - ((my - y) * ns) / s,
      });
    };

    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const mid = toSvg(el, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        pinchRef.current = {
          d: Math.max(1, dist(a, b)),
          s: viewRef.current.s,
          x: viewRef.current.x,
          y: viewRef.current.y,
          mx: mid.mx,
          my: mid.my,
        };
        dragRef.current = null;
      } else if (e.touches.length === 1 && viewRef.current.s > 1.02) {
        dragRef.current = null;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const p = pinchRef.current;
        if (!p) return;
        const factor = dist(a, b) / p.d;
        const ns = Math.min(5, Math.max(1, p.s * factor));
        const mid = toSvg(el, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        apply({
          s: ns,
          x: mid.mx - ((p.mx - p.x) * ns) / p.s,
          y: mid.my - ((p.my - p.y) * ns) / p.s,
        });
      } else if (e.touches.length === 1 && dragRef.current && viewRef.current.s > 1.02) {
        return;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null;
      if (e.touches.length === 0) dragRef.current = null;
    };

    const blockPageZoom = (e: Event) => e.preventDefault();
    const blockPageGesture = (e: Event) => {
      const t = e.target as Node | null;
      if (t && el.contains(t)) return;
      e.preventDefault();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("gesturestart", blockPageZoom);
    el.addEventListener("gesturechange", blockPageZoom);
    el.addEventListener("gestureend", blockPageZoom);
    document.addEventListener("gesturestart", blockPageGesture, { passive: false });
    document.addEventListener("gesturechange", blockPageGesture, { passive: false });
    document.addEventListener("gestureend", blockPageGesture, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("gesturestart", blockPageZoom);
      el.removeEventListener("gesturechange", blockPageZoom);
      el.removeEventListener("gestureend", blockPageZoom);
      document.removeEventListener("gesturestart", blockPageGesture);
      document.removeEventListener("gesturechange", blockPageGesture);
      document.removeEventListener("gestureend", blockPageGesture);
    };
  }, []);

  return { boxRef, s: view.s, x: view.x, y: view.y, reset, zoomBy };
}

function pathRuns(samples: RouteSample[], progress: number) {
  type Run = { chop: Chop; past: boolean; pts: { x: number; y: number }[] };
  return {
    build: (sx: (lon: number) => number, sy: (lat: number) => number) => {
      const out: Run[] = [];
      let cur: Run | null = null;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!;
        const pt = { x: sx(s.lon), y: sy(s.lat) };
        const past = s.frac < progress;
        const chop = s.chop;
        if (!cur) {
          cur = { chop, past, pts: [pt] };
          continue;
        }
        const dx = pt.x - cur.pts[cur.pts.length - 1]!.x;
        const dy = pt.y - cur.pts[cur.pts.length - 1]!.y;
        const jump = Math.hypot(dx, dy);
        if (cur.chop === chop && cur.past === past && jump < 90) {
          cur.pts.push(pt);
        } else {
          if (cur.pts.length >= 2) out.push(cur);
          cur = { chop, past, pts: jump < 90 ? [cur.pts[cur.pts.length - 1]!, pt] : [pt] };
        }
      }
      if (cur && cur.pts.length >= 2) out.push(cur);
      return out;
    },
  };
}

function ringHits(
  ring: [number, number][],
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
) {
  let a = 180;
  let b = -180;
  let c = 90;
  let d = -90;
  for (const [lo, la] of ring) {
    if (lo < a) a = lo;
    if (lo > b) b = lo;
    if (la < c) c = la;
    if (la > d) d = la;
  }
  return b >= minLon && a <= maxLon && d >= minLat && c <= maxLat;
}

function ringFillable(ring: [number, number][]) {
  if (ring.length < 4) return false;
  let span = 0;
  for (let i = 1; i < ring.length; i++) {
    const step = Math.abs(ring[i][0] - ring[i - 1][0]);
    if (step > 170) return false;
    if (step > span) span = step;
  }
  let minL = 180;
  let maxL = -180;
  for (const [lo] of ring) {
    if (lo < minL) minL = lo;
    if (lo > maxL) maxL = lo;
  }
  return maxL - minL < 180;
}

export function RouteMap({ story }: { story: FlightStory }) {
  const weatherOn = useFiled((s) => s.weatherOn);
  const setWeatherOn = useFiled((s) => s.setWeatherOn);
  const zoom = useMapBoxZoom(`${story.callsign}:${story.origin.iata}:${story.dest.iata}`);
  const samples = story.route?.samples ?? [];
  if (samples.length < 2) return null;

  const lats = samples.map((s) => s.lat).filter((n) => Number.isFinite(n));
  const lons = samples.map((s) => s.lon).filter((n) => Number.isFinite(n));
  if (Number.isFinite(story.origin.lat)) lats.push(story.origin.lat);
  if (Number.isFinite(story.dest.lat)) lats.push(story.dest.lat);
  if (Number.isFinite(story.origin.lon)) lons.push(story.origin.lon);
  if (Number.isFinite(story.dest.lon)) lons.push(story.dest.lon);
  if (story.aircraft && Number.isFinite(story.aircraft.lat)) lats.push(story.aircraft.lat);
  if (story.aircraft && Number.isFinite(story.aircraft.lon)) lons.push(story.aircraft.lon);
  if (lats.length < 2 || lons.length < 2) return null;
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLon = Math.min(...lons);
  let maxLon = Math.max(...lons);
  const latPad = Math.max((maxLat - minLat) * 0.22, 2.2);
  const lonPad = Math.max((maxLon - minLon) * 0.18, 3);
  minLat -= latPad;
  maxLat += latPad;
  minLon -= lonPad;
  maxLon += lonPad;
  const proj = projectBox(minLon, maxLon, minLat, maxLat);
  minLat = proj.minLat;
  maxLat = proj.maxLat;
  minLon = proj.minLon;
  maxLon = proj.maxLon;
  const sx = proj.sx;
  const sy = proj.sy;

  const origin = { lat: story.origin.lat, lon: story.origin.lon };
  const dest = { lat: story.dest.lat, lon: story.dest.lon };
  const ac = story.aircraft;
  const onField = Boolean(ac?.onGround && haversineNm(ac, dest) < 8);
  const landed = story.currentStage === "gate" || onField;
  const progress = landed ? 1 : story.route.progress;
  const ax = landed
    ? sx(dest.lon)
    : ac
      ? sx(ac.lon)
      : sx(samples[Math.round(progress * (samples.length - 1))]!.lon);
  const ay = landed
    ? sy(dest.lat)
    : ac
      ? sy(ac.lat)
      : sy(samples[Math.round(progress * (samples.length - 1))]!.lat);
  const rot = landed ? 0 : story.route.heading;
  const future = samples.filter((s) => s.frac > progress + 0.08);
  const firstBump = future.find((s) => s.chop !== "smooth");
  const mid = future[Math.max(0, Math.floor(future.length * 0.45))];
  const ticks = [firstBump, mid].filter((s, i, arr): s is NonNullable<typeof s> => {
    if (!s) return false;
    if (s.frac > 0.88) return false;
    if (Math.abs(s.lon - dest.lon) + Math.abs(s.lat - dest.lat) < 2.8) return false;
    return arr.findIndex((x) => x && Math.abs(x.frac - s.frac) < 0.04) === i;
  });
  const fixes = samples.filter((s) => s.fix);
  const runs = pathRuns(samples, progress).build(sx, sy);
  const countries = WORLD_COUNTRY_RINGS.filter((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat));
  const admin1 = ADMIN1_RINGS.filter((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat));

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div
        ref={zoom.boxRef}
        data-map-box
        className="relative overflow-hidden select-none"
        style={{ touchAction: "pan-y" }}
      >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="block aspect-square h-auto w-full"
        role="img"
        aria-label={`Route ${story.origin.iata} to ${story.dest.iata}`}
      >
        <rect width={W} height={H} className="fill-bg" />
        <g transform={`translate(${zoom.x} ${zoom.y}) scale(${zoom.s})`} strokeLinejoin="round" strokeLinecap="round">
        {weatherOn && (
          <RadarLayer minLon={minLon} maxLon={maxLon} minLat={minLat} maxLat={maxLat} sx={sx} sy={sy} />
        )}

        <g>
          {countries.map((ring, i) => {
            if (!ringFillable(ring)) return null;
            const points = ring.map(([lo, la]) => `${sx(lo).toFixed(1)},${sy(la).toFixed(1)}`).join(" ");
            return <polygon key={`fill-${i}`} points={points} className="fill-fg/10 stroke-none" />;
          })}
          {admin1.map((ring, i) => {
            const points = ring.map(([lo, la]) => `${sx(lo).toFixed(1)},${sy(la).toFixed(1)}`).join(" ");
            return (
              <polyline
                key={`adm-${i}`}
                points={points}
                className="fill-none stroke-fg/20"
                strokeWidth="0.9"
              />
            );
          })}
          {countries.map((ring, i) => {
            const points = ring.map(([lo, la]) => `${sx(lo).toFixed(1)},${sy(la).toFixed(1)}`).join(" ");
            return ringFillable(ring) ? (
              <polygon
                key={`c-${i}`}
                points={points}
                className="fill-none stroke-fg/35"
                strokeWidth="1.25"
              />
            ) : (
              <polyline
                key={`c-${i}`}
                points={points}
                className="fill-none stroke-fg/35"
                strokeWidth="1.25"
              />
            );
          })}
        </g>

        {runs.map((run, i) => {
          const d = run.pts.map((p, j) => `${j === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
          const w = run.past ? 3.2 : run.chop === "smooth" ? 5.2 : 6.4;
          return (
            <g key={`run-${i}`}>
              <path d={d} className="fill-none stroke-bg" strokeWidth={w + 3.4} />
              <path d={d} className={cn("fill-none", chopClass(run.chop, run.past))} strokeWidth={w} />
            </g>
          );
        })}

        {fixes.map((s) => (
          <rect
            key={`fix-${s.frac}`}
            x={sx(s.lon) - 2.6}
            y={sy(s.lat) - 2.6}
            width="5.2"
            height="5.2"
            transform={`rotate(45 ${sx(s.lon)} ${sy(s.lat)})`}
            className="fill-fg/55"
          />
        ))}

        <circle cx={sx(origin.lon)} cy={sy(origin.lat)} r="5.5" className="fill-accent stroke-bg" strokeWidth="2" />
        <circle cx={sx(dest.lon)} cy={sy(dest.lat)} r="5.5" className="fill-fg stroke-bg" strokeWidth="2" />

        {story.hazards
          .filter((h) => h.lat != null && h.lon != null && (h.kind === "convective" || h.kind === "pirep"))
          .slice(0, 6)
          .map((h) => {
            const storm = h.kind === "convective";
            const cx = sx(h.lon!);
            const cy = sy(h.lat!);
            return (
              <g key={h.id}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={storm ? 10 : 5}
                  className={storm ? "fill-ifr/25 stroke-ifr/70" : "fill-mvfr/40"}
                  strokeWidth="1"
                />
                <text
                  x={cx + (storm ? 13 : 9)}
                  y={cy + 3.5}
                  className={storm ? "fill-ifr" : "fill-muted"}
                  fontSize="11"
                  fontFamily="IBM Plex Sans, system-ui, sans-serif"
                >
                  {storm ? "Storms" : "Bumps reported"}
                </text>
              </g>
            );
          })}

        {ticks.map((s) => (
          <g key={`t-${s.frac}`}>
            <circle cx={sx(s.lon)} cy={sy(s.lat)} r="2.6" className="fill-fg/80" />
            <text
              x={sx(s.lon) + 8}
              y={sy(s.lat) + (s.chop === "smooth" ? 16 : -10)}
              className="fill-muted"
              fontSize="11"
              fontFamily="IBM Plex Mono, ui-monospace, monospace"
            >
              {s.chop === "smooth"
                ? formatDuration(s.etaMin)
                : `${formatDuration(s.etaMin)} ${s.chop === "light" ? "light bumps" : "bumpier"}`}
            </text>
          </g>
        ))}

        <g transform={`translate(${ax} ${ay}) rotate(${rot})`}>
          <polygon points="0,-10 8,11 -8,11" className="fill-fg stroke-bg" strokeWidth="1.4" />
        </g>

        <text
          x={sx(origin.lon)}
          y={sy(origin.lat) + 22}
          textAnchor="middle"
          className="fill-muted"
          fontSize="13"
          fontFamily="Barlow Condensed, sans-serif"
          letterSpacing="0.12em"
        >
          {story.origin.iata}
        </text>
        <text
          x={sx(dest.lon)}
          y={sy(dest.lat) + 22}
          textAnchor="middle"
          className="fill-fg"
          fontSize="13"
          fontFamily="Barlow Condensed, sans-serif"
          letterSpacing="0.12em"
        >
          {story.dest.iata}
        </text>
        </g>
      </svg>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <p className="rounded-sm border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted">
          {story.route.source === "track" ? "ACTUAL TRACK · FIXES" : "PLANNED PATH"}
        </p>
        <p className="rounded-sm border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted">
          {landed ? "Landed" : `${formatNm(story.route.remainingNm)} · ${formatDuration(story.route.etaMin)}`}
        </p>
      </div>
        {zoom.s > 1.02 ? (
          <button
            type="button"
            onClick={zoom.reset}
            className="absolute bottom-3 left-3 z-10 h-9 rounded-sm border border-border bg-bg/90 px-2.5 font-mono text-xs tracking-wide text-fg"
          >
            Reset map
          </button>
        ) : (
          <p className="pointer-events-none absolute bottom-3 left-3 font-mono text-xs tracking-wide text-subtle">
            Pinch to zoom
          </p>
        )}
        <div className="absolute right-3 bottom-3 z-10 flex gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoom.zoomBy(1.4)}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-border bg-bg/90 font-display text-xl text-fg"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoom.zoomBy(1 / 1.4)}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-border bg-bg/90 font-display text-xl text-fg"
          >
            −
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-3 py-2 text-xs text-muted">
        <Legend swatch="bg-accent" label="Smooth" />
        <Legend swatch="bg-mvfr" label="Light bumps" />
        <Legend swatch="bg-ifr" label="Bumpier" />
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border border-ifr/70 bg-ifr/40" />
          Storms nearby
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-mvfr" />
          Bumps reported nearby
        </span>
        <button
          type="button"
          onClick={() => setWeatherOn(!weatherOn)}
          className={cn(
            "ml-auto inline-flex h-9 items-center gap-1.5 rounded-sm border px-2.5 font-mono text-xs tracking-wide",
            weatherOn
              ? "border-accent bg-surface-2 text-fg"
              : "border-border bg-surface text-muted hover:text-fg",
          )}
        >
          <CloudRain className="size-3.5" />
          {weatherOn ? "Radar on" : "Live weather"}
        </button>
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-1.5 w-5 rounded-full", swatch)} />
      {label}
    </span>
  );
}
