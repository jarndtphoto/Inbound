import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { FlightStory } from "@/lib/types";
import { haversineNm } from "@/lib/geo";
import { RouteMap } from "@/components/route-map";

type MapView = "Departure" | "Route" | "Arrival";
function automaticView(story: FlightStory): MapView {
  if (story.currentStage === "gate" || (story.currentStage === "arrival" && story.aircraft?.onGround)) return "Arrival";
  return ["inbound", "push", "taxi"].includes(story.currentStage) ? "Departure" : "Route";
}

export function FlightMap({ story }: { story: FlightStory }) {
  const auto = automaticView(story);
  const [choice, setChoice] = useState<{ phase: MapView; view: MapView } | null>(null);
  const selected = choice?.phase === auto ? choice.view : auto;
  return <div className="flex h-full min-h-0 flex-col gap-2">
    <div role="tablist" aria-label="Map views" className="grid shrink-0 grid-cols-3 gap-1 rounded-xl border border-border bg-surface p-1">
      {(["Departure", "Route", "Arrival"] as const).map((view, index, views) => <button key={view} id={`map-tab-${view}`} type="button" role="tab" aria-selected={selected === view} aria-controls="map-view-panel" tabIndex={selected === view ? 0 : -1}
        onClick={() => setChoice({ phase: auto, view })} onKeyDown={event => {
          const i = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
          if (i < 0) return;
          event.preventDefault(); setChoice({ phase: auto, view: views[i] });
          document.getElementById(`map-tab-${views[i]}`)?.focus();
        }} className={`min-h-11 rounded-lg px-2 text-sm font-semibold ${selected === view ? "bg-accent text-accent-fg" : "text-muted"}`}>
        {view}{view !== "Route" && <span className="ml-1 text-xs opacity-80">{view === "Departure" ? story.origin.iata : story.dest.iata}</span>}
      </button>)}
    </div>
    <div id="map-view-panel" role="tabpanel" aria-labelledby={`map-tab-${selected}`} className="min-h-0 flex-1">
      {selected === "Route" ? <RouteMap story={story} fixedViewport /> : <AirportMap key={`${selected}:${story.origin.icao}:${story.dest.icao}`} story={story} arrival={selected === "Arrival"} />}
    </div>
  </div>;
}

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
function world(lat: number, lon: number) {
  const sin = Math.sin(clamp(lat, -85, 85) * Math.PI / 180);
  return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}
