import { RouteAirportSurface } from "./route-airport-surface";
import { airportNearViewport, maxRouteZoom, routeVisibleWidthMiles, routeStrokeWidths } from "@/lib/route-airport-detail";
import { lastKnownProgressLabel } from "@/lib/route-continuity";
import { remainingFlight, type RemainingFlightPresentation } from "@/lib/flight-presentation";
import { destPoint, formatDuration, formatMiles, haversineNm } from "@/lib/geo";
import { ArrivalRunwayChip } from "./arrival-runway-chip";
import { upcomingStorms } from "@/lib/route-hazards";
import { weatherEventNumber } from "@/lib/weather-events";
import { WeatherEventMarker } from "@/components/weather-event-marker";
import { WeatherPreviewLabel, WeatherIntensityLabel } from "@/components/weather-event-copy";
import { upcomingWeatherEvents, eventWeatherCopy, pilotReportTiming } from "@/lib/weather-presentation";
import { useFiled } from "@/lib/store";
import type { FlightStory, PilotReportObservation, RouteSample } from "@/lib/types";
import { ADMIN1_RINGS } from "@/lib/admin1-lines";
import { GREAT_LAKES } from "@/lib/great-lakes";
import { HAWAII_COASTLINES } from "@/lib/hawaii-coastlines";
import { latToTileY, pickRadarTiles, tileXToLon, tileYToLat } from "@/lib/radar-tiles";
import { WORLD_COUNTRY_RINGS } from "@/lib/world-country-lines";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CloudRain } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useId, useMemo } from "react";

import { clampRouteMapView as clampView, isMapControl, minimumFreeRouteZoom, reconcileRouteMapView, type RouteMapPanBounds } from "@/lib/route-map-interaction";

import { routeWeatherSegments, sampleWeather } from "@/lib/route-weather-segments";

const W = 800;
const H = 800;
const PAD = 40;

function weatherStroke(band: string, past: boolean) {
  if (past) return "stroke-muted/40";
  return band === "light" ? "stroke-turbulence-light" : band === "moderate" ? "stroke-turbulence-moderate" : "stroke-turbulence-smooth";
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
    latitudeAtY: (y: number) => tileYToLat(y0 + (y - PAD) / scale, 0),
  };
}

type RadarMaps = {
  host: string;
  radar: { past?: { time: number; path: string }[] };
};

const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia", PR: "Puerto Rico", VI: "U.S. Virgin Islands", GU: "Guam",
};

function WeatherPreviewLocation({ lat, lon }: { lat: number; lon: number }) {
  const q = useQuery({
    queryKey: ["weather-event-nearest-place", lat.toFixed(3), lon.toFixed(3)],
    queryFn: async ({ signal }) => {
      const res = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
        signal,
        headers: { Accept: "application/geo+json" },
      });
      if (!res.ok) throw new Error("location unavailable");
      const data = await res.json() as {
        properties?: {
          relativeLocation?: { properties?: { city?: string; state?: string } };
        };
      };
      const place = data.properties?.relativeLocation?.properties;
      const city = place?.city?.trim();
      const stateCode = place?.state?.trim().toUpperCase();
      if (!city || !stateCode) return null;
      return `${city}, ${US_STATE_NAMES[stateCode] ?? stateCode}`;
    },
    staleTime: 24 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: false,
  });

  if (!q.data) return null;
  return (
    <p className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-bg/90 px-2.5 py-1 font-mono text-xs text-fg shadow-sm">
      Near {q.data}
    </p>
  );
}

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
    <g data-radar-layer opacity="0.7">
      {tiles.map((t) => (
        <image key={t.key} href={t.href} x={t.x} y={t.y} width={t.w} height={t.h} preserveAspectRatio="none" />
      ))}
    </g>
  );
}

