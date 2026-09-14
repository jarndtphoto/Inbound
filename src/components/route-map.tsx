import { formatDuration, formatMiles, haversineNm } from "@/lib/geo";
import { upcomingStorms } from "@/lib/route-hazards";
import { routeWeatherEvents } from "@/lib/weather-events";
import { WeatherEventMarker } from "@/components/weather-event-marker";
import { useFiled } from "@/lib/store";
import type { Chop, FlightStory, RouteSample } from "@/lib/types";
import { ADMIN1_RINGS } from "@/lib/admin1-lines";
import { GREAT_LAKES } from "@/lib/great-lakes";
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
  if (c === "severe" || c === "moderate" || c === "light") return "stroke-ifr";
  return "stroke-accent";
}

function turbLabel(c: Chop) {
  if (c === "light") return "light turbulence";
  if (c === "moderate") return "moderate turbulence";
  if (c === "severe") return "severe turbulence";
  return "";
}

function mercX(lon: number) {
  return (lon + 180) / 360;
}
function mercY(lat: number) {
  return latToTileY(Math.max(-85, Math.min(85, lat)), 0);
}

function projectBox(minLon: number, maxLon: number, minLat: number, maxLat: number, H = 800) {
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

function useRadarMaps() {
  return useQuery({
    queryKey: ["radar-maps"],
    queryFn: async () => {
      const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error("radar unavailable");
      return (await res.json()) as RadarMaps;
    },
    staleTime: 2 * 60_000,
    refetchInterval: 2 * 60_000,
  });
}

function RadarStatus() {
  const q = useRadarMaps();
  const stamp = q.data?.radar.past?.at(-1)?.time;
  const validStamp = typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0;
  const time = validStamp ? new Date(stamp * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "UTC",
  }) : null;
  return (
    <p role="status" className="w-full text-xs leading-snug text-subtle">
      RainViewer precipitation · {time ? `Frame ${time} UTC` : q.isPending ? "Loading…" : "Frame unavailable"}.
      {q.isError ? " Update failed; any displayed frame is the last available." : ""}
      {validStamp && Date.now() / 1000 - stamp > 20 * 60 ? " Frame is over 20 minutes old." : ""}
      {" "}Coverage is mostly over land. Frame time applies to radar, not route forecasts.
    </p>
  );
}

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
  const q = useRadarMaps();

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
        href: `${q.data!.host}${frame.path}/512/${t.z}/${t.x}/${t.y}/2/0_1.png`,
        x: sx(west),
        y: sy(north),
        w,
        h,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t != null);

  return (
    <g opacity="0.7">
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

function useMapBoxZoom(resetKey: string, H = 800) {
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
  }, [H]);

  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
  }, [resetKey, H]);

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
  }, [H]);

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
        // Split only at the longitude seam; zoom can make valid adjacent
        // route samples hundreds of screen pixels apart.
        const crossesSeam = Math.abs(s.lon - samples[i - 1]!.lon) > 180;
        if (cur.chop === chop && cur.past === past && !crossesSeam) {
          cur.pts.push(pt);
        } else {
          // Weather begins at the first affected sample and ends at the last
          // affected sample. Share that exact boundary with the adjacent run.
          const enteringWeather = cur.chop === "smooth" && chop !== "smooth" && cur.past === past;
          if (!crossesSeam && enteringWeather) cur.pts.push(pt);
          if (cur.pts.length >= 2) out.push(cur);
          const boundary = enteringWeather ? pt : cur.pts[cur.pts.length - 1]!;
          cur = { chop, past, pts: !crossesSeam ? [boundary, pt] : [pt] };
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

export function RouteMap({ story, fixedViewport = false, weatherPreview }: { story: FlightStory; fixedViewport?: boolean; weatherPreview?: { eventNumber: number; label: string; startFrac: number; endFrac: number; startEtaMin: number; endEtaMin: number; ranges?: {from: number; to: number}[] } }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [mapHeight, setMapHeight] = useState(800);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !fixedViewport) return;
    const observer = new ResizeObserver(() => {
      if (frame.clientWidth && frame.clientHeight) setMapHeight(800 * frame.clientHeight / frame.clientWidth);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fixedViewport]);
  const H = fixedViewport ? mapHeight : 800;
  const weatherOn = useFiled((s) => s.weatherOn);
  const setWeatherOn = useFiled((s) => s.setWeatherOn);
  const zoom = useMapBoxZoom(`${story.callsign}:${story.origin.iata}:${story.dest.iata}`, H);
  const samples = story.route?.samples ?? [];
  if (samples.length < 2) return null;

  // Forecast previews frame the affected segment, rather than the entire trip.
  const focusSamples = weatherPreview
    ? samples.filter(s => s.frac >= weatherPreview.startFrac - 0.015 && s.frac <= weatherPreview.endFrac + 0.015)
    : samples;
  const boundsSamples = focusSamples.length ? focusSamples : samples;
  const lats = boundsSamples.map(s => s.lat).filter(Number.isFinite);
  const lons = boundsSamples.map(s => s.lon).filter(Number.isFinite);
  if (weatherPreview && lats.length === 1) { lats.push(lats[0]); lons.push(lons[0]); }
  if (!weatherPreview) {
    if (Number.isFinite(story.origin.lat)) lats.push(story.origin.lat);
    if (Number.isFinite(story.dest.lat)) lats.push(story.dest.lat);
    if (Number.isFinite(story.origin.lon)) lons.push(story.origin.lon);
    if (Number.isFinite(story.dest.lon)) lons.push(story.dest.lon);
    if (story.live && story.aircraft && Number.isFinite(story.aircraft.lat)) lats.push(story.aircraft.lat);
    if (story.live && story.aircraft && Number.isFinite(story.aircraft.lon)) lons.push(story.aircraft.lon);
  }
  if (lats.length < 2 || lons.length < 2) return null;
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLon = Math.min(...lons);
  let maxLon = Math.max(...lons);
  const latPad = Math.max((maxLat - minLat) * 0.22, weatherPreview ? 0.7 : 2.2);
  const lonPad = Math.max((maxLon - minLon) * 0.18, weatherPreview ? 1 : 3);
  minLat -= latPad;
  maxLat += latPad;
  minLon -= lonPad;
  maxLon += lonPad;
  const proj = projectBox(minLon, maxLon, minLat, maxLat, H);
  minLat = proj.minLat;
  maxLat = proj.maxLat;
  minLon = proj.minLon;
  maxLon = proj.maxLon;
  const sx = proj.sx;
  const sy = proj.sy;

  const origin = { lat: story.origin.lat, lon: story.origin.lon };
  const dest = { lat: story.dest.lat, lon: story.dest.lon };
  const ac = story.aircraft;
  const hasFix = Boolean(story.live && ac && Number.isFinite(ac.lat) && Number.isFinite(ac.lon));
  const onField = Boolean(hasFix && ac?.onGround && haversineNm(ac, dest) < 8);
  const atGate = story.currentStage === "gate";
  const landed = atGate || onField;
  const progress = landed ? 1 : story.route.progress;
  const ax = landed
    ? sx(dest.lon)
    : hasFix
      ? sx(ac!.lon)
      : sx(origin.lon);
  const ay = landed
    ? sy(dest.lat)
    : hasFix
      ? sy(ac!.lat)
      : sy(origin.lat);
  const rot = landed ? 0 : story.route.heading;
  const weatherLabel = (sample: RouteSample) => [sample.convective ? "Thunderstorms possible" : "",
    sample.chop !== "smooth" ? turbLabel(sample.chop) : "",
    sample.cloud ? "Cloudy stretch" : ""].filter(Boolean).join(" · ");
  const takeoffAt = story.times.takeoffUnix;
  const airborneNow = story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach";
  const elapsedMin = airborneNow && story.times.takeoffKind === "actual" && takeoffAt != null
    ? Math.max(0, (story.fetchedAt / 1000 - takeoffAt) / 60) : null;
  const plannedMinutes = takeoffAt != null && story.times.landUnix != null && story.times.landUnix > takeoffAt
    ? (story.times.landUnix - takeoffAt) / 60 : null;
  const mapEvents = routeWeatherEvents(samples, progress);
  // Both the full map and preview pin the event's entry point. The affected
  // route line still spans every range through the event's exit.
  const ticks = weatherPreview
    ? [{
        eventNumber: weatherPreview.eventNumber,
        ...samples.reduce((best, sample) =>
          Math.abs(sample.frac - weatherPreview.startFrac) < Math.abs(best.frac - weatherPreview.startFrac) ? sample : best, samples[0]),
        alertLabel: weatherPreview.label,
        durationMin: weatherPreview.endEtaMin - weatherPreview.startEtaMin,
        intoMin: airborneNow ? elapsedMin == null ? null : elapsedMin + weatherPreview.startEtaMin
          : plannedMinutes == null ? null : weatherPreview.startFrac * plannedMinutes
      }]
    : mapEvents.map((event, index) => ({
        eventNumber: index + 1,
        ...event.start,
        alertLabel: weatherLabel(event.start),
        durationMin: airborneNow ? event.endEtaMin - event.startEtaMin
          : plannedMinutes == null ? null : (event.endFrac - event.startFrac) * plannedMinutes,
        intoMin: airborneNow ? elapsedMin == null ? null : elapsedMin + event.startEtaMin
          : plannedMinutes == null ? null : event.startFrac * plannedMinutes
      }));
  const fixes = samples.filter((s) => s.fix);
  const runs = pathRuns(samples, progress).build(sx, sy);
  const countries = WORLD_COUNTRY_RINGS.filter((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat));
  const admin1 = ADMIN1_RINGS.filter((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat));
  const lakes = GREAT_LAKES.filter((lake) => lake.rings.some((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat)));
  const hazards = upcomingStorms(story.hazards ?? []);

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-surface", fixedViewport && "flex h-full flex-col items-center")}>
      <div
        ref={(node) => { zoom.boxRef.current = node; frameRef.current = node; }}
        data-map-box
        className={cn("relative overflow-hidden select-none", fixedViewport && "w-full min-h-0 flex-1")}
        style={{ touchAction: fixedViewport ? "none" : "pan-y",  }}
      >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className={fixedViewport ? "block h-full w-full" : "block aspect-square h-auto w-full"}
        role="img"
        aria-label={`Route ${story.origin.iata} to ${story.dest.iata}`}
      >
        <rect width={W} height={H} className="fill-bg" />
        <g transform={`translate(${zoom.x} ${zoom.y}) scale(${zoom.s})`} strokeLinejoin="round" strokeLinecap="round">
        {(weatherOn || weatherPreview) && (
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
          {lakes.map((lake) => (
            <path
              key={lake.name}
              d={lake.rings.map((ring) => `${ring.map(([lo, la], i) => `${i ? "L" : "M"}${sx(lo).toFixed(1)} ${sy(la).toFixed(1)}`).join(" ")} Z`).join(" ")}
              fillRule="evenodd"
              className="fill-bg/95 stroke-fg/35"
              strokeWidth="1.25"
            />
          ))}
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

        {weatherPreview && (weatherPreview.ranges ?? [weatherPreview]).map((range, index) => {
          const section = samples.filter(s => s.frac >= range.from && s.frac <= range.to);
          return <g key={index} aria-label="Weather area for this forecast">
            <polyline points={section.map(s => `${sx(s.lon)},${sy(s.lat)}`).join(" ")} fill="none" className="stroke-ifr" strokeWidth="18" opacity="0.55" />
            {section.length === 1 && <circle cx={sx(section[0].lon)} cy={sy(section[0].lat)} r="12" className="fill-ifr" opacity="0.65" />}
          </g>;
        })}
        {fixes.map((s) => (
          <rect
            key={`fix-${s.frac}`}
            x={sx(s.lon) - 2.6}
            y={sy(s.lat) - 2.6}
            width="5.2"
            height="5.2"
            transform={`rotate(45 ${sx(s.lon)} ${sy(s.lat)})`}
            className="route-fix-marker fill-fg/55"
          />
        ))}

        <circle cx={sx(origin.lon)} cy={sy(origin.lat)} r="5.5" className="fill-accent stroke-bg" strokeWidth="2" />
        <circle cx={sx(dest.lon)} cy={sy(dest.lat)} r="5.5" className="fill-fg stroke-bg" strokeWidth="2" />

        {hazards.map((h) => {
          const cx = sx(h.lon!);
          const cy = sy(h.lat!);
          return (
            <g key={h.id}>
              <circle
                cx={cx}
                cy={cy}
                r="10"
                className="fill-ifr/25 stroke-ifr/70"
                strokeWidth="1"
              />

            </g>
          );
        })}

        {ticks.map((s) => (
          <WeatherEventMarker key={s.frac} eventNumber={s.eventNumber}
            entry={{ lat: s.lat, lon: s.lon }} x={sx(s.lon)} y={sy(s.lat)} />
        ))}

        {hasFix && <g transform={`translate(${ax} ${ay}) rotate(${rot})`}>
          <polygon points="0,-10 8,11 -8,11" className="fill-fg stroke-bg" strokeWidth="1.4" />
        </g>}

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
          {weatherPreview ? weatherPreview.label : story.route.source === "track" ? "TRACK + PROJECTED ROUTE" : "PROJECTED ROUTE"}
        </p>
        <p className="rounded-sm border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted">
          {weatherPreview ? `Route toward ${story.dest.iata}` : atGate ? "At the gate" : landed ? "Landed" : Date.now() - story.fetchedAt > 15_000 || (story.providers?.chosenPositionAgeSec ?? Infinity) > 60 ? "Updating live position…" : `Remaining ${formatMiles(story.route.remainingNm)} · ${formatDuration(story.route.etaMin)}`}
        </p>
      </div>
        {weatherPreview ? null : zoom.s > 1.02 ? (
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
        <div style={weatherPreview ? { display: "none" } : undefined} className="absolute right-3 bottom-3 z-10 flex gap-1">
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

      <div className="pointer-events-auto relative z-20 flex shrink-0 items-center gap-3 border-t border-border bg-surface px-3 py-1 text-xs text-fg">
        <details className="group">
          <summary className="cursor-pointer py-3 font-semibold">Weather alerts</summary>
          <div className="absolute inset-x-0 bottom-full max-h-48 overflow-y-auto rounded-t-xl border border-border bg-surface p-3 text-sm shadow-lg">
            {ticks.map((s) => <div key={s.frac} className="flex items-start gap-2 py-2"><span className="shrink-0 rounded border border-border bg-bg px-1.5 font-semibold">{s.eventNumber}</span><div><p className="font-semibold">{s.alertLabel}</p><p>{s.intoMin == null ? "Time into flight unavailable" : `Around ${formatDuration(s.intoMin)} into flight`}</p><p>{s.durationMin != null && s.durationMin > 0 ? `Approximate duration: ${formatDuration(s.durationMin)}` : "Duration not established"}</p>{airborneNow && <p className="text-muted">About {formatDuration(s.etaMin)} from now</p>}</div></div>)}
            
            {!ticks.length && <p>No map alerts shown. Coverage may be incomplete.</p>}
          </div>
        </details>
        <details>
          <summary className="cursor-pointer py-3 font-semibold">Map details</summary>
          <div className="absolute inset-x-0 bottom-full max-h-48 space-y-3 overflow-y-auto rounded-t-xl border border-border bg-surface p-3 text-sm shadow-lg">
            <div className="flex flex-wrap gap-3">
              <Legend swatch="bg-accent" label="Smooth" />
              <Legend swatch="bg-ifr" label="Light / moderate turbulence" />
              <span>○ Thunderstorms</span>
            </div>
            {(weatherOn || weatherPreview) && <RadarStatus />}
            {story.hazards.filter(h => h.remaining && h.validity).map(h => <p key={h.id}>{h.label} · {h.validity}</p>)}
          </div>
        </details>
        {!weatherPreview && <button type="button" onClick={() => setWeatherOn(!weatherOn)} aria-pressed={weatherOn}
          className="ml-auto inline-flex min-h-10 shrink-0 items-center gap-1 rounded-sm border border-border px-2 text-fg">
          <CloudRain className="size-3.5" />{weatherOn ? "Radar on" : "Radar off"}
        </button>}
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
