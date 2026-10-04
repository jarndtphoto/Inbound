import { InboundNearbyResponseSchema, type InboundNearbyResponse, type PublicFeaturedFlight, type PublicRadarTarget } from "./nearby-response";
import { deriveRadarDisplayPosition, projectRadarPoint, RADAR_AIRPORTS, radarLabels, radarRouteText, radarSelectionForClick, radarSelectionSnapshot, type RadarPoint } from "./radar-renderer";

type View = "radar" | "flights";
type DisplayMode = "inline" | "fullscreen" | "pip";
type WidgetState = { version: 3; areaId: InboundNearbyResponse["area"]["id"]; selectedRadarId: string | null; views: Record<DisplayMode, View>; paused: boolean };
type HostContext = { displayMode: DisplayMode; availableDisplayModes: string[] };
type OpenAi = { widgetState?: Partial<WidgetState>; toolOutput?: unknown; setWidgetState?: (state: WidgetState) => void; callTool?: (name: string, args: object) => Promise<unknown>; requestClose?: () => void };
declare global { interface Window { __INBOUND_RADAR_INITIAL__: InboundNearbyResponse; openai?: OpenAi; inboundRadarProof?: { read: () => object; refresh: () => Promise<void> } } }

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id); if (!node) throw new Error(`Missing Radar element: ${id}`); return node as T;
};
const initial = InboundNearbyResponseSchema.parse(window.__INBOUND_RADAR_INITIAL__);
const host = () => window.openai;
let saved: Partial<WidgetState> = host()?.widgetState || {};
if (!host()?.widgetState) { try { saved = JSON.parse(sessionStorage.getItem("inbound-radar-preview-v3") || "{}"); } catch { /* host may deny storage */ } }
const validView = (view: unknown): view is View => view === "radar" || view === "flights";
const validArea = (area: unknown): area is WidgetState["areaId"] => ["preset:chicago", "airport:KORD", "airport:KMDW"].includes(String(area));
const state: WidgetState = {
  version: 3, areaId: validArea(saved.areaId) ? saved.areaId : initial.area.id,
  selectedRadarId: typeof saved.selectedRadarId === "string" ? saved.selectedRadarId : null,
  views: { inline: validView(saved.views?.inline) ? saved.views.inline : "flights", fullscreen: validView(saved.views?.fullscreen) ? saved.views.fullscreen : "radar", pip: validView(saved.views?.pip) ? saved.views.pip : "flights" }, paused: saved.paused === true,
};
let board = initial, dismissed = false, busy = false, refreshCalls = 0, frameCount = 0, requestGeneration = 0;
let timer: ReturnType<typeof setTimeout> | null = null, ageTimer: ReturnType<typeof setInterval> | null = null, frame: number | null = null;
let abort: AbortController | null = null, mapKey = "", hostReady = false, hostOrigin: string | null = null, sequence = 0;
let selectedTarget: PublicRadarTarget | null = null, selectedFeatured: PublicFeaturedFlight | null = null;
let hostContext: HostContext = { displayMode: "inline", availableDisplayModes: [] };
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
let displayPositions: Array<{ radarId: string; latitude: number; longitude: number; altitudeFt: number | null; extrapolatedSeconds: number; stopped: boolean }> = [];
let labelIds: string[] = [];
let radarHitTargets: Array<{ radarId: string; point: RadarPoint }> = [];
const targetOrigin = () => hostOrigin && hostOrigin !== "null" ? hostOrigin : "*";
const displayMode = (): DisplayMode => ["inline", "fullscreen", "pip"].includes(hostContext.displayMode) ? hostContext.displayMode : "inline";
const currentView = () => state.views[displayMode()];
const liveAge = (observedAt: string) => Math.max(0, (Date.now() - Date.parse(observedAt)) / 1_000);
const wanted = () => !dismissed && !state.paused && !document.hidden;
const liveFeaturedAge = (card: PublicFeaturedFlight) => { const fix = board.radarTargets.find(target => target.radarId === card.radarId); return fix ? liveAge(fix.observedAt) : card.freshness.ageSeconds + liveAge(board.generatedAt); };
const save = () => { try { const copy = { ...state, views: { ...state.views } }; host()?.setWidgetState ? host()!.setWidgetState!(copy) : sessionStorage.setItem("inbound-radar-preview-v3", JSON.stringify(copy)); } catch { /* local persistence is optional */ } };
function rpc(method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error("Host request timed out")); }, 5_000);
    pending.set(id, { resolve, reject, timeout }); window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, targetOrigin());
  });
}
const notify = (method: string, params: object = {}) => { if (window.parent !== window) window.parent.postMessage({ jsonrpc: "2.0", method, params }, targetOrigin()); };
const altitudeText = (ft: number | null) => ft === null ? "Altitude unavailable" : `${Math.round(ft).toLocaleString("en-US")} ft`;
const trendText = (motion: PublicRadarTarget["motion"]) => ({ rising: "rising", falling: "falling", level: "level", unknown: "vertical trend unavailable" }[motion.verticalTrend]);
function updateSelection() {
  const selected = radarSelectionSnapshot(state.selectedRadarId, board.radarTargets, board.featuredFlights, selectedTarget, selectedFeatured);
  selectedTarget = selected.target; selectedFeatured = selected.featured;
}
function selectAircraft(radarId: string) { state.selectedRadarId = radarId; updateSelection(); save(); render(); }
function setView(view: View) { if (dismissed) return; state.views[displayMode()] = view; save(); render(); }
function svgElement(tag: string, attributes: Record<string, string | number> = {}, text = ""): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text) node.textContent = text; return node;
}
function hostControls() {
  el("proof").dataset.displayMode = displayMode();
  el<HTMLButtonElement>("pip").disabled = dismissed || !hostReady || !hostContext.availableDisplayModes.includes("pip");
  el<HTMLButtonElement>("fullscreen").disabled = dismissed || !hostReady || !hostContext.availableDisplayModes.includes("fullscreen");
  el("fullscreen").textContent = displayMode() === "fullscreen" ? "Return inline" : "Expand";
  el("host-status").textContent = hostReady ? `Host bridge connected · ${displayMode()}. Picture-in-Picture requires an advertised host capability. Manual ChatGPT testing is pending.` : "Inline fallback. Fullscreen and Picture-in-Picture are unavailable until the host advertises them.";
}
function paintMap(width: number, height: number) {
  const map = el("radar-map"); map.replaceChildren(); map.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const project = (latitude: number, longitude: number) => projectRadarPoint({ latitude, longitude }, board.area.reference, width, height, board.area.radiusNm)!;
  const shoreline = [[42.6, -87.85], [42.28, -87.825], [42.1, -87.71], [41.93, -87.63], [41.88, -87.61], [41.7, -87.52], [41.5, -87.20], [41.2, -86.95], [41.2, -85.5], [42.6, -85.5]];
  map.append(svgElement("polygon", { class: "lake", points: shoreline.map(([lat, lon]) => { const p = project(lat, lon); return `${p.x},${p.y}`; }).join(" ") }));
  for (const fraction of [.5, 1]) map.append(svgElement("circle", { class: "range-ring", cx: width / 2, cy: height / 2, r: (Math.min(width, height) - 56) / 2 * fraction }));
  map.append(svgElement("line", { class: "map-grid", x1: 0, y1: height / 2, x2: width, y2: height / 2 }), svgElement("line", { class: "map-grid", x1: width / 2, y1: 0, x2: width / 2, y2: height }));
  const city = project(41.8819, -87.6278);
  if (city.inView) map.append(svgElement("circle", { class: "reference-point", cx: city.x, cy: city.y, r: 2 }), svgElement("text", { class: "city-label", x: city.x + 7, y: city.y + 18 }, "Chicago"));
  const lake = project(42.06, -87.35);
  if (lake.inView) map.append(svgElement("text", { class: "map-label", x: lake.x, y: lake.y, "text-anchor": "middle" }, "LAKE MICHIGAN"));
  for (const airport of RADAR_AIRPORTS) {
    const p = project(airport.latitude, airport.longitude); if (!p.inView) continue;
    const group = svgElement("g", { "data-airport": airport.code, "data-primary": String(airport.areaId === board.area.id), transform: `translate(${p.x} ${p.y})` });
    group.append(svgElement("rect", { class: `airport-shape${airport.areaId === board.area.id ? " airport-primary" : ""}`, x: -5, y: -5, width: 10, height: 10, rx: 2 }), svgElement("text", { class: "airport-label", x: 9, y: 4 }, airport.code)); map.append(group);
  }
}
function renderRadar() {
  const nowMs = Date.now();
  displayPositions = board.radarTargets.flatMap(target => {
    const display = deriveRadarDisplayPosition(target, nowMs, board.health, board.generatedAt);
    return display ? [{ radarId: target.radarId, latitude: display.latitude, longitude: display.longitude, altitudeFt: display.altitudeFt, extrapolatedSeconds: display.extrapolatedSeconds, stopped: display.stopped }] : [];
  });
  if (currentView() !== "radar" || dismissed) return;
  const surface = el("radar-surface"), width = surface.clientWidth, height = surface.clientHeight; if (!width || !height) return;
  const key = JSON.stringify([board.area, width, height]); if (key !== mapKey) { mapKey = key; paintMap(width, height); }
  const byId = new Map(displayPositions.map(display => [display.radarId, display]));
  const shown = board.radarTargets.flatMap(target => {
    if (liveAge(target.observedAt) > 120) return [];
    const display = byId.get(target.radarId), point = display && projectRadarPoint(display, board.area.reference, width, height, board.area.radiusNm);
    return point?.inView ? [{ target, point }] : [];
  });
  radarHitTargets = shown.map(({ target, point }) => ({ radarId: target.radarId, point }));
  const markers = el("radar-markers");
  for (const button of Array.from(markers.children)) if (!shown.some(({ target }) => target.radarId === (button as HTMLElement).dataset.radarId)) button.remove();
  const labels = radarLabels(shown.map(({ target, point }) => ({ ...target, point })), state.selectedRadarId, width, height);
  labelIds = labels.map(label => label.radarId);
  for (const { target, point } of shown) {
    let button = Array.from(markers.children).find(node => (node as HTMLElement).dataset.radarId === target.radarId) as HTMLButtonElement | undefined;
    if (!button) {
      button = document.createElement("button"); button.className = "aircraft-marker"; button.dataset.radarId = target.radarId;
      const glyph = svgElement("svg", { class: "aircraft-glyph", viewBox: "-12 -12 24 24", "aria-hidden": "true" }); glyph.append(svgElement("path"));
      const label = document.createElement("span"); label.className = "marker-label";
      label.append(document.createElement("span"), document.createElement("small")); button.append(glyph, label); button.onclick = event => {
        const bounds = surface.getBoundingClientRect();
        const pickedId = radarSelectionForClick(target.radarId, { detail: event.detail, x: event.clientX - bounds.left, y: event.clientY - bounds.top }, radarHitTargets);
        if (event.detail > 0) (Array.from(markers.children).find(node => (node as HTMLElement).dataset.radarId === pickedId) as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
        selectAircraft(pickedId);
      }; markers.append(button);
    }
    const picked = target.radarId === state.selectedRadarId, stale = board.health === "stale" || liveAge(target.observedAt) > 45;
    button.style.left = `${point.x}px`; button.style.top = `${point.y}px`; button.setAttribute("aria-pressed", String(picked)); button.dataset.stale = String(stale);
    button.dataset.track = target.groundTrackDeg === null ? "neutral" : String(target.groundTrackDeg);
    button.setAttribute("aria-label", `${target.displayIdent}, ${altitudeText(target.altitudeFt)}, ${target.motion.label}, ${trendText(target.motion)}, ${target.groundTrackDeg === null ? "track unavailable" : `track ${Math.round(target.groundTrackDeg)} degrees`}${stale ? ", stale observation" : ""}`);
    const glyph = button.querySelector<SVGElement>(".aircraft-glyph")!; glyph.style.transform = target.groundTrackDeg === null ? "" : `rotate(${target.groundTrackDeg}deg)`;
    glyph.firstElementChild!.setAttribute("d", target.groundTrackDeg === null ? "M0 -8 8 0 0 8 -8 0Z" : "M0 -11 3 -2 10 3 10 5 3 3 2 8 5 10 5 11 0 9 -5 11 -5 10 -2 8 -3 3 -10 5 -10 3 -3 -2Z");
    const label = button.querySelector<HTMLElement>(".marker-label")!, placement = labels.find(item => item.radarId === target.radarId); label.hidden = !placement;
    if (placement) { label.style.left = `${placement.x - point.x + 22}px`; label.style.top = `${placement.y - point.y + 22}px`; label.style.width = `${placement.width}px`; }
    label.querySelector("span")!.textContent = `${target.displayIdent}${picked ? " ✓" : ""}`; label.querySelector("small")!.textContent = target.altitudeFt === null ? "Altitude unavailable" : `${(target.altitudeFt / 1_000).toFixed(1)}k ft`;
  }
  el("radar-reference").textContent = board.area.reference.label; el("radar-range").textContent = `${board.area.radiusNm} nm view`;
  el("radar-surface").setAttribute("aria-label", `Invented aircraft radar around ${board.area.reference.label}`);
  el("radar-empty").hidden = shown.length > 0; el("radar-empty").textContent = board.health === "unavailable" ? "Current aircraft data is temporarily unavailable. Coverage is not empty sky." : "No current observations in this view. Coverage may be limited.";
}
function renderCards() {
  const cards = el("cards"), visible = board.featuredFlights.filter(card => liveFeaturedAge(card) <= 120);
  for (const button of Array.from(cards.children)) if (!visible.some(card => card.radarId === (button as HTMLElement).dataset.radarId)) button.remove();
  for (const [index, card] of visible.entries()) {
    let button = Array.from(cards.children).find(node => (node as HTMLElement).dataset.radarId === card.radarId) as HTMLButtonElement | undefined;
    if (!button) {
      button = document.createElement("button"); button.className = "card"; button.dataset.radarId = card.radarId;
      const top = document.createElement("span"); top.className = "card-top";
      for (const name of ["ident", "altitude"]) { const span = document.createElement("span"); span.className = name; top.append(span); }
      const route = document.createElement("span"); route.className = "route"; const bottom = document.createElement("span"); bottom.className = "card-bottom";
      for (let i = 0; i < 3; i++) bottom.append(document.createElement("span")); button.append(top, route, bottom); button.onclick = () => selectAircraft(card.radarId);
    }
    const distance = `${(card.distanceNm * 1.150779448).toFixed(1)} mi from ${board.area.reference.label}`;
    button.setAttribute("aria-pressed", String(state.selectedRadarId === card.radarId)); button.setAttribute("aria-label", `${card.displayIdent}, ${radarRouteText(card.route)}, ${altitudeText(card.altitudeFt)}, ${distance}`);
    button.querySelector(".ident")!.textContent = card.displayIdent; button.querySelector(".altitude")!.textContent = altitudeText(card.altitudeFt); button.querySelector(".route")!.textContent = radarRouteText(card.route);
    const texts = [card.motion.label, distance, `Updated ${Math.floor(liveFeaturedAge(card))} sec ago`];
    Array.from(button.querySelector(".card-bottom")!.children).forEach((span, i) => { span.textContent = texts[i]; });
    if (cards.children[index] !== button) cards.insertBefore(button, cards.children[index] || null);
  }
  el("flights-empty").hidden = visible.length > 0;
}
function renderSelection() {
  updateSelection(); const picked = selectedTarget, expired = picked && liveAge(picked.observedAt) > 120;
  const present = picked && board.radarTargets.some(target => target.radarId === picked.radarId);
  el("selected").hidden = dismissed || currentView() !== "radar" && !state.selectedRadarId;
  el("selected-ident").textContent = picked ? picked.displayIdent : state.selectedRadarId ? "Selected aircraft unavailable" : "Select an aircraft";
  el("selected-route").textContent = picked ? radarRouteText(selectedFeatured?.route) : "Tap a marker or Featured card to see its observation.";
  el("selected-altitude").textContent = picked ? altitudeText(picked.altitudeFt) : "";
  el("selected-motion").textContent = picked ? `${picked.motion.label} · ${trendText(picked.motion)}` : "";
  el("selected-distance").textContent = picked && present && selectedFeatured ? `${(selectedFeatured.distanceNm * 1.150779448).toFixed(1)} mi from ${board.area.reference.label}` : "";
  el("selected-age").textContent = picked ? expired ? "Observation expired. Last accepted observation retained for this selection." : !present ? "No current observation in this area. Last accepted observation retained." : `${board.health === "stale" || liveAge(picked.observedAt) > 45 ? "Stale · " : ""}Updated ${Math.floor(liveAge(picked.observedAt))} sec ago` : state.selectedRadarId ? "Selection is retained; no current observation is available." : "";
  el("selected-track").textContent = picked ? picked.groundTrackDeg === null ? "Track unavailable · Neutral symbol" : `Track ${Math.round(picked.groundTrackDeg)}° · ${picked.groundspeedKt === null ? "Speed unavailable" : `${Math.round(picked.groundspeedKt)} kt`}` : "";
  el("selection-note").textContent = state.selectedRadarId ? `Focused: ${picked?.displayIdent || "selected aircraft"}${expired ? " — observation expired" : ""}. Selection stays with you in Radar and Flights.` : "Select an aircraft to focus it locally.";
}
function render() {
  hostControls(); const view = currentView();
  el("area-title").textContent = board.area.id === "airport:KORD" ? "Near ORD" : board.area.id === "airport:KMDW" ? "Near MDW" : "Near Chicago";
  el("reference").textContent = `Distances from ${board.area.reference.label}`; el<HTMLSelectElement>("area").value = state.areaId;
  el("pause").textContent = state.paused ? "Resume" : "Pause"; el<HTMLButtonElement>("refresh").disabled = dismissed || busy; el<HTMLButtonElement>("pause").disabled = dismissed; el<HTMLSelectElement>("area").disabled = dismissed;
  for (const name of ["radar", "flights"] as const) { const tab = el<HTMLButtonElement>(`view-${name}`); tab.setAttribute("aria-selected", String(view === name)); tab.tabIndex = view === name ? 0 : -1; tab.disabled = dismissed; el(`${name}-panel`).hidden = dismissed || view !== name; }
  el("content").dataset.view = view;
  const current = board.radarTargets.filter(target => liveAge(target.observedAt) <= 120);
  el("view-count").textContent = `${current.length} aircraft · ${board.featuredFlights.length} Featured`;
  const message = { ok: "Available coverage · Invented aircraft", partial: "Some coverage is limited. Available aircraft remain visible.", stale: "Last accepted observations · Motion stopped while updates are delayed.", unavailable: "Current aircraft data is temporarily unavailable. This does not mean empty sky." }[board.health];
  el("board-notice").textContent = dismissed ? "Preview dismissed. Refresh stopped." : document.hidden || state.paused ? "Refresh paused. Accepted observations continue to age." : !current.length && board.health !== "unavailable" ? "Accepted observations have expired. Current coverage is unavailable." : board.warning || (board.health === "ok" && current.some(target => liveAge(target.observedAt) > 45) ? "Last accepted observations are aging. Bounded motion has stopped." : message);
  el("proof-status").textContent = `Nearby refresh calls: ${refreshCalls}. Shared collection version: ${board.collectionVersion ?? "warming"}. This UI sends no chat messages or model requests.`;
  renderCards(); renderSelection(); renderRadar();
}
function stopPolling() { if (timer !== null) clearTimeout(timer); if (ageTimer !== null) clearInterval(ageTimer); timer = null; ageTimer = null; requestGeneration++; abort?.abort(); abort = null; }
function schedule() {
  stopPolling(); if (dismissed || document.hidden) return; ageTimer = setInterval(render, 1_000); if (!wanted()) return;
  timer = setTimeout(async () => { timer = null; await refresh(); schedule(); }, 20_000);
}
function accept(result: unknown) {
  const value = result && typeof result === "object" && "structuredContent" in result ? (result as { structuredContent: unknown }).structuredContent : result;
  const parsed = InboundNearbyResponseSchema.safeParse(value); if (!parsed.success) return;
  board = parsed.data; state.areaId = board.area.id; updateSelection(); save(); render();
}
async function refresh() {
  if (!wanted() || busy) return; busy = true; const generation = requestGeneration; render();
  const area = state.areaId;
  try {
    let result: unknown;
    if (hostReady) result = await rpc("tools/call", { name: "get_nearby_flights", arguments: { area, limit: 4 } });
    else if (host()?.callTool) result = await host()!.callTool!("get_nearby_flights", { area, limit: 4 });
    else if (window.parent === window) {
      abort = new AbortController(); const response = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, signal: abort.signal, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: "get_nearby_flights", arguments: { area, limit: 4 } } }) });
      if (!response.ok) throw new Error("Nearby refresh unavailable"); result = (await response.json()).result;
    } else { el("host-status").textContent = "No callable host bridge. Periodic refresh is unavailable; accepted positions remain bounded."; return; }
    refreshCalls++; if (generation === requestGeneration && wanted()) accept(result);
  } catch { if (wanted()) el("board-notice").textContent = "Refresh temporarily unavailable. Last accepted positions remain bounded and continue to age."; }
  finally { busy = false; abort = null; el<HTMLButtonElement>("refresh").disabled = dismissed; }
}
async function display(mode: DisplayMode) {
  if (!hostReady || !hostContext.availableDisplayModes.includes(mode)) return;
  try { const result = await rpc("ui/request-display-mode", { mode }) as { mode?: DisplayMode }; if (result?.mode && ["inline", "fullscreen", "pip"].includes(result.mode)) hostContext.displayMode = result.mode; render(); schedule(); }
  catch { el("host-status").textContent = "Host declined the display request. The current view remains available."; }
}
function animate() { if (dismissed || document.hidden) { frame = null; return; } frameCount++; renderRadar(); frame = requestAnimationFrame(animate); }
el("view-radar").onclick = () => setView("radar"); el("view-flights").onclick = () => setView("flights");
for (const view of ["radar", "flights"] as const) el(`view-${view}`).onkeydown = event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
  const next = event.key === "Home" ? "radar" : event.key === "End" ? "flights" : view === "radar" ? "flights" : "radar"; setView(next); el(`view-${next}`).focus();
};
el("pip").onclick = () => { void display("pip"); }; el("fullscreen").onclick = () => { void display(displayMode() === "fullscreen" ? "inline" : "fullscreen"); };
el("refresh").onclick = async () => { await refresh(); schedule(); };
el("pause").onclick = async () => { state.paused = !state.paused; save(); render(); if (!state.paused) await refresh(); schedule(); };
el<HTMLSelectElement>("area").onchange = async () => { const area = el<HTMLSelectElement>("area").value; if (!validArea(area)) return; state.areaId = area; save(); stopPolling(); await refresh(); schedule(); };
el("dismiss").onclick = () => { dismissed = true; stopPolling(); if (frame !== null) cancelAnimationFrame(frame); frame = null; save(); render(); host()?.requestClose?.(); };
document.addEventListener("visibilitychange", async () => { stopPolling(); if (frame !== null) cancelAnimationFrame(frame); frame = null; render(); if (wanted()) { await refresh(); schedule(); } if (!dismissed && !document.hidden) frame = requestAnimationFrame(animate); });
window.addEventListener("pagehide", () => { dismissed = true; stopPolling(); if (frame !== null) cancelAnimationFrame(frame); frame = null; save(); });
window.addEventListener("openai:set_globals", event => {
  const globals = (event as CustomEvent<{ globals?: { toolOutput?: unknown; widgetState?: Partial<WidgetState> } }>).detail?.globals;
  if (globals?.toolOutput) accept(globals.toolOutput); const next = globals?.widgetState;
  if (next) { if (typeof next.selectedRadarId === "string" || next.selectedRadarId === null) state.selectedRadarId = next.selectedRadarId; for (const mode of ["inline", "fullscreen", "pip"] as const) if (validView(next.views?.[mode])) state.views[mode] = next.views[mode]; render(); }
});
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0" || hostOrigin && event.origin !== hostOrigin) return;
  const message = event.data;
  if (pending.has(message.id) && ("result" in message || "error" in message)) {
    const request = pending.get(message.id)!; pending.delete(message.id); clearTimeout(request.timeout); if (!hostOrigin) hostOrigin = event.origin;
    message.error ? request.reject(new Error("Host request failed")) : request.resolve(message.result); return;
  }
  if (!hostReady) return;
  if (message.method === "ui/notifications/tool-result" && wanted()) accept(message.params);
  if (message.method === "ui/notifications/host-context-changed") { hostContext = { ...hostContext, ...message.params }; render(); schedule(); }
  if (message.method === "ui/resource-teardown") { dismissed = true; stopPolling(); if (frame !== null) cancelAnimationFrame(frame); frame = null; save(); render(); window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, targetOrigin()); }
});
new ResizeObserver(() => renderRadar()).observe(el("radar-surface"));
window.inboundRadarProof = {
  read: () => ({ selectedRadarId: state.selectedRadarId, selectedView: currentView(), views: { ...state.views }, areaId: board.area.id, collectionVersion: board.collectionVersion, health: board.health, positions: board.radarTargets.map(target => ({ radarId: target.radarId, latitude: target.latitude, longitude: target.longitude, observedAt: target.observedAt, altitudeFt: target.altitudeFt, groundspeedKt: target.groundspeedKt, groundTrackDeg: target.groundTrackDeg, positionKind: target.positionKind })), displayPositions: displayPositions.map(position => ({ ...position })), labelIds: [...labelIds], refreshCalls, pollScheduled: timer !== null, displayMode: displayMode(), hostReady, frameCount, paused: state.paused, dismissed }), refresh,
};
const restoredArea = state.areaId;
save(); accept(host()?.toolOutput || initial); state.areaId = restoredArea; render(); schedule(); frame = requestAnimationFrame(animate);
if (window.parent !== window) void rpc("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Inbound invented Radar proof", version: "0.3.0" }, appCapabilities: { availableDisplayModes: ["inline", "pip", "fullscreen"] } }).then(value => {
  const result = value as { hostContext?: Partial<HostContext> }; hostReady = true; hostContext = { ...hostContext, ...result.hostContext }; notify("ui/notifications/initialized"); render(); schedule();
}).catch(() => hostControls());
if (state.areaId !== board.area.id) void refresh();