function useMapBoxZoom(resetKey: string, H = 800, freePan = false) {
  const maxZoomRef = useRef(12);
  const panBoundsRef = useRef<RouteMapPanBounds | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  const resetKeyRef = useRef(resetKey);
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

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    const { s, x, y } = viewRef.current;
    const minScale = freePan ? minimumFreeRouteZoom(panBoundsRef.current, H) : 1;
    const ns = Math.min(maxZoomRef.current, Math.max(minScale, s * factor));
    const cx = anchor ? anchor.x * s + x : W / 2;
    const cy = anchor ? anchor.y * s + y : H / 2;
    setView(
      clampView({
        s: ns,
        x: cx - ((cx - x) * ns) / s,
        y: cy - ((cy - y) * ns) / s,
      }, H, freePan, maxZoomRef.current, panBoundsRef.current),
    );
  }, [H, freePan]);

  useEffect(() => {
    const resetForNewLeg = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    setView((current) => reconcileRouteMapView(
      current,
      resetForNewLeg,
      H,
      freePan,
      maxZoomRef.current,
      panBoundsRef.current,
    ));
  }, [resetKey, H, freePan]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    const apply = (next: { s: number; x: number; y: number }) => setView(clampView(next, H, freePan, maxZoomRef.current, panBoundsRef.current));

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { s, x, y } = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0018);
      const minScale = freePan ? minimumFreeRouteZoom(panBoundsRef.current, H) : 1;
      const ns = Math.min(maxZoomRef.current, Math.max(minScale, s * factor));
      const { mx, my } = toSvg(el, e.clientX, e.clientY);
      apply({
        s: ns,
        x: mx - ((mx - x) * ns) / s,
        y: my - ((my - y) * ns) / s,
      });
    };

    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    let blockedTouchGesture = false;
    const onTouchStart = (e: TouchEvent) => {
      if (blockedTouchGesture || isMapControl(e.target) || Array.from(e.touches).some(t => isMapControl(t.target))) {
        blockedTouchGesture = true;
        pinchRef.current = null;
        dragRef.current = null;
        return;
      }
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
      } else if (e.touches.length === 1 && freePan) {
        const t = e.touches[0]!;
        dragRef.current = { px: t.clientX, py: t.clientY, x: viewRef.current.x, y: viewRef.current.y };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        const p = pinchRef.current;
        if (!p) return;
        e.preventDefault();
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const factor = dist(a, b) / p.d;
        const minScale = freePan ? minimumFreeRouteZoom(panBoundsRef.current, H) : 1;
        const ns = Math.min(maxZoomRef.current, Math.max(minScale, p.s * factor));
        const mid = toSvg(el, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        apply({
          s: ns,
          x: mid.mx - ((p.mx - p.x) * ns) / p.s,
          y: mid.my - ((p.my - p.y) * ns) / p.s,
        });
      } else if (e.touches.length === 1 && freePan && dragRef.current) {
        e.preventDefault();
        const t = e.touches[0]!;
        const r = el.getBoundingClientRect();
        apply({
          s: viewRef.current.s,
          x: dragRef.current.x + ((t.clientX - dragRef.current.px) / Math.max(1, r.width)) * W,
          y: dragRef.current.y + ((t.clientY - dragRef.current.py) / Math.max(1, r.height)) * H,
        });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null;
      if (e.touches.length === 0) {
        dragRef.current = null;
        blockedTouchGesture = false;
      }
    };

    let pointerDrag: { id: number; px: number; py: number; x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      if (!freePan || e.pointerType === "touch" || e.button !== 0 || !e.isPrimary || pointerDrag || isMapControl(e.target)) return;
      e.preventDefault();
      pointerDrag = { id: e.pointerId, px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pointerDrag || pointerDrag.id !== e.pointerId) return;
      const r = el.getBoundingClientRect();
      apply({
        s: viewRef.current.s,
        x: pointerDrag.x + ((e.clientX - pointerDrag.px) / Math.max(1, r.width)) * W,
        y: pointerDrag.y + ((e.clientY - pointerDrag.py) / Math.max(1, r.height)) * H,
      });
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (!pointerDrag || pointerDrag.id !== e.pointerId) return;
      pointerDrag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };

    const blockPageZoom = (e: Event) => e.preventDefault();
    const blockPageGesture = (e: Event) => {
      const t = e.target as Node | null;
      if (t && el.contains(t)) return;
      e.preventDefault();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerEnd);
    el.addEventListener("pointercancel", onPointerEnd);
    el.addEventListener("lostpointercapture", onPointerEnd);
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
      if (pointerDrag && el.hasPointerCapture(pointerDrag.id)) el.releasePointerCapture(pointerDrag.id);
      pinchRef.current = null;
      dragRef.current = null;
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerEnd);
      el.removeEventListener("pointercancel", onPointerEnd);
      el.removeEventListener("lostpointercapture", onPointerEnd);
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
  }, [H, freePan]);

  return { boxRef, maxZoomRef, panBoundsRef, s: view.s, x: view.x, y: view.y, reset, zoomBy };
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

