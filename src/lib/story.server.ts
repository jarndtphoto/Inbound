Warning: truncated output (original token count: 50762)
Total output lines: 4660

// @ts-nocheck
import { phaseOf, verticalTrend, createPhaseHistory, destinationContext, type PhaseContext } from "./aircraft-phase.ts";
import { loadAeroFlight } from "./aeroapi.server.ts";
import { findInboundDiversion } from "./inbound-diversion.ts";
import { createHash } from "node:crypto";
import { readFlightResume } from "./flight-resume";
import { flightNotFound, verifiedFlightNotFoundPage } from "./flight-search.ts";
import { withStoryRequest, noteStoryCache, noteStorySchedule, noteStoryFallback } from "./story-request-log.server.ts";
import { loadPhaseState, savePhaseState, phaseStateEqual } from "./flight-phase-state.server";
import { confirmTakeoff, reconcileTakeoff, takeoffFloorStage, takeoffDiagnostic, hasOriginSurfaceFix } from "./confirmed-takeoff.ts";
import { activeConfirmedTakeoff, mergeConfirmedTakeoff } from "./flight-phase-state-logic.ts";
import { BUILD_INFO } from "./build-info.ts";
// Only server-validated evidence enters this bounded outage continuity memo.
// Durable state remains authoritative across cold instances.
const takeoffContinuity = new Map();
import { departureSeedUnix, flightStateIdentity } from "./flight-identity.ts";
import { advisoryTiming, distinctRouteHazards } from "./route-hazards";
import { isFreshPilotReport, observationTime } from "./pirep-time.ts";
import { routeWeatherEvents } from "./weather-events";
import { flightWeatherSummary } from "./weather-presentation";
import { airframeOf, airlineOf, isVehicleType } from "./aircraft";
import { AIRPORT_BY_ICAO, airportByIata, airportByIcao } from "./airports";
import { IATA_TO_ICAO, displayIata, parseFlightQuery } from "./flight-parse";
import {
  densifyPath,
  destPoint,
  distanceToSegmentNm,
  downsampleNm,
  formatDuration,
  formatMiles,
  greatCirclePoints,
  haversineNm,
  initialBearing,
  pathFracs,
  pointInGeoJson,
  progressAlongPath,
  polylineLengthNm,
  wrap360,
} from "./geo";
import { decodeMetar } from "./metar";
import {
	advisoryValidAt,
	decodeTafPassenger,
	digestWx,
	gairmetApplies,
	gairmetChop as gairmetChopOf,
	pirepAltFt,
	pirepRouteBounds,
	pirepChop as pirepChopOf,
	pirepMatchesSample,
	rememberFiledWx,
	sampleAltFt,
	corridorStations,
	wxDeltas,
} from "./wx-brief";
import { faAltFt, hasAirborneEvidence, liveFromAware as liveFromAwareTrack, parseJsonObject, timeFracOf } from "./fa-track";
import { choosePosition, normalizedToLive, passengerEtaMin, type NormalizedFlight, type NormalizedPosition } from "./flight-data.ts";
import { arrivalEntryEvidence, updateArrivalProjection } from "./arrival-projection-state.ts";
import { displayArrivalProjection } from "./arrival-display.ts";
import { showDetailedArrivalGeometry } from "./arrival-pattern.ts";
import { arrivalStateStore } from "./arrival-state-store.server.ts";
import { emptyRouteMemory, mergeRouteMemory, mergeObservedTrack, routeLeg, validatedFiledRoute, freshRouteObservation, routeProgress, routeMemoryEqual, sanitizeRouteMemory } from "./route-memory.ts";
import { routeMemoryStore } from "./route-memory-store.server.ts";
const ARRIVAL_INSTANCE = Math.random().toString(36).slice(2, 10);
import { expectedArrivalRunway } from "./arrival-runway.server.ts";
import { loadOfficialFlightData } from "./official-flight-data.server.ts";
import {
	fetchAround,
	fetchByCallsign,
	fetchByHex,
	fetchByReg,
	fuseProviderLists,
	lastGoodAround,
	rememberAround,
	seenOf as fusionSeen,
	stickyPick
} from "./adsb-fusion";
var UA = "Inbound/1.0 (passenger flight companion)";
var cache = /* @__PURE__ */ new Map();
var inflight = /* @__PURE__ */ new Map();
function cached(key, ttlMs, fn) {
	const hit = cache.get(key);
	const ttl = hit?.ttl ?? ttlMs;
	const storyCache = /^story\d*:|^resume:[a-f0-9]+:story$/.test(key);
	if (hit && Date.now() >= hit.at && Date.now() - hit.at < ttl) {
		if (storyCache) noteStoryCache("hit");
		return Promise.resolve(hit.value);
	}
	const pending = inflight.get(key);
	if (pending) {
		if (storyCache) noteStoryCache("inflight");
		return pending;
	}
	if (storyCache) noteStoryCache("miss");
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("Flight data request timed out. Please try again.")), 30000);
	});
	const p = Promise.race([Promise.resolve().then(fn), deadline]).then((value) => {
		const empty = value == null || (Array.isArray(value) && value.length === 0);
		cache.set(key, { at: Date.now(), value, ttl: empty ? Math.min(1200, ttlMs) : ttlMs });
		return value;
	}).finally(() => {
		clearTimeout(timer);
		if (inflight.get(key) === p) inflight.delete(key);
	});
	inflight.set(key, p);
	return p;
}
async function fetchJson(url, ms = 6e3) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "application/json"
		},
		signal: AbortSignal.timeout(ms)
	});
	if (res.status === 429) throw new Error("upstream 429");
	if (!res.ok) throw new Error(`upstream ${res.status}`);
	return await res.json();
}
async function safe(p, fallback) {
	try {
		return await p;
	} catch {
		return fallback;
	}
}
const TRACE_HOSTS = [
	"https://globe.theairtraffic.com",
	"https://globe.adsb.fi",
	"https://globe.airplanes.live",
];
function parseTraceJson(data) {
	const base = data?.timestamp ?? 0;
	const out = [];
	for (const row of data?.trace ?? []) {
		const lat = row[1];
		const lon = row[2];
		const sec = row[0];
		if (typeof lat !== "number" || typeof lon !== "number") continue;
		if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
		const altRaw = row[3];
		const gsRaw = row[4];
		const trackRaw = row[5];
		const ground = altRaw === "ground" || altRaw === 0 || altRaw === "0";
		const alt = typeof altRaw === "number" && altRaw > 0 ? altRaw : ground ? 0 : null;
		const gs = typeof gsRaw === "number" ? gsRaw : null;
		const track = typeof trackRaw === "number" && trackRaw >= 0 && trackRaw <= 360 ? trackRaw : null;
		out.push({
			t: base + (typeof sec === "number" ? sec : 0),
			lat,
			lon,
			alt,
			ground,
			gs,
			track
		});
	}
	return out;
}
async function fetchTrace(hex, kind) {
	const id = hex.toLowerCase();
	return cached(`trace3:${kind}:${id}`, kind === "trace_recent" ? 8e3 : 25e3, async () => {
		const attempts = TRACE_HOSTS.map(async (host) => {
			const url = `${host}/data/traces/${id.slice(-2)}/${kind}_${id}.json`;
			const res = await fetch(url, {
				headers: {
					"User-Agent": UA,
					Accept: "application/json"
				},
				signal: AbortSignal.timeout(2800)
			});
			if (!res.ok) throw new Error("trace miss");
			const parsed = parseTraceJson(await res.json());
			if (!parsed.length) throw new Error("trace empty");
			return parsed;
		});
		return await Promise.any(attempts).catch(() => []);
	});
}
function uniqueTrack(points, minNm = 6) {
	const out = [];
	const gap = Math.max(0.4, minNm);
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && haversineNm(last, p) < gap) continue;
		out.push({
			lat: p.lat,
			lon: p.lon
		});
	}
	return out;
}
function isGroundPt(p) {
	if (p.ground) return true;
	if (p.alt != null && p.alt <= 50 && (p.gs == null || p.gs < 80)) return true;
	if (p.gs != null && p.gs < 40 && (p.alt == null || p.alt < 200)) return true;
	return false;
}
/** Split a tail's whole-day ADS-B trace into one continuous airborne run per sector. */
function splitTraceLegs(points) {
	if (!points.length) return [];
	const sorted = points.slice().sort((a, b) => a.t - b.t);
	const legs = [];
	let cur = [];
	let airPts = 0;
	let groundStreak = 0;
	const flush = () => {
		if (cur.length >= 4) legs.push(cur);
		cur = [];
		airPts = 0;
		groundStreak = 0;
	};
	for (const p of sorted) {
		const last = cur[cur.length - 1];
		if (last) {
			const dt = p.t - last.t;
			const jump = haversineNm(last, p);
			if (dt > 2400 || jump > 520 && dt > 480) flush();
		}
		if (isGroundPt(p)) {
			groundStreak++;
			if (airPts >= 6 && groundStreak >= 2) {
				cur.push(p);
				flush();
				continue;
			}
		} else {
			airPts++;
			groundStreak = 0;
		}
		cur.push(p);
	}
	flush();
	return legs;
}
function mergeTraces(full, recent) {
	const byT = new Map();
	for (const p of [...full, ...recent]) {
		const k = Math.round(p.t);
		if (!byT.has(k)) byT.set(k, p);
	}
	return [...byT.values()].sort((a, b) => a.t - b.t);
}
function corridorNm(gc) {
	return Math.max(240, Math.min(420, gc * 0.14));
}
function nearLiveNm(leg, livePt) {
	if (!livePt) return 999;
	let n = 999;
	for (const p of leg) {
		const d = haversineNm(p, livePt);
		if (d < n) n = d;
	}
	return n;
}

export function selectCurrentTraceLeg(legs, livePt = null) {
	if (!Array.isArray(legs) || !legs.length) return [];
	let candidates = legs;
	if (livePt) {
		const nearLive = legs.filter((leg) => nearLiveNm(leg, livePt) < 45);
		if (nearLive.length) candidates = nearLive;
	}
	let best = candidates[0] ?? null;
	for (const leg of candidates.slice(1)) {
		const bestEnd = best?.[best.length - 1]?.t ?? 0;
		const legEnd = leg?.[leg.length - 1]?.t ?? 0;
		if (legEnd > bestEnd) best = leg;
	}
	return best ? best.slice() : [];
}
/** Keep only this origin→dest sector. Drop earlier legs of the same tail. */
function legsForThisSector(legs, origin, dest, live, takeoffUnix) {
	if (!legs.length) return [];
	const gc = Math.max(40, haversineNm(origin, dest));
	const corridor = corridorNm(gc);
	const livePt = live ? { lat: live.lat, lon: live.lon } : null;
	let t0 = takeoffUnix != null ? takeoffUnix - 25 * 60 : null;
	if (t0 == null) {
		for (let i = legs.length - 1; i >= 0; i--) {
			const leg = legs[i];
			if (haversineNm(leg[0], origin) < 90 && polylineLengthNm(leg) > 30) {
				t0 = leg[0].t - 5 * 60;
				break;
			}
		}
	}
	const kept = [];
	for (const leg of legs) {
		const start = leg[0];
		const end = leg[leg.length - 1];
		if (t0 != null && end.t < t0) continue;
		// A just-departed sector is short. Rejecting it used to make the
		// fallback choose the same tail's previous arrival into this airport.
		if (polylineLengthNm(leg) < 12 && !(haversineNm(start, origin) < 15 && livePt && nearLiveNm(leg, livePt) < 15)) continue;
		const startOrig = haversineNm(start, origin);
		const startDest = haversineNm(start, dest);
		const endOrig = haversineNm(end, origin);
		const endDest = haversineNm(end, dest);
		const liveD = nearLiveNm(leg, livePt);
		if (endOrig < 60 && startOrig > 150 && startDest < startOrig) continue;
		if (startDest < 60 && startOrig > 150 && endOrig + 80 < endDest) continue;
		const startFrac = progressAlongPath([origin, dest], start).frac;
		const endFrac = progressAlongPath([origin, dest], end).frac;
		if (endFrac + 0.05 < startFrac && liveD > 50) continue;
		const mid = leg[Math.floor(leg.length / 2)];
		const off = Math.min(distanceToSegmentNm(start, origin, dest), distanceToSegmentNm(end, origin, dest), distanceToSegmentNm(mid, origin, dest));
		if (off > corridor && liveD > 50 && startOrig > 90) continue;
		kept.push(leg);
	}
	// Never bypass sector/date checks merely because an old trace ended
	// near the live position. Missing current-sector history stays missing.
	// A tail's day trace can contain more than one geographically plausible
	// sector. Concatenating every match makes the map draw an old flight path
	// underneath the current one. Keep exactly one current leg: prefer a leg
	// that passes near the live aircraft, then the most recent by timestamp.
	return selectCurrentTraceLeg(kept, livePt);
}
function ensureEnds(points, origin, dest) {
	const out = points.slice();
	if (!out.length) return [origin, dest];
	if (haversineNm(origin, out[0]) > 18) out.unshift(origin);
	if (haversineNm(out[out.length - 1], dest) > 8) out.push(dest);
	return out;
}
function makeSpine(origin, dest, waypoints) {
	const wps = Array.isArray(waypoints) ? waypoints.slice() : [];
	if (wps.length >= 4) return densifyPath(downsampleNm(ensureEnds(wps, origin, dest), 28), 70);
	const n = Math.max(18, Math.round(haversineNm(origin, dest) / 90));
	return greatCirclePoints(origin, dest, n);
}
function blendTrackOntoSpine(flown, spine) {
	if (spine.length < 2) return flown.length >= 2 ? flown : spine;
	if (flown.length < 6) return spine;
	const origin = spine[0];
	const dest = spine[spine.length - 1];
	const gc = haversineNm(origin, dest);
	const maxOff = Math.max(240, gc * 0.14);
	const fracs = pathFracs(spine);
	const onRoute = [];
	for (const p of flown) {
		if (distanceToSegmentNm(p, origin, dest) > maxOff) continue;
		onRoute.push({ p, frac: progressAlongPath(spine, p).frac });
	}
	if (onRoute.length < 6) return spine;
	const out = [origin];
	const first = onRoute[0];
	const last = onRoute[onRoute.length - 1];
	for (let i = 0; i < spine.length; i++) {
		if (fracs[i] < first.frac - 0.012 && haversineNm(out[out.length - 1], spine[i]) > 8) out.push(spine[i]);
	}
	for (let i = 0; i < onRoute.length; i++) {
		const prev = out[out.length - 1];
		const b = onRoute[i].p;
		if (haversineNm(prev, b) > 220) {
			const fa = i === 0 ? first.frac : onRoute[i - 1].frac;
			const fb = onRoute[i].frac;
			for (let s = 0; s < spine.length; s++) {
				if (fracs[s] > fa + 0.008 && fracs[s] < fb - 0.008 && haversineNm(out[out.length - 1], spine[s]) > 8) out.push(spine[s]);
			}
		}
		if (haversineNm(out[out.length - 1], b) > 6) out.push(b);
	}
	const lastPt = last.p;
	const dLeft = haversineNm(lastPt, dest);
	if (dLeft < 62) {
		if (haversineNm(out[out.length - 1], lastPt) > 2) out.push(lastPt);
		for (const p of arrivalRemainder(lastPt, dest, null)) {
			if (haversineNm(out[out.length - 1], p) > 2) out.push(p);
		}
		if (haversineNm(out[out.length - 1], dest) > 2) out.push(dest);
	} else {
		for (let i = 0; i < spine.length; i++) {
			if (fracs[i] > last.frac + 0.012 && haversineNm(out[out.length - 1], spine[i]) > 8) out.push(spine[i]);
		}
		if (haversineNm(out[out.length - 1], dest) > 4) out.push(dest);
	}
	const blended = uniqueTrack(out);
	if (polylineLengthNm(blended) > gc * 1.85 + 250) return spine;
	return blended;
}
function arrivalRemainder(from, dest, live) {
	const here = { lat: from.lat, lon: from.lon };
	const d = haversineNm(here, dest);
	if (d < 5) return [here, dest];
	const track = live?.track;
	if (track == null || !Number.isFinite(track)) return densifyPath([here, dest], Math.max(6, Math.round(d / 4)));
	const toDest = initialBearing(here, dest);
	const delta = headingDelta(track, toDest);
	if (delta < 28) return densifyPath([here, dest], Math.max(6, Math.round(d / 4)));
	const holdNm = Math.min(14, Math.max(4, d * 0.28));
	const elbow = destPoint(here, track, holdNm);
	return densifyPath([here, elbow, dest], Math.max(8, Math.round(d / 3)));
}
function stitchArrival(flown, live, dest) {
	const here = live ? { lat: live.lat, lon: live.lon } : flown[flown.length - 1];
	if (!here) return null;
	if (haversineNm(here, dest) > 68) return null;
	const out = uniqueTrack(flown.length >= 3 ? flown : []);
	if (!out.length || haversineNm(out[out.length - 1], here) > 1.2) out.push(here);
	for (const p of arrivalRemainder(here, dest, live)) {
		if (haversineNm(out[out.length - 1], p) > 1.2) out.push(p);
	}
	if (haversineNm(out[out.length - 1], dest) > 0.8) out.push(dest);
	return densifyPath(downsampleNm(out, 10), 32);
}
function remainingLeg(from, dest, live) {
	const leftover = haversineNm(from, dest);
	if (leftover < 35) return [from, dest];
	return densifyPath([from, dest], Math.min(90, Math.max(40, leftover / 24)));
}
function directSpine(origin, dest, live) {
	const here = live ? { lat: live.lat, lon: live.lon } : null;
	const spine = [origin];
	if (here && haversineNm(origin, here) > 12) spine.push(here);
	spine.push(...remainingLeg(here ?? origin, dest, live).slice(1));
	if (haversineNm(spine[spine.length - 1], dest) > 2) spine.push(dest);
	return densifyPath(downsampleNm(spine, 18), 55);
}

// Build one display geometry for Route, Weather, and route-weather sampling:
 // trustworthy flown track -> current aircraft -> forward-only projection.
function distanceToPathNm(point, path) {
	let best = Infinity;
	for (let i = 1; i < path.length; i++) best = Math.min(best, distanceToSegmentNm(point, path[i - 1], path[i]));
	return best;
}

export function canonicalLiveDisplayPath({ filedPath, flownTrack, live, dest, origin = null }) {
	if (!live || live.onGround || live.extrapolated || !Number.isFinite(live.lat) || !Number.isFinite(live.lon)) {
		return Array.isArray(filedPath) ? filedPath : [];
	}
	const here = { lat: live.lat, lon: live.lon };
	const destination = { lat: dest.lat, lon: dest.lon };
	const reference = Array.isArray(filedPath) && filedPath.length >= 2 ? filedPath : [here, destination];
	let behind = uniqueTrack(Array.isArray(flownTrack) ? flownTrack : [], 1.2);
	if (behind.length) {
		let nearest = 0;
		let nearestNm = Infinity;
		for (let i = 0; i < behind.length; i++) {
			const d = haversineNm(behind[i], here);
			if (d < nearestNm) { nearest = i; nearestNm = d; }
		}
		if (nearestNm <= 30) behind = behind.slice(0, nearest + 1);
		else if (haversineNm(behind[behind.length - 1], here) > 30) behind = [];
	}
	// With no track, the origin-to-fix chord is an approximation of travel,
	// never the filed spine's nearest (possibly much later) route point.
	if (origin && (!behind.length || haversineNm(origin, behind[0]) > 0.1))
		behind.unshift({ lat: origin.lat, lon: origin.lon });
	if (!behind.length || haversineNm(behind[behind.length - 1], here) > 0.1) behind.push(here);
	else behind[behind.length - 1] = here;

	const directNm = haversineNm(here, destination);
	const deviationNm = distanceToPathNm(here, reference);
	const along = progressAlongPath(reference, here);
	const fracs = pathFracs(reference);
	const forwardReference = reference.filter((p, i) =>
		fracs[i] > along.frac + 0.004 && haversineNm(p, destination) < directNm - 6);
	let ahead = [];
	if (deviationNm <= 8 && forwardReference.length) {
		ahead = forwardReference;
	} else {
		const maxConnectorNm = Math.min(140, Math.max(45, directNm * 0.35));
		ahead = forwardReference.filter((p, i) => {
			if (i > 0) return true;
			if (haversineNm(here, p) > maxConnectorNm) return false;
			if (!Number.isFinite(live.track)) return true;
			return headingDelta(live.track, initialBearing(here, p)) <= 100;
		});
	}
	if (!ahead.length) {
		const toward = initialBearing(here, destination);
		const useTrack = Number.isFinite(live.track) && headingDelta(live.track, toward) <= 115;
		const holdNm = Math.min(30, Math.max(8, directNm * 0.08));
		ahead = useTrack && directNm > 35 ? [destPoint(here, live.track, holdNm), destination] : [destination];
	} else if (haversineNm(ahead[ahead.length - 1], destination) > 2) {
		ahead.push(destination);
	}
	const future = densifyPath([here, ...ahead], Math.max(8, Math.min(70, ahead.length * 3)));
	const joined = [...behind, ...future.slice(1)];
	// Keep the exact aircraft boundary even when the previous observation is
	// closer than the usual downsampling distance.
	return joined;
}

async function loadFiledPath(hex, origin, dest, live, takeoffUnix, waypoints, faTrack) {
	const spine = makeSpine(origin, dest, waypoints);
	let hexRaw = [];
	if (hex) try {
		const [full, recent] = await Promise.all([fetchTrace(hex, "trace_full"), fetchTrace(hex, "trace_recent")]);
		hexRaw = mergeTraces(full, recent);
	} catch {
		hexRaw = [];
	}
	const faRaw = Array.isArray(faTrack) && faTrack.length >= 2 ? faTrack : [];
	let raw = faRaw.length ? faRaw.slice() : [];
	if (hexRaw.length) raw = raw.length ? mergeTraces(raw, hexRaw) : hexRaw;
	const sector = legsForThisSector(splitTraceLegs(raw), origin, dest, live, takeoffUnix ?? null);
	const phaseHistory = sector.map(p => ({ seenAt: p.t, altFt: p.alt, onGround: p.ground, lat: p.lat, lon: p.lon }));
	const flown = uniqueTrack(sector, faRaw.length ? 1.6 : 6);
	if (live && haversineNm({ lat: live.lat, lon: live.lon }, dest) < 68) {
		const arrival = stitchArrival(flown, live, dest);
		if (arrival && arrival.length >= 4) return { phaseHistory, points: arrival, spine, flown, source: flown.length >= 6 ? "track" : "direct" };
	}
	if (flown.length >= 6) {
		return {
			phaseHistory, points: densifyPath(downsampleNm(ensureEnds(blendTrackOntoSpine(flown, spine), origin, dest), 22), 48),
			spine,
			flown,
			source: "track"
		};
	}
	if (flown.length >= 2) {
		return {
			phaseHistory, points: densifyPath(downsampleNm(ensureEnds(flown, origin, dest), 12), 36),
			spine,
			flown,
			source: "track"
		};
	}
	if (Array.isArray(waypoints) && waypoints.length >= 4) return { phaseHistory, points: spine, spine, flown, source: "filed" };
	if (live) return { phaseHistory, points: directSpine(origin, dest, live), spine, flown, source: "direct" };
	return { phaseHistory, points: spine, spine, flown, source: "direct" };
}

