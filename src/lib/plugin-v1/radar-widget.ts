import { InboundNearbyResponseSchema, type InboundNearbyResponse, type PublicFeaturedFlight, type PublicRadarTarget } from "./nearby-response";
import { FlightResultV1Schema, type FlightCandidateV1, type FlightResultV1, type InboundFlightV1 } from "./contracts";
import { deriveRadarDisplayPosition, projectRadarPoint, RADAR_AIRPORTS, radarLabels, radarRouteText, radarSelectionForClick, radarSelectionSnapshot, type RadarPoint } from "./radar-renderer";

type View = "radar" | "flights";
type DisplayMode = "inline" | "fullscreen" | "pip";
type WidgetState = { version: 4; areaId: InboundNearbyResponse["area"]["id"]; selectedRadarId: string | null; views: Record<DisplayMode, View>; paused: boolean };
type HostContext = { displayMode: DisplayMode; availableDisplayModes: string[] };
type OpenAi = { widgetState?: Partial<WidgetState>; toolOutput?: unknown; setWidgetState?: (state: WidgetState) => void; callTool?: (name: string, args: object) => Promise<unknown>; requestClose?: () => void };
type AcceptOutcome = { accepted: boolean; trajectoryAdvanced: boolean };
type RefreshOutcome = AcceptOutcome & { started: boolean };
type HandoffRequestType = "resolve" | "choice" | "instance";
type ActiveHandoffRequest = Readonly<{ id: number; type: HandoffRequestType; expectedRadarId: string; credentialFingerprint: string; startedAt: number }>;
declare global { interface Window { __INBOUND_RADAR_INITIAL__: InboundNearbyResponse; openai?: OpenAi; inboundRadarProof?: { read: () => object } } }

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id); if (!node) throw new Error(`Missing Radar element: ${id}`); return node as T;
};
const initial = InboundNearbyResponseSchema.parse(window.__INBOUND_RADAR_INITIAL__);
const host = () => window.openai;
let saved: Partial<WidgetState> = host()?.widgetState || {};
if (!host()?.widgetState) { try { saved = JSON.parse(sessionStorage.getItem("inbound-radar-preview-v4") || "{}"); } catch { /* host may deny storage */ } }
const validView = (view: unknown): view is View => view === "radar" || view === "flights";
const validArea = (area: unknown): area is WidgetState["areaId"] => ["preset:chicago", "airport:KORD", "airport:KMDW"].includes(String(area));
const state: WidgetState = {
  version: 4, areaId: validArea(saved.areaId) ? saved.areaId : initial.area.id,
  selectedRadarId: typeof saved.selectedRadarId === "string" ? saved.selectedRadarId : null,
  views: { inline: validView(saved.views?.inline) ? saved.views.inline : "flights", fullscreen: validView(saved.views?.fullscreen) ? saved.views.fullscreen : "radar", pip: validView(saved.views?.pip) ? saved.views.pip : "flights" }, paused: saved.paused === true,
};
let board = initial, dismissed = false, pageInactive = false, refreshCalls = 0, frameCount = 0, requestGeneration = 0;
let timer: ReturnType<typeof setTimeout> | null = null, ageTimer: ReturnType<typeof setInterval> | null = null, frame: number | null = null;
let timerToken: number | null = null, ageTimerToken: number | null = null, timerSequence = 0, ageTimerSequence = 0;
const pendingPollTimers = new Set<number>(), pendingAgeTimers = new Set<number>();
let maxPendingPollTimers = 0, maxPendingAgeTimers = 0, pollTimerFires = 0, ageTimerFires = 0;
let abort: AbortController | null = null, activeRequestGeneration: number | null = null, nextPollAt: number | null = null, pollScheduleEpoch = 0;
let nextPollKind: "normal" | "short-retry" | null = null, motionRetryTrajectoryKey: string | null = null;
let motionRetryCount = 0, lastMotionRetryAt: number | null = null, shortRetrySchedules = 0, shortRetryFires = 0;
let mapKey = "", hostReady = false, hostOrigin: string | null = null, sequence = 0;
let selectedTarget: PublicRadarTarget | null = null, selectedFeatured: PublicFeaturedFlight | null = null;
let handoffMode: "nearby" | "loading" | "ambiguous" | "detail" | "error" = "nearby";
let handoffResult: FlightResultV1 | null = null, handoffCalls = 0;
let activeHandoffRequest: ActiveHandoffRequest | null = null, handoffRequestSequence = 0;
let ignoredHandoffReplays = 0, ignoredHandoffResponses = 0, appliedHandoffResponses = 0, canceledHandoffRequests = 0;
const resolvedInstances = new Map<string, string>();
let hostContext: HostContext = { displayMode: "inline", availableDisplayModes: [] };
let latestAcceptedVersion = initial.collectionVersion, latestAcceptedGeneratedAt = Date.parse(initial.generatedAt);
let acceptedResults = 0, rejectedResults = 0, globalsEvents = 0, hostContextEvents = 0;
let lastRejectedReason: string | null = null;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
let displayPositions: Array<{ radarId: string; latitude: number; longitude: number; altitudeFt: number | null; extrapolatedSeconds: number; stopped: boolean }> = [];
let labelIds: string[] = [];
let radarHitTargets: Array<{ radarId: string; point: RadarPoint }> = [];
const targetOrigin = () => hostOrigin && hostOrigin !== "null" ? hostOrigin : "*";
const displayMode = (): DisplayMode => ["inline", "fullscreen", "pip"].includes(hostContext.displayMode) ? hostContext.displayMode : "inline";
const currentView = () => state.views[displayMode()];
const liveAge = (observedAt: string) => Math.max(0, (Date.now() - Date.parse(observedAt)) / 1_000);
const NORMAL_POLL_MS = 20_000, FIRST_MOTION_RETRY_MS = 3_000, MOTION_RETRY_INTERVAL_MS = 4_000;
const MOTION_RETRY_WINDOW_MS = 7_000, MAX_MOTION_RETRIES = 3, MOTION_BOUND_MS = 25_000;
const trajectoryKey = (value: InboundNearbyResponse) => JSON.stringify([value.collectionVersion,
  Math.max(...value.radarTargets.map(target => Date.parse(target.observedAt)), Number.NEGATIVE_INFINITY)]);