function ageText(seconds: number) {
  if (!Number.isFinite(seconds)) return "time unavailable";
  return seconds < 60 ? `${Math.floor(seconds)}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

function AirportMap({ story, arrival }: { story: FlightStory; arrival: boolean }) {
  const airport = arrival ? story.dest : story.origin;
  const airportPoint = world(airport.lat, airport.lon);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(14);
  const [center, setCenter] = useState(airportPoint);
  const [following, setFollowing] = useState(true);
  const [now, setNow] = useState(Date.now);
  const [failedTiles, setFailedTiles] = useState<Set<string>>(() => new Set());
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; distance: number; zoom: number; cx: number; cy: number } | null>(null);
  const aircraft = story.aircraft;
  const positionAge = aircraft?.seenSec != null && Number.isFinite(aircraft.seenSec)
    ? Math.max(0, aircraft.seenSec) + Math.max(0, now - story.fetchedAt) / 1000 : Infinity;
  const groundPosition = aircraft && aircraft.onGround && !aircraft.extrapolated
    && Number.isFinite(aircraft.lat) && Number.isFinite(aircraft.lon)
    && haversineNm(aircraft, airport) < 12 ? aircraft : null;
  // Preserve only reported coordinates. Never fabricate a gate position or animate a predicted taxi path.
  const [last, setLast] = useState<{ lat: number; lon: number; track: number | null; observedAt: number } | null>(null);
  useEffect(() => {
    if (!groundPosition || !Number.isFinite(positionAge)) return;
    const observedAt = story.fetchedAt - Math.max(0, groundPosition.seenSec ?? 0) * 1000;
    setLast(previous => previous && previous.observedAt > observedAt ? previous : {
      lat: groundPosition.lat, lon: groundPosition.lon, track: groundPosition.track, observedAt,
    });
  }, [story.fetchedAt, groundPosition?.lat, groundPosition?.lon, groundPosition?.seenSec, groundPosition?.track]);
  const point = groundPosition && Number.isFinite(positionAge) ? {
    lat: groundPosition.lat, lon: groundPosition.lon, track: groundPosition.track,
    observedAt: story.fetchedAt - Math.max(0, groundPosition.seenSec ?? 0) * 1000,
  } : last;
  const age = point ? Math.max(0, now - point.observedAt) / 1000 : Infinity;
  const fresh = Boolean(groundPosition && point && age <= 30);
  const target = point ? world(point.lat, point.lon) : null;
  useEffect(() => {
    if (following && fresh && target) setCenter(target);
  }, [following, fresh, target?.x, target?.y]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const frame = box.current;
    const observer = new ResizeObserver(() => {
      if (frame) setSize({ w: frame.clientWidth, h: frame.clientHeight });
    });
    if (frame) observer.observe(frame);
    return () => { clearInterval(timer); observer.disconnect(); };
  }, []);
  const scale = 256 * 2 ** zoom;
  const z = Math.floor(zoom), count = 2 ** z, tileSize = scale / count;
  const left = center.x * scale - size.w / 2, top = center.y * scale - size.h / 2;
  const tiles: { key: string; src: string; x: number; y: number }[] = [];
  if (size.w > 0 && size.h > 0) for (let x = Math.floor(left / tileSize); x <= Math.floor((left + size.w) / tileSize); x++) {
    for (let y = Math.max(0, Math.floor(top / tileSize)); y <= Math.min(count - 1, Math.floor((top + size.h) / tileSize)); y++) {
      const wrappedX = ((x % count) + count) % count;
      const key = `${z}/${wrappedX}/${y}`;
      tiles.push({ key, src: `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${wrappedX}`, x: x * tileSize - left, y: y * tileSize - top });
    }
  }
  const visibleTileError = tiles.some(tile => failedTiles.has(tile.key));
  function startGesture() {
    const points = [...pointers.current.values()];
    if (!points.length) { gesture.current = null; return; }
    const a = points[0], b = points[1] ?? a;
    gesture.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: points.length > 1 ? Math.hypot(a.x - b.x, a.y - b.y) : 0, zoom, cx: center.x, cy: center.y };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()], a = points[0], b = points[1] ?? a, g = gesture.current;
    setFollowing(false);
    const nextZoom = g.distance > 0 && points.length > 1 ? clamp(g.zoom + Math.log2(Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) / g.distance), 12, 19) : g.zoom;
    setZoom(nextZoom);
    const s = 256 * 2 ** g.zoom;
    setCenter({ x: g.cx - ((a.x + b.x) / 2 - g.x) / s, y: clamp(g.cy - ((a.y + b.y) / 2 - g.y) / s, 0, 1) });
  }
  function release(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId); startGesture();
  }
  const markerX = target ? ((target.x - center.x + 1.5) % 1 - 0.5) * scale + size.w / 2 : 0;
  const markerY = target ? (target.y - center.y) * scale + size.h / 2 : 0;
  const controls = "min-h-11 rounded-lg border border-border bg-surface px-3 text-sm font-semibold text-fg shadow-sm";
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
    <div className="shrink-0 px-3 py-2">
      <p className="text-sm font-semibold">{airport.iata} · {arrival ? "Arrival airport" : "Departure airport"}</p>
      <p role="status" className="text-xs text-muted">{fresh ? `Ground position · ${ageText(age)}` : point ? `Last position · ${ageText(age)}` : (story.currentStage === "taxi" && !arrival ? "Departure reported · waiting for ground coordinates" : "Ground position unavailable · showing airport")}</p>
    </div>
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden bg-[#e5e7eb]" style={{ touchAction: "none" }} aria-label={`${airport.iata} airport ground map`}
      onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); startGesture(); }}
      onPointerMove={move} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}>
      {tiles.map(tile => <img key={tile.key} src={tile.src} alt="" draggable={false} referrerPolicy="strict-origin-when-cross-origin" className="pointer-events-none absolute max-w-none select-none" style={{ left: tile.x, top: tile.y, width: tileSize + 0.5, height: tileSize + 0.5 }}
        onError={() => setFailedTiles(previous => new Set(previous).add(tile.key))} />)}
      {point && target && <div className="pointer-events-none absolute" style={{ left: markerX, top: markerY, transform: "translate(-50%, -50%)" }}>
        <svg width="38" height="38" viewBox="0 0 40 40" role="img" aria-label={fresh ? "Reported aircraft position" : "Last reported aircraft position"}>
          <circle cx="20" cy="20" r="18" fill={fresh ? "#0b4f73" : "#59616b"} stroke="white" strokeWidth="3" />
          <path d="M20 8l3 9 10 6v3l-11-3v6l4 3v2l-6-2-6 2v-2l4-3v-6-0l-11 3v-3l10-6z" fill="white" transform={`rotate(${point.track ?? 0} 20 20)`} />
        </svg>
      </div>}
      {visibleTileError && <p role="status" className="absolute inset-x-2 top-2 rounded-lg bg-surface px-3 py-2 text-xs text-fg">Some airport map detail could not load.</p>}
      <div className="absolute inset-x-2 bottom-7 flex flex-wrap items-center gap-1" onPointerDown={event => event.stopPropagation()}>
        <button type="button" className={controls} aria-pressed={following && fresh} disabled={!fresh} onClick={() => { setFollowing(true); if (target) setCenter(target); }}>{following && fresh ? "Following" : "Follow aircraft"}</button>
        <button type="button" className={controls} onClick={() => { setFollowing(false); setCenter(airportPoint); setZoom(14); }}>Airport</button>
        <div className="ml-auto flex gap-1"><button type="button" className={controls} aria-label="Zoom in airport map" disabled={zoom >= 19} onClick={() => setZoom(z => Math.min(19, Math.floor(z) + 1))}>+</button><button type="button" className={controls} aria-label="Zoom out airport map" disabled={zoom <= 12} onClick={() => setZoom(z => Math.max(12, Math.ceil(z) - 1))}>−</button></div>
      </div>
      <a className="absolute inset-x-0 bottom-0 bg-white/95 px-2 py-1 text-center text-[9px] text-[#263238]" href="https://goto.arcgisonline.com/maps/World_Imagery" target="_blank" rel="noreferrer noopener" onPointerDown={event => event.stopPropagation()}>Imagery: Esri, Vantor, Earthstar Geographics, GIS community</a>
    </div>
  </div>;
}