function acList(d) {
	return d?.ac ?? d?.aircraft ?? [];
}
function destParkedLeftover(cand, dest, aware) {
	if (!cand || !dest || !aware?.takeoff?.actual || aware?.landing?.actual) return false;
	const now = Date.now() / 1e3;
	const airborneSec = now - aware.takeoff.actual;
	if (airborneSec < 8 * 60) return false;
	if (haversineNm({ lat: cand.lat, lon: cand.lon }, dest) >= 18) return false;
	if (!cand.onGround && (cand.altFt ?? 0) > 400) return false;
	if ((cand.gsKt ?? 0) > 40) return false;
	const ld = aware.landing?.estimated ?? aware.landing?.scheduled;
	if (ld && now >= ld - 45 * 60) return false;
	if (!ld && airborneSec > 4 * 3600) return false;
	return true;
}
function lastAirborneTracePt(points, takeoffUnix) {
	if (!points?.length) return null;
	const now = Date.now() / 1e3;
	const t0 = takeoffUnix != null ? takeoffUnix - 8 * 60 : now - 10 * 3600;
	let last = null;
	for (const p of points) {
		if (p.t < t0 || p.t > now + 120) continue;
		if (isGroundPt(p)) continue;
		if ((p.alt ?? 0) < 400 && (p.gs ?? 0) < 80) continue;
		last = p;
	}
	if (!last) return null;
	if (now - last.t > 25 * 60) return null;
	return last;
}
function coastTracePt(pt) {
	const now = Date.now() / 1e3;
	const age = Math.max(0, now - pt.t);
	let lat = pt.lat;
	let lon = pt.lon;
	if (age > 0 && age <= 20 && (pt.gs ?? 0) > 80 && pt.track != null && Number.isFinite(pt.track)) {
		const moved = destPoint(pt, pt.track, (pt.gs / 3600) * age);
		lat = moved.lat;
		lon = moved.lon;
	}
	return { lat, lon, age, alt: pt.alt ?? null, gs: pt.gs ?? null, track: pt.track ?? null };
}
export function liveFromTracePt(pt, hex, seed, context: PhaseContext = {}) {
	const c = coastTracePt(pt);
	const sample = { lat: c.lat, lon: c.lon, altFt: c.alt, gsKt: c.gs, seenAt: pt.t, seenSec: c.age, onGround: false, vertFpm: pt.vertFpm };
	const trend = verticalTrend(sample, context.history);
	return {
		...trend,
		hex: hex || seed?.hex || "",
		callsign: seed?.callsign ?? null,
		registration: seed?.registration ?? null,
		type: seed?.type ?? null,
		typeName: seed?.typeName ?? seed?.type ?? null,
		year: seed?.year ?? null,
		operator: seed?.operator ?? null,
		lat: c.lat,
		lon: c.lon,
		altFt: c.alt,
		gsKt: c.gs,
		track: c.track ?? seed?.track ?? null,
		vertFpm: Number.isFinite(pt.vertFpm) ? pt.vertFpm : trend.phaseVertFpm,
		onGround: false,
		phase: phaseOf({ ...sample, ...trend }, context),
		extrapolated: c.age > 45,
		seenSec: c.age, seenAt: pt.t
	};
}
function rememberKin(identKey, live) {
	if (!live || live.onGround) return;
	if (live.altFt == null && live.gsKt == null) return;
	lastKinByIdent.set(identKey, { ...live, at: Date.now() });
}
function restoreKin(identKey, live, dest, aware) {
	const prev = lastKinByIdent.get(identKey);
	if (!prev || Date.now() - prev.at > 20 * 60_000) return live;
	// A remembered enroute point is useful through a transient outage, but is
	// unsafe on approach: it can remain miles behind the aircraft at touchdown.
	if (dest && haversineNm(prev, dest) < 80 && Date.now() - prev.at > 45_000) return live;
	if (destParkedLeftover(prev, dest, aware)) return live;
	if (!live) {
		const age = (Date.now() - prev.at) / 1000;
		let lat = prev.lat;
		let lon = prev.lon;
		if (age > 0 && age <= 20 && (prev.gsKt ?? 0) > 80 && prev.track != null && Number.isFinite(prev.track)) {
			const moved = destPoint(prev, prev.track, (prev.gsKt / 3600) * age);
			lat = moved.lat;
			lon = moved.lon;
		}
		return { ...prev, lat, lon, extrapolated: true, seenSec: age };
	}
	return {
		...live,
		altFt: live.altFt ?? prev.altFt,
		gsKt: live.gsKt ?? prev.gsKt,
		track: live.track ?? prev.track
	};
}
function toLive(raw) {
	const hex = (raw.hex ?? "").toLowerCase();
	const lat = raw.lat;
	const lon = raw.lon;
	if (!hex || lat == null || lon == null) return null;
	const altBaro = raw.alt_baro;
	const altGeom = raw.alt_geom;
	const onGround = altBaro === "ground" || altBaro === 0;
	const altFt = onGround
		? 0
		: typeof altBaro === "number" && altBaro > 0
			? altBaro
			: typeof altGeom === "number" && altGeom > 0
				? altGeom
				: null;
	const gsKt = typeof raw.gs === "number" ? raw.gs : typeof raw.spd === "number" ? raw.spd : null;
	const vertFpm = Number.isFinite(raw.baro_rate) ? raw.baro_rate : Number.isFinite(raw.geom_rate) ? raw.geom_rate : null;
	const type = raw.t?.trim() || null;
	const fusedSeen = raw._fusion?.ageSec ?? fusionSeen(raw);
	const seenSec = fusedSeen === 999 ? null : fusedSeen;
	return {
		hex,
		callsign: String(raw.flight ?? "").replace(/\s/g, "").toUpperCase() || null,
		registration: raw.r?.trim() || null,
		type,
		typeName: airframeOf(type)?.name ?? raw.desc ?? type,
		year: raw.year?.trim() || null,
		operator: raw.ownOp?.trim() || null,
		lat,
		lon,
		altFt,
		gsKt,
		track: typeof raw.track === "number" ? raw.track : null,
		vertFpm,
		// Keep the same raw rate input for arrival projection.
		arrivalVertFpm: Number.isFinite(raw.baro_rate) ? raw.baro_rate : Number.isFinite(raw.geom_rate) ? raw.geom_rate : null,
		onGround,
		extrapolated: Boolean(raw.extrapolated ?? raw._fusion?.extrapolated),
		seenSec,
		seenAt: seenSec == null ? null : Date.now() / 1000 - Math.max(0, seenSec),
		source: "adsb",
		phase: phaseOf({
			onGround,
			gsKt,
			altFt,
			vertFpm
		})
	};
}
function fieldElev(origin) {
	if (!origin) return 0;
	return (origin.icao ? airportByIcao(origin.icao)?.elevationFt : null)
		?? (origin.iata ? airportByIata(origin.iata)?.elevationFt : null)
		?? origin.elevationFt ?? 0;
}
function asOnGround(live, origin) {
	if (!live) return live;
	if (live.onGround) {
		if (live.phase !== "taxi" && live.phase !== "parked") {
			return { ...live, phase: (live.gsKt ?? 0) >= 2 ? "taxi" : "parked" };
		}
		return live;
	}
	if (!origin) return live;
	if (haversineNm({ lat: live.lat, lon: live.lon }, origin) > 8) return live;
	const agl = (live.altFt ?? 0) - fieldElev(origin);
	const gs = live.gsKt ?? 0;
	if (gs < 55 && agl < 380) {
		return { ...live, onGround: true, altFt: 0, phase: gs >= 2 ? "taxi" : "parked" };
	}
	return live;
}
function stillOnField(live, origin) {
	if (!live || !origin) return false;
	const d = haversineNm({ lat: live.lat, lon: live.lon }, origin);
	if (d > 10) return false;
	const gs = live.gsKt ?? 0;
	if (live.onGround) return true;
	if (gs < 50) return true;
	const agl = (live.altFt ?? 0) - fieldElev(origin);
	if (gs < 70 && agl < 400) return true;
	return false;
}