const resetMotionRetryState = (key: string) => { motionRetryTrajectoryKey = key; motionRetryCount = 0; lastMotionRetryAt = null; };
const syncMotionRetryState = () => {
  const key = trajectoryKey(board); if (motionRetryTrajectoryKey !== key) resetMotionRetryState(key); return key;
};
const motionCapDeadline = () => {
  if (board.health !== "ok" && board.health !== "partial") return null;
  const deadlines = board.radarTargets.flatMap(target => target.groundTrackDeg !== null && target.groundspeedKt !== null && target.groundspeedKt > 0
    ? [Date.parse(target.observedAt) + MOTION_BOUND_MS] : []);
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
};
const nearMotionBound = () => {
  const deadline = motionCapDeadline(); return deadline !== null && deadline - Date.now() <= MOTION_RETRY_WINDOW_MS;
};
const nextMotionRetryDeadline = () => {
  syncMotionRetryState();
  if (!nearMotionBound() || motionRetryCount >= MAX_MOTION_RETRIES) return null;
  const now = Date.now();
  return lastMotionRetryAt === null ? now + FIRST_MOTION_RETRY_MS : Math.max(now, lastMotionRetryAt + MOTION_RETRY_INTERVAL_MS);
};
const wanted = () => !dismissed && !pageInactive && !state.paused && !document.hidden;
const animationWanted = () => !dismissed && !pageInactive && !document.hidden;
const liveFeaturedAge = (card: PublicFeaturedFlight) => { const fix = board.radarTargets.find(target => target.radarId === card.radarId); return fix ? liveAge(fix.observedAt) : card.freshness.ageSeconds + liveAge(board.generatedAt); };
const save = () => { try { const copy = { ...state, views: { ...state.views } }; host()?.setWidgetState ? host()!.setWidgetState!(copy) : sessionStorage.setItem("inbound-radar-preview-v4", JSON.stringify(copy)); } catch { /* local persistence is optional */ } };
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
function selectAircraft(radarId: string) { cancelActiveHandoff(); state.selectedRadarId = radarId; handoffMode = "nearby"; handoffResult = null; updateSelection(); save(); render(); ensureAnimationLoop(); }
function setView(view: View) { if (dismissed) return; state.views[displayMode()] = view; save(); render(); ensureAnimationLoop(); }
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
  const selection = picked?.selection, tokenExpired = selection?.expiresAt ? Date.parse(selection.expiresAt) <= Date.now() : false;
  const knownInstance = picked ? resolvedInstances.get(picked.radarId) : null;
  const actionable = Boolean(picked && (knownInstance || selection?.state !== "unsupported" && selection?.token && !tokenExpired));
  const track = el<HTMLButtonElement>("track-flight"); track.disabled = !actionable || handoffMode === "loading"; track.textContent = knownInstance ? "View flight" : handoffMode === "loading" ? "Loading…" : "Track flight";
  el("track-notice").textContent = !picked ? "Select an aircraft, then explicitly load its invented flight."
    : selection?.state === "unsupported" ? "Detailed tracking is not supported for this invented aircraft."
      : tokenExpired ? "This observation handle expired. Refresh Nearby to select a current observation."
        : "Tracking starts only when you choose Track flight; selecting alone never refreshes a provider.";
  el("selection-note").textContent = state.selectedRadarId ? `Focused: ${picked?.displayIdent || "selected aircraft"}${expired ? " — observation expired" : ""}. Selection stays with you in Radar and Flights.` : "Select an aircraft to focus it locally.";
}
const factValue = (value: { value: unknown } | null) => value ? String(value.value) : "Unavailable";
const eventValue = (event: InboundFlightV1["times"]["landing"]) => event.providerActual?.value ?? event.detected?.value ?? event.providerEstimated?.value ?? event.inboundEstimated?.value ?? event.scheduled?.value ?? null;
function renderHandoff() {
  const panel = el("handoff-panel"); panel.hidden = handoffMode === "nearby";
  el("content").hidden = handoffMode !== "nearby"; el("selection-note").hidden = handoffMode !== "nearby";
  const candidates = el("candidate-list"); candidates.replaceChildren(); el("detail-grid").hidden = handoffMode !== "detail";
  el("handoff-error").textContent = "";
  if (handoffMode === "nearby") return;
  if (handoffMode === "loading") { el("handoff-kicker").textContent = "Invented flight"; el("detail-ident").textContent = selectedTarget?.displayIdent ?? "Flight detail"; el("detail-route").textContent = "Resolving the exact selected occurrence…"; el("handoff-status").textContent = "One bounded read-only handoff is in progress."; return; }
  if (!handoffResult) return;
  if (handoffResult.status === "ambiguous") {
    el("handoff-kicker").textContent = "Choose a dated occurrence"; el("detail-ident").textContent = selectedTarget?.displayIdent ?? "Ambiguous flight";
    el("detail-route").textContent = "The aircraft evidence matches more than one invented dated leg."; el("handoff-status").textContent = "No flight was chosen automatically.";
    for (const candidate of handoffResult.candidates) {
      const button = document.createElement("button"); button.className = "candidate";
      const label = document.createElement("strong"), detail = document.createElement("span"); label.textContent = `${candidate.displayIdent} · ${candidate.originIata} → ${candidate.destinationIata}`;
      detail.textContent = `${candidate.serviceDate}${candidate.scheduledDepartureAt ? ` · ${new Date(candidate.scheduledDepartureAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`;
      button.append(label, detail); button.onclick = () => { void chooseCandidate(candidate); }; candidates.append(button);
    }
    return;
  }
  if (handoffResult.status !== "resolved" || !handoffResult.flight) {
    el("handoff-kicker").textContent = "Flight unavailable"; el("detail-ident").textContent = selectedTarget?.displayIdent ?? "Selected aircraft";
    el("detail-route").textContent = "The exact invented occurrence was not loaded."; el("handoff-status").textContent = "Back to Radar keeps your area, tab, selection and current board.";
    el("handoff-error").textContent = handoffResult.error?.message ?? "Flight detail is temporarily unavailable."; return;
  }
  const flight = handoffResult.flight, position = flight.position;
  el("handoff-kicker").textContent = `${flight.identity.serviceDate} · Invented fixture`; el("detail-ident").textContent = flight.identity.displayIdent;
  el("detail-route").textContent = `${flight.route.origin.iata} → ${flight.route.destination.iata}`; el("handoff-status").textContent = `Exact occurrence · ${flight.flightInstanceId}`;
  el("detail-status").textContent = flight.status.text; el("detail-phase").textContent = flight.phase.label;
  el("detail-position").textContent = position ? `${position.altitudeFt?.toLocaleString("en-US") ?? "Altitude unavailable"} ft · ${position.groundspeedKt ?? "Speed unavailable"}${position.groundspeedKt === null ? "" : " kt"}` : "Position unavailable";
  el("detail-aircraft").textContent = flight.aircraft?.typeName ?? flight.aircraft?.typeCode ?? "Unavailable";
  el("detail-departure").textContent = `${flight.route.origin.iata} · Gate ${factValue(flight.departure.gate)} · Runway ${flight.departure.runway?.designation ?? "Unavailable"}`;
  el("detail-arrival").textContent = `${flight.route.destination.iata} · Gate ${factValue(flight.arrival.gate)} · Baggage ${factValue(flight.arrival.baggage)}`;
  const landing = eventValue(flight.times.landing); el("detail-landing").textContent = landing ? new Date(landing).toLocaleString() : "Unavailable";
  el("detail-freshness").textContent = flight.freshness.stale ? "Stale snapshot" : `Updated ${Math.floor(flight.freshness.storyAgeSeconds)} sec ago`;
}
function render() {
  hostControls(); const view = currentView();
  el("area-title").textContent = board.area.id === "airport:KORD" ? "Near ORD" : board.area.id === "airport:KMDW" ? "Near MDW" : "Near Chicago";
  el("reference").textContent = `Distances from ${board.area.reference.label}`; el<HTMLSelectElement>("area").value = state.areaId;
  el("pause").textContent = state.paused ? "Resume" : "Pause"; el<HTMLButtonElement>("refresh").disabled = dismissed || activeRequestGeneration === requestGeneration; el<HTMLButtonElement>("pause").disabled = dismissed; el<HTMLSelectElement>("area").disabled = dismissed;
  for (const name of ["radar", "flights"] as const) { const tab = el<HTMLButtonElement>(`view-${name}`); tab.setAttribute("aria-selected", String(view === name)); tab.tabIndex = view === name ? 0 : -1; tab.disabled = dismissed; el(`${name}-panel`).hidden = dismissed || view !== name; }
  el("content").dataset.view = view;
  const current = board.radarTargets.filter(target => liveAge(target.observedAt) <= 120);
  el("view-count").textContent = `${current.length} aircraft · ${board.featuredFlights.length} Featured`;
  const message = { ok: "Available coverage · Invented aircraft", partial: "Some coverage is limited. Available aircraft remain visible.", stale: "Last accepted observations · Motion stopped while updates are delayed.", unavailable: "Current aircraft data is temporarily unavailable. This does not mean empty sky." }[board.health];
  el("board-notice").textContent = dismissed ? "Preview dismissed. Refresh stopped." : document.hidden || state.paused ? "Refresh paused. Accepted observations continue to age." : !current.length && board.health !== "unavailable" ? "Accepted observations have expired. Current coverage is unavailable." : board.warning || (board.health === "ok" && current.some(target => liveAge(target.observedAt) > 45) ? "Last accepted observations are aging. Bounded motion has stopped." : message);
  el("proof-status").textContent = `Nearby refresh calls: ${refreshCalls}. Shared collection version: ${board.collectionVersion ?? "warming"}. This UI sends no chat messages or model requests.`;
  renderCards(); renderSelection(); renderRadar(); renderHandoff();
}
function clearPollingTimers() {
  if (timer !== null) clearTimeout(timer); if (ageTimer !== null) clearInterval(ageTimer);
  if (timerToken !== null) pendingPollTimers.delete(timerToken); if (ageTimerToken !== null) pendingAgeTimers.delete(ageTimerToken);
  timer = null; ageTimer = null; timerToken = null; ageTimerToken = null; pollScheduleEpoch++;
}
function stopPolling() { clearPollingTimers(); requestGeneration++; abort?.abort(); abort = null; }
function schedule(resetDeadline = false) {
  clearPollingTimers(); const epoch = pollScheduleEpoch; if (dismissed || pageInactive || document.hidden) return;
  const nextAgeToken = ++ageTimerSequence; ageTimerToken = nextAgeToken; pendingAgeTimers.add(nextAgeToken); maxPendingAgeTimers = Math.max(maxPendingAgeTimers, pendingAgeTimers.size);
  ageTimer = setInterval(() => { ageTimerFires++; render(); }, 1_000); if (!wanted()) return;
  if (resetDeadline || nextPollAt === null) { nextPollAt = Date.now() + NORMAL_POLL_MS; nextPollKind = "normal"; }
  const nextTimerToken = ++timerSequence; timerToken = nextTimerToken; pendingPollTimers.add(nextTimerToken); maxPendingPollTimers = Math.max(maxPendingPollTimers, pendingPollTimers.size);
  const scheduledKind = nextPollKind;
  const scheduledTrajectoryKey = trajectoryKey(board);
  timer = setTimeout(async () => {
    pendingPollTimers.delete(nextTimerToken); pollTimerFires++;
    if (timerToken === nextTimerToken) { timer = null; timerToken = null; }
    if (epoch !== pollScheduleEpoch) return;
    const retryAttemptAt = Date.now(); nextPollKind = null;
    const generation = requestGeneration, outcome = await refresh();
    if (outcome.started && generation === requestGeneration) {
      if (scheduledKind === "short-retry") shortRetryFires++;
      if (scheduledKind === "short-retry" && !outcome.trajectoryAdvanced && scheduledTrajectoryKey === trajectoryKey(board)) {
        syncMotionRetryState(); motionRetryCount++; lastMotionRetryAt = retryAttemptAt;
      }
      scheduleAfterRefresh(outcome, "attempt");
    }
  }, Math.max(0, nextPollAt - Date.now()));
}
function scheduleAt(deadline: number, kind: "normal" | "short-retry") { nextPollAt = deadline; nextPollKind = kind; schedule(); }
function scheduleNormal() { scheduleAt(Date.now() + NORMAL_POLL_MS, "normal"); }
function scheduleAfterRefresh(outcome: RefreshOutcome, mode: "reset" | "after" | "attempt") {
  syncMotionRetryState(); const now = Date.now(), retryDeadline = nextMotionRetryDeadline();
  const preservedDeadline = mode === "after" && nextPollAt !== null && nextPollAt > now ? nextPollAt : null;
  const preservedKind = preservedDeadline === null ? null : nextPollKind || "normal";
  if (retryDeadline !== null && (preservedDeadline === null || retryDeadline < preservedDeadline)) {
    shortRetrySchedules++; scheduleAt(retryDeadline, "short-retry"); return;
  }
  if (preservedDeadline !== null) { scheduleAt(preservedDeadline, preservedKind!); return; }
  if (outcome.trajectoryAdvanced || mode !== "after" || nextPollAt === null || nextPollAt <= Date.now()) scheduleNormal();
  else schedule();
}
function accept(result: unknown, options: { expectedArea?: WidgetState["areaId"] | null } = {}): AcceptOutcome {
  const value = result && typeof result === "object" && "structuredContent" in result ? (result as { structuredContent: unknown }).structuredContent : result;
  const parsed = InboundNearbyResponseSchema.safeParse(value);
  if (!parsed.success) { rejectedResults++; lastRejectedReason = `schema:${parsed.error.issues.map(issue => issue.message).join("|")}`; return { accepted: false, trajectoryAdvanced: false }; }
  const candidate = parsed.data, expectedArea = options.expectedArea === undefined ? state.areaId : options.expectedArea;
  const candidateGeneratedAt = Date.parse(candidate.generatedAt);
  if (expectedArea !== null && candidate.area.id !== expectedArea) { rejectedResults++; lastRejectedReason = `area:${candidate.area.id}->${expectedArea}`; return { accepted: false, trajectoryAdvanced: false }; }
  if (candidateGeneratedAt < latestAcceptedGeneratedAt) { rejectedResults++; lastRejectedReason = "generatedAt:older"; return { accepted: false, trajectoryAdvanced: false }; }
  if (candidateGeneratedAt === latestAcceptedGeneratedAt && candidate.collectionVersion !== null && latestAcceptedVersion !== null && candidate.collectionVersion < latestAcceptedVersion) {
    rejectedResults++; lastRejectedReason = "collectionVersion:older-at-same-generatedAt"; return { accepted: false, trajectoryAdvanced: false };
  }
  const previousTrajectoryKey = trajectoryKey(board), candidateTrajectoryKey = trajectoryKey(candidate);
  board = candidate;
  if (candidateGeneratedAt > latestAcceptedGeneratedAt) { latestAcceptedGeneratedAt = candidateGeneratedAt; latestAcceptedVersion = candidate.collectionVersion; }
  else if (candidate.collectionVersion !== null) latestAcceptedVersion = latestAcceptedVersion === null ? candidate.collectionVersion : Math.max(latestAcceptedVersion, candidate.collectionVersion);
  acceptedResults++;
  const trajectoryAdvanced = candidateTrajectoryKey !== previousTrajectoryKey;
  if (trajectoryAdvanced) {
    resetMotionRetryState(candidateTrajectoryKey);
    if (nextPollKind === "short-retry") { nextPollAt = Date.now() + NORMAL_POLL_MS; nextPollKind = "normal"; schedule(); }
  }
  updateSelection(); render(); ensureAnimationLoop(); return { accepted: true, trajectoryAdvanced };
}
async function refresh(): Promise<RefreshOutcome> {
  if (!wanted() || activeRequestGeneration === requestGeneration) return { started: false, accepted: false, trajectoryAdvanced: false };
  const generation = requestGeneration; activeRequestGeneration = generation; render(); let accepted = false, trajectoryAdvanced = false;
  const area = state.areaId;
  let requestAbort: AbortController | null = null;
  try {
    let result: unknown;
    if (hostReady) result = await rpc("tools/call", { name: "get_nearby_flights", arguments: { area, limit: 4 } });
    else if (host()?.callTool) result = await host()!.callTool!("get_nearby_flights", { area, limit: 4 });
    else if (window.parent === window) {
      requestAbort = new AbortController(); abort = requestAbort; const response = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, signal: requestAbort.signal, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name: "get_nearby_flights", arguments: { area, limit: 4 } } }) });
      if (!response.ok) throw new Error("Nearby refresh unavailable"); result = (await response.json()).result;
    } else { el("host-status").textContent = "No callable host bridge. Periodic refresh is unavailable; accepted positions remain bounded."; return { started: true, accepted, trajectoryAdvanced }; }
    refreshCalls++; if (generation === requestGeneration && wanted()) ({ accepted, trajectoryAdvanced } = accept(result));
  } catch { if (generation === requestGeneration && wanted()) el("board-notice").textContent = "Refresh temporarily unavailable. Last accepted positions remain bounded and continue to age."; }
  finally { if (activeRequestGeneration === generation) activeRequestGeneration = null; if (abort === requestAbort) abort = null; el<HTMLButtonElement>("refresh").disabled = dismissed || activeRequestGeneration === requestGeneration; }
  return { started: true, accepted, trajectoryAdvanced };
}
const toolContent = (value: unknown) => value && typeof value === "object" && "structuredContent" in value
  ? (value as { structuredContent: unknown }).structuredContent : value;
const correlationFingerprint = (value: string) => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};
function cancelActiveHandoff() {
  if (activeHandoffRequest) canceledHandoffRequests++;
  activeHandoffRequest = null;
}
function beginHandoff(type: HandoffRequestType, expectedRadarId: string, credential: string) {
  cancelActiveHandoff();
  const request: ActiveHandoffRequest = Object.freeze({ id: ++handoffRequestSequence, type, expectedRadarId, credentialFingerprint: correlationFingerprint(credential), startedAt: Date.now() });
  activeHandoffRequest = request; handoffMode = "loading"; handoffResult = null; render(); return request;
}
const currentHandoff = (request: ActiveHandoffRequest) => activeHandoffRequest?.id === request.id
  && activeHandoffRequest.expectedRadarId === request.expectedRadarId
  && activeHandoffRequest.credentialFingerprint === request.credentialFingerprint
  && state.selectedRadarId === request.expectedRadarId;
function acceptHostToolOutput(value: unknown, options: { expectedArea?: WidgetState["areaId"] | null } = {}): AcceptOutcome {
  if (FlightResultV1Schema.safeParse(toolContent(value)).success) { ignoredHandoffReplays++; return { accepted: false, trajectoryAdvanced: false }; }
  return accept(value, options);
}
async function invokeReadTool(name: "resolve_nearby_flight" | "get_flight", args: object): Promise<unknown> {
  let result: unknown;
  if (hostReady) result = await rpc("tools/call", { name, arguments: args });
  else if (host()?.callTool) result = await host()!.callTool!(name, args);
  else if (window.parent === window) {
    const response = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }) });
    if (!response.ok) throw new Error("Flight handoff unavailable"); result = (await response.json()).result;
  } else throw new Error("No callable host bridge");
  handoffCalls++; return toolContent(result);
}
function applyHandoff(request: ActiveHandoffRequest, value: unknown) {
  if (!currentHandoff(request)) { ignoredHandoffResponses++; return false; }
  const parsed = FlightResultV1Schema.safeParse(toolContent(value));
  if (!parsed.success) return false;
  activeHandoffRequest = null; handoffResult = parsed.data; appliedHandoffResponses++;
  if (parsed.data.status === "resolved") {
    handoffMode = "detail";
    if (parsed.data.flightInstanceId) resolvedInstances.set(request.expectedRadarId, parsed.data.flightInstanceId);
  } else handoffMode = parsed.data.status === "ambiguous" ? "ambiguous" : "error";
  render(); ensureAnimationLoop(); return true;
}
function failHandoff(request: ActiveHandoffRequest) {
  if (!currentHandoff(request)) { ignoredHandoffResponses++; return; }
  activeHandoffRequest = null;
  handoffResult = FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "unavailable", responseAt: new Date().toISOString(), refreshAfterSeconds: 20,
    flightInstanceId: null, flight: null, candidates: [], error: { code: "backend_unavailable", message: "Flight detail is temporarily unavailable." } });
  handoffMode = "error"; render();
}
async function trackSelected() {
  const target = selectedTarget; if (!target || handoffMode === "loading") return;
  const instance = resolvedInstances.get(target.radarId); const selection = target.selection;
  if (!instance && !selection.token) return;
  const request = beginHandoff(instance ? "instance" : "resolve", target.radarId, instance || selection.token!);
  try {
    const value = instance ? await invokeReadTool("get_flight", { target: { kind: "instance", flightInstanceId: instance } })
      : selection.token ? await invokeReadTool("resolve_nearby_flight", { selectionToken: selection.token }) : null;
    if (!value) throw new Error("Missing flight handoff response");
    if (!applyHandoff(request, value) && currentHandoff(request)) throw new Error("Invalid flight handoff response");
  } catch { failHandoff(request); }
}
async function chooseCandidate(candidate: FlightCandidateV1) {
  if (handoffMode === "loading" || !state.selectedRadarId) return;
  const request = beginHandoff("choice", state.selectedRadarId, candidate.candidateToken);
  try { if (!applyHandoff(request, await invokeReadTool("get_flight", { target: { kind: "choice", candidateToken: candidate.candidateToken } })) && currentHandoff(request)) throw new Error("Invalid candidate response"); }
  catch { failHandoff(request); }
}
async function refreshAndSchedule(mode: "reset" | "after") {
  const generation = requestGeneration, outcome = await refresh();
  if (!outcome.started || generation !== requestGeneration) return false;
  scheduleAfterRefresh(outcome, mode);
  return true;
}
function startNearbyUpdates() {
  // A host can retain the resource HTML longer than its embedded observations.
  // Resume from a real Nearby read instead of waiting another full poll interval
  // with every moving aircraft already at its extrapolation limit.
  if (activeRequestGeneration === requestGeneration) return;
  const newestMotionFix = Math.max(...board.radarTargets.filter(target => target.groundTrackDeg !== null
    && target.groundspeedKt !== null && target.groundspeedKt > 0).map(target => Date.parse(target.observedAt)));
  const needsRefresh = state.areaId !== board.area.id || board.health === "stale" || board.health === "unavailable"
    || Date.now() - Date.parse(board.generatedAt) >= NORMAL_POLL_MS
    || Number.isFinite(newestMotionFix) && newestMotionFix + MOTION_BOUND_MS - Date.now() <= MOTION_RETRY_WINDOW_MS;
  if (wanted() && needsRefresh) { clearPollingTimers(); void refreshAndSchedule("reset"); }
  else schedule();
}
async function display(mode: DisplayMode) {
  if (!hostReady || !hostContext.availableDisplayModes.includes(mode)) return;
  try { const result = await rpc("ui/request-display-mode", { mode }) as { mode?: DisplayMode }; if (result?.mode && ["inline", "fullscreen", "pip"].includes(result.mode)) hostContext.displayMode = result.mode; render(); ensureAnimationLoop(); }
  catch { el("host-status").textContent = "Host declined the display request. The current view remains available."; }
}
function stopAnimationLoop() { if (frame !== null) cancelAnimationFrame(frame); frame = null; }
function ensureAnimationLoop() { if (frame !== null || !animationWanted()) return; frame = requestAnimationFrame(animate); }
function animate() { frame = null; if (!animationWanted()) return; frameCount++; try { renderRadar(); } finally { ensureAnimationLoop(); } }
el("view-radar").onclick = () => setView("radar"); el("view-flights").onclick = () => setView("flights");
for (const view of ["radar", "flights"] as const) el(`view-${view}`).onkeydown = event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
  const next = event.key === "Home" ? "radar" : event.key === "End" ? "flights" : view === "radar" ? "flights" : "radar"; setView(next); el(`view-${next}`).focus();
};
el("pip").onclick = () => { void display("pip"); }; el("fullscreen").onclick = () => { void display(displayMode() === "fullscreen" ? "inline" : "fullscreen"); };
el("track-flight").onclick = () => { void trackSelected(); };
el("back-radar").onclick = () => { cancelActiveHandoff(); handoffMode = "nearby"; handoffResult = null; render(); ensureAnimationLoop(); };
el("refresh").onclick = async () => { await refreshAndSchedule("reset"); ensureAnimationLoop(); };
el("pause").onclick = async () => { state.paused = !state.paused; save(); stopPolling(); render(); ensureAnimationLoop(); if (!state.paused) await refreshAndSchedule("reset"); else schedule(); };
el<HTMLSelectElement>("area").onchange = async () => { const area = el<HTMLSelectElement>("area").value; if (!validArea(area)) return; state.areaId = area; save(); stopPolling(); render(); ensureAnimationLoop(); await refreshAndSchedule("after"); };
el("dismiss").onclick = () => { dismissed = true; stopPolling(); stopAnimationLoop(); render(); host()?.requestClose?.(); };
document.addEventListener("visibilitychange", () => {
  stopPolling(); stopAnimationLoop(); render();
  if (!dismissed && !pageInactive && !document.hidden) {
    ensureAnimationLoop(); if (wanted()) void refreshAndSchedule("reset"); else schedule();
  }
});
window.addEventListener("pagehide", () => { pageInactive = true; stopPolling(); stopAnimationLoop(); render(); });
window.addEventListener("pageshow", () => {
  if (!pageInactive) return; pageInactive = false; render(); ensureAnimationLoop();
  if (wanted()) void refreshAndSchedule("reset"); else schedule();
});
window.addEventListener("openai:set_globals", event => {
  const globals = (event as CustomEvent<{ globals?: { toolOutput?: unknown; widgetState?: Partial<WidgetState> } }>).detail?.globals;
  globalsEvents++; const next = globals?.widgetState, previousArea = state.areaId, previousPaused = state.paused, previousSelectedRadarId = state.selectedRadarId;
  if (next) {
    if (validArea(next.areaId)) state.areaId = next.areaId;
    if (typeof next.selectedRadarId === "string" || next.selectedRadarId === null) state.selectedRadarId = next.selectedRadarId;
    for (const mode of ["inline", "fullscreen", "pip"] as const) if (validView(next.views?.[mode])) state.views[mode] = next.views[mode];
    if (typeof next.paused === "boolean") state.paused = next.paused;
  }
  if (state.selectedRadarId !== previousSelectedRadarId) { cancelActiveHandoff(); handoffMode = "nearby"; handoffResult = null; updateSelection(); }
  const areaChanged = state.areaId !== previousArea, pausedChanged = state.paused !== previousPaused;
  if (areaChanged || pausedChanged) stopPolling();
  const acceptedToolOutput = globals?.toolOutput ? acceptHostToolOutput(globals.toolOutput) : { accepted: false, trajectoryAdvanced: false }; render(); ensureAnimationLoop();
  if (areaChanged || pausedChanged) {
    const needsRefresh = pausedChanged && !state.paused || areaChanged && (!acceptedToolOutput.accepted || board.area.id !== state.areaId);
    if (wanted() && needsRefresh) void refreshAndSchedule(pausedChanged ? "reset" : "after");
    else if (wanted() && areaChanged && acceptedToolOutput.accepted) scheduleAfterRefresh({ started: true, ...acceptedToolOutput }, "after");
    else schedule();
  }
});
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0" || hostOrigin && event.origin !== hostOrigin) return;
  const message = event.data;
  if (pending.has(message.id) && ("result" in message || "error" in message)) {
    const request = pending.get(message.id)!; pending.delete(message.id); clearTimeout(request.timeout); if (!hostOrigin) hostOrigin = event.origin;
    message.error ? request.reject(new Error("Host request failed")) : request.resolve(message.result); return;
  }
  if (message.method === "ui/resource-teardown") { dismissed = true; stopPolling(); stopAnimationLoop(); render(); window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, targetOrigin()); return; }
  if (!hostReady) return;
  if (message.method === "ui/notifications/tool-result" && wanted()) acceptHostToolOutput(message.params);
  if (message.method === "ui/notifications/host-context-changed") { hostContextEvents++; hostContext = { ...hostContext, ...message.params }; render(); ensureAnimationLoop(); }
});
new ResizeObserver(() => renderRadar()).observe(el("radar-surface"));
window.inboundRadarProof = {
  read: () => ({ selectedRadarId: state.selectedRadarId, selectedView: currentView(), views: { ...state.views }, requestedAreaId: state.areaId, areaId: board.area.id, collectionVersion: board.collectionVersion, generatedAt: board.generatedAt, health: board.health, handoffMode, handoffStatus: handoffResult?.status ?? null, handoffCalls, activeHandoffRequest: activeHandoffRequest ? { id: activeHandoffRequest.id, type: activeHandoffRequest.type, expectedRadarId: activeHandoffRequest.expectedRadarId, startedAt: activeHandoffRequest.startedAt } : null, ignoredHandoffReplays, ignoredHandoffResponses, appliedHandoffResponses, canceledHandoffRequests, selectedSelection: selectedTarget ? { ...selectedTarget.selection, ...(resolvedInstances.has(selectedTarget.radarId) ? { state: "resolved", flightInstanceId: resolvedInstances.get(selectedTarget.radarId) } : {}) } : null, trajectoryKey: trajectoryKey(board), shortRetryTrajectoryKey: motionRetryTrajectoryKey, motionRetryCount, motionRetryBudgetRemaining: Math.max(0, MAX_MOTION_RETRIES - motionRetryCount), lastMotionRetryAt, motionCapDeadline: motionCapDeadline(), positions: board.radarTargets.map(target => ({ radarId: target.radarId, latitude: target.latitude, longitude: target.longitude, observedAt: target.observedAt, altitudeFt: target.altitudeFt, groundspeedKt: target.groundspeedKt, groundTrackDeg: target.groundTrackDeg, positionKind: target.positionKind })), displayPositions: displayPositions.map(position => ({ ...position })), labelIds: [...labelIds], refreshCalls, refreshInFlight: activeRequestGeneration === requestGeneration, pollScheduled: timer !== null, ageScheduled: ageTimer !== null, pollTimers: { pending: pendingPollTimers.size, maxPending: maxPendingPollTimers, fired: pollTimerFires }, ageTimers: { pending: pendingAgeTimers.size, maxPending: maxPendingAgeTimers, fired: ageTimerFires }, nextPollAt, nextPollKind, shortRetryUsed: motionRetryTrajectoryKey === trajectoryKey(board) && motionRetryCount > 0, shortRetrySchedules, shortRetryFires, pollScheduleEpoch, requestGeneration, activeRequestGeneration, displayMode: displayMode(), hostReady, hostContext: { ...hostContext, availableDisplayModes: [...hostContext.availableDisplayModes] }, hostWidgetState: host()?.widgetState ? { ...host()!.widgetState, views: host()!.widgetState!.views ? { ...host()!.widgetState!.views } : undefined } : null, frameCount, animationScheduled: frame !== null, paused: state.paused, documentHidden: document.hidden, pageInactive, dismissed, acceptedResults, rejectedResults, lastRejectedReason, latestAcceptedVersion, latestAcceptedGeneratedAt, globalsEvents, hostContextEvents }),
};
const restoredArea = state.areaId;
acceptHostToolOutput(host()?.toolOutput || initial, { expectedArea: null }); state.areaId = restoredArea; render(); schedule(true); ensureAnimationLoop();
if (window.parent !== window) void rpc("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Inbound invented flight handoff proof", version: "0.4.0" }, appCapabilities: { availableDisplayModes: ["inline", "pip", "fullscreen"] } }).then(value => {
  if (dismissed) return;
  const result = value as { hostContext?: Partial<HostContext> }; hostReady = true; hostContext = { ...hostContext, ...result.hostContext }; notify("ui/notifications/initialized"); render(); ensureAnimationLoop();
  startNearbyUpdates();
}).catch(() => { if (!dismissed) hostControls(); });
if (window.parent === window || host()?.callTool) startNearbyUpdates();