export function RouteMap(props: Parameters<typeof RouteMapContent>[0]) {
  if ((props.story.route?.samples?.length ?? 0) < 2) return null;
  return <RouteMapContent {...props} />;
}

function RouteMapContent({ story, fixedViewport = false, weatherPreview, remaining }: { story: FlightStory; fixedViewport?: boolean; weatherPreview?: { reported?: boolean; pilotReports?: PilotReportObservation[]; intensityBand?: string; intensity?: string; eventNumber: number; label: string; startFrac: number; endFrac: number; startEtaMin: number; endEtaMin: number; ranges?: {from: number; to: number}[] }; remaining?: RemainingFlightPresentation }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<SVGGElement>(null);
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
  const freePan = fixedViewport && !weatherPreview;
  const zoom = useMapBoxZoom(`${story.callsign}:${story.origin.iata}:${story.dest.iata}`, H, freePan);
  const setMapFrame = useCallback((node: HTMLDivElement | null) => {
    zoom.boxRef.current = node;
    frameRef.current = node;
  }, [zoom.boxRef]);
  const panelGroup = useId();
  const samples = story.route?.samples ?? [];


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
  const proj = useMemo(() => projectBox(minLon, maxLon, minLat, maxLat, H), [minLon, maxLon, minLat, maxLat, H]);
  minLat = proj.minLat;
  maxLat = proj.maxLat;
  minLon = proj.minLon;
  maxLon = proj.maxLon;
  const sx = proj.sx;
  const sy = proj.sy;
  zoom.panBoundsRef.current = freePan ? {
    minX: Math.min(sx(-180), sx(180)),
    maxX: Math.max(sx(-180), sx(180)),
    minY: Math.min(sy(85), sy(-85)),
    maxY: Math.max(sy(85), sy(-85)),
  } : null;
  const minRouteZoom = freePan ? minimumFreeRouteZoom(zoom.panBoundsRef.current, H) : 1;
  const centerLatitude = proj.latitudeAtY((H / 2 - zoom.y) / zoom.s);
  const baseWidthMiles = routeVisibleWidthMiles(W / (sx(1) - sx(0)), centerLatitude);
  const visibleWidthMiles = baseWidthMiles / zoom.s;
  zoom.maxZoomRef.current = weatherPreview ? 12 : maxRouteZoom(baseWidthMiles);
  const radiusPx = W * 5 / baseWidthMiles;
  const originNear = airportNearViewport({ x: sx(story.origin.lon), y: sy(story.origin.lat) }, zoom, H, radiusPx);
  const destNear = airportNearViewport({ x: sx(story.dest.lon), y: sy(story.dest.lat) }, zoom, H, radiusPx);

  const origin = { lat: story.origin.lat, lon: story.origin.lon };
  const dest = { lat: story.dest.lat, lon: story.dest.lon };
  const ac = story.aircraft;
  const hasFix = Boolean(story.route.progressSource !== "last_known" && story.live && ac && Number.isFinite(ac.lat) && Number.isFinite(ac.lon));
  const lastKnownLabel = lastKnownProgressLabel(story);
  const remainingView = remaining ?? remainingFlight(story);
  const hasCredibleProgress = (hasFix && !remainingView.estimated) || story.route.progressSource === "last_known";
  const remainingLabel = remainingView.text
    ? `Remaining ${hasCredibleProgress && Number.isFinite(story.route.remainingNm) ? `${formatMiles(story.route.remainingNm)} · ` : ""}${remainingView.text}${remainingView.estimated ? " estimated" : ""}`
    : "Updating remaining time…";
  const progressLabel = lastKnownLabel ? `${lastKnownLabel} · ${remainingLabel}` : remainingLabel;
  const onField = Boolean(hasFix && ac?.onGround && haversineNm(ac, dest) < 8);
  const atGate = story.currentStage === "gate";
  const landed = atGate || onField || story.route.progressSource === "landed"
    || story.currentStage === "taxi_in" || story.arrivalStatus === "landed" || story.arrivalStatus === "taxi_in";
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
  const takeoffAt = story.times.takeoffUnix;
  const airborneNow = story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach";
  const elapsedMin = airborneNow && story.times.takeoffKind === "actual" && takeoffAt != null
    ? Math.max(0, (story.fetchedAt / 1000 - takeoffAt) / 60) : null;
  const plannedMinutes = takeoffAt != null && story.times.landUnix != null && story.times.landUnix > takeoffAt
    ? (story.times.landUnix - takeoffAt) / 60 : null;
  const mapEvents = upcomingWeatherEvents(samples, progress);
  const previewEntry = weatherPreview ? samples.reduce((best, sample) =>
    Math.abs(sample.frac - weatherPreview.startFrac) < Math.abs(best.frac - weatherPreview.startFrac) ? sample : best, samples[0]) : null;
  // Both the full map and preview pin the event's entry point. The affected
  // route line still spans every range through the event's exit.
  const ticks = weatherPreview
    ? [{
        eventNumber: weatherPreview.eventNumber,
        ...previewEntry!,
        etaMin: weatherPreview.startEtaMin,
        pilotReports: weatherPreview.pilotReports,
        alertLabel: weatherPreview.label,
        reported: Boolean(weatherPreview.reported),
        chop: weatherPreview.reported ? weatherPreview.intensity?.includes("moderate") ? "moderate" as const : weatherPreview.intensity === "severe" ? "severe" as const : "light" as const
          : previewEntry!.chop,
        intensity: weatherPreview.intensity,
        intensityBand: weatherPreview.intensityBand,
        durationMin: weatherPreview.endEtaMin - weatherPreview.startEtaMin,
        intoMin: airborneNow ? elapsedMin == null ? null : elapsedMin + weatherPreview.startEtaMin
          : plannedMinutes == null ? null : weatherPreview.startFrac * plannedMinutes
      }]
    : mapEvents.map((event, index) => ({
        eventNumber: weatherEventNumber(mapEvents, event),
        ...event.start,
        pilotReports: event.pilotReports,
        alertLabel: eventWeatherCopy(event, story.dest.city || story.dest.iata).mapLabel,
        reported: event.source === "observed",
        intensityBand: event.intensities.length === 1 && event.intensities[0] === "light-moderate" ? "light" : undefined,
        intensity: event.key.startsWith("turbulence:") ? event.key.slice(11) : undefined,
        durationMin: airborneNow ? event.endEtaMin - event.startEtaMin
          : plannedMinutes == null ? null : (event.endFrac - event.startFrac) * plannedMinutes,
        intoMin: airborneNow ? elapsedMin == null ? null : elapsedMin + event.startEtaMin
          : plannedMinutes == null ? null : event.startFrac * plannedMinutes
      }));
  const allFiledFixes = (story.route.filedFixes ?? []).filter((p) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lon) && typeof p.label === "string" && p.label.trim().length > 0);
  // Marker count is derived only from the published plan and remains stable
  // while zooming. Route samples still drive geometry, ETA, and weather.
  const filedStep = Math.max(1, Math.ceil(allFiledFixes.length / 24));
  const filedFixes = allFiledFixes.filter((_, index) => index % filedStep === 0);
  const runs = routeWeatherSegments(samples, progress).map(segment => ({ ...segment, pts: segment.points.map(s => ({ x: sx(s.lon), y: sy(s.lat) })) }));
  const hazards = upcomingStorms(story.hazards ?? []);
  // Numbered weather-event markers already identify route weather. Do not draw
  // a second convective dot under the same marker; the overlap creates the
  // large red/white halo seen around event 1 while event 2 stays clean.
  const visibleHazards = hazards.filter((hazard) => !ticks.some((tick) =>
    haversineNm(
      { lat: hazard.lat!, lon: hazard.lon! },
      { lat: tick.lat, lon: tick.lon },
    ) <= 12,
  ));
  const movedFromHome = Math.abs(zoom.s - 1) > 0.02 || Math.abs(zoom.x) > 1 || Math.abs(zoom.y) > 1;
  const arrival = story.route.expectedArrival;
  const runwayAhead = arrival ? destPoint(arrival.threshold, arrival.heading, 1) : null;
  const arrivalZoomAnchor = arrival && !landed
    ? { x: sx(arrival.threshold.lon), y: sy(arrival.threshold.lat) } : undefined;
  // Include the flown part of the drawn near-field approach, so the label remains
  // useful on short final. The rest of a long trip cannot qualify a tiny airport.
  const approachSamples = arrival ? samples.filter(sample => haversineNm(sample, arrival.threshold) <= 40) : [];

  // Geographic paths only change when the projection changes, not on every drag.
  const basemap = useMemo(() => {
  const countries = freePan ? WORLD_COUNTRY_RINGS : WORLD_COUNTRY_RINGS.filter((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat));
  const admin1 = freePan ? ADMIN1_RINGS : ADMIN1_RINGS.filter((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat));
  const hawaii = freePan ? HAWAII_COASTLINES : HAWAII_COASTLINES.filter((island) => ringHits(island.ring, minLon, maxLon, minLat, maxLat));
  const lakes = freePan ? GREAT_LAKES : GREAT_LAKES.filter((lake) => lake.rings.some((ring) => ringHits(ring, minLon, maxLon, minLat, maxLat)));
    return (<g>
          {countries.map((ring, i) => {
            if (!ringFillable(ring)) return null;
            const points = ring.map(([lo, la]) => `${sx(lo).toFixed(6)},${sy(la).toFixed(6)}`).join(" ");
            return <polygon key={`fill-${i}`} points={points} className="fill-fg/10 stroke-none" />;
          })}
          {admin1.map((ring, i) => {
            const points = ring.map(([lo, la]) => `${sx(lo).toFixed(6)},${sy(la).toFixed(6)}`).join(" ");
            return (
              <polyline
                key={`adm-${i}`}
                points={points}
                className="fill-none stroke-fg/20"
                strokeWidth="0.9"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {countries.map((ring, i) => {
            const points = ring.map(([lo, la]) => `${sx(lo).toFixed(6)},${sy(la).toFixed(6)}`).join(" ");
            return ringFillable(ring) ? (
              <polygon
                key={`c-${i}`}
                points={points}
                className="fill-none stroke-fg/35"
                strokeWidth="1.25"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <polyline
                key={`c-${i}`}
                points={points}
                className="fill-none stroke-fg/35"
                strokeWidth="1.25"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {lakes.map((lake) => (
            <path
              key={lake.name}
              data-map-water="great-lake"
              d={lake.rings.map((ring) => `${ring.map(([lo, la], i) => `${i ? "L" : "M"}${sx(lo).toFixed(6)} ${sy(la).toFixed(6)}`).join(" ")} Z`).join(" ")}
              fillRule="evenodd"
              className="stroke-fg/35"
              style={{ fill: "var(--journey-water)" }}
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hawaii.map((island) => (
            <polygon
              key={`hawaii-${island.name}`}
              data-hawaii-island={island.name}
              points={island.ring.map(([lo, la]) => `${sx(lo).toFixed(6)},${sy(la).toFixed(6)}`).join(" ")}
              className="fill-fg/10 stroke-fg/45"
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>);
  }, [proj, freePan]);

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-surface", fixedViewport && "flex h-full flex-col items-center")}>
      <div
        ref={setMapFrame}
        data-map-box
        className={cn("relative overflow-hidden select-none", fixedViewport && "w-full min-h-0 flex-1")}
        style={{ touchAction: fixedViewport ? "none" : "pan-y", cursor: freePan ? "grab" : undefined }}
      >
      <svg
        data-route-map
        data-visible-width-mi={visibleWidthMiles}
        data-max-route-zoom={zoom.maxZoomRef.current}
        data-min-route-zoom={minRouteZoom}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className={fixedViewport ? "block h-full w-full" : "block aspect-square h-auto w-full"}
        role="img"
        aria-label={`Route ${story.origin.iata} to ${story.dest.iata}`}
      >
        <rect width={W} height={H} className="fill-bg" />
        <g ref={geometryRef} transform={`translate(${zoom.x} ${zoom.y}) scale(${zoom.s})`} strokeLinejoin="round" strokeLinecap="round">


        {basemap}

        <RouteAirportSurface airport={story.origin} near={originNear} approachActive={false} widthMiles={visibleWidthMiles} inverseScale={1 / zoom.s} sx={sx} sy={sy} />
        <RouteAirportSurface airport={story.dest} near={destNear} approachActive={!!story.route.expectedArrival && !!story.route.arrivalPatternKind && !weatherPreview} widthMiles={visibleWidthMiles} inverseScale={1 / zoom.s} sx={sx} sy={sy} />
        {(weatherOn || weatherPreview) && (
          <RadarLayer minLon={minLon} maxLon={maxLon} minLat={minLat} maxLat={maxLat} sx={sx} sy={sy} />
        )}
        <g aria-label="Filed flight-plan fixes" opacity="0.58">
          {filedFixes.map((fix, index) => (
            <g key={`filed-${index}-${fix.lat}-${fix.lon}`} data-filed-fix={fix.label ?? "filed fix"}
              transform={`translate(${sx(fix.lon)} ${sy(fix.lat)}) scale(${1 / zoom.s}) rotate(45)`}>
              <rect x="-2.2" y="-2.2" width="4.4" height="4.4" className="fill-white stroke-fg/35"
                strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {zoom.s >= 2 && fix.label ? (
                <text x="7" y="3" transform="rotate(-45)" className="fill-muted" fontSize="9"
                  fontFamily="Barlow Condensed, sans-serif" letterSpacing="0.08em">{fix.label}</text>
              ) : null}
            </g>
          ))}
        </g>

        {runs.map((run, i) => {
          const d = run.pts.map((p, j) => `${j === 0 ? "M" : "L"}${p.x.toFixed(6)} ${p.y.toFixed(6)}`).join(" ");
          const widths = routeStrokeWidths(zoom.s, run.band, run.past);
          const w = widths.line;
          return (
            <g key={`run-${i}`} data-weather-intensity={run.intensity} data-segment-start-frac={run.points[0].frac}>
              <path d={d} data-route-stroke="outline" className="fill-none stroke-bg" strokeWidth={widths.outline} strokeLinecap="butt" vectorEffect="non-scaling-stroke" />
              {run.pts.length === 1 && run.band !== "smooth" && <circle cx={run.pts[0].x} cy={run.pts[0].y} r={w / 2 / zoom.s} className={run.band === "light" ? "fill-turbulence-light" : "fill-turbulence-moderate"} />}
              <path d={d} data-route-stroke={run.past ? "flown" : "projected"} className={cn("fill-none", weatherStroke(run.band, run.past))} data-segment-start-lat={run.points[0].lat} data-segment-start-lon={run.points[0].lon} strokeWidth={w} strokeDasharray={!run.past && story.route.arrivalPatternKind ? "8 5" : undefined} opacity={!run.past && story.route.arrivalPatternKind ? 0.8 : 1} strokeLinecap="butt" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}

        {mapEvents.filter(event => event.source === "observed").flatMap(event => event.ranges.map((range, i) => {
          const points = [...new Map([event.start, ...samples, event.end]
            .filter(sample => sample.frac >= range.from && sample.frac <= range.to)
            .sort((a, b) => a.frac - b.frac).map(sample => [sample.frac, sample])).values()];
          if (points.length < 2 || points.some((point, j) => j > 0 && Math.abs(point.lon - points[j - 1].lon) > 180)) return null;
          return <path key={`reported-${event.startFrac}-${i}`} data-pilot-report-area
            d={points.map((point, j) => `${j ? "L" : "M"}${sx(point.lon).toFixed(6)} ${sy(point.lat).toFixed(6)}`).join(" ")}
            className="fill-none stroke-muted" strokeWidth={routeStrokeWidths(zoom.s, "smooth").reported} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />;
        }))}

        <g data-map-obstacle transform={`translate(${sx(origin.lon)} ${sy(origin.lat)}) scale(${1 / zoom.s})`}>
          <circle r="5.5" className="fill-accent stroke-bg" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <text y="22" textAnchor="middle" className="fill-muted" fontSize="13" fontFamily="Barlow Condensed, sans-serif" letterSpacing="0.12em">{story.origin.iata}</text>
        </g>
        <g data-map-obstacle data-arrival-threshold transform={`translate(${sx(story.route.expectedArrival?.threshold.lon ?? dest.lon)} ${sy(story.route.expectedArrival?.threshold.lat ?? dest.lat)}) scale(${1 / zoom.s})`}>
          <circle r="5.5" className="fill-fg stroke-bg" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <text y="22" textAnchor="middle" className="fill-fg" fontSize="13" fontFamily="Barlow Condensed, sans-serif" letterSpacing="0.12em">{story.dest.iata}</text>
        </g>

        {visibleHazards.map((h) => {
          const cx = sx(h.lon!);
          const cy = sy(h.lat!);
          return (
            <g key={h.id} data-map-hazard="convective" transform={`translate(${cx} ${cy}) scale(${1 / zoom.s})`}>
              <circle
                r="10"
                className="fill-ifr/25 stroke-ifr/70"
                strokeWidth="1"
              />

            </g>
          );
        })}

        {ticks.map((s) => (
          <WeatherEventMarker key={s.frac} eventNumber={s.eventNumber} inverseScale={1 / zoom.s}
            entry={{ lat: s.lat, lon: s.lon }} x={sx(s.lon)} y={sy(s.lat)} kind={sampleWeather(s).kind} band={sampleWeather(s).band} label={s.alertLabel} />
        ))}

        {hasFix && <g data-map-obstacle data-map-aircraft transform={`translate(${ax} ${ay}) scale(${1 / zoom.s}) rotate(${rot})`}>
          <polygon points="0,-10 8,11 -8,11" className="fill-fg stroke-bg" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        </g>}

        </g>
      </svg>

      {arrival && runwayAhead && !weatherPreview && !landed && <ArrivalRunwayChip
        frameRef={frameRef} geometryRef={geometryRef}
        threshold={{ x: sx(arrival.threshold.lon), y: sy(arrival.threshold.lat) }}
        runwayForward={{ x: sx(runwayAhead.lon) - sx(arrival.threshold.lon), y: sy(runwayAhead.lat) - sy(arrival.threshold.lat) }}
        approach={approachSamples.map(sample => ({ x: sx(sample.lon), y: sy(sample.lat) }))}
        route={samples.map(sample => ({ x: sx(sample.lon), y: sy(sample.lat) }))}
        runway={arrival.runway} reported={arrival.source === "provider"}
        viewKey={`${zoom.s}:${zoom.x}:${zoom.y}:${H}`}
      />}

      <div data-map-obstacle className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <p className="max-w-1/2 rounded-sm border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted">
          {weatherPreview ? <WeatherPreviewLabel label={weatherPreview.label} /> : story.route.source === "track" ? "TRACK + PROJECTED ROUTE" : "PROJECTED ROUTE"}
          {!weatherPreview && story.route.arrivalProjectionStale ? <span className="block">Approach plan · stale</span> : null}
        </p>
        <p data-route-progress-source={story.route.progressSource} className="max-w-1/2 rounded-sm border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted">
          {weatherPreview ? `Route toward ${story.dest.iata}` : atGate ? "At the gate" : landed ? "Landed" : progressLabel}
        </p>
      </div>
      {weatherPreview && ticks[0] ? <WeatherPreviewLocation lat={ticks[0].lat} lon={ticks[0].lon} /> : null}
        {weatherPreview ? null : movedFromHome ? (
          <button
            data-map-obstacle
            type="button"
            onClick={zoom.reset}
            className="absolute bottom-3 left-3 z-10 h-9 rounded-sm border border-border bg-bg/90 px-2.5 font-mono text-xs tracking-wide text-fg"
          >
            Reset map
          </button>
        ) : (
          <p data-map-obstacle className="pointer-events-none absolute bottom-3 left-3 font-mono text-xs tracking-wide text-subtle">
            Pinch to zoom · drag to pan
          </p>
        )}
        <div data-map-obstacle style={weatherPreview ? { display: "none" } : undefined} className="absolute right-3 bottom-3 z-10 flex gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoom.zoomBy(1.4, arrivalZoomAnchor)}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-border bg-bg/90 font-display text-xl text-fg"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoom.zoomBy(1 / 1.4, arrivalZoomAnchor)}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-border bg-bg/90 font-display text-xl text-fg"
          >
            −
          </button>
        </div>
      </div>

      <div className="pointer-events-auto relative z-20 flex shrink-0 items-center gap-3 border-t border-border bg-surface px-3 py-1 text-xs text-fg">
        <details name={panelGroup} className="group">
          <summary className="cursor-pointer py-3 font-semibold">Weather alerts</summary>
          <div className="absolute inset-x-0 bottom-full max-h-48 overflow-y-auto rounded-t-xl border border-border bg-surface p-3 text-sm shadow-lg">
            {ticks.map((s) => <div key={s.frac} className="flex items-start gap-2 py-2"><span className="shrink-0 rounded border border-border bg-bg px-1.5 font-semibold">{s.eventNumber || (s.convective ? "⚡" : "☁")}</span><div>{s.intensity && <p><WeatherIntensityLabel intensity={s.intensity} band={s.intensityBand} /> {s.reported ? "bumps reported" : "turbulence"}</p>}<p className={sampleWeather(s).band === "light" ? "font-semibold text-turbulence-light" : sampleWeather(s).band === "moderate" ? "font-semibold text-turbulence-moderate" : "font-semibold"}>{s.alertLabel}</p>{s.reported ? <p>{s.etaMin <= 1 ? "You’re passing this reported area around now" : `You’ll pass this area in about ${formatDuration(s.etaMin)}`}</p> : <><p>{s.intoMin == null ? "Time into flight unavailable" : `Around ${formatDuration(s.intoMin)} into flight`}</p><p>{s.durationMin != null && s.durationMin > 0 ? `Approximate duration: ${formatDuration(s.durationMin)}` : "Duration not established"}</p>{airborneNow && <p className="text-muted">About {formatDuration(s.etaMin)} from now</p>}</>}{s.pilotReports?.map(report => <p key={report.id} className="text-muted">Reported by another aircraft · {pilotReportTiming(report.observedAt)}</p>)}</div></div>)}
            
            {!ticks.length && <p>No map alerts shown. Coverage may be incomplete.</p>}
          </div>
        </details>
        <details name={panelGroup}>
          <summary className="cursor-pointer py-3 font-semibold">Map details</summary>
          <div className="absolute inset-x-0 bottom-full max-h-48 space-y-3 overflow-y-auto rounded-t-xl border border-border bg-surface p-3 text-sm shadow-lg">
            <div className="flex flex-wrap gap-3">
              <Legend swatch="bg-turbulence-smooth" label="Smooth" />
              <Legend swatch="bg-turbulence-light" label="Light–moderate" />
              <Legend swatch="bg-turbulence-moderate" label="Moderate–severe" />
              <span>⚡ Thunderstorms · ☁ Clouds</span>
            </div>
            {(weatherOn || weatherPreview) && <RadarStatus />}
            {!weatherPreview && lastKnownLabel ? <p>{lastKnownLabel}. {story.route.source === "track" ? "The solid line retains the observed track." : "The projected route geometry is retained."} No current aircraft position is shown.</p> : null}
            {!weatherPreview && story.route.arrivalProjectionStale ? <p>Approach plan is stale and held from the last known point until a fresh observation arrives.</p> : null}
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