// Midway's airport reference point sits near the runway complex, not the
// passenger terminal. If the first fresh fix arrives only after pushback, using
// that point as the "parked stand" baseline can incorrectly keep the stage at
// Gate all the way to the runway. This small terminal envelope lets a fresh
// physical fix prove the airplane has already left the passenger-gate area.
const PASSENGER_GATE_AREAS = {
	MDW: { lat: 41.7866, lon: -87.7434, radiusNm: 0.55 },
};
export function departureSurfaceLocationHint(live, origin, gateOut, nowSec = Date.now() / 1e3) {
	if (!live || !origin || live.onGround !== true || !stillOnField(live, origin)) return { awayFromPassengerGateArea: false };
	const area = PASSENGER_GATE_AREAS[origin.iata];
	if (!area) return { awayFromPassengerGateArea: false };
	const planned = gateOut?.actual ?? gateOut?.estimated ?? gateOut?.scheduled ?? null;
	if (planned != null && (nowSec < planned - 30 * 60 || nowSec > planned + 3 * 60 * 60)) {
		return { awayFromPassengerGateArea: false };
	}
	return {
		awayFromPassengerGateArea: haversineNm({ lat: live.lat, lon: live.lon }, area) > area.radiusNm,
	};
}
function flightBegun(live, origin) {
	if (!live) return false;
	// Ground speed alone cannot establish takeoff: surface receivers regularly
	// report a fast roll (or a noisy speed) before the wheels leave the runway.
	if (live.onGround) return false;
	const gs = live.gsKt ?? 0;
	const agl = (live.altFt ?? 0) - fieldElev(origin);
	if (agl > 400) return true;
	if (stillOnField(live, origin)) return false;
	return gs >= 90 && Boolean(origin && haversineNm({ lat: live.lat, lon: live.lon }, origin) > 3);
}
export function motionFromTrace(points, origin) {
	if (!points?.length || !origin) return { pushed: false, taxiing: false, flying: false };
	const now = Date.now() / 1e3;
	const recent = points.filter((p) => p.t <= now && now - p.t < 18 * 60 && haversineNm(p, origin) < 8);
	const last = recent[recent.length - 1];
	if (!last || now - last.t > 30) return { pushed: false, taxiing: false, flying: false };
	const lastGs = last.gs ?? 0;
	const lastAlt = last.alt ?? 0;
	const lastGround = Boolean(last.ground) || lastAlt < 200;
	const flying = !lastGround && lastAlt > 400 && lastGs > 80;
	if (recent.length < 2) return { pushed: false, taxiing: false, flying };
	const first = recent[0];
	let maxDist = 0;
	for (const p of recent) {
		const d = haversineNm(first, p);
		if (d > maxDist) maxDist = d;
	}
	const taxiing = lastGround && (maxDist > 0.10 || (lastGs >= 6 && maxDist > 0.05));
	const pushed = lastGround && (maxDist > 0.05 || (lastGs >= 4 && maxDist > 0.03));
	return { pushed, taxiing, flying };
}
export function pushEvidenceFromTrack(points, origin, parked = null, minUnix = 0) {
	if (!Array.isArray(points) || !origin) return null;
	const surfaceCeilingFt = fieldElev(origin) + 250;
	const surface = points
		.map((p) => ({ ...p, t: Number(p.t ?? p.seenAt), gs: p.gs ?? p.gsKt ?? null, alt: p.alt ?? p.altFt ?? null }))
		.filter((p) => Number.isFinite(p.t) && p.t >= minUnix && Number.isFinite(p.lat) && Number.isFinite(p.lon)
			&& haversineNm(p, origin) < 8 && (p.ground === true || (p.alt ?? 9999) <= surfaceCeilingFt))
		.sort((a, b) => a.t - b.t);
	if (surface.length < 2) return null;
	const base = parked ?? surface.find((p) => (p.gs ?? 0) < 1.2) ?? null;
	if (!base) return null;
	const baseUnix = Number(base.t ?? base.seenAt ?? (base.at ? base.at / 1000 : minUnix));
	const firstMoving = surface.find((p) => p.t >= baseUnix && (p.gs ?? 0) >= 2) ?? null;
	for (let i = 0; i < surface.length; i++) {
		const p = surface[i];
		if (p.t < baseUnix) continue;
		const distanceNm = haversineNm(base, p);
		if (!(distanceNm >= 0.05 || ((p.gs ?? 0) >= 4 && distanceNm >= 0.03))) continue;
		const confirming = surface.slice(i + 1).find((q) => q.t - p.t <= 5 * 60
			&& (haversineNm(base, q) >= 0.05 || (q.gs ?? 0) >= 4));
		if (!confirming) continue;
		return {
			unix: p.t,
			lat: p.lat,
			lon: p.lon,
			gsKt: p.gs ?? null,
			distanceNm,
			parked: { lat: base.lat, lon: base.lon, at: baseUnix * 1000 },
			firstGroundMovementUnix: firstMoving?.t ?? null
		};
	}
	return null;
}
export function choosePushEvidence(providerActual, evidence) {
	const tracks = (evidence ?? []).filter((e) => e && Number.isFinite(e.unix)).sort((a, b) => a.unix - b.unix);
	const earliest = tracks[0] ?? null;
	// Preserve the earliest actual evidence. A later provider OUT value can
	// confirm the event, but must not replace an earlier physical stand exit.
	if (Number.isFinite(providerActual) && (!earliest || providerActual <= earliest.unix)) {
		return { unix: providerActual, source: "provider_actual", evidence: earliest };
	}
	return earliest ? { unix: earliest.unix, source: "track_detected", evidence: earliest } : null;
}
export function reconcilePushLatch(prior, selected, gateOut) {
	if (!prior || typeof prior !== "object" || !Number.isFinite(prior.unix)) return selected;
	if (!selected || !Number.isFinite(selected.unix)) return prior;
	const copiedEstimate = prior.source === "live_detected"
		&& [gateOut?.scheduled, gateOut?.estimated].some((unix) => Number.isFinite(unix) && Math.abs(prior.unix - unix) <= 60)
		&& selected.unix > prior.unix + 60;
	if (copiedEstimate) return selected;
	return prior.unix <= selected.unix ? prior : selected;
}
function callsignVariants(callsign) {
	const u = String(callsign || "").replace(/\s/g, "").toUpperCase();
	if (!u) return [];
	const out = new Set([u]);
	const m = u.match(/^([A-Z]{2,3})(\d+)$/);
	if (!m) return [...out];
	const prefix = m[1];
	const num = m[2];
	const stripped = num.replace(/^0+/, "") || "0";
	const nums = [...new Set([num, stripped, stripped.padStart(3, "0"), stripped.padStart(4, "0")])];
	const prefixes = new Set([prefix]);
	if (prefix.length === 3) {
		const iata = Object.entries(IATA_TO_ICAO).find(([, v]) => v === prefix)?.[0];
		if (iata) prefixes.add(iata);
	} else if (IATA_TO_ICAO[prefix]) {
		prefixes.add(IATA_TO_ICAO[prefix]);
	}
	for (const p of prefixes) {
		for (const n of nums) out.add(`${p}${n}`);
	}
	return [...out];
}
function identPrefixes(callsign) {
	const u = String(callsign || "").replace(/\s/g, "").toUpperCase();
	const m = u.match(/^([A-Z]{2,3})\d/);
	const prefix = m ? m[1] : u.slice(0, 3);
	const out = new Set([prefix]);
	if (prefix.length === 3) {
		const iata = Object.entries(IATA_TO_ICAO).find(([, v]) => v === prefix)?.[0];
		if (iata) out.add(iata);
	} else if (IATA_TO_ICAO[prefix]) out.add(IATA_TO_ICAO[prefix]);
	return [...out].filter(Boolean);
}
function isAtcCallsign(fl, prefixes) {
	const u = String(fl || "").replace(/\s/g, "").toUpperCase();
	if (!u) return false;
	return prefixes.some((p) => u.startsWith(p)) && /^[A-Z]{2,3}\d+[A-Z]+$/.test(u);
}
function flightIdentOk(fl, parsed, aware) {
	const u = String(fl || "").replace(/\s/g, "").toUpperCase();
	if (!u || !parsed) return false;
	const vars = new Set(callsignVariants(parsed.callsign));
	const atc = String(aware?.atcIdent ?? "").replace(/\s/g, "").toUpperCase();
	if (atc) vars.add(atc);
	const faIdent = String(aware?.ident ?? "").replace(/\s/g, "").toUpperCase();
	if (faIdent) vars.add(faIdent);
	const faIata = String(aware?.iataIdent ?? "").replace(/\s/g, "").toUpperCase();
	if (faIata) vars.add(faIata);
	if (vars.has(u)) return true;
	return isAtcCallsign(u, identPrefixes(parsed.callsign));
}
function rawMatchesQuery(raw, parsed, aware) {
	if (!raw) return false;
	const fl = String(raw.flight ?? "").replace(/\s/g, "").toUpperCase();
	const r = String(raw.r ?? "").replace(/[-\s]/g, "").toUpperCase();
	const tail = String(aware?.tail ?? "").replace(/[-\s]/g, "").toUpperCase();
	// A reused or incorrect callsign cannot override the assigned aircraft.
	if (tail && r && r !== tail) return false;
	if (flightIdentOk(fl, parsed, aware)) return true;
	if (tail && r === tail) return true;
	return false;
}
function liveFitsLeg(live, aware, origin) {
	if (!live) return false;
	const assigned = String(aware?.tail ?? "").replace(/[-\s]/g, "").toUpperCase();
	const observed = String(live.registration ?? "").replace(/[-\s]/g, "").toUpperCase();
	if (assigned && observed && assigned !== observed) return false;
	const expected = aware?.takeoff?.estimated ?? aware?.takeoff?.scheduled;
	if (!aware?.takeoff?.actual && expected && expected > Date.now() / 1e3 + 5 * 60 && !live.onGround && origin && haversineNm(live, origin) > 25) {
		// A distant flight with this number cannot be the leg still awaiting departure.
		return false;
	}
	return true;
}
function pickAroundAircraft(near, parsed, aware, origin, dest, maxNm, lockedHex) {
	if (!near?.length || !origin) return null;
	const vars = new Set(callsignVariants(parsed.callsign));
	const atc = String(aware?.atcIdent ?? "").replace(/\s/g, "").toUpperCase();
	if (atc) vars.add(atc);
	const faIdent = String(aware?.ident ?? "").replace(/\s/g, "").toUpperCase();
	if (faIdent) vars.add(faIdent);
	const faIata = String(aware?.iataIdent ?? "").replace(/\s/g, "").toUpperCase();
	if (faIata) vars.add(faIata);
	const tail = String(aware?.tail ?? "").replace(/[-\s]/g, "").toUpperCase();
	const wantNum = String(parsed.callsign || "").replace(/\s/g, "").toUpperCase().match(/^[A-Z]{2,3}(\d+)/)?.[1]?.replace(/^0+/, "") || "";
	const prefixes = identPrefixes(parsed.callsign);
	let locked = null;
	for (const a of near) {
		if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
		if (fusionSeen(a) > 40) continue;
		const here = { lat: a.lat, lon: a.lon };
		const dOrig = haversineNm(here, origin);
		const dDest = dest ? haversineNm(here, dest) : 999;
		if (dOrig > maxNm && dDest > maxNm) continue;
		const fl = String(a.flight ?? "").replace(/\s/g, "").toUpperCase();
		const r = String(a.r ?? "").replace(/[-\s]/g, "").toUpperCase();
		if (tail && r && r !== tail) continue;
		const hex = String(a.hex ?? "").toLowerCase();
		if (lockedHex && hex === String(lockedHex).toLowerCase() && rawMatchesQuery(a, parsed, aware)) locked = a;
		if (vars.has(fl)) return a;
		if (tail && r === tail) return a;
		if (wantNum && prefixes.some((p) => fl.startsWith(p))) {
			const num = fl.match(/^[A-Z]{2,3}(\d+)/)?.[1]?.replace(/^0+/, "");
			if (num && num === wantNum) return a;
		}
	}
	return locked;
}
function seenOf(a) {
	return fusionSeen(a);
}
function fusePacks(packs, airside) {
	const fused = fuseProviderLists(packs, { airside: Boolean(airside) });
	return fused;
}
async function adsbByCallsign(callsign) {
	const u = String(callsign || "").replace(/\s/g, "").toUpperCase();
	if (!u) return null;
	return cached(`cs5:${u}`, 5000, async () => {
		const variants = new Set(callsignVariants(u));
		const primary = fusePacks(await fetchByCallsign(u), false)
			.find((a) => variants.has(String(a.flight ?? "").replace(/\s/g, "").toUpperCase())) ?? null;
		if (primary) return primary;
		const iata = displayIata(u, null).replace(/\s/g, "");
		if (!iata || iata === u) return null;
		return fusePacks(await fetchByCallsign(iata), false)
			.find((a) => variants.has(String(a.flight ?? "").replace(/\s/g, "").toUpperCase())) ?? null;
	});
}
async function adsbByReg(reg) {
	const u = String(reg || "").replace(/[-\s]/g, "").toUpperCase();
	if (!u) return null;
	return cached(`reg4:${u}`, 2000, async () => {
		const packs = await fetchByReg(u);
		return fusePacks(packs, false).find((a) => String(a.r ?? "").replace(/[-\s]/g, "").toUpperCase() === u) ?? null;
	});
}
async function adsbAround(lat, lon, dist) {
	const key = `around:${lat.toFixed(2)}:${lon.toFixed(2)}:${dist}`;
	const snapshot = await cached(`around8:${key}`, 6000, async () => {
		const packs = await fetchAround(lat, lon, dist);
		let fused = fusePacks(packs, dist <= 24);
		if (!fused.length) fused = lastGoodAround(key) ?? [];
		else rememberAround(key, fused);
		return fused.map((raw) => ({ at: Date.now(), raw }));
	});
	// A cache hit retains the original observation time. Otherwise a held
	// broad fix looks brand new and can replace a newer exact-identity fix.
	return snapshot.map(({ at, raw }) => {
		const heldSec = Math.max(0, Date.now() - at) / 1000;
		return {
			...raw,
			seen_pos: seenOf(raw) + heldSec,
			_fusion: raw._fusion ? { ...raw._fusion, ageSec: raw._fusion.ageSec + heldSec } : undefined,
		};
	});
}
function headingDelta(a, b) {
	const d = Math.abs(wrap360(a) - wrap360(b));
	return Math.min(d, 360 - d);
}
export function remainingEtaMin(remainingNm, directDestinationNm, live, aware) {
	const now = Date.now() / 1e3;
	const fa = aware?.landing?.estimated ?? aware?.landing?.scheduled ?? null;
	const faMin = typeof fa === "number" && fa > now ? (fa - now) / 60 : null;
	return passengerEtaMin({ remainingNm, directToDestNm: directDestinationNm, gsKt: live?.gsKt ?? 0, providerEtaMin: faMin });
}
async function loadRoute(callsign) {
	return cached(`route:${callsign}`, 18e5, async () => {
		return (await fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, 5e3)).response?.flightroute ?? null;
	});
}
function asTimes(v) {
	const o = v ?? {};
	const actual = typeof o.actual === "number" && Number.isFinite(o.actual) && o.actual > 0 && o.actual <= Date.now() / 1e3 + 30 ? o.actual : null;
	return {
		scheduled: typeof o.scheduled === "number" ? o.scheduled : null,
		estimated: typeof o.estimated === "number" ? o.estimated : null,
		actual
	};
}
function gateOutTimes(v) {
	const gateOut = asTimes(v);
	const ambiguousPublicActual = Boolean(
		gateOut.actual &&
		(
			(gateOut.estimated != null && Math.abs(gateOut.actual - gateOut.estimated) <= 60) ||
			(gateOut.scheduled != null && Math.abs(gateOut.actual - gateOut.scheduled) <= 60)
		)
	);
	return ambiguousPublicActual ? { ...gateOut, actual: null } : gateOut;
}
function confirmedGateOutActual(v) {
	if (v?._trustedActual === true) return asTimes(v).actual;
	return gateOutTimes(v).actual;
}
function bestUnix(t) {
	return t.actual ?? t.estimated ?? t.scheduled;
}
function stampKind(t) {
	if (!t) return null;
	if (t.actual) return "actual";
	if (t.estimated && t.scheduled && Math.abs(t.estimated - t.scheduled) >= 90) return "estimated";
	if (t.scheduled) return "scheduled";
	if (t.estimated) return "estimated";
	return null;
}
function identFromFa(id) {
	if (!id) return null;
	return String(id).toUpperCase().match(/^([A-Z]{2,4}\d{1,4}[A-Z]?)/)?.[1] ?? null;
}
export function operatingIdentFromSchedule(aware, requested) {
	const operating = identFromFa(aware?.flightId);
	const requestedIdent = String(requested ?? "").replace(/\s/g, "").toUpperCase();
	if (!operating || !requestedIdent || operating === requestedIdent) return null;
	return operating;
}
function coordPair(v) {
	if (!Array.isArray(v) || v.length < 2) return null;
	const a = v[0];
	const b = v[1];
	if (typeof a !== "number" || typeof b !== "number") return null;
	if (Math.abs(a) <= 90 && Math.abs(b) > 90) return {
		lat: a,
		lon: b
	};
	return {
		lat: b,
		lon: a
	};
}
function clockAt(unix, tz) {
	if (!unix) return null;
	const zones = [tz, "UTC"].filter(Boolean);
	for (const zone of zones) {
		try {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: zone,
				hour: "numeric",
				minute: "2-digit",
				timeZoneName: "short"
			}).formatToParts(new Date(unix * 1e3));
			const hour = parts.find((p) => p.type === "hour")?.value;
			const minute = parts.find((p) => p.type === "minute")?.value;
			const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value;
			let tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
			if (tzName === "GMT" && (zone === "UTC" || zone === "Etc/UTC")) tzName = "UTC";
			else if (zone === "Europe/London" && /GMT\+1|UTC\+1/.test(tzName)) tzName = "BST";
			else if (zone === "Europe/Paris" && /GMT\+2|UTC\+2/.test(tzName)) tzName = "CEST";
			else if (zone === "Europe/Paris" && /GMT\+1|UTC\+1/.test(tzName)) tzName = "CET";
			const time = dayPeriod ? `${hour}:${minute} ${dayPeriod}` : `${hour}:${minute}`;
			return tzName ? `${time} ${tzName}` : time;
		} catch {
			/* try next zone */
		}
	}
	return null;
}
var origByFlight = /* @__PURE__ */ new Map();
function seedUnix(t) {
	return departureSeedUnix(t);
}
function scheduledSeedUnix(t) {
	return Number.isFinite(t?.scheduled) ? t.scheduled : null;
}
function earliestUnix(a, b) {
	if (a == null) return b;
	if (b == null) return a;
	return Math.min(a, b);
}
function origKey(aware) {
	const u = seedUnix(aware.gateOut) ?? seedUnix(aware.takeoff) ?? Date.now() / 1e3;
	const day = (/* @__PURE__ */ new Date(u * 1e3)).toISOString().slice(0, 10);
	return `${aware._resumeScope ?? ""}${aware.ident}|${aware.originIata ?? ""}|${aware.destIata ?? ""}|${day}`;
}
export function pushLatchFromResume(progressResume) {
	if (!progressResume || !["push", "taxi", "takeoff_roll"].includes(progressResume.departureStage)) return null;
	const detected = progressResume.detectedPushUnix;
	const reportedActual = progressResume.gateOut?.actual;
	const unix = Number.isFinite(detected) ? detected : Number.isFinite(reportedActual) ? reportedActual : null;
	if (!Number.isFinite(unix)) return null;
	return {
		unix,
		source: Number.isFinite(detected) ? "live_detected" : "provider_actual",
		live: true,
		at: unix,
	};
}
function rememberOrig(aware) {
	const key = origKey(aware);
	const prev = origByFlight.get(key);
	const postedGo = bestUnix(aware.gateOut);
	let gateOut = earliestUnix(prev?.gateOut ?? null, scheduledSeedUnix(aware.gateOut));
	if (gateOut != null && postedGo != null && Math.abs(postedGo - gateOut) > 8 * 3600) gateOut = scheduledSeedUnix(aware.gateOut);
	const postedTo = bestUnix(aware.takeoff);
	let takeoff = earliestUnix(prev?.takeoff ?? null, scheduledSeedUnix(aware.takeoff));
	if (takeoff != null && postedTo != null && Math.abs(postedTo - takeoff) > 8 * 3600) takeoff = scheduledSeedUnix(aware.takeoff);
	const postedLd = bestUnix(aware.landing);
	let landing = earliestUnix(prev?.landing ?? null, scheduledSeedUnix(aware.landing));
	if (landing != null && postedLd != null && Math.abs(postedLd - landing) > 8 * 3600) landing = scheduledSeedUnix(aware.landing);
	const next = {
		gateOut,
		takeoff,
		landing,
		gateIn: earliestUnix(prev?.gateIn ?? null, scheduledSeedUnix(aware.gateIn))
	};
	origByFlight.set(key, next);
	return next;
}
function slipMin(posted, orig) {
	if (posted == null || orig == null) return null;
	const m = Math.round((posted - orig) / 60);
	if (!Number.isFinite(m)) return null;
	if (Math.abs(m) < 5) return 0;
	if (m > 8 * 60 || m < -90) return 0;
	return m;
}
function asTaxiMin(v) {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
	const n = v > 180 ? v / 60 : v;
	if (n < 2 || n > 180) return null;
	return Math.round(n);
}
function medianMin(vals) {
	if (vals.length < 2) return vals[0] ?? null;
	const s = vals.slice().sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? Math.round(s[m]) : Math.round((s[m - 1] + s[m]) / 2);
}
function typicalTaxiFromLog(f) {
	const log = f.activityLog;
	const rows = Array.isArray(log?.flights) ? log.flights : [];
	const outs = [];
	const inns = [];
	for (const row of rows) {
		const go = asTimes(row.gateDepartureTimes);
		const to = asTimes(row.takeoffTimes);
		const ld = asTimes(row.landingTimes);
		const gi = asTimes(row.gateInTimes ?? row.gateArrivalTimes);
		if (go.actual && to.actual && to.actual > go.actual) {
			const m = Math.round((to.actual - go.actual) / 60);
			if (m >= 4 && m <= 120) outs.push(m);
		}
		if (ld.actual && gi.actual && gi.actual > ld.actual) {
			const m = Math.round((gi.actual - ld.actual) / 60);
			if (m >= 3 && m <= 90) inns.push(m);
		}
	}
	return {
		out: medianMin(outs.slice(0, 8)),
		inn: medianMin(inns.slice(0, 8))
	};
}
export function pickTaxi(start, end, explicit, typical) {
	if (start.actual && end.actual && end.actual > start.actual) {
		const m = Math.round((end.actual - start.actual) / 60);
		if (m >= 2 && m <= 180) return {
			min: m,
			kind: "measured"
		};
	}
	// Current endpoint estimates outrank a generic filed/typical taxi duration.
	const currentStart = start.actual ?? start.estimated;
	const currentEnd = end.actual ?? end.estimated;
	if (currentStart != null && currentEnd != null && currentEnd > currentStart) {
		const minutes = Math.round((currentEnd - currentStart) / 60);
		if (minutes >= 1 && minutes <= 180) return { min: minutes, kind: "posted" };
	}
	if (explicit != null) return {
		min: explicit,
		kind: "posted"
	};
	const a = start.estimated ?? start.scheduled;
	const b = end.estimated ?? end.scheduled;
	const posted = a != null && b != null && b > a ? Math.round((b - a) / 60) : null;
	if (posted != null && posted >= 16) return {
		min: posted,
		kind: "posted"
	};
	if (typical != null && typical >= 16 && (posted == null || posted <= 14)) return {
		min: typical,
		kind: "typical"
	};
	if (posted != null && posted >= 2) return {
		min: posted,
		kind: posted <= 14 ? "filed" : "posted"
	};
	if (typical != null) return {
		min: typical,
		kind: "typical"
	};
	return {
		min: null,
		kind: null
	};
}
function asDelaySec(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function parseAwareRecord(f, fallbackIdent, withInbound) {
	const origin = f.origin ?? {};
	const dest = f.destination ?? {};
	const oc = coordPair(origin.coord);
	const dc = coordPair(dest.coord);
	const wps = [];
	if (Array.isArray(f.waypoints)) for (const w of f.waypoints) {
		const c = coordPair(w);
		if (c) wps.push({ ...c, label: typeof w?.name === "string" ? w.name : typeof w?.ident === "string" ? w.ident : null });
	}
	const faTrack = [];
	if (Array.isArray(f.track)) {
		for (const p of f.track) {
			const c = coordPair(p?.coord);
			if (!c) continue;
			const altRaw = p.alt;
			const alt = faAltFt(altRaw);
			faTrack.push({
				t: typeof p.timestamp === "number" ? p.timestamp : 0,
				lat: c.lat,
				lon: c.lon,
				alt,
				gs: typeof p.gs === "number" ? p.gs : null,
				track: typeof p.heading === "number" ? p.heading : null,
				ground: alt != null && alt < 200
			});
		}
	}
	if (faTrack.length && typeof f.heading === "number") {
		faTrack[faTrack.length - 1].track = f.heading;
	}
	if (faTrack.length && typeof f.groundspeed === "number") {
		faTrack[faTrack.length - 1].gs = f.groundspeed;
	}
	const here = coordPair(f.coord);
	if (here) {
		const altRaw = f.altitude;
		const alt = faAltFt(altRaw);
		const last = faTrack[faTrack.length - 1];
		const same = last && Math.abs(last.lat - here.lat) < 1e-4 && Math.abs(last.lon - here.lon) < 1e-4;
		if (!same) {
			faTrack.push({
				t: typeof last?.t === "number" && last.t ? last.t : 0,
				lat: here.lat,
				lon: here.lon,
				alt,
				gs: typeof f.groundspeed === "number" ? f.groundspeed : last?.gs ?? null,
				track: typeof f.heading === "number" ? f.heading : last?.track ?? null,
				ground: alt != null && alt < 200
			});
		} else if (last) {
			if (alt != null) last.alt = alt;
		}
	}
	const ac = f.aircraft ?? {};
	let inboundIdent = null;
	let inboundFlightId = null;
	let inbound = null;
	if (withInbound) {
		const inboundRaw = f.inboundFlight;
		if (inboundRaw && typeof inboundRaw === "object") {
			const ir = inboundRaw;
			inboundFlightId = typeof ir.flightId === "string" && ir.flightId.trim() ? ir.flightId.trim() : null;
			inboundIdent = identFromFa(String(ir.flightId ?? ir.ident ?? ""));
			if (inboundIdent && (ir.origin || ir.destination || ir.landingTimes || ir.flightStatus)) inbound = parseAwareRecord(ir, inboundIdent, false);
		}
	}
	const avg = f.averageDelays ?? {};
	const hist = withInbound ? typicalTaxiFromLog(f) : {
		out: null,
		inn: null
	};
	const takeoffTimes = asTimes(f.takeoffTimes);
	return {
		ident: String(f.ident ?? fallbackIdent),
		iataIdent: typeof f.iataIdent === "string" ? f.iataIdent : null,
		status: String(f.flightStatus ?? ""),
		flightId: typeof f.flightId === "string" ? f.flightId : undefined,
		diversion: f.diverted === true || /^diverted\b/i.test(String(f.flightStatus ?? ""))
			? { source: "flightaware", reportedAt: Date.now(), originalDestination: null, destination: null } : undefined,
		originIata: typeof origin.iata === "string" ? origin.iata : null,
		originIcao: typeof origin.icao === "string" ? origin.icao : null,
		originName: typeof origin.friendlyName === "string" ? origin.friendlyName : null,
		originCity: typeof origin.friendlyLocation === "string" ? String(origin.friendlyLocation).split(",")[0] : null,
		originLat: oc?.lat ?? null,
		originLon: oc?.lon ?? null,
		originGate: typeof origin.gate === "string" ? origin.gate : null,
		originTz: faAirportTz(origin),
		destIata: typeof dest.iata === "string" ? dest.iata : null,
		destIcao: typeof dest.icao === "string" ? dest.icao : null,
		destName: typeof dest.friendlyName === "string" ? dest.friendlyName : null,
		destCity: typeof dest.friendlyLocation === "string" ? String(dest.friendlyLocation).split(",")[0] : null,
		destLat: dc?.lat ?? null,
		destLon: dc?.lon ?? null,
		destGate: typeof dest.gate === "string" ? dest.gate : null,
		destTz: faAirportTz(dest),
		takeoff: takeoffTimes,
		landing: asTimes(f.landingTimes),
		gateOut: gateOutTimes(f.gateDepartureTimes),
		gateIn: asTimes(f.gateArrivalTimes),
		inboundIdent,
		inbound,
		inboundFlightId,
		waypoints: wps,
		type: typeof ac.type === "string" ? ac.type : null,
		tail: typeof ac.tail === "string" ? ac.tail : typeof ac.registration === "string" ? ac.registration : typeof f.registration === "string" ? f.registration : null,
		hex: typeof f.hexid === "string" ? f.hexid : typeof ac.hexid === "string" ? ac.hexid : null,
		atcIdent: typeof f.atcIdent === "string" && f.atcIdent.trim() ? f.atcIdent.trim().toUpperCase() : null,
		cancelled: Boolean(f.cancelled),
		averageDelaySec: {
			departure: asDelaySec(avg.departure),
			arrival: asDelaySec(avg.arrival)
		},
		typicalTaxiOutMin: hist.out,
		typicalTaxiInMin: hist.inn,
		filedTaxiOutMin: asTaxiMin(f.taxiOut),
		filedTaxiInMin: asTaxiMin(f.taxiIn),
		gsKt: typeof f.groundspeed === "number" ? f.groundspeed : null,
		heading: typeof f.heading === "number" ? f.heading : null,
		altFt: faAltFt(f.altitude),
		faTrack
	};
}
export async function fetchAwarePage(url, fallbackIdent, withInbound, redirect = "follow", historyFollowed = false) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html"
		},
		redirect,
		signal: AbortSignal.timeout(12e3)
	});
	if (res.status >= 300 && res.status < 400) {
		const stub = stubAwareFromHistory(res.headers.get("location"), fallbackIdent);
		if (stub) {
			// Read the exact dated instance, never the current flight-number page.
			const target = new URL(res.headers.get("location"), url);
			if (!historyFollowed && target.origin === "https://www.flightaware.com"
				&& target.pathname.startsWith(`/live/flight/${stub.ident}/history/`)) {
				const detail = await safe(fetchAwarePage(target.href, fallbackIdent, withInbound, "manual", true), null);
				if (detail && detail.ident === stub.ident && detail.originIcao === stub.originIcao
					&& detail.destIcao === stub.destIcao) return detail;
			}
			return { ...stub, routeOnly: true };
		}
	}
	if (!res.ok) {
		if (res.status === 404 && withInbound && verifiedFlightNotFoundPage(404, await res.text()))
			throw new Error(`[flight_not_found] No flight found for ${fallbackIdent}.`);
		let reason = "";
		if (res.status === 402) {
			const body = (await res.text()).slice(0, 16000);
			reason = /insufficient.{0,30}(credit|balance)|credit.{0,30}exhaust/i.test(body) ? "credit limit"
				: /payment required/i.test(body) ? "payment required"
				: /access denied|request blocked/i.test(body) ? "access denied"
				: /captcha|automated|robot|bot detection/i.test(body) ? "automated-access screening"
				: /FlightAware/i.test(body) ? "FlightAware response" : "unidentified response";
			const clean = (value) => String(value || "absent").replace(/[^a-zA-Z0-9 ._:/;-]/g, "").slice(0, 100);
			const provider = /cloudflare/i.test(body) ? "cloudflare" : /vercel/i.test(body) ? "vercel" : "unidentified";
			const meta = [
				"host=" + clean(new URL(res.url || url).hostname),
				"server=" + clean(res.headers.get("server")),
				"type=" + clean(res.headers.get("content-type")),
				"bodyChars=" + body.length,
				"branding=" + provider,
				"vercelError=" + clean(res.headers.get("x-vercel-error")),
				"retryAfter=" + clean(res.headers.get("retry-after")),
			].join("; ");
			reason += "; " + meta;
		}
		throw new Error(`Current flight route unavailable: schedule provider returned HTTP ${res.status}${reason ? " (" + reason + ")" : ""}. Please try again shortly.`);
	}
	const html = await res.text();
	const raw = html.split("trackpollBootstrap = ")[1];
	if (!raw && withInbound && verifiedFlightNotFoundPage(res.status, html))
		throw new Error(`[flight_not_found] No flight found for ${fallbackIdent}.`);
	if (!raw) throw new Error("Current flight route unavailable: schedule provider returned no flight data. Please try again shortly.");
	const flights = parseJsonObject(raw)?.flights;
	if (!flights) return null;
	const f = flights[Object.keys(flights)[0] ?? ""];
	if (!f) return null;
	return parseAwareRecord(f, fallbackIdent, withInbound);
}
function stubAwareFromHistory(loc, fallbackIdent) {
	if (!loc) return null;
	const m = decodeURIComponent(String(loc)).match(/\/live\/flight\/([A-Z0-9]+)\/history\/(\d{8})\/(\d{3,4}Z)\/([A-Z]{4})\/([A-Z]{4})/i);
	if (!m) return null;
	const ident = m[1].toUpperCase();
	const origin = airportByIcao(m[4].toUpperCase());
	const dest = airportByIcao(m[5].toUpperCase());
	const none = {
		scheduled: null,
		estimated: null,
		actual: null
	};
	const parsed = parseFlightQuery(ident);
	return {
		ident: ident || fallbackIdent,
		iataIdent: parsed?.iata ?? null,
		// A canonical history URL identifies a flight instance; it does not prove
		// that the aircraft has arrived. Live ADS-B or actual arrival timestamps
		// must establish landing and gate state.
		status: "",
		originIata: origin?.iata ?? m[4].slice(1),
		originIcao: origin?.icao ?? m[4].toUpperCase(),
		originName: origin?.name ?? null,
		originCity: origin?.city ?? null,
		originLat: origin?.lat ?? null,
		originLon: origin?.lon ?? null,
		originGate: null,
		destIata: dest?.iata ?? m[5].slice(1),
		destIcao: dest?.icao ?? m[5].toUpperCase(),
		destName: dest?.name ?? null,
		destCity: dest?.city ?? null,
		destLat: dest?.lat ?? null,
		destLon: dest?.lon ?? null,
		destGate: null,
		takeoff: none,
		landing: none,
		gateOut: none,
		gateIn: none,
		inboundIdent: null,
		inbound: null,
		inboundFlightId: null,
		waypoints: [],
		type: null,
		tail: null,
		hex: null,
		cancelled: false,
		averageDelaySec: {
			departure: null,
			arrival: null
		},
		typicalTaxiOutMin: null,
		typicalTaxiInMin: null,
		filedTaxiOutMin: null,
		filedTaxiInMin: null
	};
}
function cleanPublicScheduleHtml(html) {
	return String(html ?? "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ")
		.trim();
}
const FLIGHTSTATS_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const FLIGHTSTATS_TZ_OFFSET_MIN = {
	UTC: 0, GMT: 0,
	EDT: -240, EST: -300, CDT: -300, CST: -360, MDT: -360, MST: -420, PDT: -420, PST: -480,
	AKDT: -480, AKST: -540, HST: -600,
	BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
	JST: 540, KST: 540, IST: 330, GST: 240, AEST: 600, AEDT: 660, AWST: 480, NZST: 720, NZDT: 780,
};
function flightStatsTimeUnix(section, label) {
	const text = String(section ?? "");
	const re = new RegExp(`\\b${label}\\s+(\\d{1,2}):(\\d{2})\\s+([A-Z]{2,5}|[+-]\\d{2})\\b`, "i");
	const m = re.exec(text);
	if (!m) return null;
	// A section can publish one date followed by Scheduled, Estimated and Actual
	// times. An explicit later date starts a new context (including midnight).
	const dates = [...text.slice(0, m.index).matchAll(/\b(\d{2})-([A-Za-z]{3})-(\d{4})\b/g)];
	const date = dates.at(-1);
	if (!date) return null;
	const month = FLIGHTSTATS_MONTHS[date[2][0].toUpperCase() + date[2].slice(1, 3).toLowerCase()];
	const hour = Number(m[1]), minute = Number(m[2]), year = Number(date[3]), day = Number(date[1]);
	if (!Number.isInteger(month) || !Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
	const zone = m[3].toUpperCase();
	let offset = FLIGHTSTATS_TZ_OFFSET_MIN[zone];
	if (offset == null && /^[+-]\d{2}$/.test(zone)) offset = Number(zone) * 60;
	if (!Number.isFinite(offset)) return null;
	return Math.floor((Date.UTC(year, month, day, hour, minute) - offset * 60_000) / 1000);
}
function flightStatsTimes(section) {
	return {
		scheduled: flightStatsTimeUnix(section, "Scheduled"),
		estimated: flightStatsTimeUnix(section, "Estimated"),
		actual: flightStatsTimeUnix(section, "Actual"),
	};
}
function flightStatsDetailUrls(html, carrier, number, date) {
	const escaped = String(html ?? "").replace(/&amp;/gi, "&");
	const pattern = new RegExp(`(?:https:\\/\\/www\\.flightstats\\.com)?\\/v2\\/flight-tracker\\/${carrier}\\/${number}\\?[^"'<>\\s]*flightId=\\d+[^"'<>\\s]*`, "gi");
	const urls = [];
	for (const found of escaped.match(pattern) ?? []) {
		try {
			const url = new URL(found.startsWith("http") ? found : `https://www.flightstats.com${found}`);
			if (Number(url.searchParams.get("year")) !== date.year
				|| Number(url.searchParams.get("month")) !== date.month
				|| Number(url.searchParams.get("date")) !== date.day
				|| !url.searchParams.get("flightId")) continue;
			const value = url.toString();
			if (!urls.includes(value)) urls.push(value);
			if (urls.length >= 6) break;
		} catch {
			/* ignore malformed public links */
		}
	}
	return urls;
}
export function parseFlightStatsPublicSchedule(html, callsign, dateKey) {
	const parsed = parseFlightQuery(callsign);
	const iataIdent = parsed?.iata;
	const match = String(iataIdent ?? "").match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
	if (!match) return null;
	const text = cleanPublicScheduleHtml(html);
	if (!/Flight Status/i.test(text)) return null;
	const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (!compact.includes(iataIdent.toUpperCase())) return null;
	const statusStart = text.search(/Flight Status/i);
	const section = statusStart >= 0 ? text.slice(statusStart, statusStart + 4500) : text.slice(0, 4500);
	const departureIndex = section.search(/\bFlight Departure Times\b/i);
	const arrivalIndex = section.search(/\bFlight Arrival Times\b/i);
	if (departureIndex < 0 || arrivalIndex <= departureIndex) return null;
	const header = section.slice(0, departureIndex);
	const departureSection = section.slice(departureIndex, arrivalIndex);
	const arrivalSection = section.slice(arrivalIndex);
	// FlightStats exposes IATA codes in the route header even when an airport is
	// not in our curated display directory. Keep those identities so the field
	// resolver can obtain coordinates from AviationWeather instead of dropping
	// the entire schedule. Route codes are the final uppercase triplets before
	// the departure section; status/timezone tokens are excluded explicitly.
	const ignoredCodes = new Set(["ARR", "DEP", "ETA", "ETD", "EST", "UTC", "GMT", "TBD"]);
	const candidates = [...header.matchAll(/\b([A-Z]{3})\b/g)]
		.map((m) => m[1])
		.filter((code) => !ignoredCodes.has(code));
	const codes = [];
	for (let i = candidates.length - 1; i >= 0 && codes.length < 2; i--) {
		const code = candidates[i];
		if (!codes.includes(code)) codes.unshift(code);
	}
	if (codes.length < 2 || codes[0] === codes[1]) return null;
	const origin = airportByIata(codes[0]);
	const dest = airportByIata(codes[1]);
	const gateOut = flightStatsTimes(departureSection);
	const gateIn = flightStatsTimes(arrivalSection);
	const none = { scheduled: null, estimated: null, actual: null };
	const cancelled = /\bCancelled\b/i.test(header);
	const arrived = /\bArrived\b|\bLanded\b/i.test(header);
	const departed = /\bDeparted\b/i.test(header);
	return {
		ident: parsed.callsign,
		iataIdent,
		status: cancelled ? "cancelled" : arrived ? "arrived" : departed ? "departed" : /\bScheduled\b/i.test(header) ? "scheduled" : "",
		confirmedAt: Date.now(),
		originIata: origin?.iata ?? codes[0],
		originIcao: origin?.icao ?? null,
		originName: origin?.name ?? codes[0],
		originCity: origin?.city ?? "",
		originLat: origin?.lat ?? null,
		originLon: origin?.lon ?? null,
		originGate: null,
		originTz: origin?.tz ?? null,
		destIata: dest?.iata ?? codes[1],
		destIcao: dest?.icao ?? null,
		destName: dest?.name ?? codes[1],
		destCity: dest?.city ?? "",
		destLat: dest?.lat ?? null,
		destLon: dest?.lon ?? null,
		destGate: null,
		destTz: dest?.tz ?? null,
		takeoff: { ...none },
		landing: { ...none },
		gateOut,
		gateIn,
		inboundIdent: null,
		inbound: null,
		inboundFlightId: null,
		waypoints: [],
		type: null,
		tail: null,
		hex: null,
		cancelled,
		averageDelaySec: { departure: null, arrival: null },
		typicalTaxiOutMin: null,
		typicalTaxiInMin: null,
		filedTaxiOutMin: null,
		filedTaxiInMin: null,
		_publicScheduleSource: "flightstats",
		_publicScheduleDate: dateKey,
	};
}
export function chooseFlightStatsScheduleCandidate(records, nowSec = Date.now() / 1000) {
	const MAX_FUTURE_SEC = 18 * 3600;
	const MAX_PAST_SEC = 18 * 3600;
	const usable = (records ?? []).filter(Boolean).filter((record) => {
		const depart = bestUnix(record.gateOut);
		const arrive = bestUnix(record.gateIn);
		if (depart != null && arrive != null && arrive > depart && nowSec >= depart && nowSec <= arrive) return true;
		if (depart != null && depart > nowSec) return depart - nowSec <= MAX_FUTURE_SEC;
		if (arrive != null && arrive < nowSec) return nowSec - arrive <= MAX_PAST_SEC;
		if (depart != null && depart <= nowSec && arrive == null) return nowSec - depart <= MAX_PAST_SEC;
		if (arrive != null && arrive >= nowSec && depart == null) return arrive - nowSec <= MAX_FUTURE_SEC;
		return depart == null && arrive == null;
	});
	if (!usable.length) return null;
	const score = (record) => {
		const depart = bestUnix(record.gateOut);
		const arrive = bestUnix(record.gateIn);
		if (depart != null && arrive != null && arrive > depart) {
			if (nowSec >= depart && nowSec <= arrive) return 0;
			if (nowSec < depart) return depart - nowSec;
			return (nowSec - arrive) * 0.75;
		}
		if (depart != null) return Math.abs(depart - nowSec);
		if (arrive != null) return Math.abs(arrive - nowSec) * (nowSec >= arrive ? 0.75 : 1);
		const day = Date.parse(`${record._publicScheduleDate ?? ""}T12:00:00Z`) / 1000;
		return Number.isFinite(day) ? Math.abs(day - nowSec) + 36 * 3600 : Number.POSITIVE_INFINITY;
	};
	return usable.slice().sort((a, b) => score(a) - score(b))[0] ?? null;
}
async function loadFlightStatsPublic(callsign) {
	const parsed = parseFlightQuery(callsign);
	const m = String(parsed?.iata ?? "").match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
	if (!m) return null;
	const now = new Date(Date.now());
	const dates = [0, -1, 1].map((offset) => {
		const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
		return { key: d.toISOString().slice(0, 10), year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
	});
	return cached(`flightstats-public-v2:${parsed.iata}:${dates[0].key}`, 60_000, async () => {
		const pages = (await Promise.all(dates.map(async (date) => {
			try {
				const url = `https://www.flightstats.com/v2/flight-tracker/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}?year=${date.year}&month=${date.month}&date=${date.day}`;
				const res = await fetch(url, {
					headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": UA },
					signal: AbortSignal.timeout(6500),
				});
				if (!res.ok) return null;
				const html = await res.text();
				if (html.length > 4_000_000) return null;
				return { date, html, direct: parseFlightStatsPublicSchedule(html, callsign, date.key) };
			} catch {
				return null;
			}
		}))).filter(Boolean);
		const directRecords = pages.map((page) => page.direct).filter(Boolean);
		let candidates = directRecords.slice();
		const bestDirect = chooseFlightStatsScheduleCandidate(directRecords);
		const bestPage = bestDirect ? pages.find((page) => page.direct === bestDirect) : null;
		const detailPages = bestPage ? [bestPage] : pages;
		const detailRequests = [];
		const seenDetailUrls = new Set();
		for (const page of detailPages) {
			for (const url of flightStatsDetailUrls(page.html, m[1], m[2], page.date)) {
				if (seenDetailUrls.has(url)) continue;
				seenDetailUrls.add(url);
				detailRequests.push({ url, dateKey: page.date.key });
				if (detailRequests.length >= 12) break;
			}
			if (detailRequests.length >= 12) break;
		}
		if (detailRequests.length) {
			const details = await Promise.all(detailRequests.map(async ({ url, dateKey }) => {
				try {
					const res = await fetch(url, {
						headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": UA },
						signal: AbortSignal.timeout(6500),
					});
					if (!res.ok) return null;
					const html = await res.text();
					if (html.length > 4_000_000) return null;
					return parseFlightStatsPublicSchedule(html, callsign, dateKey);
				} catch {
					return null;
				}
			}));
			candidates = candidates.concat(details.filter(Boolean));
		}
		const selected = chooseFlightStatsScheduleCandidate(candidates);
		if (!selected && pages.length === dates.length && pages.every(page => verifiedFlightNotFoundPage(200, page.html)))
			throw new Error(`[flight_not_found] No flight found for ${parsed.iata} on the checked service dates.`);
		if (selected) {
			console.info("[flightstats-schedule]", {
				callsign: parsed.callsign,
				date: selected._publicScheduleDate,
				origin: selected.originIata,
				destination: selected.destIata,
				status: selected.status,
				gateOut: bestUnix(selected.gateOut),
				gateIn: bestUnix(selected.gateIn),
				candidates: candidates.length,
			});
		}
		return selected;
	});
}
const awareRejections = new Map();
let awarePublicBlockedUntil = 0;
export function scheduleHasRoute(record) {
	return Boolean(record && (record.originIata || record.originIcao) && (record.destIata || record.destIcao));
}
async function loadAware(callsign) {
	const apiRecord = await loadAeroFlight(callsign);
	if (apiRecord) return { ...apiRecord, _scheduleSource: "flightaware_api" };
	if (Date.now() < awarePublicBlockedUntil) {
		const fallback = await loadFlightStatsPublic(callsign);
		noteStoryFallback(fallback ? "flightstats_used" : "flightstats_unavailable");
		if (fallback) return fallback;
		throw new Error("Current flight route unavailable: public FlightAware schedule source is temporarily blocked.");
	}
	const rejected = awareRejections.get(callsign);
	if (rejected && Date.now() < rejected.until) {
		const fallback = await loadFlightStatsPublic(callsign);
		noteStoryFallback(fallback ? "flightstats_used" : "flightstats_unavailable");
		if (fallback) return fallback;
		throw rejected.error;
	}
	awareRejections.delete(callsign);
	try {
		const record = await cached(`aware:${callsign}`, 8e3, async () => {
			const result = await fetchAwarePage(`https://www.flightaware.com/live/flight/${encodeURIComponent(callsign)}`, callsign, true);
			return result ? { ...result, confirmedAt: Date.now() } : null;
		});
		if (scheduleHasRoute(record)) awarePublicBlockedUntil = 0;
		if (record && !scheduleHasRoute(record)) {
			// FlightAware occasionally publishes a truthy trackpoll shell with no
			// route. Treat it as unavailable so it cannot suppress the independent
			// public schedule fallback.
			const fallback = await loadFlightStatsPublic(callsign);
			noteStoryFallback(fallback ? "flightstats_used" : "flightstats_unavailable");
			if (fallback) return fallback;
		}
		return record;
	} catch (error) {
		if (/HTTP 402\b/.test(error?.message ?? "")) {
			awarePublicBlockedUntil = Math.max(awarePublicBlockedUntil, Date.now() + 60_000);
			for (const [key, entry] of awareRejections) if (entry.until <= Date.now()) awareRejections.delete(key);
			if (awareRejections.size >= 100) awareRejections.delete(awareRejections.keys().next().value);
			awareRejections.set(callsign, { until: Date.now() + 60000, error });
		}
		if (!flightNotFound(error)) {
			const fallback = await loadFlightStatsPublic(callsign);
			noteStoryFallback(fallback ? "flightstats_used" : "flightstats_unavailable");
			if (fallback) return fallback;
		}
		throw error;
	}
}
/** Specific FA instance (UAL2290-…), not the current flight using that number. */
function faInstanceId(flightId) {
	return String(flightId || "").replace(/:.*$/, "").trim();
}
async function loadAwareById(flightId) {
	const id = faInstanceId(flightId);
	if (!id) return null;
	const ident = identFromFa(id) || id;
	const apiRecord = await loadAeroFlight(id, true);
	if (apiRecord) return apiRecord;
	return cached(`awareid2:${id}`, 12e3, async () => {
		return fetchAwarePage(`https://www.flightaware.com/live/flight/id/${encodeURIComponent(id)}`, ident, false, "manual");
	});
}
function fieldFromKnown(iata, icao, lat, lon, name, city, tzHint) {
	const known = icao && airportByIcao(icao) || iata && airportByIata(iata) || void 0;
	if (!known && (lat == null || lon == null)) return null;
	return {
		icao: known?.icao ?? icao ?? "",
		iata: known?.iata ?? iata ?? "",
		name: known?.name ?? name?.replace(/Intl|International Airport/gi, "").trim() ?? iata ?? "",
		city: known?.city ?? city ?? "",
		lat: known?.lat ?? lat,
		lon: known?.lon ?? lon,
		tz: known?.tz ?? ianaFromFa(tzHint) ?? tzFromCoord(known?.lat ?? lat, known?.lon ?? lon),
		elevationFt: known?.elevationFt ?? 0,
		decoded: null,
		rawMetar: null,
		nas: null,
		category: "UNK"
	};
}
async function loadAirportInfo(iata, icao) {
	const normalizedIata = String(iata ?? "").toUpperCase();
	const normalizedIcao = String(icao ?? "").toUpperCase();
	const candidates = [...new Set([
		/^[A-Z0-9]{4}$/.test(normalizedIcao) ? normalizedIcao : null,
		/^[A-Z]{3}$/.test(normalizedIata) ? `K${normalizedIata}` : null,
	].filter(Boolean))];
	for (const candidate of candidates) {
		const row = await safe(cached(`airport-info-v2:${candidate}`, 24 * 60 * 60_000, async () => {
			const rows = await fetchJson(`https://aviationweather.gov/api/data/airport?ids=${encodeURIComponent(candidate)}&format=json`, 10e3);
			return Array.isArray(rows) ? rows[0] ?? null : null;
		}), null);
		if (!row || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
		const rowIata = String(row.iataId ?? "").toUpperCase();
		const rowIcao = String(row.icaoId ?? "").toUpperCase();
		if (normalizedIata && rowIata !== normalizedIata) continue;
		if (normalizedIcao && rowIcao !== normalizedIcao) continue;
		return {
			iata: rowIata || normalizedIata,
			icao: rowIcao || normalizedIcao,
			lat: row.lat,
			lon: row.lon,
			name: row.name ?? row.site ?? normalizedIata,
			city: row.city ?? "",
		};
	}
	return null;
}
/** Resolve coordinates without replacing a current flight's airport identity. */
export async function resolveFlightField(aware, side, fallback) {
  const prefix = side === "origin" ? "origin" : "dest";
  const iata = aware?.[prefix + "Iata"] ?? null;
  const icao = aware?.[prefix + "Icao"] ?? null;
  const make = (lat, lon) => fieldFromKnown(iata, icao, lat, lon,
    aware?.[prefix + "Name"], aware?.[prefix + "City"], aware?.[prefix + "Tz"]);
  const known = make(aware?.[prefix + "Lat"], aware?.[prefix + "Lon"]);
  if (known) return known;
  const airportInfo = await loadAirportInfo(iata, icao);
  if (airportInfo) {
	const resolved = fieldFromKnown(airportInfo.iata, airportInfo.icao, airportInfo.lat, airportInfo.lon,
		aware?.[prefix + "Name"] || airportInfo.name, aware?.[prefix + "City"] || airportInfo.city, aware?.[prefix + "Tz"]);
	if (resolved) return resolved;
  }
  if (icao && /^[A-Z0-9]{4}$/.test(icao)) {
    const { metar } = await safe(loadMetar(icao), {metar:null});
    if (Number.isFinite(metar?.lat) && Number.isFinite(metar?.lon)) return make(metar.lat, metar.lon);
  }
  const candidate = fieldFromAdsbdb(fallback);
  if (!candidate) return null;
  // Route databases can retain a previous city pair for this flight number.
  if ((iata || icao) && candidate.iata !== iata && candidate.icao !== icao) return null;
  return candidate;
}
function titleNas(reason) {
	if (!reason) return reason;
	const cleaned = String(reason)
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^(wx|weather)\s*[:/-]\s*/i, "")
		.trim()
		.toLowerCase();
	if (!cleaned) return reason;
	const small = /^(and|or|of|the|at|to|for|in|on|a|an)$/;
	return cleaned
		.split(" ")
		.map((w, i) => {
			if (!w) return w;
			if (i > 0 && small.test(w)) return w;
			return w.charAt(0).toUpperCase() + w.slice(1);
		})
		.join(" ");
}
async function loadNas(iata) {
	if (!/^[A-Z]{3}$/.test(iata)) return null;
	return cached(`nas2:${iata}`, 22e3, async () => {
		try {
			const st = (await fetchJson(`https://external-api.faa.gov/asws/api/airport/status/${iata}`, 5e3)).Status?.[0];
			const reason = (st?.Reason ?? "").trim();
			const type = st?.Type ?? null;
			const isNotam = reason.startsWith("!") || /NON SKED|PPR CTC/i.test(reason);
			const known = Boolean(type) && !/no known delays/i.test(reason) && !isNotam;
			return {
				delayed: known,
				type,
				reason: known ? titleNas(reason) : "No known FAA delays",
				avg: st?.AvgDelay ?? null,
				min: st?.MinDelay ?? null,
				max: st?.MaxDelay ?? null,
				trend: st?.Trend ?? null
			};
		} catch {
			return null;
		}
	});
}
async function loadMetar(icao) {
	return cached(`wx:${icao}`, 22e3, async () => {
		return { metar: (await safe(fetchJson(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=2`), []))[0] ?? null };
	});
}
async function loadTaf(icao) {
	if (!icao) return null;
	return cached(`taf:${icao}`, 60e3, async () => {
		const rows = await safe(fetchJson(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`), []);
		return Array.isArray(rows) ? rows[0] ?? null : null;
	});
}
async function loadHazards() {
	return cached("hazards", 22e3, async () => {
		const [gairmet, sigmet, pirep, cwa, tcf] = await Promise.all([
			safe(fetchJson("https://aviationweather.gov/api/data/gairmet?format=geojson").then((d) => d.features ?? []), null),
			safe(fetchJson("https://aviationweather.gov/api/data/airsigmet?format=geojson").then((d) => d.features ?? []), null),
			Promise.resolve([]),
			safe(fetchJson("https://aviationweather.gov/api/data/cwa?format=geojson").then((d) => d.features ?? []), null),
			safe(fetchJson("https://aviationweather.gov/api/data/tcf?format=geojson").then((d) => d.features ?? []), null)
		]);
		return {
			gairmet: gairmet ?? [],
			sigmet: sigmet ?? [],
			pirep,
			cwa: cwa ?? [],
			tcf: tcf ?? [],
			failedSources: [["Turbulence advisories", gairmet], ["Storm advisories", sigmet], ["Local advisories", cwa], ["Storm forecasts", tcf]].filter(([, data]) => data == null).map(([name]) => name)
		};
	});
}
function fieldFromAdsbdb(p) {
	const icao = (p?.icao_code ?? "").toUpperCase();
	const iata = (p?.iata_code ?? "").toUpperCase();
	const lat = p?.latitude;
	const lon = p?.longitude;
	if (!icao || lat == null || lon == null) return null;
	const known = airportByIcao(icao) ?? (iata ? airportByIata(iata) : void 0);
	return {
		icao,
		iata: iata || known?.iata || icao.slice(1),
		name: known?.name ?? (p?.name ? p.name.replace(/International Airport/i, "").trim() : icao),
		city: known?.city ?? p?.municipality ?? "",
		lat: known?.lat ?? lat,
		lon: known?.lon ?? lon,
		tz: known?.tz ?? tzFromCoord(known?.lat ?? lat, known?.lon ?? lon),
		decoded: null,
		rawMetar: null,
		nas: null,
		category: "UNK"
	};
}
function nasCopy(nas, role) {
	if (!nas || !nas.delayed) return role === "origin" ? "No FAA delay program on the field right now." : "No FAA delay program at arrival right now.";
	const wait = nas.avg ?? (nas.min && nas.max ? `${nas.min}–${nas.max}` : nas.min ?? nas.max);
	const type = nas.type ? nas.type.toLowerCase() : "delay";
	const reason = nas.reason.replace(/^[A-Z0-9!].{40,}$/, "operational restriction");
	const waitBit = wait ? ` About ${wait}.` : "";
	if (role === "origin") {
		if (/ground stop/i.test(type)) return `Ground stop — nothing is leaving until this lifts.${waitBit} ${reason}.`;
		if (/ground delay/i.test(type)) return `Ground delay program.${waitBit} Reason: ${reason}.`;
		if (/departure/i.test(type)) return `Departure metering is on.${waitBit} ${reason}.`;
		return `The field is delayed (${type}).${waitBit} ${reason}.`;
	}
	if (/ground delay/i.test(type)) return `Arrival ground delay.${waitBit} ${reason}.`;
	if (/ground stop/i.test(type)) return `Arrival ground stop.${waitBit} ${reason}.`;
	if (/arrival/i.test(type)) return `Inbound…10762 tokens truncated…o: flight.origin.icao ?? null,
		originName: null,
		originCity: null,
		originTz: null,
		originLat: null,
		originLon: null,
		originGate: flight.origin.gate ?? null,
		destIata: flight.destination.iata ?? null,
		destIcao: flight.destination.icao ?? null,
		destName: null,
		destCity: null,
		destTz: null,
		destLat: null,
		destLon: null,
		destGate: flight.destination.gate ?? null,
		gateOut: flight.push ?? { ...none },
		takeoff: flight.takeoff ?? { ...none },
		landing: flight.landing ?? { ...none },
		gateIn: flight.gateIn ?? { ...none },
		inboundIdent: null,
		inbound: null,
		inboundFlightId: null,
		waypoints: flight.waypoints ?? [],
		type: flight.type ?? position.type ?? null,
		tail: flight.registration ?? position.registration ?? null,
		hex: flight.hex ?? position.hex ?? null,
		cancelled: false,
		averageDelaySec: { departure: null, arrival: null },
		typicalTaxiOutMin: null,
		typicalTaxiInMin: null,
		filedTaxiOutMin: null,
		filedTaxiInMin: null,
		gsKt: position.gsKt ?? null,
		heading: position.track ?? null,
		altFt: position.altFt ?? null,
		faTrack,
		providerEta: flight.providerEta ?? null,
	};
}

function pointAtFrac(path, frac) {
	if (!path?.length) return null;
	const t = Math.max(0, Math.min(1, frac));
	const idx = t * (path.length - 1);
	const i = Math.floor(idx);
	const f = idx - i;
	const a = path[i];
	const b = path[Math.min(path.length - 1, i + 1)] ?? a;
	return {
		lat: a.lat + (b.lat - a.lat) * f,
		lon: a.lon + (b.lon - a.lon) * f
	};
}
function resumeFromAware(aware, query) {
	if (!aware || aware.diversion) return undefined;
	return readFlightResume({ ...aware, version: 1, callsign: parseFlightQuery(query)?.callsign }, query);
}
function awareFromResume(resume, scope) {
	return {
		...resume, _resumeScope: scope, iataIdent: parseFlightQuery(resume.callsign)?.iata,
		// No old positions, status strings, or inferred inbound state become live data.
		status: "", faTrack: [], inbound: null, inboundIdent: null, inboundFlightId: null,
		cancelled: false, averageDelaySec: { departure: null, arrival: null },
		typicalTaxiOutMin: null, typicalTaxiInMin: null, filedTaxiOutMin: null, filedTaxiInMin: null,
	};
}
async function buildStory(query, resumed = null, progressResume = null) {
	const parsed = parseFlightQuery(query);
	if (!parsed) throw new Error("Try a flight number like AA 1 or UA 2814");
	const identKey = parsed.callsign.toUpperCase();
	const stateIdent = `${resumed?.scope ?? ""}${identKey}`;
	let knownHex = hexByIdent.get(stateIdent) || null;
	const hazardsP = loadHazards();
	let scheduleError = null;
	const [rawAc0, publicAware, route] = await Promise.all([
		knownHex
			? safe(adsbByHex(knownHex), null)
			: parsed.registration
				? safe(adsbByReg(parsed.registration), null)
				: safe(adsbByCallsign(parsed.callsign), null),
		(resumed ? Promise.resolve(awareFromResume(resumed.resume, resumed.scope)) : loadAware(parsed.callsign)).catch((err) => {
			scheduleError = err;
			console.warn("[schedule-fallback-unavailable]", {
				callsign: parsed.callsign,
				reason: err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180),
			});
			return null;
		}),
		safe(loadRoute(parsed.callsign), null),
	]);
	const operatingIdent = operatingIdentFromSchedule(publicAware, parsed.callsign);
	const nowSec = Date.now() / 1000;
	const fr24DepartureClock = publicAware ? bestUnix(publicAware.gateOut) : null;
	const fr24SurfaceDeparture = Boolean(
		publicAware &&
		!publicAware?.takeoff?.actual &&
		!publicAware?.landing?.actual &&
		fr24DepartureClock != null &&
		nowSec >= fr24DepartureClock - 2 * 60 * 60 &&
		nowSec <= fr24DepartureClock + 4 * 60 * 60
	);
	const official = await loadOfficialFlightData(parsed.callsign, {
		fr24FlightNumber: parsed.iata,
		fr24OriginIata: publicAware?.originIata ?? null,
		fr24DestIata: publicAware?.destIata ?? null,
		fr24Registration: publicAware?.tail ?? null,
		fr24OperatingCallsign: operatingIdent,
		fr24SurfaceDeparture,
	});
	const fr24Aware = publicAware ? null : awareFromLiveFr24(official.fr24);
	if (fr24Aware) {
		console.info(JSON.stringify({
			event: "fr24_live_leg_fallback",
			requested: parsed.callsign,
			flightId: fr24Aware.flightId,
			origin: fr24Aware.originIata ?? fr24Aware.originIcao,
			destination: fr24Aware.destIata ?? fr24Aware.destIcao,
		}));
	}
	const currentLegAware = publicAware ?? fr24Aware;
	const scheduleSource = resumed ? "saved_resume" : publicAware
		? publicAware._scheduleSource ?? (publicAware._publicScheduleDate ? "flightstats_public" : "flightaware_public")
		: fr24Aware ? "fr24_live" : "unavailable";
	noteStorySchedule(scheduleSource);
	const flightawareOfficial = officialAwareCompatible(currentLegAware, official.flightaware) ? official.flightaware : null;
	if (official.flightaware && !flightawareOfficial) {
		console.log("[flightaware-instance-mismatch]", {
			requested: parsed.callsign,
			selectedFlightId: currentLegAware?.flightId ?? null,
			officialFlightId: official.flightaware.flightId ?? null,
			selectedRoute: [currentLegAware?.originIata ?? currentLegAware?.originIcao ?? null, currentLegAware?.destIata ?? currentLegAware?.destIcao ?? null],
			officialRoute: [official.flightaware.origin?.iata ?? official.flightaware.origin?.icao ?? null, official.flightaware.destination?.iata ?? official.flightaware.destination?.icao ?? null]
		});
	}
	const aware = mergeOfficialAware(currentLegAware, flightawareOfficial);
	// Flight-number route databases retain old assignments after a number moves
	// to a different city pair. A fresh aircraft at the old origin cannot
	// establish the destination or service date. Require a current schedule
	// or FR24 live record that identifies both ends of the active leg.
	if (!parsed.registration && (!(aware?.originIata || aware?.originIcao) || !(aware?.destIata || aware?.destIcao))) {
		if (flightNotFound(scheduleError)) throw scheduleError;
		throw new Error("Current flight route unavailable. Try again when the flight feed responds.");
	}
	let rawAc = rawAc0;
	if (rawAc && !rawMatchesQuery(rawAc, parsed, aware)) {
		rawAc = null;
		hexByIdent.delete(stateIdent);
		hexRouteByIdent.delete(stateIdent);
	}
	if (!rawAc && aware?.ident) {
		const faCs = String(aware.ident).replace(/\s/g, "").toUpperCase();
		if (faCs && faCs !== identKey) {
			const byFa = await safe(adsbByCallsign(faCs), null);
			if (byFa && rawMatchesQuery(byFa, parsed, aware)) rawAc = byFa;
		}
	}
	if (!rawAc && knownHex) rawAc = parsed.registration
		? await safe(adsbByReg(parsed.registration), null)
		: await safe(adsbByCallsign(parsed.callsign), null);
	const liveCs = parsed.callsign;
	const adsbLive = rawAc ? toLive(rawAc) : null;
	let [origin, dest] = await Promise.all([
    resolveFlightField(aware, "origin", route?.origin),
    resolveFlightField(aware, "dest", route?.destination),
  ]);
	if (!origin || !dest) throw new Error("Flight route unavailable. Try again when the flight feeds respond.");
	const frGround = official.fr24?.position;
	const surfaceField = frGround?.onGround === true && haversineNm(frGround, dest) < haversineNm(frGround, origin) ? dest : origin;
	const positionChoice = choosePosition(
		[normalizedAdsb(adsbLive), official.fr24?.position, flightawareOfficial?.position],
		{ callsigns: [parsed.callsign, aware?.ident, aware?.iataIdent].filter(Boolean), registration: aware?.tail ?? null, hex: knownHex ?? aware?.hex ?? null },
		Date.now() / 1000, fieldElev(surfaceField)
	);
	const phaseContext = { origin: { ...origin, elevationFt: fieldElev(origin) }, dest: { ...dest, elevationFt: fieldElev(dest) } };
	let live = positionChoice.chosen ? normalizedToLive(positionChoice.chosen, phaseContext) : adsbLive ?? liveFromAware(aware, phaseContext);
	const fieldsP = Promise.all([hydrateField(origin), hydrateField(dest), hazardsP]);
	const inboundAlreadyDone = Boolean(aware?.takeoff?.actual) || Boolean(aware?.landing?.actual);
	live = asOnGround(live, origin);
	const routeKey = `${origin.iata}|${dest.iata}`;
	if (hexRouteByIdent.get(stateIdent) && hexRouteByIdent.get(stateIdent) !== routeKey) {
		hexByIdent.delete(stateIdent);
		hexRouteByIdent.delete(stateIdent);
		knownHex = null;
		if (live && !flightIdentOk(live.callsign, parsed, aware) && !(aware?.tail && live.registration && String(live.registration).replace(/[-\s]/g, "").toUpperCase() === String(aware.tail).replace(/[-\s]/g, "").toUpperCase())) {
			live = null;
		}
	}
	const takeoffAge = aware?.takeoff?.actual ? Date.now() / 1e3 - aware.takeoff.actual : 0;
	const confirmedSurface = Boolean(live && (live.seenSec ?? 999) <= 30 && liveFitsLeg(live, aware, origin)
		&& flightIdentOk(live.callsign, parsed, aware) && takeoffAge < 30 * 60);
	if (aware?.takeoff?.actual && live?.onGround && origin && haversineNm({ lat: live.lat, lon: live.lon }, origin) < 15 && takeoffAge > 4 * 60 && !confirmedSurface) {
		live = null;
		hexByIdent.delete(stateIdent);
		hexRouteByIdent.delete(stateIdent);
	}
	if (destParkedLeftover(live, dest, aware)) {
		live = null;
		hexByIdent.delete(stateIdent);
		hexRouteByIdent.delete(stateIdent);
	}
	if (!live) live = liveFromAware(aware);
	let fieldList = [];
	const hexHint = (live?.hex || knownHex || aware?.hex || "").toLowerCase();
	if (hexHint && /^[0-9a-f]{6}$/.test(hexHint) && live?.hex !== hexHint) {
		const freshRaw = await safe(adsbByHex(hexHint), null);
		if (freshRaw && rawMatchesQuery(freshRaw, parsed, aware)) {
			const cand = asOnGround(toLive(freshRaw), origin);
			if (cand && !destParkedLeftover(cand, dest, aware)) live = cand;
			else if (cand && destParkedLeftover(cand, dest, aware)) {
				live = null;
				hexByIdent.delete(stateIdent);
				hexRouteByIdent.delete(stateIdent);
			}
		} else if (freshRaw && String(freshRaw.flight ?? "").trim()) {
			hexByIdent.delete(stateIdent);
			hexRouteByIdent.delete(stateIdent);
		}
	}
	if (origin && !Boolean(aware?.landing?.actual) && !Boolean(aware?.takeoff?.actual) && !flightBegun(live, origin)) {
		const alreadyAtDest = Boolean(live && dest && haversineNm({ lat: live.lat, lon: live.lon }, dest) < 12);
		if (!alreadyAtDest) {
			fieldList = await safe(adsbAround(origin.lat, origin.lon, 12), []);
			const match = pickAroundAircraft(fieldList, parsed, aware, origin, dest, 12, knownHex || live?.hex);
			if (match) {
				const swap = String(match.hex ?? "").toLowerCase();
				const keepHex = String(knownHex || live?.hex || "").toLowerCase();
				if (keepHex && swap !== keepHex && live?.hex === keepHex && !rawMatchesQuery(match, parsed, aware)) {
					/* stick to locked hex */
				} else {
					const cand = asOnGround(toLive(match), origin);
					if (cand && stillOnField(cand, origin)
						&& (!live || (liveAgeSec(cand) ?? Infinity) <= (liveAgeSec(live) ?? Infinity))) live = cand;
				}
			}
		}
	} else if (live && dest && !live.onGround && !flightIdentOk(live.callsign, parsed, aware)) {
		const dDest = haversineNm({ lat: live.lat, lon: live.lon }, dest);
		if (dDest < 50) {
			const nearDest = await safe(adsbAround(dest.lat, dest.lon, 20), []);
			const match = pickAroundAircraft(nearDest, parsed, aware, dest, origin, 20, knownHex || live?.hex);
			if (match) {
				const swap = String(match.hex ?? "").toLowerCase();
				const keepHex = String(knownHex || live?.hex || "").toLowerCase();
				if (!(keepHex && swap !== keepHex && live?.hex === keepHex && !rawMatchesQuery(match, parsed, aware))) {
					const cand = toLive(match);
					if (cand) live = asOnGround(cand, dest);
				}
			}
		}
	}
	if (live && !liveFitsLeg(live, aware, origin)) live = null;
	// Reacquire around the destination before evaluating touchdown. The normal
	// identity lookup can return a remembered/track point that is valid enroute
	// but much too old for final approach.
	const preLandingAgeSec = liveAgeSec(live);
	const preLandingDistanceNm = live && dest ? haversineNm(live, dest) : null;
	const providerLanding = aware?.landing?.estimated ?? aware?.landing?.scheduled ?? null;
	const landingSoon = providerLanding != null && providerLanding - Date.now() / 1000 < 75 * 60;
	if (!Boolean(aware?.landing?.actual) && dest && (live?.extrapolated || (preLandingAgeSec ?? 999) > 15) &&
		((preLandingDistanceNm ?? 999) < 80 || landingSoon)) {
		const nearDest = await safe(adsbAround(dest.lat, dest.lon, 45), []);
		const match = pickAroundAircraft(nearDest, parsed, aware, dest, origin, 45, knownHex || live?.hex);
		if (match) {
			const cand = asOnGround(toLive(match), dest);
			if (cand) live = cand;
		}
	}
	const faLanded = Boolean(aware?.landing?.actual) || /arrived|landed/i.test(aware?.status ?? "");
	const dLiveDest = live && dest ? haversineNm({ lat: live.lat, lon: live.lon }, dest) : 999;
	const onFieldNow = Boolean(
		live && dest && (
			(live.onGround && dLiveDest < 10) ||
			(live.onGround && dLiveDest < 14 && (live.gsKt ?? 0) < 40) ||
			((live.altFt ?? 9999) < 250 && (live.gsKt ?? 0) < 70 && dLiveDest < 5)
		)
	);
	const flyingAway = Boolean(live && !live.onGround && ((live.altFt ?? 0) > 2500 || (live.gsKt ?? 0) > 160) && dLiveDest > 25);
	const legContext = { requested: parsed.callsign, origin, destination: dest };
	const stateIdentity = flightStateIdentity(aware, legContext, { deviceOnly: Boolean(resumed) });
	const stateKey = stateIdentity.key;
	const legacyKeys = stateIdentity.legacyKeys;
	// Device-only resumes may read same-leg state, but never write shared rows.
	const canPersistState = stateIdentity.canPersist;
	const landKey = `${resumed?.scope ?? ""}${stateKey ?? `unvalidated:${stateIdent}|${origin.iata}|${dest.iata}`}`;
	// Durable ground-phase state for this flight instance (see
	// src/lib/flight-phase-state.server.ts for why this replaced module-scope
	// Maps). Loaded once here, mutated locally exactly as the old Maps were,
	// written back once near the end of this function.
	const loadedPhase = await loadPhaseState(stateKey ?? "", legacyKeys, stateIdentity.recentLegacyKeys);
	const loadedArrival = await arrivalStateStore.load(stateKey ?? "", legacyKeys, stateIdentity.recentLegacyKeys);
	const memoryLeg = routeLeg(stateKey ?? "", origin.iata, dest.iata);
	const loadedRoute = memoryLeg ? await routeMemoryStore.load(stateKey, memoryLeg, canPersistState ? legacyKeys : []) : null;
	let routeMemory = loadedRoute?.state ?? null;
	let routeMemoryPersistence = loadedRoute?.status ?? "unavailable";
	let pushLatchValue = loadedPhase.state.push;
	let taxiOutLatchValue = loadedPhase.state.taxiOut;
	let phaseStatePersistence = loadedPhase.status;
	const evidenceArgs = { schedule: aware, key: stateKey, reason: stateIdentity.reason,
		now: Date.now() / 1000, deviceOnly: Boolean(resumed), origin, groundElevationFt: fieldElev(origin),
		expected: { callsigns: [parsed.callsign, aware?.ident, aware?.iataIdent].filter(Boolean),
			registration: aware?.tail ?? null, hex: aware?.hex ?? knownHex ?? null } };
	let takeoffEvidence = loadedPhase.state.confirmedTakeoff;
	const memo = takeoffContinuity.get(stateKey);
	if (memo && Date.now() / 1000 - memo.at <= 30 * 3600)
		takeoffEvidence = mergeConfirmedTakeoff(takeoffEvidence, memo.confirmation);
	takeoffEvidence = reconcileTakeoff(takeoffEvidence, { ...evidenceArgs, position: live });
	let confirmedTakeoff = activeConfirmedTakeoff(takeoffEvidence);
	if (progressResume && progressResume.originIcao === origin.icao && progressResume.destIcao === dest.icao) {
		if (!pushLatchValue) {
			const resumedPush = pushLatchFromResume(progressResume);
			if (resumedPush) pushLatchValue = resumedPush;
		}
		// Restoring from a resume token means taxiing was previously confirmed,
		// not that it started this instant -- use the real timestamp the token
		// carried (detectedTaxiUnix) when present, falling back to "now" only
		// for an older resume token that predates that field.
		if (progressResume.departureStage === "taxi") {
			taxiOutLatchValue = { at: progressResume.detectedTaxiUnix ?? Date.now() / 1e3 };
		}
	}
	const departureProgressKnownBeforeMovement = Boolean(
		pushLatchValue ||
		taxiOutLatchValue ||
		progressResume?.departureStage === "push" ||
		progressResume?.departureStage === "taxi" ||
		progressResume?.departureStage === "takeoff_roll"
	);
	if ((faLanded && !flyingAway) || onFieldNow) landedLatch.set(landKey, Date.now() / 1e3);
	let ourLanded = Boolean(landedLatch.get(landKey));
	if (ourLanded && live && !live.onGround) {
		if (dLiveDest > 20) live = null;
		else live = { ...live, onGround: true, altFt: 0, gsKt: Math.min(live.gsKt ?? 0, 25), phase: (live.gsKt ?? 0) >= 4 ? "taxi" : "parked" };
	}
	if (live && origin && dest) {
		const dOrig = haversineNm({ lat: live.lat, lon: live.lon }, origin);
		const dDest = haversineNm({ lat: live.lat, lon: live.lon }, dest);
		const identOk = flightIdentOk(live.callsign, parsed, aware) ||
			(aware?.tail && live.registration && String(live.registration).replace(/[-\s]/g, "").toUpperCase() === String(aware.tail).replace(/[-\s]/g, "").toUpperCase());
		if (ourLanded && dDest > 20 && !identOk) live = null;
		else if (!identOk && dOrig < 15 && Boolean(aware?.takeoff?.actual)) live = null;
		else if (!ourLanded && !identOk && !aware?.takeoff?.actual && dDest < 12 && dOrig > 20) live = null;
	}
	if (!live && origin && !ourLanded && !Boolean(aware?.takeoff?.actual)) {
		const near = await safe(adsbAround(origin.lat, origin.lon, 48), []);
		const match = pickAroundAircraft(near, parsed, aware, origin, dest, 48, knownHex);
		if (match) live = asOnGround(toLive(match), origin);
	}
	if (!live && origin && dest) {
		const extra = [];
		if (aware?.hex) extra.push(safe(adsbByHex(aware.hex), null));
		if (aware?.tail) extra.push(safe(adsbByReg(aware.tail), null));
		extra.push(safe(adsbByCallsign(parsed.callsign), null));
		if (aware?.ident) {
			const faCs = String(aware.ident).replace(/\s/g, "").toUpperCase();
			if (faCs && faCs !== identKey) extra.push(safe(adsbByCallsign(faCs), null));
		}
		const extras = extra.length ? await Promise.all(extra) : [];
		const airborneAway = [];
		const originSide = [];
		const destSide = [];
		for (const raw of extras) {
			if (!rawMatchesQuery(raw, parsed, aware)) continue;
			const cand = raw ? asOnGround(toLive(raw), origin) : null;
			if (!cand || !liveFitsLeg(cand, aware, origin)) continue;
			if (destParkedLeftover(cand, dest, aware)) continue;
			const dOrig = haversineNm({ lat: cand.lat, lon: cand.lon }, origin);
			const dDest = haversineNm({ lat: cand.lat, lon: cand.lon }, dest);
			if (!cand.onGround && dDest > 25) airborneAway.push(cand);
			else if (dOrig < 20) originSide.push(cand);
			else if (dDest < 20) destSide.push(cand);
			else if (!cand.onGround) airborneAway.push(cand);
		}
		if (ourLanded && destSide[0]) live = destSide[0];
		else if (airborneAway[0]) live = airborneAway[0];
		else if (!ourLanded && originSide[0]) live = originSide[0];
	}
	if (live && !liveFitsLeg(live, aware, origin)) live = null;
	if (!ourLanded && Boolean(aware?.takeoff?.actual) && !aware?.landing?.actual) {
		live = restoreKin(stateIdent, live, dest, aware);
		if (!live) live = liveFromAware(aware);
		const needTrace = !live || live.altFt == null || live.gsKt == null;
		const hexForTrace = String(live?.hex || hexByIdent.get(stateIdent) || aware?.hex || "").toLowerCase();
		if (needTrace && /^[0-9a-f]{6}$/.test(hexForTrace)) {
			const [full, recent] = await Promise.all([
				safe(fetchTrace(hexForTrace, "trace_full"), []),
				safe(fetchTrace(hexForTrace, "trace_recent"), [])
			]);
			const trace = mergeTraces(full, recent);
			const pt = lastAirborneTracePt(trace, aware?.takeoff?.actual ?? null);
			if (pt) {
				if (!live) {
					const cand = liveFromTracePt(pt, hexForTrace, { hex: hexForTrace, callsign: parsed.callsign, registration: aware?.tail ?? null, type: aware?.type ?? null, typeName: airframeOf(aware?.type)?.name ?? aware?.type ?? null }, { ...phaseContext, history: trace.map(p => ({ seenAt: p.t, altFt: p.alt, onGround: p.ground, lat: p.lat, lon: p.lon })) });
					if (cand && !destParkedLeftover(cand, dest, aware)) live = cand;
				} else {
					live = {
						...live,
						altFt: live.altFt ?? pt.alt,
						gsKt: live.gsKt ?? pt.gs,
						track: live.track ?? pt.track
					};
				}
			}
		}
		live = restoreKin(stateIdent, live, dest, aware);
		rememberKin(stateIdent, live);
	}
	if (live?.hex && (flightIdentOk(live.callsign, parsed, aware) || (aware?.tail && live.registration && String(live.registration).replace(/[-\s]/g, "").toUpperCase() === String(aware.tail).replace(/[-\s]/g, "").toUpperCase()))) {
		hexByIdent.set(stateIdent, live.hex);
		hexRouteByIdent.set(stateIdent, routeKey);
	}
	if (aware?.hex && !hexByIdent.get(stateIdent)) {
		hexByIdent.set(stateIdent, String(aware.hex).toLowerCase());
		hexRouteByIdent.set(stateIdent, routeKey);
	}
	if (live && dest && !live.onGround && ((live.altFt ?? 0) > 1500 || (live.gsKt ?? 0) > 80) && haversineNm({ lat: live.lat, lon: live.lon }, dest) > 6) {
		if (landedLatch.get(landKey)) {
			live = null;
			ourLanded = true;
		}
	}
	// Without a current schedule OR a fresh matching position, retain the last
	// story as saved data instead of rebuilding a stage from expired estimates.
	if (resumed && (!live || live.extrapolated || (live.seenSec ?? 999) > 30)) {
		throw new Error("Schedule updates are delayed, and no fresh position is available for this flight. Please try again shortly.");
	}
	let inboundAware = aware?.inbound ?? null;
	const inboundIdent = inboundAware?.ident ?? aware?.inboundIdent ?? null;
	const inboundFlightId = aware?.inboundFlightId ?? null;
	const snapKey = inboundSnapKey(aware, origin, dest, query);
	const existingSnap = inboundSnapByFlight.get(snapKey);
	const inboundLocked = Boolean(existingSnap?.frozen);
	const inboundFetch = inboundAlreadyDone || inboundLocked
		? Promise.resolve(null)
		: inboundFlightId
			? safe(loadAwareById(inboundFlightId), null)
			: inboundIdent && !inboundLocked
				? safe(loadAware(inboundIdent), null)
				: Promise.resolve(inboundAware);
	const [[hydOrigin, hydDest, hazardsPack], inboundFetched] = await Promise.all([fieldsP, inboundFetch]);
	origin = hydOrigin;
	dest = hydDest;
	if (inboundFetched && (!inboundFetched.routeOnly || !inboundAware)) inboundAware = inboundFetched;
	// Preserve diversion evidence before an off-route inbound is excluded from arrival estimates.
	const inboundDiversion = !resumed && aware && !inboundAlreadyDone
		? await safe(cached(`inbound-diversion:${snapKey}:${aware.tail ?? ""}:${aware.inboundFlightId ?? ""}`, 120000,
			() => findInboundDiversion(aware, inboundAware, loadAwareById)), undefined)
		: undefined;
	if (inboundAware && !inboundServesOrigin(inboundAware, origin.iata)) inboundAware = null;
	const originTz = tzOf(origin);
	if (inboundAware) rememberInboundSnap(snapKey, {
		...snapFromAware(inboundAware, originTz),
		flightId: inboundFlightId
	});
	const landed = inboundLanded(inboundAware) || Boolean(inboundSnapByFlight.get(snapKey)?.landUnix);
	const atGateFa = inboundAtGate(inboundAware);
	const onField = Boolean(live && stillOnField(live, origin));
	takeoffEvidence = reconcileTakeoff(takeoffEvidence, { ...evidenceArgs, now: Date.now() / 1000, origin, position: live });
	confirmedTakeoff = activeConfirmedTakeoff(takeoffEvidence);
	const faSaysAir = Boolean(confirmedTakeoff);
	const surfaceFixAtOrigin = Boolean(live && live.onGround && stillOnField(live, origin));
	const ourAirborne = Boolean(confirmedTakeoff && !ourLanded) || Boolean(flightBegun(live, origin))
		|| (Boolean(faSaysAir) && !(aware?.landing?.actual) && !surfaceFixAtOrigin);
	let inboundRaw = null;
	if (!inboundLocked && !atGateFa && !inboundAlreadyDone) {
		const tail = inboundAware?.tail ?? existingSnap?.tail ?? null;
		const inHex = (inboundAware?.hex ?? existingSnap?.hex ?? "").toLowerCase() || null;
		if (tail) inboundRaw = await safe(adsbByReg(tail), null);
		else if (inHex) inboundRaw = await safe(adsbByHex(inHex), null);
		else if (!landed && inboundIdent) inboundRaw = await safe(adsbByCallsign(inboundIdent), null);
	}
	let inboundLiveRaw = inboundRaw ? toLive(inboundRaw) : null;
	if (!inboundLiveRaw && !inboundLocked && live && live.onGround && !ourAirborne && haversineNm({
		lat: live.lat,
		lon: live.lon
	}, origin) < 12) inboundLiveRaw = live;
	const inboundLive = inboundLocked ? null : inboundLiveFits(inboundLiveRaw, inboundAware, origin, landed) ? inboundLiveRaw : null;
	const nowUnix = Date.now() / 1e3;
	if (!inboundLocked && inboundLive && inboundLive.onGround && haversineNm({
		lat: inboundLive.lat,
		lon: inboundLive.lon
	}, origin) < 12) {
		rememberInboundSnap(snapKey, {
			landUnix: inboundAware?.landing?.actual ?? inboundSnapByFlight.get(snapKey)?.landUnix ?? nowUnix,
			landClock: clockAt(inboundAware?.landing?.actual ?? inboundSnapByFlight.get(snapKey)?.landUnix ?? nowUnix, originTz),
			tail: inboundLive.registration,
			hex: inboundLive.hex,
			type: inboundLive.type,
			taxiing: (inboundLive.gsKt ?? 0) >= 5
		});
		const landAt = inboundSnapByFlight.get(snapKey)?.landUnix;
		const parkedLong = (inboundLive.gsKt ?? 0) < 5 && landAt && nowUnix - landAt > 4 * 60;
		if (parkedLong || atGateFa || confirmedGateOutActual(aware?.gateOut)) {
			const gateUnix = inboundAware?.gateIn?.actual ?? (parkedLong ? nowUnix : null);
			rememberInboundSnap(snapKey, {
				gateUnix,
				gateClock: clockAt(gateUnix, originTz),
				freeze: true,
				taxiing: false
			});
		}
	} else if (!inboundLocked && (atGateFa || confirmedGateOutActual(aware?.gateOut) && landed)) {
		const gateUnix = inboundAware?.gateIn?.actual ?? null;
		rememberInboundSnap(snapKey, {
			...snapFromAware(inboundAware, originTz),
			gateUnix,
			gateClock: clockAt(gateUnix, originTz),
			freeze: true
		});
	}
	const snap = inboundSnapByFlight.get(snapKey) ?? null;

	// When the current departure has not acquired a callsign/registration on the
	// surface yet, reuse the exact aircraft identity from its assigned inbound
	// turn after that inbound has reached the gate. This is identity evidence,
	// not a stage guess: the candidate must be a fresh on-ground ADS-B fix at
	// this origin and within the current departure window.
	const departureClock = bestUnix(aware?.gateOut);
	const turnTail = inboundAware?.tail ?? snap?.tail ?? null;
	const turnHex = String(inboundAware?.hex ?? snap?.hex ?? "").toLowerCase() || null;
	const inboundTurnComplete = Boolean(inboundAware?.gateIn?.actual || snap?.frozen);
	const inDepartureWindow = Boolean(departureClock && nowUnix >= departureClock - 45 * 60 && nowUnix <= departureClock + 3 * 60 * 60);
	const currentLiveAge = liveAgeSec(live) ?? Number.POSITIVE_INFINITY;
	if (!ourAirborne && inboundTurnComplete && inDepartureWindow && (turnTail || turnHex)
		&& (!live || live.extrapolated || currentLiveAge > 15)) {
		const turnRaw = turnTail
			? await safe(adsbByReg(turnTail), null)
			: turnHex
				? await safe(adsbByHex(turnHex), null)
				: null;
		const turnLive = turnRaw ? asOnGround(toLive(turnRaw), origin) : null;
		const turnAge = liveAgeSec(turnLive) ?? Number.POSITIVE_INFINITY;
		const turnAtOrigin = Boolean(turnLive && turnLive.onGround
			&& haversineNm({ lat: turnLive.lat, lon: turnLive.lon }, origin) < 12);
		const turnIdentityMatches = Boolean(turnLive && (
			(turnTail && turnLive.registration
				&& String(turnLive.registration).replace(/[-\s]/g, "").toUpperCase() === String(turnTail).replace(/[-\s]/g, "").toUpperCase())
			|| (turnHex && String(turnLive.hex ?? "").toLowerCase() === turnHex)
		));
		if (turnAtOrigin && turnIdentityMatches && turnAge <= 30 && turnAge + 1 < currentLiveAge) {
			live = turnLive;
			if (turnLive.hex) {
				knownHex = String(turnLive.hex).toLowerCase();
				hexByIdent.set(stateIdent, knownHex);
				hexRouteByIdent.set(stateIdent, routeKey);
			}
			console.info("[outbound-turn-recovery]", {
				flight: parsed.iata,
				inbound: inboundIdent,
				registration: turnLive.registration ?? turnTail,
				hex: turnLive.hex ?? turnHex,
				ageSec: Math.round(turnAge),
				gsKt: turnLive.gsKt ?? null,
			});
		}
	}

	const start = {
		lat: origin.lat,
		lon: origin.lon
	};
	const end = {
		lat: dest.lat,
		lon: dest.lon
	};
	const hex = live ? (live.hex || "").toLowerCase() : null;
	const previousRouteAnchor = routeMemory?.lastObserved ?? loadedRoute?.storedState?.lastObserved ?? null;
	const filedRaw = await loadFiledPath(!ourLanded && ourAirborne ? hex : null, start, end, !ourLanded && ourAirborne ? live : null, aware?.takeoff?.actual ?? aware?.takeoff?.estimated ?? null, aware?.waypoints ?? [], aware?.faTrack ?? []);
	if (memoryLeg) {
		const poll = emptyRouteMemory(memoryLeg);
		poll.filed = validatedFiledRoute(aware?.waypoints ?? [], start, end,
			aware?.originIata === origin.iata && aware?.destIata === dest.iata, Date.now());
		if (!ourLanded && ourAirborne && !live?.onGround)
			poll.track = (filedRaw.phaseHistory ?? []).map(p => ({ lat: p.lat, lon: p.lon, seenAt: p.seenAt * 1000 }));
		routeMemory = mergeRouteMemory(routeMemory, poll);
		// Repair legacy whole-tail traces only with a real confirmed takeoff
		// clock and an actual early-origin observation. A first oceanic fix,
		// schedule or estimate must never trim a correctly held sector.
		const takeoffMs = confirmedTakeoff?.time != null ? confirmedTakeoff.time * 1000 : null;
		const earlyFix = freshRouteObservation(live);
		const departurePoints = [...routeMemory.track, ...(earlyFix ? [earlyFix] : [])];
		if (takeoffMs != null && departurePoints.some(p => p.seenAt >= takeoffMs
			&& p.seenAt <= takeoffMs + 15 * 60_000 && haversineNm(p, start) <= 25))
			routeMemory = sanitizeRouteMemory(routeMemory, takeoffMs);
	}
	const heldWaypoints = routeMemory?.filed?.waypoints ?? [];
	const heldSpine = heldWaypoints.length >= 4 ? makeSpine(start, end, heldWaypoints) : filedRaw.spine;
	const heldTrack = routeMemory?.track?.length >= 2 ? routeMemory.track : filedRaw.flown;
	const filed = { ...filedRaw, spine: heldSpine, flown: heldTrack };
	let path;
	let pathSource;
	if (heldTrack.length >= 2) {
		path = densifyPath(downsampleNm(ensureEnds(blendTrackOntoSpine(heldTrack, heldSpine), start, end), 22), 48);
		pathSource = "track";
	} else if (heldWaypoints.length >= 4) {
		path = heldSpine;
		pathSource = "filed";
	} else {
		path = filed.points.length >= 2 ? filed.points : greatCirclePoints(start, end, 18);
		pathSource = filed.source;
	}
	path = ensureEnds(path, start, end);
	if (haversineNm(path[path.length - 1], end) > 8) path = path.concat([end]);
	if (!ourLanded && ourAirborne) {
		if (!live || !Number.isFinite(live.lat) || !Number.isFinite(live.lon)) {
			const fromFa = liveFromAware(aware);
			if (fromFa && !fromFa.onGround) live = fromFa;
		}
		// Elapsed time is an ETA input, never an observed aircraft position.
		if (live && Number.isFinite(live.lat) && Number.isFinite(live.lon) && (!live.hex || live.extrapolated)) {
			const nearby = await safe(adsbAround(live.lat, live.lon, 90), []);
			const match = pickAroundAircraft(nearby, parsed, aware, origin, dest, 90, live.hex || knownHex);
			if (match) {
				const cand = asOnGround(toLive(match), origin);
				if (cand && !destParkedLeftover(cand, dest, aware) && !cand.onGround) live = cand;
			}
		}
	}
	const routeObservation = freshRouteObservation(live);
	const repairedAnchor = !ourLanded && ourAirborne && previousRouteAnchor
		&& (!routeMemory?.lastObserved || routeMemory.progressGeometryVersion !== 1)
		&& (routeMemory?.trackNotBeforeMs == null || previousRouteAnchor.seenAt >= routeMemory.trackNotBeforeMs)
		? previousRouteAnchor : null;
	// A last known anchor shapes the historical/projected route only. It never
	// becomes `live`, an aircraft marker, or a newly timed observation.
	const displayAnchor = routeObservation ?? (!ourLanded && ourAirborne ? routeMemory?.lastObserved ?? repairedAnchor : null);
	if (routeMemory) filed.flown = mergeObservedTrack(routeMemory.track, routeObservation ? [routeObservation] : [])
		.filter(p => !displayAnchor || p.seenAt <= displayAnchor.seenAt);
	if (!ourLanded && ourAirborne && displayAnchor) {
		path = canonicalLiveDisplayPath({
			filedPath: filed.spine ?? path,
			flownTrack: filed.flown ?? [],
			live: displayAnchor,
			dest: end, origin: start
		});
		if ((filed.flown?.length ?? 0) >= 2) pathSource = "track";
	}
	const recomputedProgress = routeProgress(path, routeMemory, routeObservation ?? repairedAnchor, ourAirborne, ourLanded);
	const routeProgressValue = !routeObservation && repairedAnchor && !ourLanded
		? { ...recomputedProgress, source: "last_known" as const } : recomputedProgress;
	let totalNm = routeProgressValue.totalNm;
	let remainingNm;
	let routeRemainingNm = routeProgressValue.remainingNm;
	let progress = routeProgressValue.progress;
	const directToDestNm = routeObservation && live && Number.isFinite(live.lat) && Number.isFinite(live.lon)
		? haversineNm({ lat: live.lat, lon: live.lon }, end)
		: null;
	const filedRouteDeviationNm = live && filed.spine?.length >= 2
		? distanceToPathNm({ lat: live.lat, lon: live.lon }, filed.spine)
		: null;
	remainingNm = ourLanded
		? 0
		: directToDestNm != null && directToDestNm <= 25
		? directToDestNm
		: routeRemainingNm;
	// Preserve the original distance input to stage classification. Runway
	// projection changes display/weather distance and ETA, never flight phases.
	const stageRemainingNm = remainingNm;
	if (live) {
		const history = [...filedRaw.phaseHistory ?? [], ...(aware?.faTrack ?? []).map(p => ({ seenAt: p.t, altFt: p.alt, onGround: p.ground, lat: p.lat, lon: p.lon }))];
		live = { ...live, ...observePhase(`${stateKey}|${live.hex || live.registration || live.callsign}`, live, { ...phaseContext, history }) };
	}
	let expectedArrival = null;
	let arrivalPatternKind = null;
	// Arrival projection keeps its independent provider/altitude evidence.
	const arrivalLive = live ? { ...live, vertFpm: positionChoice.chosen?.vertFpm ?? live.arrivalVertFpm ?? live.vertFpm ?? null } : null;
	const arrivalInput = {
		live: arrivalLive, dest: { ...end, elevationFt: fieldElev(dest) }, landed: ourLanded,
		approachEvidence: Boolean(live && isFinalApproach(live, dest)), now: Date.now()
	};
	const arrivalEntry = arrivalEntryEvidence(loadedArrival.state, arrivalInput).entryGate;
	const arrivalDistanceNm = live && Number.isFinite(live.lat) && Number.isFinite(live.lon) ? haversineNm(live, end) : null;
	const arrivalDescending = Boolean(live && ((live.vertFpm ?? 0) < -100 || live.phase === "descent" || live.phase === "approach"));
	const arrivalRunwayWindow = Boolean(ourAirborne && !ourLanded && (arrivalDescending || (arrivalDistanceNm != null && arrivalDistanceNm <= 150)));
	let selectedArrival = loadedArrival.state.runway;
	if (arrivalRunwayWindow || arrivalEntry || loadedArrival.state.startedAt || ourLanded) {
		selectedArrival = await expectedArrivalRunway(dest.icao, {
			aircraft: live, providerRunway: official.fr24?.runway?.landing ?? flightawareOfficial?.runway?.landing ?? null,
			actualLanding: Boolean(official.fr24?.landing?.actual || flightawareOfficial?.landing?.actual),
			windDir: hydDest.windDir, windKt: hydDest.windKt, previous: loadedArrival.state.runway
		});
	}
	const arrivalUpdate = updateArrivalProjection(loadedArrival.state, { ...arrivalInput, runway: selectedArrival });
	let arrivalState = arrivalUpdate.state;
	let arrivalPersistence: string = loadedArrival.status;
	if (canPersistState && JSON.stringify(arrivalState) !== JSON.stringify(loadedArrival.state)) {
		const saved = await arrivalStateStore.save(stateKey, arrivalState, loadedArrival.version);
		arrivalState = saved.state;
		arrivalPersistence = saved.status;
	}
	expectedArrival = arrivalState.runway;
	const showDetailedArrival = Boolean(arrivalState.startedAt
		&& showDetailedArrivalGeometry(arrivalLive, end, arrivalInput.approachEvidence));
	const pattern = showDetailedArrival ? displayArrivalProjection(arrivalState, {
		observation: routeObservation && Date.now() - routeObservation.seenAt <= 60_000 ? routeObservation : null,
		live, lastObserved: routeObservation ?? routeMemory?.lastObserved ?? null, landed: ourLanded
	}) : null;
	if (pattern) {
		arrivalPatternKind = pattern.kind;
		// Preserve observed history; only the future display path changes.
		let join = 0, nearest = Infinity;
		const entry = pattern.points[0];
		for (let i = 0; i < path.length; i++) {
			const distance = haversineNm(path[i], entry);
			if (distance < nearest) { nearest = distance; join = i; }
		}
		path = [...path.slice(0, join), ...pattern.points];
		totalNm = Math.max(1, polylineLengthNm(path));
		remainingNm = pattern.lengthNm;
		routeRemainingNm = pattern.lengthNm;
		progress = Math.max(0, 1 - remainingNm / totalNm);
		if (pattern.stale && routeMemory?.lastObserved) {
			// A held plan does not create a new progress observation.
			progress = routeMemory.lastObserved.progress;
			totalNm = routeMemory.lastObserved.totalNm;
			remainingNm = routeRemainingNm = routeMemory.lastObserved.remainingNm;
		}
	}
	if (arrivalRunwayWindow || arrivalEntry || loadedArrival.state.startedAt || ourLanded) console.info("[arrival-projection]", {
		flight: parsed.callsign, landKey, stateKey, instance: ARRIVAL_INSTANCE,
		entryGate: arrivalEntry, reason: arrivalUpdate.reason, persistence: arrivalPersistence,
		applied: Boolean(pattern), geometrySource: pattern?.geometrySource ?? null,
		displayPointCount: pattern?.points.length ?? 0, stale: pattern?.stale ?? false,
		loadedVersion: loadedArrival.version, hadPrevious: Boolean(loadedArrival.state.startedAt),
		runway: expectedArrival?.runway ?? null, source: expectedArrival?.source ?? null,
		side: arrivalState.side, active: arrivalState.active, startedAt: arrivalState.startedAt,
		offPathStreak: arrivalState.offPathStreak, vertFpm: arrivalUpdate.vertFpm,
		verticalRateSource: arrivalUpdate.verticalRateSource, stageVertFpm: live?.vertFpm ?? null,
		cursorNm: arrivalState.cursorNm, plannedPoints: arrivalState.points.length,
		directToThresholdNm: live && expectedArrival ? haversineNm(live, expectedArrival.threshold) : null,
		showDetailedArrival, arrivalRunwayWindow,
		phase: live?.phase ?? null, extrapolated: live?.extrapolated ?? false, seenSec: live?.seenSec ?? null,
		kind: arrivalPatternKind, remainingNm, stageRemainingNm
	});
	const progressAnchor = routeObservation ?? repairedAnchor;
	if (routeMemory && progressAnchor && !ourLanded && ourAirborne) {
		routeMemory = mergeRouteMemory(routeMemory, {
			...emptyRouteMemory(memoryLeg), progressGeometryVersion: 1, track: routeObservation ? [routeObservation] : [],
			lastObserved: { ...progressAnchor, progress, totalNm, remainingNm }
		});
	}
	const etaMin = remainingEtaMin(remainingNm, directToDestNm, live, aware);
	const heading = ourLanded
		? initialBearing(path[Math.max(0, path.length - 2)] ?? start, end)
		: live?.track ?? initialBearing(start, end);
	const hazards = [];
	let sinceFix = 0;
	const routeNowUnix = Date.now() / 1e3;
	const samples = path.map((p, i) => {
		const prev = path[i - 1];
		const step = prev ? haversineNm(prev, p) : 0;
		sinceFix += step;
		const isFix = i > 0 && i < path.length - 1 && sinceFix >= 65;
		if (isFix) sinceFix = 0;
		const distNm = path.slice(0, i + 1).reduce((acc, cur, idx) => {
			if (idx === 0) return 0;
			return acc + haversineNm(path[idx - 1], cur);
		}, 0);
		const frac = distNm / totalNm;
		const remainingHere = Math.max(0, totalNm - distNm);
		const sampleAlt = sampleAltFt(frac, remainingHere, live?.altFt ?? null);
		const plannedTakeoff = aware?.takeoff?.estimated ?? aware?.takeoff?.scheduled;
		const plannedLanding = aware?.landing?.estimated ?? aware?.landing?.scheduled;
		const beforeTakeoff = !ourAirborne && !ourLanded && plannedTakeoff && plannedLanding > plannedTakeoff;
		const etaHere = beforeTakeoff
			? Math.max(0, (plannedTakeoff - routeNowUnix) / 60) + frac * (plannedLanding - plannedTakeoff) / 60
			: frac <= progress ? 0 : (frac - progress) / Math.max(.01, 1 - progress) * etaMin;
		const sampleUnix = routeNowUnix + etaHere * 60;
		let chop = "smooth";
		let cloud = false;
		let convective = false;
		const notes = [];
		for (const f of hazardsPack.gairmet) {
			if (!advisoryValidAt(f.properties, sampleUnix)) continue;
			if (!pointInGeoJson(p.lat, p.lon, f.geometry ?? null)) continue;
			const hazard = String(f.properties?.hazard ?? "");
			const due = String(f.properties?.dueTo ?? "");
			if (!gairmetApplies(hazard, f.properties, sampleAlt)) continue;
			const c = gairmetChop(hazard, f.properties?.severity);
			if (c) {
				chop = worse(chop, c);
				notes.push(hazard === "TURB-HI" ? "High-altitude turbulence airmet" : hazard === "LLWS" ? "Low-level wind shear" : "Low-level turbulence airmet");
				hazards.push({
					id: `g-${hazard}-${i}`,
					validity: advisoryTiming(f.properties),
					kind: "turb",
					chop: c,
					label: hazard === "TURB-HI" ? "High turbulence airmet" : hazard === "LLWS" ? "Low-level wind shear" : "Low turbulence airmet",
					detail: due || hazard,
					remaining: frac >= progress,
					lat: p.lat,
					lon: p.lon,
					source: "advisory"
				});
			}
			if (hazard === "IFR" || hazard === "MT_OBSC") {
				cloud = true;
				notes.push("Low cloud / mountain obscuration");
			}
			if (hazard === "LLWS") {
				chop = worse(chop, "light");
				notes.push("Low-level wind shear");
			}
		}
		for (const f of hazardsPack.sigmet) {
			if (!advisoryValidAt(f.properties, sampleUnix)) continue;
			if (!pointInGeoJson(p.lat, p.lon, f.geometry ?? null)) continue;
			const hz = String(f.properties?.hazard ?? f.properties?.airSigmetType ?? "").toUpperCase();
			if (hz.includes("CONVECTIVE") || hz.includes("TS")) {
				convective = true;
				chop = worse(chop, "moderate");
				notes.push("Convective SIGMET — thunderstorms");
				hazards.push({
					id: `s-${i}`,
					validity: advisoryTiming(f.properties),
					kind: "convective",
					chop: "moderate",
					label: "Thunderstorm SIGMET",
					detail: String(f.properties?.rawAirSigmet ?? "Convective SIGMET").slice(0, 160),
					remaining: frac >= progress,
					lat: p.lat,
					lon: p.lon,
					source: "advisory"
				});
			} else if (hz.includes("TURB")) {
				if (!gairmetApplies("TURB-HI", f.properties, sampleAlt)) continue;
				chop = worse(chop, "moderate");
				notes.push("Turbulence SIGMET");
				hazards.push({
					id: `st-${i}`,
					validity: advisoryTiming(f.properties),
					kind: "turb",
					chop: "moderate",
					label: "Turbulence SIGMET",
					detail: String(f.properties?.rawAirSigmet ?? hz).slice(0, 140),
					remaining: frac >= progress,
					lat: p.lat,
					lon: p.lon,
					source: "advisory"
				});
			}
		}
		for (const f of hazardsPack.cwa ?? []) {
			if (!advisoryValidAt(f.properties, sampleUnix)) continue;
			if (!pointInGeoJson(p.lat, p.lon, f.geometry ?? null)) continue;
			const txt = String(f.properties?.text ?? f.properties?.hazard ?? f.properties?.cwaText ?? "CWA").toUpperCase();
			if (txt.includes("TS") || txt.includes("CONVECT")) {
				convective = true;
				chop = worse(chop, "moderate");
				notes.push("Center weather advisory — storms");
				hazards.push({
					id: `cwa-${i}`,
					validity: advisoryTiming(f.properties),
					kind: "convective",
					chop: "moderate",
					label: "Center weather advisory",
					detail: String(f.properties?.text ?? txt).slice(0, 140),
					remaining: frac >= progress,
					lat: p.lat,
					lon: p.lon,
					source: "advisory"
				});
			} else if (txt.includes("TURB")) {
				if (!gairmetApplies("TURB-HI", f.properties, sampleAlt)) continue;
				chop = worse(chop, "light");
				notes.push("Center weather advisory — turbulence");
			}
		}
		for (const f of hazardsPack.tcf ?? []) {
			if (!advisoryValidAt(f.properties, sampleUnix)) continue;
			if (!pointInGeoJson(p.lat, p.lon, f.geometry ?? null)) continue;
			const cov = String(f.properties?.coverage ?? "").toLowerCase();
			const chopF = cov === "solid" || cov === "medium" ? "moderate" : "light";
			convective = true;
			chop = worse(chop, chopF);
			notes.push("Forecast storms (TCF)");
			hazards.push({
				id: `tcf-${i}`,
				validity: advisoryTiming(f.properties),
				kind: "convective",
				chop: chopF,
				label: "Forecast storms (TCF)",
				detail: `TFM convective forecast · ${cov || "area"} coverage, tops ${f.properties?.tops ?? "—"}. Forecast, not a SIGMET.`,
				remaining: frac >= progress,
				lat: p.lat,
				lon: p.lon,
				source: "forecast"
			});
		}
		return {
			lat: p.lat,
			lon: p.lon,
			frac,
			distNm,
			remainingNm: remainingHere,
			etaMin: etaHere,
			chop,
			cloud,
			convective,
			note: notes[0] ?? null,
			fix: isFix
		};
	});
	const corridorAps = corridorStations(path, origin.iata, dest.iata, Object.values(AIRPORT_BY_ICAO), haversineNm);
	const corridorMetsP = Promise.all(corridorAps.map((ap) => safe(loadMetar(ap.icao), { metar: null })));
	const pirepPacks = await Promise.all(pirepRouteBounds(path).map((bbox) =>
		cached(`pirep:${bbox}`, 120_000, () => safe(fetchJson(`https://aviationweather.gov/api/data/pirep?format=geojson&bbox=${bbox}`).then((d) => d.features ?? []), null))
	));
	const pirepNow = Date.now();
	for (const f of pirepPacks.flatMap(pack => pack ?? [])) {
		const coords = f.geometry?.type === "Point" ? f.geometry.coordinates : null;
		if (!coords || coords.length < 2) continue;
		const lon = coords[0];
		const lat = coords[1];
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
		const raw = String(f.properties?.rawOb ?? "PIREP");
		const observedAt = observationTime(f.properties, raw, pirepNow);
		if (!isFreshPilotReport(observedAt ?? undefined, pirepNow)) continue;
		const c = pirepChop(String(f.properties?.tbInt1 ?? f.properties?.turbulence ?? f.properties?.tb ?? raw));
		if (!c) continue;
		const pAlt = pirepAltFt(f.properties, raw);
		const providerId = (typeof f.id === "number" && Number.isFinite(f.id)) || (typeof f.id === "string" && f.id.trim())
			? String(f.id) : createHash("sha256").update(JSON.stringify([lat, lon, pAlt, raw])).digest("hex").slice(0, 16);
		const id = `p-${providerId}-${observedAt}-${lat}-${lon}`;
		const observation = { id, chop: c, observedAt, detail: raw.slice(0, 140) };
		let hit = false;
		let remaining = false;
		for (const s of samples) {
			const d = haversineNm({ lat, lon }, s);
			const sAlt = sampleAltFt(s.frac, s.remainingNm, live?.altFt ?? null);
			if (!pirepMatchesSample({ lat, lon, altFt: pAlt }, { lat: s.lat, lon: s.lon, altFt: sAlt }, d)) continue;
			s.pilotReports ??= [];
			if (!s.pilotReports.some(report => report.id === id && report.observedAt === observedAt)) s.pilotReports.push(observation);
			hit = true;
			if (s.frac >= progress) remaining = true;
		}
		if (!hit) continue;
		hazards.push({
			id,
			kind: "pirep",
			chop: c,
			label: `${c} chop reported`,
			detail: observation.detail,
			observedAt,
			remaining,
			lat,
			lon,
			source: "observed"
		});
	}
	const uniqHazards = distinctRouteHazards(hazards);
	const weatherCoverage = { failedSources: [...(hazardsPack.failedSources ?? []), ...(pirepPacks.some(pack => pack == null) ? ["Pilot reports"] : [])] };
	const aeroPush = flightawareOfficial?.push ?? null;
	const aeroPushMatchesFlight = Boolean(
		aeroPush &&
		flightawareOfficial?.flightId &&
		aware?.flightId &&
		official.flightaware.flightId === aware.flightId
	);
	const effectiveGateOut = aeroPushMatchesFlight && aeroPush?.actual
		? { ...aware.gateOut, actual: aeroPush.actual, _trustedActual: true }
		: aware.gateOut;
	const awareWithEffectiveGateOut = effectiveGateOut === aware.gateOut
		? aware
		: { ...aware, gateOut: effectiveGateOut };
	let times = timesOf(awareWithEffectiveGateOut, origin, dest);
	if (!confirmedTakeoff && (resumed || takeoffEvidence?.revocations?.some(r => r.time === aware?.takeoff?.actual))) {
		// Device clocks and explicitly rejected provider stamps are schedule
		// context, not validated takeoff proof (also across a later position gap).
		const departureEstimate = aware?.takeoff?.estimated ?? aware?.takeoff?.scheduled ?? null;
		times = { ...times, airborne: false, takeoffUnix: departureEstimate,
			takeoff: clockAt(departureEstimate, tzOf(origin)), takeoffKind: departureEstimate ? "estimated" : null };
	}
	const atOrigLive = Boolean(live && origin && haversineNm({ lat: live.lat, lon: live.lon }, origin) < 10);
	const dOrigLive = live && origin ? haversineNm({ lat: live.lat, lon: live.lon }, origin) : 0;
	const { awayFromPassengerGateArea } = departureSurfaceLocationHint(live, origin, effectiveGateOut);
	if (live && atOrigLive && live.onGround && (live.gsKt ?? 0) < 1.2 && (live.seenSec ?? 999) <= 30
		&& !awayFromPassengerGateArea && !pushLatchValue && !times.pushed) {
		const prev = parkByFlight.get(landKey);
		if (!prev) parkByFlight.set(landKey, { lat: live.lat, lon: live.lon, at: Date.now() });
		else if (haversineNm({ lat: live.lat, lon: live.lon }, prev) < 0.03) {
			parkByFlight.set(landKey, { lat: (prev.lat + live.lat) / 2, lon: (prev.lon + live.lon) / 2, at: prev.at });
		}
	}
	const park = parkByFlight.get(landKey);
	const distPark = live && park ? haversineNm({ lat: live.lat, lon: live.lon }, park) : 0;
	let motion = { pushed: false, taxiing: false, flying: false };
	const hexNow = String(live?.hex || hexByIdent.get(stateIdent) || aware?.hex || "").toLowerCase();
	const needsGroundTrace = !live || (live.onGround && (live.gsKt ?? 0) < 1.2 && distPark < 0.025 && !pushLatchValue);
	const takeoffForHistory = aware?.takeoff?.actual ?? null;
	const historyStillUseful = !takeoffForHistory || Date.now() / 1e3 - takeoffForHistory < 2 * 3600;
	let openTrace = [];
	if (hexNow && origin && !ourLanded && (needsGroundTrace || historyStillUseful)) {
		const [full, recent] = await Promise.all([
			safe(fetchTrace(hexNow, "trace_full"), []),
			safe(fetchTrace(hexNow, "trace_recent"), [])
		]);
		openTrace = mergeTraces(full, recent);
		motion = motionFromTrace(openTrace, origin);
	}
	const historyStart = (aware?.gateOut?.scheduled ?? aware?.gateOut?.estimated ?? aware?.takeoff?.scheduled ?? Date.now() / 1e3) - 6 * 3600;
	const faHistory = mergeTraces(
		flightawareOfficial?.track?.map((p) => ({ ...p, t: p.seenAt, gs: p.gsKt, alt: p.altFt, ground: p.altFt === 0 })) ?? [],
		aware?.faTrack ?? []
	);
	const fr24History = official.fr24?.track?.map((p) => ({ ...p, t: p.seenAt, gs: p.gsKt, alt: p.altFt, ground: p.altFt === 0 })) ?? [];
	const flightAwarePush = pushEvidenceFromTrack(faHistory, origin, park, historyStart);
	const fr24Push = pushEvidenceFromTrack(fr24History, origin, park, historyStart);
	const adsbPush = pushEvidenceFromTrack(openTrace, origin, park, historyStart);
	const freshSurface = Boolean(live && live.onGround && atOrigLive && !live.extrapolated && (live.seenSec ?? 999) <= 30);
	const leftGate = Boolean(
		!ourLanded &&
		(
			(freshSurface && (awayFromPassengerGateArea || distPark >= 0.05 || (live.gsKt ?? 0) >= 4)) ||
			motion.pushed ||
			motion.taxiing
		)
	);
	// Pushback begins on the first validated movement evidence. Taxi begins only
	// once a fresh on-ground fix reaches 6 kt for the first time.
	const taxiHint = Boolean(freshSurface && ((live.gsKt ?? 0) >= 6 || awayFromPassengerGateArea));
	// Do not let one sparse surface update create Pushback and Taxi at once.
	// If this is the first movement evidence for the leg, expose Pushback for
	// this response; a later confirmed movement update may advance to Taxi.
	const firstDepartureMovement = Boolean(leftGate && !departureProgressKnownBeforeMovement && !times.pushed);
	const stageTaxiHint = taxiHint && (!firstDepartureMovement || awayFromPassengerGateArea);
	// Airport reference coordinates are not gate coordinates. Only a stand
	// observed before departure can contradict a reported gate-out, and the
	// position itself must be fresh and newer than that report.
	const fixUnix = live ? Date.now() / 1e3 - (live.seenSec ?? 999) : 0;
	const gateOutUnix = confirmedGateOutActual(effectiveGateOut);
	const parkedObservedSec = park ? Math.max(0, (Date.now() - park.at) / 1000) : 0;
	const stationaryEvidenceBeatsGateOut = Boolean(
		!gateOutUnix ||
		(park && park.at / 1e3 < gateOutUnix && fixUnix >= gateOutUnix) ||
		parkedObservedSec >= 12
	);
	const stationaryAtStand = Boolean(live && surfaceFixAtOrigin && park && !awayFromPassengerGateArea
		&& (live.seenSec ?? 999) <= 30 && (live.gsKt ?? 0) < 1.2
		&& distPark < 0.025 && !pushLatchValue
		&& stationaryEvidenceBeatsGateOut);
	// A recent stationary surface fix is stronger evidence than a provider's
	// prematurely stamped gate-out or takeoff time.
	if (stationaryAtStand && !motion.pushed && !motion.taxiing && !leftGate) {
		const nextPush = aware?.gateOut?.estimated ?? aware?.gateOut?.scheduled ?? null;
		times = { ...times, pushed: false, airborne: false,
			pushUnix: nextPush, push: clockAt(nextPush, tzOf(origin)), pushKind: nextPush ? "estimated" : null,
			pushSource: null };
	}
	if (surfaceFixAtOrigin) {
		const nextTakeoff = aware?.takeoff?.estimated ?? aware?.takeoff?.scheduled ?? null;
		times = { ...times, airborne: false, takeoffUnix: nextTakeoff,
			takeoff: clockAt(nextTakeoff, tzOf(origin)), takeoffKind: nextTakeoff ? "estimated" : null };
	}
	if (ourAirborne && !times.airborne) {
		times = { ...times, airborne: true };
	}
	const providerPushActual = confirmedGateOutActual(effectiveGateOut);
	const selectedPush = choosePushEvidence(providerPushActual, [
		flightAwarePush && { ...flightAwarePush, provider: "flightaware" },
		fr24Push && { ...fr24Push, provider: "fr24" },
		adsbPush && { ...adsbPush, provider: "adsb" }
	]);
	if (selectedPush && !stationaryAtStand && (leftGate || taxiHint || times.pushed || times.airborne)) {
		const prior = pushLatchValue;
		const reconciledPush = reconcilePushLatch(prior, selectedPush, effectiveGateOut);
		const useUnix = reconciledPush.unix;
		const useSource = reconciledPush.source;
		const origPush = times.origPushUnix ?? useUnix;
		const delayMin = slipMin(useUnix, origPush);
		times = { ...times, pushed: true, pushKind: useSource === "provider_actual" ? "actual" : "estimated",
			pushSource: useSource, pushUnix: useUnix, push: clockAt(useUnix, tzOf(origin)), delayMin,
			pushWas: delayMin != null && delayMin >= 5 ? clockAt(origPush, tzOf(origin)) : times.pushWas };
		pushLatchValue = { unix: useUnix, source: useSource, live: true, at: Date.now() / 1e3 };
	}
	// A taxi hold can look stationary near the departure stand. Preserve the
	// observed pushback until this flight's identity changes.
	if (leftGate && !times.pushed) {
		const now = Date.now() / 1e3;
		const otz = tzOf(origin);
		const priorPush = pushLatchValue;
		const pushUnix = priorPush && typeof priorPush === "object" && priorPush.live && priorPush.unix
			? priorPush.unix
			: now;
		const origPush = times.origPushUnix ?? pushUnix;
		const delayMin = slipMin(pushUnix, origPush);
		times = {
			...times,
			pushed: true,
			pushKind: "estimated",
			pushSource: "live_detected",
			pushUnix,
			push: clockAt(pushUnix, otz),
			delayMin,
			pushWas: delayMin != null && delayMin >= 5 ? clockAt(origPush, otz) : times.pushWas
		};
	}
	if (leftGate || times.airborne || (live && !live.onGround)) {
		const unix = times.pushUnix ?? Date.now() / 1e3;
		pushLatchValue = { unix, source: times.pushSource ?? "live_detected", live: true, at: Date.now() / 1e3 };
	} else if (!live && !times.airborne) {
		const prev = pushLatchValue;
		if (!prev || typeof prev !== "object" || !prev.live) pushLatchValue = null;
	}
	if (stageTaxiHint || times.airborne || (live && !live.onGround)) {
		taxiOutLatchValue = { at: Date.now() / 1e3 };
	}
	const taxiOutLatched = Boolean(taxiOutLatchValue);
	const latched = pushLatchValue;
	const latchUnix = latched && typeof latched === "object" ? latched.unix : typeof latched === "number" ? null : null;
	if (latchUnix && !times.pushed) {
		const age = Date.now() / 1e3 - (latched.at ?? latchUnix);
		if (live || times.airborne || (latched.live && age < 180)) {
			const otz = tzOf(origin);
			const origPush = times.origPushUnix ?? latchUnix;
			const delayMin = slipMin(latchUnix, origPush);
			times = {
				...times,
				pushed: true,
				pushKind: "estimated",
				pushSource: latched.source ?? "live_detected",
				pushUnix: latchUnix,
				push: clockAt(latchUnix, otz),
				delayMin,
				pushWas: delayMin != null && delayMin >= 5 ? clockAt(origPush, otz) : times.pushWas
			};
		}
	}
	if (!ourLanded && (ourAirborne || (live && !live.onGround)) && etaMin > 2) {
		const faLand = aware?.landing?.estimated ?? aware?.landing?.scheduled ?? null;
		const landUnix = typeof faLand === "number" && faLand > Date.now() / 1e3 - 60
			? faLand
			: Date.now() / 1e3 + etaMin * 60;
		if (!times.land || remainingNm < 80 || !faLand) {
			times = {
				...times,
				landUnix,
				land: clockAt(landUnix, tzOf(dest))
			};
		}
	}
	if (times.taxiOutKind !== "measured") {
		const wheelsUp = Boolean(live && !live.onGround) || (Boolean(aware?.takeoff?.actual) && !(live && live.onGround && origin && haversineNm({ lat: live.lat, lon: live.lon }, origin) < 12));
		if (wheelsUp) {
			const pushU = confirmedGateOutActual(effectiveGateOut);
			const toU = aware?.takeoff?.actual;
			if (pushU && toU && toU > pushU) {
				const m = Math.round((toU - pushU) / 60);
				if (m >= 1 && m <= 180) times = { ...times, taxiOutMin: m, taxiOutKind: "measured" };
			}
		}
	}
	if (!ourAirborne && times.taxiOutKind === "measured" && !(live && !live.onGround)) {
		times = { ...times, taxiOutKind: "posted" };
	}
	const dGate = live && dest ? haversineNm({ lat: live.lat, lon: live.lon }, dest) : 999;
	const parkedAtGate = Boolean(
		ourLanded && (
			Boolean(aware?.gateIn?.actual) ||
			(live && live.onGround && (live.gsKt ?? 0) < 1.2 && dGate < 0.55)
		)
	);
	if (parkedAtGate) {
		const now = Date.now() / 1e3;
		const prev = gateLatch.get(landKey) ?? {};
		const landUnix = aware?.landing?.actual ?? prev.landUnix ?? times.landUnix ?? landedLatch.get(landKey) ?? now;
		const gateUnix = aware?.gateIn?.actual ?? prev.gateUnix ?? now;
		const pushUnix = confirmedGateOutActual(effectiveGateOut) ?? prev.pushUnix ?? times.pushUnix;
		const takeoffUnix = aware?.takeoff?.actual ?? prev.takeoffUnix ?? times.takeoffUnix;
		gateLatch.set(landKey, { landUnix, gateUnix, pushUnix, takeoffUnix });
	}
	const g = gateLatch.get(landKey);
	if (g?.pushUnix && g?.takeoffUnix && g.takeoffUnix > g.pushUnix) {
		const m = Math.round((g.takeoffUnix - g.pushUnix) / 60);
		if (m >= 1 && m <= 180) times = { ...times, taxiOutMin: m, taxiOutKind: "measured" };
	}
	if (g?.landUnix && g?.gateUnix && g.gateUnix > g.landUnix) {
		const m = Math.round((g.gateUnix - g.landUnix) / 60);
		if (m >= 1 && m <= 180) {
			times = {
				...times,
				taxiInMin: m,
				taxiInKind: "measured",
				landUnix: g.landUnix,
				land: clockAt(g.landUnix, tzOf(dest)),
				landKind: "actual"
			};
		}
	}
	if (ourLanded && times.landKind !== "actual") {
		const landUnix = aware?.landing?.actual ?? times.landUnix ?? landedLatch.get(landKey) ?? null;
		times = {
			...times,
			landKind: "actual",
			landUnix: landUnix ?? times.landUnix,
			land: times.land ?? clockAt(landUnix, tzOf(dest))
		};
	}
	if (parkedAtGate) {
		const gateUnix = g?.gateUnix ?? aware?.gateIn?.actual ?? times.gateUnix ?? Date.now() / 1e3;
		times = {
			...times,
			gateKind: "actual",
			gateUnix,
			gate: clockAt(gateUnix, tzOf(dest))
		};
	}
	const inbound = buildInbound({
		live,
		ourTakeoffActual: confirmedTakeoff ? confirmTakeoff({ ...evidenceArgs, position: live })?.time ?? null : null,
		ourGateOutActual: confirmedGateOutActual(effectiveGateOut),
		origin,
		inboundIdent: inboundAware?.ident ?? inboundIdent,
		inboundAware,
		inboundLive,
		snap
	});
	const lateWorst = samples.filter((s) => s.frac >= Math.max(progress, .68)).reduce((acc, s) => worse(acc, s.chop), "smooth");
	let comfort = comfortOf(samples, uniqHazards, dest, origin, progress, times, inbound.status, weatherCoverage);
	comfort = applyGradeTrend(`${stateIdent}|${origin.iata}|${dest.iata}`, {
		at: Date.now(),
		score: comfort.score,
		grade: comfort.grade,
		lateChop: lateWorst,
		originCat: origin.category,
		destCat: dest.category,
		depDelay: times.delayMin ?? 0,
		destNas: Boolean(dest.nas?.delayed),
		originNas: Boolean(origin.nas?.delayed),
		taxiOut: times.taxiOutMin,
		inbound: inbound.status
	}, comfort);
	const liveTail = String(live?.registration ?? "").replace(/[-\s]/g, "").toUpperCase();
	const awareTail = String(aware?.tail ?? "").replace(/[-\s]/g, "").toUpperCase();
	const exactFr24Leg = Boolean(
		official.fr24?.flightId &&
		aware?.flightId &&
		official.fr24.flightId === aware.flightId
	);
	const currentFlightSurfaceConfirmed = Boolean(
		live &&
		live.onGround &&
		!live.extrapolated &&
		(live.seenSec ?? 999) <= (exactFr24Leg ? 60 : 30) &&
		origin &&
		haversineNm({ lat: live.lat, lon: live.lon }, origin) < 10 &&
		(flightIdentOk(live.callsign, parsed, aware) || Boolean(awareTail && liveTail && awareTail === liveTail))
	);
	// Persist before choosing the response stage so a CAS winner also protects
	// this stale poll. No provider lookup is needed to apply the floor.
	const nextPhase = { push: pushLatchValue, taxiOut: taxiOutLatchValue,
		...(takeoffEvidence ? { confirmedTakeoff: takeoffEvidence } : {}) };
	if (canPersistState && !phaseStateEqual(loadedPhase.state, nextPhase)) {
		const saveStatus = await savePhaseState(stateKey, nextPhase, loadedPhase.version);
		if (saveStatus !== "ok") phaseStatePersistence = saveStatus;
		if (saveStatus === "conflict_resolved" || saveStatus === "conflict_dropped") {
			const winner = await loadPhaseState(stateKey);
			takeoffEvidence = mergeConfirmedTakeoff(takeoffEvidence, winner.state.confirmedTakeoff);
			confirmedTakeoff = activeConfirmedTakeoff(takeoffEvidence);
			if (winner.status !== "ok") phaseStatePersistence = winner.status;
		}
	}
	if (!confirmedTakeoff && takeoffEvidence?.revocations?.some(r => r.time === aware?.takeoff?.actual)) {
		// A CAS winner may have revoked the stamp after this poll built times.
		const departureEstimate = aware?.takeoff?.estimated ?? aware?.takeoff?.scheduled ?? null;
		times = { ...times, airborne: false, takeoffUnix: departureEstimate,
			takeoff: clockAt(departureEstimate, tzOf(origin)), takeoffKind: departureEstimate ? "estimated" : null };
	}
	if (confirmedTakeoff) {
		times = { ...times, airborne: true, ...(confirmedTakeoff.time != null ? {
			takeoffUnix: confirmedTakeoff.time, takeoffKind: "actual", takeoff: clockAt(confirmedTakeoff.time, tzOf(origin))
		} : {}) };
	}
	// Retain revocations in warm outage continuity too; an old memo must not
	// resurrect a rejected provider stamp when the database is unavailable.
	if (canPersistState && takeoffEvidence) {
		if (takeoffContinuity.size >= 1000) takeoffContinuity.delete(takeoffContinuity.keys().next().value);
		takeoffContinuity.set(stateKey, { confirmation: takeoffEvidence, at: Date.now() / 1000 });
	}
	const stageArgs = {
		live,
		remainingNm: stageRemainingNm,
		dest,
		origin,
		ourTakeoffActual: confirmedTakeoff ? confirmTakeoff({ ...evidenceArgs, position: live })?.time ?? null : null,
		ourLandingActual: aware?.landing.actual ?? null,
		ourLanded,
		// A resume contains no verified inbound leg. Do not relabel the tracked
		// aircraft's fresh departure-airport position as an inbound flight.
		inboundStatus: resumed && !inboundAware ? "unknown" : inbound.status,
		pushed: Boolean(times.pushed || leftGate),
		faAirborne: Boolean((confirmedTakeoff && confirmTakeoff({ ...evidenceArgs, position: live })) || flightBegun(live, origin) || motion.flying) && !surfaceFixAtOrigin && !stageTaxiHint,
		taxiHint: stageTaxiHint,
		taxiOutLatched,
		distPark,
		parkedAtGate,
		gateInActual: aware?.gateIn?.actual ?? null,
		weakGateInActual: scheduleSource === "flightstats_public",
		nowSec,
		currentFlightSurfaceConfirmed
	};
	const candidateStage = currentStageOf(stageArgs);
	const current = currentStageOf({ ...stageArgs, confirmedTakeoff });
	const takeoffFloorApplied = candidateStage !== current;
	const selectedStageReason = !confirmedTakeoff && hasOriginSurfaceFix({ ...evidenceArgs, origin, position: live })
		&& takeoffEvidence?.revocations?.length ? "provider_takeoff_contradicted_by_surface" : takeoffFloorApplied ? "confirmed_takeoff_floor"
		: confirmedTakeoff ? `confirmed_takeoff_${confirmedTakeoff.source}:${current}` : `current_evidence:${current}`;
	const arrivalStatus = current === "taxi_in"
		? "taxi_in"
		: current === "gate"
			? "gate"
			: ourLanded
				? "landed"
				: "airborne";
	const finalPositionAgeSec = liveAgeSec(live);
	const finalPositionSource = live?.source ?? (live?.extrapolated ? "estimated" : "fallback");
	const faPosition = flightawareOfficial?.position ?? null;
	const fr24Position = official.fr24?.position ?? null;
	const adsbPosition = normalizedAdsb(adsbLive);
	const providerDistancesNm = {
		flightawareToFr24: providerDistance(faPosition, fr24Position),
		flightawareToAdsb: providerDistance(faPosition, adsbPosition),
		fr24ToAdsb: providerDistance(fr24Position, adsbPosition)
	};
	if (atOrigLive || ["origin_gate", "push", "taxi"].includes(current) || flightAwarePush || fr24Push || adsbPush) {
		console.log("[departure-telemetry]", {
			callsignRequested: query,
			flightInstance: landKey,
			currentStage: current,
			pushLatched: Boolean(pushLatchValue),
			taxiOutLatched,
			pushTimestamp: times.pushed ? times.pushUnix : null,
			pushTimestampSource: times.pushed ? times.pushSource ?? null : null,
			firstDepartureMovement,
			rawTaxiHint: taxiHint,
			stageTaxiHint,
			taxiThresholdKt: 6,
			parkedObservedSec,
			stationaryAtStand,
			awayFromPassengerGateArea,
			providerGateOut: effectiveGateOut ?? null,
			providerGateOutPublic: aware?.gateOut ?? null,
			groundspeedKt: live?.gsKt ?? null,
			onGround: live?.onGround ?? null,
			distanceFromParkedNm: park && live ? distPark : null,
			positionAgeSec: finalPositionAgeSec,
			positionSource: finalPositionSource
		});
		console.log("[push-evidence] " + JSON.stringify({
			callsignRequested: query,
			flightInstance: landKey,
			flightaware: {
				flightId: flightawareOfficial?.flightId ?? aware?.flightId ?? null,
				publicGateOut: aware?.gateOut ?? null,
				aeroApiOut: flightawareOfficial?.push ?? null,
				firstTrackMovement: flightAwarePush
			},
			fr24: {
				flightId: official.fr24?.flightId ?? null,
				status: official.status.fr24,
				firstTrackMovement: fr24Push,
				summaryOut: official.fr24?.push ?? null
			},
			adsb: {
				firstTrackMovement: adsbPush,
				positionAgeSec: finalPositionAgeSec,
				groundspeedKt: live?.gsKt ?? null,
				distanceFromParkedNm: park && live ? distPark : null
			},
			inbound: {
				parkedPosition: park ?? null,
				selectedPush,
				pushLatch: pushLatchValue ?? null,
				taxiOutLatch: taxiOutLatchValue ?? null,
				finalPushUnix: times.pushed ? times.pushUnix : null,
				finalPushSource: times.pushed ? times.pushSource ?? null : null,
				phaseStatePersistenceOnLoad: loadedPhase.status
			}
		}));
	}
	if ((directToDestNm != null && directToDestNm <= 40) || landingSoon) {
		console.log("[flight-telemetry]", {
			callsignRequested: query,
			callsign: liveCs,
			registration: live?.registration ?? aware?.tail ?? null,
			hex: live?.hex ?? aware?.hex ?? null,
			destination: { iata: dest.iata, icao: dest.icao, lat: dest.lat, lon: dest.lon },
			livePosition: live ? { lat: live.lat, lon: live.lon } : null,
			altitudeFt: live?.altFt ?? null,
			groundspeedKt: live?.gsKt ?? null,
			onGround: live?.onGround ?? null,
			track: live?.track ?? null,
			verticalRateFpm: live?.vertFpm ?? null,
			phase: live?.phase ?? null,
			headingToDestinationDelta: finalApproachEvidence(live, dest).headingDelta,
			isFinalApproach: isFinalApproach(live, dest),
			routeRemainingNm,
			directToDestNm,
			remainingNm,
			etaMin,
			currentStage: current,
			arrivalStatus,
			ourLanded,
			positionProvider: finalPositionSource,
			positionSeenAt: live?.seenAt ?? (finalPositionAgeSec != null ? Date.now() / 1000 - finalPositionAgeSec : null),
			positionAgeSec: finalPositionAgeSec,
			flightawarePosition: faPosition,
			fr24Position,
			adsbPosition,
			providerStatus: official.status,
			providerEta: { flightaware: flightawareOfficial?.providerEta ?? null, fr24: official.fr24?.providerEta ?? null },
			providerDistancesNm,
			fusionDisagreementNm: positionChoice.disagreementNm,
			filedRouteDeviationNm,
			displayPathSource: pathSource
		});
	}
	const airline = airlineOf(liveCs) ?? route?.airline?.name ?? null;
	let aircraft = live;
	if (ourLanded) {
		if (live && haversineNm({ lat: live.lat, lon: live.lon }, dest) < 20) aircraft = live;
		else if (!confirmedTakeoff) {
			const type = aware?.type ?? live?.type ?? null;
			aircraft = {
				hex: aware?.hex ?? live?.hex ?? "",
				registration: aware?.tail ?? live?.registration ?? null,
				type,
				typeName: airframeOf(type)?.name ?? type,
				year: null,
				operator: null,
				lat: dest.lat,
				lon: dest.lon,
				altFt: 0,
				gsKt: 0,
				track: heading,
				vertFpm: null,
				onGround: true,
				phase: "parked"
			};
		}
	} else if (!aircraft && inboundLive && (inbound.status === "at_field" || inbound.status === "complete") && !ourAirborne) {
		aircraft = inboundLive;
	} else if (!aircraft) {
		const fromFa = liveFromAware(aware);
		if (fromFa) aircraft = fromFa;
		else if (!confirmedTakeoff && (aware?.type || aware?.tail)) {
			const type = aware?.type ?? null;
			aircraft = {
				hex: aware?.hex ?? "",
				registration: aware?.tail ?? null,
				type,
				typeName: airframeOf(type)?.name ?? type,
				year: null,
				operator: null,
				lat: origin.lat,
				lon: origin.lon,
				altFt: 0,
				gsKt: 0,
				track: null,
				vertFpm: null,
				onGround: true,
				phase: "parked"
			};
		}
	}
	let wx = null;
	// Final-approach position must reach the client inside the story deadline.
	// Corridor weather is non-critical here and can involve several slow feeds.
	if (directToDestNm == null || directToDestNm > 40) try {
		if (times.landUnix || times.pushUnix) {
			origin.taf = decodeTafPassenger(origin.tafRaw, times.pushUnix ?? Date.now() / 1e3) ?? origin.taf;
			dest.taf = decodeTafPassenger(dest.tafRaw, times.landUnix ?? Date.now() / 1e3) ?? dest.taf;
		}

		const corridor = [];
		if (corridorAps.length) {
			const mets = await corridorMetsP;
			for (let i = 0; i < corridorAps.length; i++) {
				const m = mets[i]?.metar;
				if (!m) continue;
				const dec = decodeMetar(m);
				const wxBit = dec.wx && !/no significant/i.test(dec.wx) ? ` · ${dec.wx}` : "";
				corridor.push({ iata: corridorAps[i].iata, summary: `${dec.category}${wxBit}` });
			}
		}
		const liveWx = digestWx({
			samples,
			hazards: uniqHazards,
			originCat: origin.category ?? "UNK",
			destCat: dest.category ?? "UNK",
			originTaf: origin.taf ?? null,
			destTaf: dest.taf ?? null,
			corridor,
			progress
		});
		const filedKey = aware ? origKey(aware) : `${identKey}|${origin.iata}|${dest.iata}`;
		const filedWx = rememberFiledWx(filedKey, liveWx);
		wx = {
			filedAt: filedWx.at,
			filed: filedWx,
			live: liveWx,
			deltas: wxDeltas(filedWx, liveWx),
			hash: liveWx.hash
		};
	} catch {
		wx = null;
	}
	const baseResume = resumed?.resume ?? resumeFromAware(aware, query);
	const detectedPush = pushLatchValue;
	const storyResume = baseResume ? {
		...baseResume,
		// Preserve the live aircraft identity independently of the schedule feed.
		// Some providers drop the completed flight-number record immediately after
		// landing (especially on same-number through flights), but the tail/hex we
		// observed in flight is still the safest key for taxi-in ground tracking.
		tail: baseResume.tail ?? aircraft?.registration ?? null,
		hex: baseResume.hex ?? aircraft?.hex ?? null,
		type: baseResume.type ?? aircraft?.type ?? null,
		stateKey,
		confirmedTakeoff: takeoffDiagnostic(confirmedTakeoff),
		takeoffRevocations: takeoffEvidence?.revocations,
		takeoff: { ...baseResume.takeoff, actual: confirmedTakeoff?.time ?? (takeoffEvidence?.revocations?.some(r => r.time === baseResume.takeoff?.actual) ? null : baseResume.takeoff?.actual) ?? null },
		departureStage: confirmedTakeoff ? null : taxiOutLatched ? "taxi" : pushLatchValue ? "push" : null,
		detectedPushUnix: detectedPush && typeof detectedPush === "object" && detectedPush.source === "live_detected"
			? detectedPush.unix
			: baseResume.detectedPushUnix ?? null,
		detectedTaxiUnix: taxiOutLatchValue?.at ?? baseResume.detectedTaxiUnix ?? null
	} : undefined;
	// Persist the combined filed/track/observation facts once, after the poll.
	// storedState is the row before alias folding, so that carry is saved too.
	if (canPersistState && routeMemory && loadedRoute && !routeMemoryEqual(routeMemory, loadedRoute.storedState)) {
		const savedRoute = await routeMemoryStore.save(stateKey, routeMemory, loadedRoute.version);
		routeMemory = savedRoute.state;
		routeMemoryPersistence = savedRoute.status;
	}
	return {
		build: BUILD_INFO,
		fetchedAt: Date.now(),
		stateKey,
		confirmedTakeoff: takeoffDiagnostic(confirmedTakeoff),
		takeoffRevocations: takeoffEvidence?.revocations,
		selectedStageReason,
		takeoffFloorApplied,
		candidateStage,
		schedule: aware ? { status: resumed ? "saved" : "current", confirmedAt: aware.confirmedAt ?? Date.now(), serviceDate: aware._publicScheduleDate ?? null } : undefined,
		resume: storyResume,
		flightId: aware?.flightId ?? undefined,
		diversion: aware?.diversion,
		inboundDiversion,
		query,
		callsign: liveCs,
		iata: displayIata(liveCs, parsed.iata ?? aware?.iataIdent ?? route?.callsign_iata ?? null),
		airline,
		live: Boolean(live),
		currentStage: current,
		arrivalStatus,
		providers: {
			scheduleSource,
			flightStateKey: stateKey,
			canonicalKey: stateIdentity.canonicalKey,
			canonicalKeyFailure: stateIdentity.reason,
			configured: official.configured,
			status: official.status,
			chosenPosition: finalPositionSource,
			chosenPositionSeenAt: live?.seenAt ?? (finalPositionAgeSec != null ? Date.now() / 1000 - finalPositionAgeSec : null),
			chosenPositionAgeSec: finalPositionAgeSec,
			fr24Position,
			flightawarePosition: faPosition,
			adsbPosition,
			disagreementNm: positionChoice.disagreementNm,
			providerDistancesNm,
			filedRouteDeviationNm,
			providerEta: { flightaware: flightawareOfficial?.providerEta ?? null, fr24: official.fr24?.providerEta ?? null },
			remainingNm,
			etaMin,
			landed: ourLanded,
			// "ok" unless the durable ground-phase store (flight_phase_state) had
			// trouble this request -- read_failed/write_failed/conflict_* mean
			// pushLatchValue/taxiOutLatchValue above were computed from an empty
			// or stale base rather than the real persisted state. Surfaced here
			// (not just server logs) so a strangely-behaving flight can be
			// checked from the response itself, not just a log search.
			phaseStatePersistence,
			routeMemoryPersistence
		},
		aircraft,
		origin,
		dest,
		route: {
			expectedArrival,
			arrivalPatternKind,
			arrivalProjectionStale: pattern?.stale ?? false,
			arrivalGeometrySource: pattern?.geometrySource ?? null,
			filedRouteFingerprint: routeMemory?.filed?.fingerprint ?? null,
			filedRouteObservedAt: routeMemory?.filed?.observedAt ?? null,
			totalNm,
			remainingNm,
			routeRemainingNm,
			directToDestNm,
			flownNm: Math.max(0, totalNm - remainingNm),
			observedFlownNm: filed.flown?.length >= 2 ? polylineLengthNm(filed.flown) : null,
			progressSource: routeProgressValue.source,
			progressObservedAt: routeProgressValue.observedAt,
			etaMin,
			progress,
			heading,
			source: pathSource,
			samples,
			filedFixes: (heldWaypoints.length ? heldWaypoints : aware?.waypoints ?? [])
				.filter((p) => typeof p.label === "string" && p.label.trim().length > 0)
				.map((p) => ({ lat: p.lat, lon: p.lon, label: p.label }))
		},
		hazards: uniqHazards.slice(0, 12),
		weatherCoverage,
		comfort,
		wx,
		inbound,
		times,
		stages: buildStages({
			live,
			origin,
			dest,
			current,
			remainingNm,
			etaMin,
			comfort,
			inbound,
			samples,
			times,
			taxiHint,
			parkedAtGate
		})
	};
}
export async function loadFlightStory(query, opts) {
	return withStoryRequest(query, Boolean(opts?.fresh), () => loadFlightStoryCore(query, opts));
}
async function loadFlightStoryCore(query, opts) {
	const fresh = Boolean(opts?.fresh);
	try {
		const key = `story43:${String(query || "").toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
		if (fresh) {
			cache.delete(key);
			for (const k of [...cache.keys()]) {
				if (/^(hex4:|cs4:|reg4:|trace3:)/.test(k)) cache.delete(k);
			}
		}
		try {
			const progressResume = readFlightResume(opts?.resume, query);
			return await cached(key, fresh ? 0 : 4e3, () => buildStory(query, null, progressResume));
		} catch (error) {
			// A schedule outage must not disable independent position/weather feeds.
			// Only a recent, leg-specific record can bridge it. New searches still
			// need a working schedule source; ADS-B route assignments aren't enough.
			if (!/schedule provider|Current flight route unavailable/i.test(error?.message ?? "")) throw error;
			const callsign = parseFlightQuery(query)?.callsign;
			const serverResume = resumeFromAware(cache.get(`aware:${callsign}`)?.value, query);
			const deviceResume = readFlightResume(opts?.resume, query);
			const resume = [serverResume, deviceResume].filter(Boolean).sort((a, b) => b.confirmedAt - a.confirmedAt)[0];
			if (!resume) throw error;
			// Device context must never enter another passenger's normal story cache
			// or flight-stage latches. Hash the entire validated context, not just q.
			const scope = `resume:${createHash("sha256").update(JSON.stringify(resume)).digest("hex")}:`;
			const resumeKey = `${scope}story`;
			if (fresh) cache.delete(resumeKey);
			return await cached(resumeKey, fresh ? 0 : 4e3, () => buildStory(query, { resume, scope }, resume));
		}
	} catch (err) {
		const msg = err instanceof Error && err.message && err.name !== "AbortError" ? err.message : "Could not load that flight. Try again.";
		const error = new Error(msg, { cause: err });
		if (err?.name === "AbortError") error.name = "AbortError";
		throw error;
	}
}
export async function loadLiveBoard() {
	return cached("live-board-v3", 25e3, async () => {
		const jfk = AIRPORT_BY_ICAO.KJFK;
		const acs = await safe(adsbAround(jfk.lat, jfk.lon, 90), []);
		const picked = /* @__PURE__ */ new Map();
		const prefs = [
			"AAL",
			"UAL",
			"DAL",
			"JBU",
			"ASA",
			"VIR",
			"BAW",
			"AFR",
			"DLH",
			"KLM",
			"ACA"
		];
		for (const raw of acs) {
			const cs = (raw.flight ?? "").trim().toUpperCase();
			if (!cs || picked.has(cs)) continue;
			if (typeof raw.alt_baro !== "number" || raw.alt_baro < 12e3) continue;
			if (!prefs.some((p) => cs.startsWith(p))) continue;
			picked.set(cs, raw);
			if (picked.size >= 6) break;
		}
		const entries = [...picked.entries()];
		const cards = (await Promise.all(entries.map(async ([cs, raw]) => {
			const route = await safe(loadRoute(cs), null);
			const origin = fieldFromAdsbdb(route?.origin);
			const dest = fieldFromAdsbdb(route?.destination);
			if (!origin || !dest) return null;
			const nas = await safe(loadNas(dest.iata), null);
			const remaining = typeof raw.lat === "number" && typeof raw.lon === "number" ? haversineNm({
				lat: raw.lat,
				lon: raw.lon
			}, dest) : null;
			const gc = haversineNm(origin, dest);
			if (remaining != null && remaining > gc * 1.4 + 80) return null;
			return {
				callsign: cs,
				iata: displayIata(cs, route?.callsign_iata ?? null),
				airline: airlineOf(cs) ?? route?.airline?.name ?? null,
				from: origin.iata,
				to: dest.iata,
				fromCity: origin.city,
				toCity: dest.city,
				type: raw.t ?? null,
				altFt: typeof raw.alt_baro === "number" ? raw.alt_baro : null,
				remainingNm: remaining,
				delayedDest: Boolean(nas?.delayed)
			};
		}))).filter((c) => c != null);
		cards.sort((a, b) => {
			if (a.delayedDest !== b.delayedDest) return a.delayedDest ? -1 : 1;
			return (b.remainingNm ?? 0) - (a.remainingNm ?? 0);
		});
		return cards.slice(0, 8);
	});
}
