// @ts-nocheck
import { airframeOf, airlineOf, isVehicleType } from "./aircraft";
import { AIRPORT_BY_ICAO, airportByIata, airportByIcao } from "./airports";
import { displayIata, parseFlightQuery } from "./flight-parse";
import {
  densifyPath,
  destPoint,
  distanceToSegmentNm,
  downsampleNm,
  formatDuration,
  formatNm,
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
var UA = "Inbound/1.0 (passenger flight companion)";
var cache = /* @__PURE__ */ new Map();
var inflight = /* @__PURE__ */ new Map();
function cached(key, ttlMs, fn) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
	const pending = inflight.get(key);
	if (pending) return pending;
	const p = fn().then((value) => {
		cache.set(key, {
			at: Date.now(),
			value
		});
		inflight.delete(key);
		return value;
	}).catch((err) => {
		inflight.delete(key);
		throw err;
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
async function fetchTrace(hex, kind) {
	const id = hex.toLowerCase();
	return cached(`trace3:${kind}:${id}`, 25e3, async () => {
		const url = `https://globe.theairtraffic.com/data/traces/${id.slice(-2)}/${kind}_${id}.json`;
		const res = await fetch(url, {
			headers: {
				"User-Agent": UA,
				Accept: "application/json"
			},
			signal: AbortSignal.timeout(7e3)
		});
		if (!res.ok) return [];
		const data = await res.json();
		const base = data.timestamp ?? 0;
		const out = [];
		for (const row of data.trace ?? []) {
			const lat = row[1];
			const lon = row[2];
			const sec = row[0];
			if (typeof lat !== "number" || typeof lon !== "number") continue;
			if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
			const altRaw = row[3];
			const gsRaw = row[4];
			const ground = altRaw === "ground" || altRaw === 0 || altRaw === "0";
			const alt = typeof altRaw === "number" && altRaw > 0 ? altRaw : ground ? 0 : null;
			const gs = typeof gsRaw === "number" ? gsRaw : null;
			out.push({
				t: base + (typeof sec === "number" ? sec : 0),
				lat,
				lon,
				alt,
				ground,
				gs
			});
		}
		return out;
	});
}
function uniqueTrack(points) {
	const out = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && haversineNm(last, p) < 6) continue;
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
			if (dt > 1080 || jump > 180 && dt > 360) flush();
		}
		if (isGroundPt(p)) {
			groundStreak++;
			if (airPts >= 8 && groundStreak >= 2) {
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
		if (polylineLengthNm(leg) < 12) continue;
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
	if (!kept.length && livePt) {
		for (let i = legs.length - 1; i >= 0; i--) {
			if (nearLiveNm(legs[i], livePt) < 45) {
				kept.push(legs[i]);
				break;
			}
		}
	}
	const pts = [];
	for (const leg of kept) pts.push(...leg);
	return pts;
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
	const brg = live?.track != null ? live.track : initialBearing(from, dest);
	const aheadNm = Math.min(leftover * 0.32, 320);
	const ahead = destPoint(from, brg, aheadNm);
	if (haversineNm(ahead, dest) >= leftover - 8) return [from, dest];
	return [from, ahead, dest];
}
function directSpine(origin, dest, live) {
	const here = live ? { lat: live.lat, lon: live.lon } : null;
	const spine = [origin];
	if (here && haversineNm(origin, here) > 12) spine.push(here);
	spine.push(...remainingLeg(here ?? origin, dest, live).slice(1));
	if (haversineNm(spine[spine.length - 1], dest) > 2) spine.push(dest);
	return densifyPath(downsampleNm(spine, 18), 55);
}
async function loadFiledPath(hex, origin, dest, live, takeoffUnix, waypoints) {
	const spine = makeSpine(origin, dest, waypoints);
	let raw = [];
	if (hex) try {
		const [full, recent] = await Promise.all([fetchTrace(hex, "trace_full"), fetchTrace(hex, "trace_recent")]);
		raw = mergeTraces(full, recent);
	} catch {
		raw = [];
	}
	const flown = uniqueTrack(legsForThisSector(splitTraceLegs(raw), origin, dest, live, takeoffUnix ?? null));
	if (live && haversineNm({ lat: live.lat, lon: live.lon }, dest) < 68) {
		const arrival = stitchArrival(flown, live, dest);
		if (arrival && arrival.length >= 4) return { points: arrival, source: flown.length >= 6 ? "track" : "direct" };
	}
	if (flown.length >= 8) {
		return {
			points: densifyPath(downsampleNm(blendTrackOntoSpine(flown, spine), 22), 48),
			source: "track"
		};
	}
	if (Array.isArray(waypoints) && waypoints.length >= 4) return { points: spine, source: "filed" };
	if (live) return { points: directSpine(origin, dest, live), source: "direct" };
	return { points: spine, source: "direct" };
}
function acList(d) {
	return d?.ac ?? d?.aircraft ?? [];
}
function phaseOf(ac) {
	if (ac.onGround) return (ac.gsKt ?? 0) > 8 ? "taxi" : "parked";
	const v = ac.vertFpm ?? 0;
	const alt = ac.altFt ?? 0;
	if (v < -400 && alt < 8e3) return "approach";
	if (v < -250) return "descent";
	if (v > 400 && alt < 12e3) return "climb";
	return "cruise";
}
function toLive(raw) {
	const hex = (raw.hex ?? "").toLowerCase();
	const lat = raw.lat;
	const lon = raw.lon;
	if (!hex || lat == null || lon == null) return null;
	const onGround = raw.alt_baro === "ground" || raw.alt_baro === 0;
	const altFt = typeof raw.alt_baro === "number" && raw.alt_baro > 0 ? raw.alt_baro : onGround ? 0 : null;
	const gsKt = typeof raw.gs === "number" ? raw.gs : null;
	const vertFpm = typeof raw.baro_rate === "number" ? raw.baro_rate : null;
	const type = raw.t?.trim() || null;
	return {
		hex,
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
		onGround,
		phase: phaseOf({
			onGround,
			gsKt,
			altFt,
			vertFpm
		})
	};
}
function callsignVariants(callsign) {
	const u = String(callsign || "").replace(/\s/g, "").toUpperCase();
	if (!u) return [];
	const out = new Set([u]);
	const m = u.match(/^([A-Z]{2,3})(\d+)$/);
	if (m) {
		const prefix = m[1];
		const num = m[2];
		out.add(prefix + num.replace(/^0+/, ""));
		out.add(prefix + num.padStart(3, "0"));
		out.add(prefix + num.padStart(4, "0"));
	}
	return [...out];
}
async function adsbByCallsign(callsign) {
	const variants = callsignVariants(callsign);
	const hits = await Promise.all(variants.map((v) => cached(`cs:${v}`, 12e3, async () => {
		return acList(await fetchJson(`https://opendata.adsb.fi/api/v2/callsign/${encodeURIComponent(v)}`))[0] ?? null;
	}).catch(() => null)));
	return hits.find(Boolean) ?? null;
}
async function adsbByReg(reg) {
	return cached(`reg:${reg}`, 12e3, async () => {
		return acList(await fetchJson(`https://opendata.adsb.fi/api/v2/registration/${encodeURIComponent(reg)}`))[0] ?? null;
	});
}
async function adsbAround(lat, lon, dist) {
	return cached(`around:${lat.toFixed(2)}:${lon.toFixed(2)}:${dist}`, 18e3, async () => {
		return acList(await fetchJson(`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`, 12e3));
	});
}
function headingDelta(a, b) {
	const d = Math.abs(wrap360(a) - wrap360(b));
	return Math.min(d, 360 - d);
}
function circularMeanDeg(degs) {
	if (!degs.length) return null;
	let x = 0;
	let y = 0;
	for (const d of degs) {
		x += Math.cos(d * Math.PI / 180);
		y += Math.sin(d * Math.PI / 180);
	}
	return wrap360(Math.atan2(y, x) * 180 / Math.PI);
}
function rwyFromHeading(hdg) {
	let n = Math.round(wrap360(hdg) / 10);
	if (n === 0 || n === 37) n = 36;
	return String(n).padStart(2, "0");
}
function alongToward(p, origin, bearingDeg) {
	const dist = haversineNm(origin, p);
	const brg = initialBearing(origin, p);
	const rad = headingDelta(brg, bearingDeg) * Math.PI / 180;
	const toward = headingDelta(brg, bearingDeg) <= 90;
	return (toward ? 1 : -1) * dist * Math.cos(rad);
}
function crossFrom(p, origin, bearingDeg) {
	const dist = haversineNm(origin, p);
	const brg = initialBearing(origin, p);
	const rad = headingDelta(brg, bearingDeg) * Math.PI / 180;
	return dist * Math.sin(rad);
}
function queueItemFromRaw(raw, you) {
	const cs = String(raw.flight ?? "").trim().toUpperCase();
	const type = raw.t?.trim() || null;
	const gs = typeof raw.gs === "number" ? raw.gs : null;
	return {
		hex: String(raw.hex ?? "").toLowerCase(),
		callsign: cs || raw.r?.trim() || "—",
		iata: cs ? displayIata(cs, null) : raw.r?.trim() || "—",
		type,
		typeName: airframeOf(type)?.name ?? raw.desc ?? type,
		gsKt: gs,
		holding: (gs ?? 0) < 8,
		you: Boolean(you)
	};
}
function headingsCluster(degs, maxSpread) {
	if (!degs.length) return null;
	const mean = circularMeanDeg(degs);
	if (mean == null) return null;
	const tight = degs.filter((d) => headingDelta(d, mean) < maxSpread);
	if (tight.length < 2) return null;
	return circularMeanDeg(tight);
}
async function loadTaxiQueue({ origin, dest, live, ourHex, ourAirborne, pushed }) {
	if (!live || !live.onGround || !origin) return null;
	if (ourAirborne) return null;
	const atOrigin = haversineNm({ lat: live.lat, lon: live.lon }, origin) < 8;
	const atDest = dest ? haversineNm({ lat: live.lat, lon: live.lon }, dest) < 6 : false;
	if (atDest && !atOrigin) return null;
	if (!atOrigin) return null;
	const gs = live.gsKt ?? 0;
	const moving = gs >= 8;
	if (!moving && !pushed) return null;
	const rawList = await safe(adsbAround(origin.lat, origin.lon, 8), []);
	const field = [];
	const takeoffHdgs = [];
	for (const raw of rawList) {
		const hex = String(raw.hex ?? "").toLowerCase();
		if (!hex || !raw.lat || !raw.lon) continue;
		if (isVehicleType(raw.t, raw.category, raw.ownOp)) continue;
		const onGround = raw.alt_baro === "ground" || raw.alt_baro === 0;
		const alt = typeof raw.alt_baro === "number" && raw.alt_baro > 0 ? raw.alt_baro : 0;
		const acGs = typeof raw.gs === "number" ? raw.gs : 0;
		const track = typeof raw.track === "number" ? raw.track : null;
		const vert = typeof raw.baro_rate === "number" ? raw.baro_rate : 0;
		const here = { lat: raw.lat, lon: raw.lon };
		const dist = haversineNm(here, origin);
		if (!onGround && dist < 9 && alt > 150 && alt < 7000 && acGs > 110 && track != null && (vert > 80 || acGs > 140 && alt < 4000)) {
			takeoffHdgs.push(track);
			continue;
		}
		if (!onGround) continue;
		if (dist > 4.4) continue;
		field.push({ raw, hex, here, dist, gs: acGs, track });
	}
	const depHdg = headingsCluster(takeoffHdgs, 14);
	if (depHdg == null) {
		if (!moving) return null;
		return {
			place: null,
			ahead: 0,
			moving: 1,
			items: [{
				hex: live.hex,
				callsign: "YOU",
				iata: "You",
				type: live.type ?? null,
				typeName: live.typeName ?? null,
				gsKt: live.gsKt ?? null,
				holding: false,
				you: true
			}],
			depRunway: null,
			depSource: null,
			status: "taxi",
			note: "Taxiing. Runway not verified yet."
		};
	}
	const depSource = "takeoffs";
	const toThr = wrap360(depHdg + 180);
	const us = { lat: live.lat, lon: live.lon };
	const ourAlong = alongToward(us, origin, toThr);
	const ourCross = crossFrom(us, origin, toThr);
	const nearRwy = ourAlong > 0.5 && ourCross < 0.9;
	if (!moving && !nearRwy) return null;
	const line = [];
	for (const ac of field) {
		if (ourHex && ac.hex === ourHex) continue;
		if (ac.gs > 28) continue;
		const holdingNearRwy = ac.gs < 5 && alongToward(ac.here, origin, toThr) > 0.55 && crossFrom(ac.here, origin, toThr) < 0.85;
		const acMoving = ac.gs >= 5;
		if (!acMoving && !holdingNearRwy) continue;
		if (ac.track != null && ac.gs > 32 && headingDelta(ac.track, toThr) < 18) continue;
		if (crossFrom(ac.here, origin, toThr) > 1.05) continue;
		if (Math.abs(crossFrom(ac.here, origin, toThr) - ourCross) > 1.15) continue;
		line.push({ ...ac, along: alongToward(ac.here, origin, toThr) });
	}
	line.sort((a, b) => b.along - a.along);
	const aheadList = line.filter((ac) => ac.along > ourAlong + 0.06);
	const items = aheadList.slice(0, 12).map((ac) => queueItemFromRaw(ac.raw, false));
	items.push({
		hex: live.hex,
		callsign: "YOU",
		iata: "You",
		type: live.type ?? null,
		typeName: live.typeName ?? null,
		gsKt: live.gsKt ?? null,
		holding: gs < 8,
		you: true
	});
	const ahead = aheadList.length;
	const place = ahead + 1;
	const depRunway = rwyFromHeading(depHdg);
	const note = place === 1
		? `You’re first for runway ${depRunway}.`
		: `You’re number ${place} for runway ${depRunway} — ${ahead} aircraft ahead.`;
	return {
		place,
		ahead,
		moving: line.filter((ac) => ac.gs >= 5).length,
		items,
		depRunway,
		depSource,
		status: "taxi",
		note
	};
}
async function loadRoute(callsign) {
	return cached(`route:${callsign}`, 18e5, async () => {
		return (await fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, 8e3)).response?.flightroute ?? null;
	});
}
function parseJsonObject(raw) {
	let depth = 0;
	let start = -1;
	for (let k = 0; k < raw.length; k++) {
		const ch = raw[k];
		if (ch === "{") {
			if (depth === 0) start = k;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) try {
				return JSON.parse(raw.slice(start, k + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}
function asTimes(v) {
	const o = v ?? {};
	return {
		scheduled: typeof o.scheduled === "number" ? o.scheduled : null,
		estimated: typeof o.estimated === "number" ? o.estimated : null,
		actual: typeof o.actual === "number" ? o.actual : null
	};
}
function bestUnix(t) {
	return t.actual ?? t.estimated ?? t.scheduled;
}
function identFromFa(id) {
	if (!id) return null;
	return String(id).toUpperCase().match(/^([A-Z]{2,4}\d{1,4}[A-Z]?)/)?.[1] ?? null;
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
	return t.scheduled ?? t.estimated ?? t.actual;
}
function earliestUnix(a, b) {
	if (a == null) return b;
	if (b == null) return a;
	return Math.min(a, b);
}
function origKey(aware) {
	const u = seedUnix(aware.gateOut) ?? seedUnix(aware.takeoff) ?? Date.now() / 1e3;
	const day = (/* @__PURE__ */ new Date(u * 1e3)).toISOString().slice(0, 10);
	return `${aware.ident}|${aware.originIata ?? ""}|${aware.destIata ?? ""}|${day}`;
}
function rememberOrig(aware) {
	const key = origKey(aware);
	const prev = origByFlight.get(key);
	const next = {
		gateOut: earliestUnix(prev?.gateOut ?? null, seedUnix(aware.gateOut)),
		takeoff: earliestUnix(prev?.takeoff ?? null, seedUnix(aware.takeoff)),
		landing: earliestUnix(prev?.landing ?? null, seedUnix(aware.landing)),
		gateIn: earliestUnix(prev?.gateIn ?? null, seedUnix(aware.gateIn))
	};
	origByFlight.set(key, next);
	return next;
}
function slipMin(posted, orig) {
	if (posted == null || orig == null) return null;
	const m = Math.round((posted - orig) / 60);
	if (Math.abs(m) < 5) return 0;
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
function pickTaxi(start, end, explicit, typical) {
	if (start.actual && end.actual && end.actual > start.actual) {
		const m = Math.round((end.actual - start.actual) / 60);
		if (m >= 2 && m <= 180) return {
			min: m,
			kind: "measured"
		};
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
		if (c) wps.push(c);
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
	return {
		ident: String(f.ident ?? fallbackIdent),
		iataIdent: typeof f.iataIdent === "string" ? f.iataIdent : null,
		status: String(f.flightStatus ?? ""),
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
		takeoff: asTimes(f.takeoffTimes),
		landing: asTimes(f.landingTimes),
		gateOut: asTimes(f.gateDepartureTimes),
		gateIn: asTimes(f.gateArrivalTimes),
		inboundIdent,
		inbound,
		inboundFlightId,
		waypoints: wps,
		type: typeof ac.type === "string" ? ac.type : null,
		tail: typeof ac.tail === "string" ? ac.tail : typeof ac.registration === "string" ? ac.registration : typeof f.registration === "string" ? f.registration : null,
		hex: typeof f.hexid === "string" ? f.hexid : typeof ac.hexid === "string" ? ac.hexid : null,
		cancelled: Boolean(f.cancelled),
		averageDelaySec: {
			departure: asDelaySec(avg.departure),
			arrival: asDelaySec(avg.arrival)
		},
		typicalTaxiOutMin: hist.out,
		typicalTaxiInMin: hist.inn,
		filedTaxiOutMin: asTaxiMin(f.taxiOut),
		filedTaxiInMin: asTaxiMin(f.taxiIn)
	};
}
async function fetchAwarePage(url, fallbackIdent, withInbound, redirect = "follow") {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html"
		},
		redirect,
		signal: AbortSignal.timeout(9e3)
	});
	if (res.status >= 300 && res.status < 400) {
		const stub = stubAwareFromHistory(res.headers.get("location"), fallbackIdent);
		if (stub) return stub;
	}
	if (!res.ok) return null;
	const raw = (await res.text()).split("trackpollBootstrap = ")[1];
	if (!raw) return null;
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
		status: "arrived",
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
async function loadAware(callsign) {
	return cached(`aware:${callsign}`, 12e3, async () => {
		return fetchAwarePage(`https://www.flightaware.com/live/flight/${encodeURIComponent(callsign)}`, callsign, true);
	});
}
/** Specific FA instance (UAL2290-…), not the current flight using that number. */
function faInstanceId(flightId) {
	return String(flightId || "").replace(/:.*$/, "").trim();
}
async function loadAwareById(flightId) {
	const id = faInstanceId(flightId);
	if (!id) return null;
	const ident = identFromFa(id) || id;
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
		decoded: null,
		rawMetar: null,
		nas: null,
		category: "UNK"
	};
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
			const st = (await fetchJson(`https://external-api.faa.gov/asws/api/airport/status/${iata}`, 7e3)).Status?.[0];
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
async function loadHazards() {
	return cached("hazards", 22e3, async () => {
		const [gairmet, sigmet, pirep] = await Promise.all([
			safe(fetchJson("https://aviationweather.gov/api/data/gairmet?format=geojson").then((d) => d.features ?? []), []),
			safe(fetchJson("https://aviationweather.gov/api/data/airsigmet?format=geojson").then((d) => d.features ?? []), []),
			safe(fetchJson("https://aviationweather.gov/api/data/pirep?format=geojson&age=2").then((d) => d.features ?? []), [])
		]);
		return {
			gairmet,
			sigmet,
			pirep
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
	if (/arrival/i.test(type)) return `Inbound metering.${waitBit} ${reason}.`;
	return `Delay at arrival (${type}).${waitBit} ${reason}.`;
}
function chopRank(c) {
	return {
		smooth: 0,
		light: 1,
		moderate: 2,
		severe: 3
	}[c];
}
function worse(a, b) {
	return chopRank(a) >= chopRank(b) ? a : b;
}
function gairmetChop(hazard) {
	const h = hazard.toUpperCase();
	if (h === "TURB-HI") return "moderate";
	if (h === "TURB-LO") return "light";
	if (h === "LLWS") return "light";
	return null;
}
function pirepChop(tb) {
	const t = (tb ?? "").toUpperCase();
	if (!t) return null;
	if (t.includes("SEV") || t.includes("EXT")) return "severe";
	if (t.includes("MOD")) return "moderate";
	if (t.includes("LGT") || t.includes("LIGHT")) return "light";
	return null;
}
function letterOf(score) {
	const s = Math.max(22, Math.min(99, Math.round(score)));
	return s >= 85 ? "A" : s >= 72 ? "B" : s >= 58 ? "C" : s >= 44 ? "D" : "F";
}
function letterRank(g) {
	return {
		A: 4,
		B: 3,
		C: 2,
		D: 1,
		F: 0
	}[g];
}
function catRank(c) {
	if (c === "LIFR") return 3;
	if (c === "IFR") return 2;
	if (c === "MVFR") return 1;
	return 0;
}
function comfortOf(samples, hazards, dest, origin, progress, times, inboundStatus) {
	const chopPenalty = {
		smooth: 0,
		light: 9,
		moderate: 22,
		severe: 40
	};
	let weighted = 0;
	let dist = 0;
	for (let i = 1; i < samples.length; i++) {
		const d = Math.max(.01, haversineNm(samples[i - 1], samples[i]));
		const frac = samples[i].frac;
		let w = chopPenalty[samples[i].chop];
		if (frac >= .85) w *= 2.2;
		else if (frac >= .68) w *= 1.7;
		weighted += w * d;
		dist += d;
	}
	const rideChop = dist > 0 ? weighted / dist : 0;
	let score = 92 - rideChop;
	const ahead = samples.filter((s) => s.frac >= progress);
	const late = samples.filter((s) => s.frac >= Math.max(progress, .68));
	const arriving = progress >= 0.88;
	const worstAhead = arriving ? "smooth" : ahead.reduce((acc, s) => worse(acc, s.chop), "smooth");
	const lateWorst = arriving ? "smooth" : late.reduce((acc, s) => worse(acc, s.chop), "smooth");
	const convAhead = arriving ? false : ahead.some((s) => s.convective);
	const convAny = arriving ? false : samples.some((s) => s.convective);
	const taxiOut = times.taxiOutMin;
	const taxiIn = times.taxiInMin;
	const destDelayed = Boolean(dest.nas?.delayed);
	const originDelayed = Boolean(origin.nas?.delayed);
	const depDelay = times.delayMin ?? 0;
	const longTaxiOut = taxiOut != null && taxiOut >= 22;
	const longTaxiIn = taxiIn != null && taxiIn >= 14;
	const lateChop = lateWorst === "moderate" || lateWorst === "severe";
	const landWait = destDelayed || longTaxiIn;
	const hourSlip = depDelay >= 50;
	const inboundOpen = inboundStatus === "watching" || inboundStatus === "unknown" || inboundStatus === "airborne";
	const originLow = origin.category === "IFR" || origin.category === "LIFR";
	const destLow = dest.category === "IFR" || dest.category === "LIFR";
	if (lateWorst === "severe") score -= 16;
	else if (lateWorst === "moderate") score -= 10;
	else if (worstAhead === "moderate") score -= 5;
	else if (worstAhead === "severe") score -= 12;
	if (convAhead) score -= 5;
	if (destDelayed) score -= 9;
	if (originDelayed) score -= 4;
	if (destLow) score -= 4;
	if (originLow) score -= 4;
	else if (origin.category === "MVFR") score -= 1;
	if (dest.category === "MVFR") score -= 2;
	if (taxiOut != null && taxiOut >= 18) score -= Math.min(14, Math.round((taxiOut - 16) * .7));
	if (taxiIn != null && taxiIn >= 12) score -= Math.min(10, Math.round((taxiIn - 10) * .8));
	if (depDelay >= 20) score -= Math.min(18, Math.round((depDelay - 10) * .2));
	if (inboundOpen && (originDelayed || originLow)) score -= 4;
	if (lateChop && landWait && longTaxiOut) score = Math.min(score, 68);
	else if (lateChop && landWait) score = Math.min(score, 70);
	else if (lateChop || landWait || longTaxiOut) score = Math.min(score, 83);
	if (lateWorst === "severe" && landWait) score = Math.min(score, 56);
	if (hourSlip) score = Math.min(score, 68);
	else if (depDelay >= 25) score = Math.min(score, 83);
	if (originLow && destLow && lateChop) score = Math.min(score, 66);
	score = Math.max(22, Math.min(99, Math.round(score)));
	const grade = letterOf(score);
	const label = "";
	const bump = arriving ? null : ahead.find((s) => s.chop !== "smooth" && s.etaMin > 4);
	const reasons = [];
	if (inboundOpen && (originDelayed || originLow)) reasons.push(`Inbound isn’t at the gate yet, and ${origin.iata} weather/delays are already in the trip grade.`);
	if (bump) reasons.push(`${bump.chop === "light" ? "Light chop" : bump.chop === "moderate" ? "Moderate chop" : "Rough air"} shows up in about ${formatDuration(bump.etaMin)}${bump.note ? ` — ${bump.note}` : ""}.`);
	if (convAny) reasons.push("Storms clip part of this corridor. The rest can still be a sitting-still ride.");
	if (originLow) reasons.push(`Low weather at ${origin.iata} — inbound and the taxi both feel that.`);
	if (destLow) reasons.push(`Low weather into ${dest.iata} — arrival and the ramp.`);
	if (taxiOut != null && taxiOut >= 18) reasons.push(`Taxi out is posted around ${taxiOut} minutes${times.originGate ? ` from gate ${times.originGate}` : ""}.`);
	if (taxiIn != null && taxiIn >= 12) reasons.push(times.taxiInKind === "measured" ? `Taxi in after landing is ${taxiIn} minutes.` : `Estimated taxi in after landing is ${taxiIn} minutes.`);
	if (depDelay >= 15) reasons.push(`Posted push slipped about ${depDelay} minutes${times.pushWas ? ` off ${times.pushWas}` : ""}.`);
	if (destDelayed) reasons.push(`Arrival delay at ${dest.iata}: ${dest.nas.reason}.`);
	if (originDelayed) reasons.push(`Departure delay at ${origin.iata}: ${origin.nas.reason}.`);
	if (!reasons.length) reasons.push("Nothing ugly in the current advisories.");
	const ground = [];
	if (originLow) ground.push(`Low weather at ${origin.iata}`);
	if (depDelay >= 15) ground.push(`${depDelay} min ground delay`);
	else if (originDelayed) ground.push(`Ground delay at ${origin.iata}`);
	if (taxiOut != null && taxiOut >= 18) ground.push(`${taxiOut} min taxi out`);
	let ride = "Smooth ride";
	if (lateWorst === "severe" || worstAhead === "severe") ride = "Severe chop";
	else if (lateWorst === "moderate" || worstAhead === "moderate") ride = "Moderate chop";
	else if (bump?.chop === "light" || worstAhead === "light") ride = "Light chop";
	if (convAhead) ride = `${ride}. Storms on the path`;
	const arrival = [];
	if (destLow) arrival.push(`Low weather into ${dest.iata}`);
	if (destDelayed) arrival.push(`Ground delay at ${dest.iata}`);
	if (taxiIn != null && taxiIn >= 12) arrival.push(times.taxiInKind === "measured" ? `${taxiIn} min taxi in` : `Est. ${taxiIn} min taxi in`);
	const parts = [];
	if (ground.length) parts.push(`${ground.join(". ")}.`);
	parts.push(`${ride}.`);
	if (arrival.length) parts.push(`${arrival.join(". ")}.`);
	const why = parts.join(" ");
	return {
		score,
		grade,
		label,
		summary: why,
		reasons: reasons.slice(0, 5),
		trend: "steady",
		trendWhy: null
	};
}
var gradeHistory = /* @__PURE__ */ new Map();
function whyTrend(base, snap, trend) {
	if (chopRank(snap.lateChop) > chopRank(base.lateChop)) return "Chop got worse on the remaining path.";
	if (chopRank(snap.lateChop) < chopRank(base.lateChop)) return "The air along the path calmed down.";
	if (catRank(snap.destCat) > catRank(base.destCat)) return "Arrival weather got worse.";
	if (catRank(snap.destCat) < catRank(base.destCat)) return "Arrival weather improved.";
	if (catRank(snap.originCat) > catRank(base.originCat)) return "Departure weather got worse.";
	if (catRank(snap.originCat) < catRank(base.originCat)) return "Departure weather improved.";
	if (snap.destNas && !base.destNas) return "A delay program showed up at arrival.";
	if (!snap.destNas && base.destNas) return "The arrival delay program dropped off.";
	if (snap.originNas && !base.originNas) return "A delay program showed up at departure.";
	if (!snap.originNas && base.originNas) return "The departure delay program dropped off.";
	if (snap.depDelay - base.depDelay >= 12) return "The posted push slipped further.";
	if (base.depDelay - snap.depDelay >= 12) return "The posted push came back toward the original.";
	if ((snap.taxiOut ?? 0) - (base.taxiOut ?? 0) >= 8) return "Taxi out got longer.";
	if ((base.taxiOut ?? 0) - (snap.taxiOut ?? 0) >= 8) return "Taxi out shortened.";
	return trend === "down" ? "The whole-trip grade dropped on the latest update." : "The whole-trip grade improved on the latest update.";
}
function applyGradeTrend(key, snap, comfort) {
	const hist = (gradeHistory.get(key) ?? []).filter((h) => Date.now() - h.at < 15e5);
	const baseline = hist.find((h) => Date.now() - h.at >= 9e4) ?? hist[0];
	let trend = "steady";
	let trendWhy = null;
	if (baseline && snap.at - baseline.at >= 8e3) {
		const dScore = snap.score - baseline.score;
		const dLetter = letterRank(snap.grade) - letterRank(baseline.grade);
		if (dLetter < 0 || dScore <= -5) trend = "down";
		else if (dLetter > 0 || dScore >= 5) trend = "up";
		if (trend !== "steady") trendWhy = whyTrend(baseline, snap, trend);
	}
	hist.push(snap);
	if (hist.length > 12) hist.shift();
	gradeHistory.set(key, hist);
	return {
		...comfort,
		trend,
		trendWhy
	};
}
function ianaFromFa(raw) {
	if (!raw || typeof raw !== "string") return null;
	const t = raw.trim().replace(/^:+/, "");
	if (t.includes("/")) {
		try {
			Intl.DateTimeFormat("en-US", { timeZone: t }).format(new Date());
			return t;
		} catch {
			return null;
		}
	}
	const u = t.toUpperCase().replace(/[^A-Z]/g, "");
	const map = {
		EDT: "America/New_York",
		EST: "America/New_York",
		CDT: "America/Chicago",
		CST: "America/Chicago",
		MDT: "America/Denver",
		MST: "America/Denver",
		PDT: "America/Los_Angeles",
		PST: "America/Los_Angeles",
		AKDT: "America/Anchorage",
		AKST: "America/Anchorage",
		HST: "Pacific/Honolulu",
		HDT: "Pacific/Honolulu",
		BST: "Europe/London",
		GMT: "Europe/London",
		WEST: "Europe/Lisbon",
		CEST: "Europe/Paris",
		CET: "Europe/Paris",
		EEST: "Europe/Athens",
		EET: "Europe/Athens",
		JST: "Asia/Tokyo",
		KST: "Asia/Seoul",
		CSTCHINA: "Asia/Shanghai",
		IST: "Asia/Kolkata",
		GST: "Asia/Dubai",
		AEDT: "Australia/Sydney",
		AEST: "Australia/Sydney",
		AWST: "Australia/Perth",
		NZDT: "Pacific/Auckland",
		NZST: "Pacific/Auckland"
	};
	return map[u] ?? null;
}
function faAirportTz(obj) {
	if (!obj || typeof obj !== "object") return null;
	return ianaFromFa(obj.TZ ?? obj.tz ?? obj.timeZone ?? obj.timezone ?? obj.olson ?? null);
}
function tzFromCoord(lat, lon) {
	if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return "UTC";
	if (lat >= 18 && lat <= 23 && lon <= -154 && lon >= -162) return "Pacific/Honolulu";
	if (lat >= 51 && lat <= 72 && lon <= -129 && lon >= -172) return "America/Anchorage";
	if (lat >= 24 && lat <= 50 && lon <= -66 && lon >= -125) {
		if (lon > -85.5) return "America/New_York";
		if (lon > -104.5) return "America/Chicago";
		if (lat < 32 && lon > -114.8 && lon < -108.8) return "America/Phoenix";
		if (lon > -114.5) return "America/Denver";
		return "America/Los_Angeles";
	}
	if (lat >= 14 && lat < 24 && lon <= -86 && lon >= -118) return lon > -90 ? "America/Mexico_City" : "America/Tijuana";
	if (lat >= 10 && lat < 28 && lon <= -59 && lon >= -86) return "America/Puerto_Rico";
	if (lat >= 49 && lat <= 70 && lon <= -52 && lon >= -141) {
		if (lon > -90) return "America/Toronto";
		if (lon > -110) return "America/Winnipeg";
		if (lon > -120) return "America/Edmonton";
		return "America/Vancouver";
	}
	if (lat >= 49 && lat <= 61 && lon >= -11 && lon <= 2) return "Europe/London";
	if (lat >= 35 && lat <= 71 && lon >= -10 && lon < 12) return "Europe/Paris";
	if (lat >= 34 && lat <= 65 && lon >= 12 && lon <= 30) return "Europe/Athens";
	if (lat >= 22 && lat <= 42 && lon >= 25 && lon <= 45) return "Asia/Dubai";
	if (lat >= 8 && lat <= 37 && lon >= 68 && lon <= 90) return "Asia/Kolkata";
	if (lat >= 18 && lat <= 54 && lon >= 100 && lon <= 125) return "Asia/Shanghai";
	if (lat >= 30 && lat <= 46 && lon >= 129 && lon <= 146) return "Asia/Tokyo";
	if (lat >= -48 && lat <= -10 && lon >= 112 && lon <= 155) return lon < 129 ? "Australia/Perth" : "Australia/Sydney";
	if (lat >= -48 && lat <= -32 && lon >= 165 && lon <= 179) return "Pacific/Auckland";
	const hours = Math.round(lon / 15);
	const clamped = Math.max(-12, Math.min(14, hours));
	return clamped <= 0 ? `Etc/GMT+${-clamped}` : `Etc/GMT-${clamped}`;
}
function tzOf(field) {
	return field?.tz ?? airportByIcao(field?.icao)?.tz ?? airportByIata(field?.iata)?.tz ?? tzFromCoord(field?.lat, field?.lon);
}
function timesOf(aware, origin, dest) {
	if (!aware) return {
		push: null,
		takeoff: null,
		taxiOutMin: null,
		land: null,
		taxiInMin: null,
		taxiOutKind: null,
		taxiInKind: null,
		originGate: null,
		destGate: null,
		pushWas: null,
		takeoffWas: null,
		landWas: null,
		delayMin: null,
		arriveDelayMin: null,
		typicalDelayMin: null,
		pushed: false,
		airborne: false,
		pushUnix: null,
		takeoffUnix: null,
		landUnix: null,
		origPushUnix: null,
		origTakeoffUnix: null,
		origLandUnix: null
	};
	const otz = tzOf(origin);
	const dtz = tzOf(dest);
	const orig = rememberOrig(aware);
	const go = bestUnix(aware.gateOut);
	const to = bestUnix(aware.takeoff);
	const ld = bestUnix(aware.landing);
	bestUnix(aware.gateIn);
	const origGo = orig.gateOut;
	const origTo = orig.takeoff;
	const origLd = orig.landing;
	const delayMin = slipMin(go, origGo);
	const arriveDelayMin = slipMin(ld, origLd);
	const typicalSec = aware.averageDelaySec.departure;
	const typicalDelayMin = typicalSec != null && typicalSec >= 1200 ? Math.round(typicalSec / 60) : null;
	const late = (delayMin ?? 0) >= 5;
	const arriveLate = (arriveDelayMin ?? 0) >= 5;
	const taxiOut = pickTaxi(aware.gateOut, aware.takeoff, aware.filedTaxiOutMin, aware.typicalTaxiOutMin);
	const taxiIn = pickTaxi(aware.landing, aware.gateIn, aware.filedTaxiInMin, aware.typicalTaxiInMin);
	return {
		push: clockAt(go, otz),
		takeoff: clockAt(to, otz),
		taxiOutMin: taxiOut.min,
		land: clockAt(ld, dtz),
		taxiInMin: taxiIn.min,
		taxiOutKind: taxiOut.kind,
		taxiInKind: taxiIn.kind,
		originGate: aware.originGate,
		destGate: aware.destGate,
		pushWas: late ? clockAt(origGo, otz) : null,
		takeoffWas: late ? clockAt(origTo, otz) : null,
		landWas: arriveLate ? clockAt(origLd, dtz) : null,
		delayMin,
		arriveDelayMin,
		typicalDelayMin,
		pushed: Boolean(aware.gateOut.actual),
		airborne: Boolean(aware.takeoff.actual),
		pushUnix: go,
		takeoffUnix: to,
		landUnix: ld,
		origPushUnix: origGo,
		origTakeoffUnix: origTo,
		origLandUnix: origLd
	};
}
function inboundLanded(inb) {
	if (!inb) return false;
	if (inb.landing?.actual) return true;
	return /arrived|landed/i.test(inb.status ?? "");
}
function inboundAtGate(inb) {
	if (!inb) return false;
	if (inb.gateIn?.actual) return true;
	return /arrived/i.test(inb.status ?? "");
}
function inboundServesOrigin(inb, originIata) {
	if (!inb?.destIata || !originIata) return true;
	return inb.destIata === originIata;
}
function inboundLiveFits(live, inb, origin, landed) {
	if (!live || !origin) return false;
	if (inb && inboundAtGate(inb)) return false;
	if (inb && !inboundServesOrigin(inb, origin.iata)) return false;
	const here = {
		lat: live.lat,
		lon: live.lon
	};
	const onField = haversineNm(here, origin) < 12;
	if (landed || live.onGround) return onField;
	if (haversineNm(here, origin) < 90) return true;
	if (inb?.originLat != null && inb?.originLon != null) {
		return distanceToSegmentNm(here, {
			lat: inb.originLat,
			lon: inb.originLon
		}, origin) < 220;
	}
	return haversineNm(here, origin) < 280;
}
const inboundSnapByFlight = /* @__PURE__ */ new Map();
const landedLatch = /* @__PURE__ */ new Map();
const gateLatch = /* @__PURE__ */ new Map();
const pushLatch = /* @__PURE__ */ new Map();
function inboundSnapKey(aware, origin, dest, query) {
	if (aware) return origKey(aware);
	const day = new Date().toISOString().slice(0, 10);
	return `${String(query || "").toUpperCase()}|${origin?.iata ?? ""}|${dest?.iata ?? ""}|${day}`;
}
function rememberInboundSnap(key, patch) {
	const prev = inboundSnapByFlight.get(key) ?? {};
	if (prev.frozen) {
		const keep = { ...prev };
		if (!keep.gateUnix && patch.gateUnix) {
			keep.gateUnix = patch.gateUnix;
			keep.gateClock = patch.gateClock ?? keep.gateClock;
		}
		if (!keep.landUnix && patch.landUnix) {
			keep.landUnix = patch.landUnix;
			keep.landClock = patch.landClock ?? keep.landClock;
		}
		inboundSnapByFlight.set(key, keep);
		return keep;
	}
	const next = {
		ident: patch.ident ?? prev.ident ?? null,
		flightId: patch.flightId ?? prev.flightId ?? null,
		iataIdent: patch.iataIdent ?? prev.iataIdent ?? null,
		fromIata: patch.fromIata ?? prev.fromIata ?? null,
		fromCity: patch.fromCity ?? prev.fromCity ?? null,
		type: patch.type ?? prev.type ?? null,
		tail: patch.tail ?? prev.tail ?? null,
		hex: patch.hex ?? prev.hex ?? null,
		gate: patch.gate ?? prev.gate ?? null,
		landUnix: prev.landUnix ?? patch.landUnix ?? null,
		landClock: prev.landClock ?? patch.landClock ?? null,
		gateUnix: prev.gateUnix ?? patch.gateUnix ?? null,
		gateClock: prev.gateClock ?? patch.gateClock ?? null,
		taxiing: patch.taxiing ?? prev.taxiing ?? false,
		frozen: Boolean(prev.frozen)
	};
	if (patch.freeze || next.gateUnix) next.frozen = true;
	if (next.frozen) next.taxiing = false;
	inboundSnapByFlight.set(key, next);
	return next;
}
function snapFromAware(inb, originTz) {
	if (!inb) return {};
	const landUnix = inb.landing?.actual ?? null;
	const gateUnix = inb.gateIn?.actual ?? null;
	return {
		ident: inb.ident ?? null,
		iataIdent: inb.iataIdent ?? null,
		fromIata: inb.originIata ?? null,
		fromCity: inb.originCity ?? inb.originIata ?? null,
		type: inb.type ?? null,
		tail: inb.tail ?? null,
		hex: inb.hex ?? null,
		gate: inb.destGate ?? null,
		landUnix,
		landClock: clockAt(landUnix, originTz),
		gateUnix,
		gateClock: clockAt(gateUnix, originTz),
		freeze: Boolean(gateUnix)
	};
}
async function adsbByHex(hex) {
	const id = String(hex || "").toLowerCase();
	if (!/^[0-9a-f]{6}$/.test(id)) return null;
	return cached(`hex:${id}`, 12e3, async () => {
		return acList(await fetchJson(`https://opendata.adsb.fi/api/v2/hex/${encodeURIComponent(id)}`))[0] ?? null;
	});
}
function buildInbound(args) {
	const { live, ourTakeoffActual, ourGateOutActual, origin, inboundIdent, inboundAware, inboundLive, snap } = args;
	if (Boolean(ourTakeoffActual) || Boolean(live && !live.onGround)) return {
		status: "complete",
		headline: "You’re on this aircraft",
		detail: "",
		watch: []
	};
	const cs = (snap?.ident || inboundIdent || inboundAware?.ident || "").toUpperCase();
	const iata = displayIata(cs || "INB", snap?.iataIdent ?? inboundAware?.iataIdent ?? null);
	const fromCity = snap?.fromCity ?? inboundAware?.originCity ?? inboundAware?.originIata ?? snap?.fromIata ?? null;
	const type = snap?.type ?? inboundLive?.type ?? inboundAware?.type ?? null;
	const originTz = tzOf(origin);
	const gate = snap?.gate ?? inboundAware?.destGate ?? null;
	const landUnix = snap?.landUnix ?? inboundAware?.landing?.actual ?? null;
	const gateInActual = snap?.gateUnix ?? inboundAware?.gateIn?.actual ?? null;
	const gateEst = inboundAware ? bestUnix(inboundAware.gateIn) : snap?.gateUnix ?? null;
	const landClock = snap?.landClock ?? clockAt(landUnix, originTz);
	const gateClock = snap?.gateClock ?? clockAt(gateInActual ?? (snap?.frozen ? gateEst : null), originTz);
	const gateEtaClock = clockAt(gateEst, originTz);
	const now = Date.now() / 1e3;
	const here = inboundLive ? {
		lat: inboundLive.lat,
		lon: inboundLive.lon
	} : null;
	let distNm = here ? haversineNm(here, origin) : 0;
	if (!here && inboundAware && bestUnix(inboundAware.landing) && bestUnix(inboundAware.landing) > now) distNm = (bestUnix(inboundAware.landing) - now) / 60 * 7.5;
	const parked = Boolean(inboundLive && inboundLive.onGround && (inboundLive.gsKt ?? 0) < 5 && distNm < 3);
	const taxiingLive = Boolean(inboundLive && inboundLive.onGround && (inboundLive.gsKt ?? 0) >= 5 && distNm < 12);
	const frozen = Boolean(snap?.frozen);
	const atGate = frozen || Boolean(gateInActual) || Boolean(ourGateOutActual && (landUnix || inboundLanded(inboundAware)));
	const arrived = Boolean(landUnix) || inboundLanded(inboundAware) || Boolean(inboundLive && inboundLive.onGround && distNm < 12) || taxiingLive;
	const inboundAirborne = !arrived && (Boolean(inboundLive && !inboundLive.onGround) || Boolean(inboundAware?.takeoff.actual && !inboundAware.landing.actual) || /airborne/i.test(inboundAware?.status ?? ""));
	let status;
	if (atGate) status = "complete";
	else if (arrived) status = "at_field";
	else if (inboundAirborne) status = "airborne";
	else if (cs) status = "watching";
	else status = "unknown";
	if (status === "unknown") {
		if (live && live.onGround && haversineNm({ lat: live.lat, lon: live.lon }, origin) < 12) {
			return {
				status: live.phase === "taxi" ? "at_field" : "complete",
				headline: live.phase === "taxi" ? "Your aircraft is taxiing in" : "Your aircraft is on the field",
				detail: live.phase === "taxi" ? `${live.registration ?? "The tail"} is taxiing at ${origin.iata}. Watching it to the gate.` : `${live.registration ?? "The tail"} is parked at ${origin.iata}. Inbound is done.`,
				watch: []
			};
		}
		return {
			status: "unknown",
			headline: "Inbound not posted yet",
			detail: `No inbound aircraft posted for this flight yet. Ground delays at ${origin.iata} still apply.`,
			watch: []
		};
	}
	const taxiPosted = inboundAware && inboundAware.gateIn.estimated && inboundAware.landing.estimated ? Math.max(4, (inboundAware.gateIn.estimated - inboundAware.landing.estimated) / 60) : 10;
	let taxiMin = null;
	if (status === "complete" && landUnix && gateInActual && gateInActual > landUnix) taxiMin = Math.round((gateInActual - landUnix) / 60);
	else if (status === "at_field" && landUnix) taxiMin = Math.max(1, Math.round((now - landUnix) / 60));
	let etaMin = 0;
	if (status === "airborne") {
		const gs = inboundLive?.gsKt && inboundLive.gsKt > 80 ? inboundLive.gsKt : 420;
		etaMin = (here ? distNm / gs * 60 : inboundAware && bestUnix(inboundAware.landing) ? Math.max(0, (bestUnix(inboundAware.landing) - now) / 60) : 0) + taxiPosted;
	} else if (status === "at_field") {
		etaMin = gateEst && gateEst > now ? Math.max(1, (gateEst - now) / 60) : Math.max(2, taxiPosted - (taxiMin ?? 0));
	}
	const watch = [{
		callsign: cs || inboundLive?.hex || "inbound",
		iata,
		type,
		distNm,
		etaMin,
		altFt: inboundLive?.altFt ?? null,
		from: fromCity,
		gate,
		clock: gateClock ?? gateEtaClock,
		landClock,
		gateClock: atGate ? gateClock : null,
		taxiing: status === "at_field",
		locked: status === "complete",
		taxiMin
	}];
	if (status === "airborne") return {
		status,
		headline: `${iata} is inbound to ${origin.iata}`,
		detail: `${fromCity ? `From ${fromCity}. ` : ""}${type ? `${type}. ` : ""}${formatNm(distNm)} out, about ${formatDuration(Math.max(1, etaMin - taxiPosted))} to the field${gate ? `, then taxi to posted gate ${gate}` : ""}${gateEtaClock ? ` — at the gate around ${gateEtaClock}` : ""}.`,
		watch
	};
	if (status === "at_field") return {
		status,
		headline: `${iata} is taxiing in`,
		detail: `Landed${landClock ? ` at ${landClock}` : ` at ${origin.iata}`}${fromCity ? ` from ${fromCity}` : ""}. Taxiing${gate ? ` to posted gate ${gate}` : " to the gate"}${etaMin ? ` — about ${formatDuration(etaMin)}` : parked ? " — should be at the gate any minute" : ""}${taxiMin != null ? ` (${taxiMin} min since landing)` : ""}.`,
		watch
	};
	if (status === "complete") return {
		status,
		headline: "Inbound is at the gate",
		detail: "",
		watch
	};
	return {
		status,
		headline: `Inbound is ${iata}`,
		detail: `${fromCity ? `Coming in from ${fromCity}` : "Inbound posted"}${gate ? ` to posted gate ${gate}` : ""}. Not on the radio yet${gateEtaClock ? ` — at the gate around ${gateEtaClock}` : ""}.`,
		watch
	};
}
function currentStageOf(args) {
	const { live, remainingNm, dest, origin, ourTakeoffActual, ourLandingActual, ourLanded, inboundStatus, pushed, faAirborne } = args;
	if (ourLanded || ourLandingActual) return "gate";
	const atOrigin = Boolean(live && origin && haversineNm({ lat: live.lat, lon: live.lon }, origin) < 10);
	const rolling = Boolean(live?.onGround && atOrigin && ((live.gsKt ?? 0) >= 8 || live.phase === "taxi"));
	if (rolling) return "taxi";
	if (live && !live.onGround) {
		const dDest = dest ? haversineNm({ lat: live.lat, lon: live.lon }, dest) : 999;
		if (live.phase === "approach" || remainingNm < 40 || live.altFt != null && live.altFt < 8e3 && (live.vertFpm ?? 0) < 0) return "arrival";
		if (dDest < 8 && live.onGround) return "gate";
		return "ride";
	}
	if (faAirborne || Boolean(ourTakeoffActual)) {
		if (remainingNm < 8) return "gate";
		if (remainingNm < 40) return "arrival";
		return "ride";
	}
	if (atOrigin && live?.onGround) return "push";
	if (inboundStatus === "airborne" || inboundStatus === "watching" || inboundStatus === "at_field") return "inbound";
	if (inboundStatus === "complete" || pushed) return "push";
	return "inbound";
}
async function hydrateField(base) {
	const [{ metar }, nas] = await Promise.all([loadMetar(base.icao), loadNas(base.iata)]);
	const decoded = metar ? decodeMetar(metar) : null;
	const wd = typeof metar?.wdir === "number" ? metar.wdir : Number(metar?.wdir);
	return {
		...base,
		decoded,
		rawMetar: metar?.rawOb ?? null,
		nas,
		category: decoded?.category ?? "UNK",
		windDir: Number.isFinite(wd) ? wd : null,
		windKt: typeof metar?.wspd === "number" ? metar.wspd : null
	};
}
function rampWx(decoded) {
	const wx = (decoded?.wx ?? "").toUpperCase();
	if (!wx || /NO SIGNIFICANT/.test(wx)) return null;
	if (/\bTS\b|VCTS|LTG|LIGHTNING|\bFC\b|\+FC|\bSQ\b/.test(wx)) return "Thunderstorms on the field.";
	if (/\bSN\b|BLSN|DRSN|SNOW/.test(wx)) return "Snow on the field.";
	if (/\bFZ|\bPL\b|\bGR\b|\bGS\b|ICE/.test(wx)) return "Icing precip on the field.";
	return null;
}
function buildStages(args) {
	const { live, origin, dest, current, remainingNm, etaMin, comfort, inbound, samples, times, taxiQueue } = args;
	const conv = samples.find((s) => s.convective);
	const order = [
		"inbound",
		"push",
		"taxi",
		"ride",
		"arrival",
		"gate"
	];
	const idx = order.indexOf(current);
	const state = (id) => {
		const i = order.indexOf(id);
		if (i < idx) return "done";
		if (i === idx) return "now";
		return "next";
	};
	const pushWatch = [];
	if (origin.nas?.delayed) pushWatch.push(nasCopy(origin.nas, "origin"));
	if ((times.delayMin ?? 0) < 12 && (times.typicalDelayMin ?? 0) >= 25) pushWatch.push(`This flight often leaves about ${times.typicalDelayMin} minutes late — even when the posted push still looks on time.`);
	if (origin.decoded?.category === "IFR" || origin.decoded?.category === "LIFR") pushWatch.push("Low weather here often means de-ice, holds, and a slow taxi even when the inbound is on time.");
	const inboundWatchouts = inbound.status === "complete"
		? []
		: inbound.status === "at_field"
			? []
			: inbound.watch.length > 0
				? []
				: ["Aircraft isn’t broadcasting yet. Most light up 20–40 minutes before they get to the gate."];
	const rideWatch = [];
	const arrivalWatch = [];
	if (dest.decoded?.category === "IFR" || dest.decoded?.category === "LIFR") arrivalWatch.push("Low ceilings on arrival = holding, a long final, and a tired taxi. Budget extra.");
	const gateWatch = [];
	const ramp = rampWx(dest.decoded);
	if (ramp) gateWatch.push(ramp);
	const pushed = Boolean(times.pushed || times.airborne || current === "taxi" || current === "ride" || current === "arrival" || current === "gate");
	const taxiingNow = Boolean(taxiQueue?.status === "taxi" || (live?.onGround && (live.gsKt ?? 0) >= 8));
	const inboundTitle = inbound.status === "complete" ? "Inbound is at the gate" : inbound.status === "at_field" ? "Inbound is taxiing in" : inbound.status === "airborne" ? "Inbound to the field" : "The inbound aircraft";
	const arrivalBody = dest.nas?.delayed ? `${times.land ? `Landing around ${times.land}. ` : ""}${nasCopy(dest.nas, "dest")}` : times.land ? (times.arriveDelayMin ?? 0) >= 15 && times.landWas ? `Landing around ${times.land}, about ${times.arriveDelayMin} minutes later than ${times.landWas}.` : `Landing around ${times.land}.` : `Into ${dest.city}.`;
	const gateBody = "";
	const rideBody = live ? `${formatNm(remainingNm)} still to run, about ${formatDuration(etaMin)}.` : `Once you’re up, ${formatNm(remainingNm)} on the filed path.`;
	return {
		push: {
			state: state("push"),
			title: pushed ? "Pushback" : `At the gate · ${origin.iata}`,
			body: pushed ? (times.push ? `Pushback at ${times.push}.` : "Pushback.") : (times.push ? `Push ${times.push}.` : ""),
			watchouts: []
		},
		taxi: {
			state: state("taxi"),
			title: taxiQueue?.depRunway ? `Taxi · Rwy ${taxiQueue.depRunway}` : current === "ride" || current === "arrival" || current === "gate" ? "Taxied" : `Taxi at ${origin.iata}`,
			body: taxiingNow
				? (taxiQueue?.place != null ? `Number ${taxiQueue.place} for the runway.` : "Taxiing.")
				: current === "ride" || current === "arrival" || current === "gate"
					? (times.taxiOutKind === "measured" && times.taxiOutMin != null ? `${times.taxiOutMin} min taxi out.` : "")
					: "",
			watchouts: taxiQueue?.status === "taxi" && taxiQueue.ahead >= 6 ? ["A long line for the runway."] : []
		},
		inbound: {
			state: state("inbound"),
			title: inbound.status === "complete" ? "Plane is at the gate" : inboundTitle,
			body: inbound.detail,
			watchouts: inboundWatchouts
		},
		ride: {
			state: state("ride"),
			title: live ? `${formatNm(remainingNm)} remaining` : `To ${dest.iata}`,
			body: rideBody,
			watchouts: rideWatch.slice(0, 3)
		},
		arrival: {
			state: state("arrival"),
			title: `Into ${dest.iata}`,
			body: arrivalBody,
			watchouts: arrivalWatch.slice(0, 3)
		},
		gate: {
			state: state("gate"),
			title: times.destGate ? `Gate ${times.destGate}` : "At the gate",
			body: gateBody,
			watchouts: gateWatch.slice(0, 3)
		}
	};
}
function timeFracOf(aware) {
	const to = aware?.takeoff?.actual;
	if (!to) return 0;
	if (aware.landing?.actual) return 1;
	const ld = aware.landing?.estimated ?? aware.landing?.scheduled;
	const now = Date.now() / 1e3;
	if (!ld || ld <= to) return Math.max(0.04, Math.min(0.92, (now - to) / 7200));
	return Math.max(0, Math.min(1, (now - to) / (ld - to)));
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
async function buildStory(query) {
	const parsed = parseFlightQuery(query);
	if (!parsed) throw new Error("Try a flight number like AA 1 or UA 2814");
	const [rawAc, aware, route] = await Promise.all([
		parsed.registration ? safe(adsbByReg(parsed.registration), null) : safe(adsbByCallsign(parsed.callsign), null),
		safe(loadAware(parsed.callsign), null),
		safe(loadRoute(parsed.callsign), null)
	]);
	const liveCs = (rawAc?.flight ?? "").trim().toUpperCase() || parsed.callsign;
	let live = rawAc ? toLive(rawAc) : null;
	let origin = fieldFromKnown(aware?.originIata ?? null, aware?.originIcao ?? null, aware?.originLat ?? null, aware?.originLon ?? null, aware?.originName ?? null, aware?.originCity ?? null, aware?.originTz ?? null) ?? fieldFromAdsbdb(route?.origin);
	let dest = fieldFromKnown(aware?.destIata ?? null, aware?.destIcao ?? null, aware?.destLat ?? null, aware?.destLon ?? null, aware?.destName ?? null, aware?.destCity ?? null, aware?.destTz ?? null) ?? fieldFromAdsbdb(route?.destination);
	if (!origin && live) origin = nearestKnown(live);
	if (!origin) origin = {
		icao: "KORD",
		iata: "ORD",
		name: "O'Hare",
		city: "Chicago",
		lat: 41.9786,
		lon: -87.9048,
		tz: "America/Chicago",
		decoded: null,
		rawMetar: null,
		nas: null,
		category: "UNK"
	};
	if (!dest) dest = {
		icao: "KLAX",
		iata: "LAX",
		name: "Los Angeles",
		city: "Los Angeles",
		lat: 33.9425,
		lon: -118.408,
		tz: "America/Los_Angeles",
		decoded: null,
		rawMetar: null,
		nas: null,
		category: "UNK"
	};
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
	const landKey = aware ? origKey(aware) : `${parsed.callsign}|${origin.iata}|${dest.iata}`;
	if ((faLanded && !flyingAway) || onFieldNow) landedLatch.set(landKey, Date.now() / 1e3);
	let ourLanded = Boolean(landedLatch.get(landKey));
	if (ourLanded && live && !live.onGround) {
		if (dLiveDest > 20) live = null;
		else live = { ...live, onGround: true, altFt: 0, gsKt: Math.min(live.gsKt ?? 0, 25), phase: (live.gsKt ?? 0) >= 8 ? "taxi" : "parked" };
	}
	if (live && origin && dest) {
		const dOrig = haversineNm({ lat: live.lat, lon: live.lon }, origin);
		const dDest = haversineNm({ lat: live.lat, lon: live.lon }, dest);
		if (ourLanded && dDest > 20) live = null;
		else if (Boolean(aware?.takeoff?.actual) && live.onGround && dOrig < 12 && dDest > 40) live = null;
		else if (!ourLanded && !aware?.takeoff?.actual && dDest < 12 && dOrig > 20) live = null;
	}
	if (!live && origin && !aware?.takeoff?.actual) {
		const near = await safe(adsbAround(origin.lat, origin.lon, 8), []);
		const vars = new Set(callsignVariants(parsed.callsign));
		const match = near.find((a) => vars.has(String(a.flight ?? "").trim().toUpperCase()));
		if (match) live = toLive(match);
	}
	if (!live && origin && dest) {
		const extra = [];
		if (aware?.hex) extra.push(safe(adsbByHex(aware.hex), null));
		if (aware?.tail) extra.push(safe(adsbByReg(aware.tail), null));
		const extras = extra.length ? await Promise.all(extra) : [];
		for (const raw of extras) {
			const cand = raw ? toLive(raw) : null;
			if (!cand) continue;
			const dOrig = haversineNm({ lat: cand.lat, lon: cand.lon }, origin);
			const dDest = haversineNm({ lat: cand.lat, lon: cand.lon }, dest);
			if (ourLanded && dDest < 20) { live = cand; break; }
			if (!ourLanded && aware?.takeoff?.actual && !(cand.onGround && dOrig < 12)) { live = cand; break; }
			if (!aware?.takeoff?.actual && dOrig < 20) { live = cand; break; }
		}
	}
	if (live && dest && !live.onGround && ((live.altFt ?? 0) > 1500 || (live.gsKt ?? 0) > 80) && haversineNm({ lat: live.lat, lon: live.lon }, dest) > 6) {
		if (landedLatch.get(landKey)) {
			live = null;
			ourLanded = true;
		}
	}
	let inboundAware = aware?.inbound ?? null;
	const inboundIdent = inboundAware?.ident ?? aware?.inboundIdent ?? null;
	const inboundFlightId = aware?.inboundFlightId ?? null;
	const snapKey = inboundSnapKey(aware, origin, dest, query);
	const existingSnap = inboundSnapByFlight.get(snapKey);
	const inboundLocked = Boolean(existingSnap?.frozen);
	const inboundFetch = inboundLocked
		? Promise.resolve(null)
		: inboundFlightId
			? safe(loadAwareById(inboundFlightId), null)
			: inboundIdent && !existingSnap
				? safe(loadAware(inboundIdent), null)
				: Promise.resolve(inboundAware);
	const [hydOrigin, hydDest, hazardsPack, inboundFetched] = await Promise.all([
		hydrateField(origin),
		hydrateField(dest),
		loadHazards(),
		inboundFetch
	]);
	origin = hydOrigin;
	dest = hydDest;
	if (inboundFetched) inboundAware = inboundFetched;
	if (inboundAware && !inboundServesOrigin(inboundAware, origin.iata)) inboundAware = null;
	const originTz = tzOf(origin);
	if (inboundAware) rememberInboundSnap(snapKey, {
		...snapFromAware(inboundAware, originTz),
		flightId: inboundFlightId
	});
	const landed = inboundLanded(inboundAware) || Boolean(inboundSnapByFlight.get(snapKey)?.landUnix);
	const atGateFa = inboundAtGate(inboundAware);
	const ourAirborne = Boolean(live && !live.onGround) || /airborne|en.?route|climbed/i.test(aware?.status ?? "") || (Boolean(aware?.takeoff.actual) && !(live && live.onGround));
	let inboundRaw = null;
	if (!inboundLocked && !atGateFa) {
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
		if (parkedLong || atGateFa || aware?.gateOut?.actual) {
			const gateUnix = inboundAware?.gateIn?.actual ?? (parkedLong ? nowUnix : null);
			rememberInboundSnap(snapKey, {
				gateUnix,
				gateClock: clockAt(gateUnix, originTz),
				freeze: true,
				taxiing: false
			});
		}
	} else if (!inboundLocked && (atGateFa || aware?.gateOut?.actual && landed)) {
		const gateUnix = inboundAware?.gateIn?.actual ?? null;
		rememberInboundSnap(snapKey, {
			...snapFromAware(inboundAware, originTz),
			gateUnix,
			gateClock: clockAt(gateUnix, originTz),
			freeze: true
		});
	}
	const snap = inboundSnapByFlight.get(snapKey) ?? null;
	const start = {
		lat: origin.lat,
		lon: origin.lon
	};
	const end = {
		lat: dest.lat,
		lon: dest.lon
	};
	const hex = live ? (live.hex || "").toLowerCase() : null;
	const filed = await loadFiledPath(!ourLanded && ourAirborne ? hex : null, start, end, !ourLanded && ourAirborne ? live : null, aware?.takeoff?.actual ?? aware?.takeoff?.estimated ?? null, aware?.waypoints ?? []);
	let path;
	let pathSource;
	if (filed.source === "track" && filed.points.length >= 8) {
		path = filed.points;
		pathSource = "track";
	} else if (aware && aware.waypoints.length >= 4) {
		const wps = aware.waypoints.slice();
		if (haversineNm(start, wps[0]) > 18) wps.unshift(start);
		if (haversineNm(wps[wps.length - 1], end) > 8) wps.push(end);
		path = densifyPath(downsampleNm(wps, 22), 48);
		pathSource = "filed";
	} else {
		path = filed.points.length >= 2 ? filed.points : greatCirclePoints(start, end, 18);
		pathSource = filed.source;
	}
	const totalNm = Math.max(1, polylineLengthNm(path));
	let remainingNm;
	let progress;
	if (ourLanded) {
		progress = 1;
		remainingNm = 0;
	} else if (live) {
		const along = progressAlongPath(path, {
			lat: live.lat,
			lon: live.lon
		});
		progress = along.frac;
		remainingNm = along.remainingNm;
	} else if (aware?.takeoff?.actual) {
		progress = timeFracOf(aware);
		remainingNm = (1 - progress) * totalNm;
	} else {
		progress = 0;
		remainingNm = totalNm;
	}
	const etaMin = remainingNm / (live?.gsKt && live.gsKt > 80 ? live.gsKt : 450) * 60;
	const heading = ourLanded
		? initialBearing(path[Math.max(0, path.length - 2)] ?? start, end)
		: live?.track ?? initialBearing(start, end);
	const hazards = [];
	let sinceFix = 0;
	const samples = path.map((p, i) => {
		const prev = path[i - 1];
		const step = prev ? haversineNm(prev, p) : 0;
		sinceFix += step;
		const isFix = i > 0 && i < path.length - 1 && sinceFix >= 85;
		if (isFix) sinceFix = 0;
		const distNm = path.slice(0, i + 1).reduce((acc, cur, idx) => {
			if (idx === 0) return 0;
			return acc + haversineNm(path[idx - 1], cur);
		}, 0);
		const frac = distNm / totalNm;
		const remainingHere = Math.max(0, totalNm - distNm);
		let chop = "smooth";
		let cloud = false;
		let convective = false;
		const notes = [];
		const arriving = remainingNm < 50 || Boolean(live && !live.onGround && (live.altFt ?? 9e4) < 14000);
		const skipHi = arriving || remainingHere < 55 || frac >= 0.86 || (live?.altFt != null && live.altFt < 18000);
		for (const f of hazardsPack.gairmet) {
			if (!pointInGeoJson(p.lat, p.lon, f.geometry ?? null)) continue;
			const hazard = String(f.properties?.hazard ?? "");
			const due = String(f.properties?.dueTo ?? "");
			const c = gairmetChop(hazard);
			if (c) {
				if (hazard === "TURB-HI" && skipHi) continue;
				chop = worse(chop, c);
				notes.push(hazard === "TURB-HI" ? "High-altitude turbulence airmet" : "Low-level turbulence airmet");
				hazards.push({
					id: `g-${hazard}-${i}`,
					kind: "turb",
					chop: c,
					label: hazard === "TURB-HI" ? "High turbulence airmet" : "Low turbulence airmet",
					detail: due || hazard,
					remaining: frac >= progress,
					lat: p.lat,
					lon: p.lon
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
			if (!pointInGeoJson(p.lat, p.lon, f.geometry ?? null)) continue;
			const hz = String(f.properties?.hazard ?? f.properties?.airSigmetType ?? "").toUpperCase();
			if (hz.includes("CONVECTIVE") || hz.includes("TS")) {
				convective = true;
				chop = worse(chop, "moderate");
				notes.push("Convective SIGMET — thunderstorms");
				hazards.push({
					id: `s-${i}`,
					kind: "convective",
					chop: "moderate",
					label: "Thunderstorm SIGMET",
					detail: String(f.properties?.rawAirSigmet ?? "Convective SIGMET").slice(0, 160),
					remaining: frac >= progress,
					lat: p.lat,
					lon: p.lon
				});
			} else if (hz.includes("TURB")) {
				if (skipHi) continue;
				chop = worse(chop, "moderate");
				notes.push("Turbulence SIGMET");
			}
		}
		const etaHere = frac <= progress ? 0 : (frac - progress) / Math.max(.01, 1 - progress) * etaMin;
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
	for (const f of hazardsPack.pirep) {
		const coords = f.geometry?.type === "Point" ? f.geometry.coordinates : null;
		if (!coords || coords.length < 2) continue;
		const lon = coords[0];
		const lat = coords[1];
		const c = pirepChop(String(f.properties?.tbInt1 ?? f.properties?.turbulence ?? f.properties?.tb ?? f.properties?.rawOb ?? ""));
		if (!c) continue;
		let nearest = Infinity;
		for (const s of samples) {
			const d = haversineNm({
				lat,
				lon
			}, s);
			if (d < nearest) nearest = d;
		}
		if (nearest > 90) continue;
		if (remainingNm < 50) continue;
		const raw = String(f.properties?.rawOb ?? "PIREP");
		hazards.push({
			id: `p-${lat.toFixed(2)}-${lon.toFixed(2)}`,
			kind: "pirep",
			chop: c,
			label: `${c} chop reported`,
			detail: raw.slice(0, 140),
			remaining: true,
			lat,
			lon
		});
		for (const s of samples) if (haversineNm({
			lat,
			lon
		}, s) < 80) s.chop = worse(s.chop, c);
	}
	const seenH = /* @__PURE__ */ new Set();
	const uniqHazards = hazards.filter((h) => {
		const k = `${h.kind}:${h.label}:${h.chop}`;
		if (seenH.has(k)) return false;
		seenH.add(k);
		return true;
	});
	let times = timesOf(aware, origin, dest);
	const leftGate = Boolean(
		live &&
		live.onGround &&
		!ourLanded &&
		origin &&
		haversineNm({ lat: live.lat, lon: live.lon }, origin) < 10 &&
		(live.gsKt ?? 0) >= 8
	);
	if (ourAirborne && !times.airborne) {
		times = { ...times, airborne: true };
	}
	if (leftGate && !times.pushed) {
		const now = Date.now() / 1e3;
		const otz = tzOf(origin);
		const pushUnix = times.pushUnix != null && times.pushUnix <= now + 120 ? Math.min(times.pushUnix, now) : now;
		const origPush = times.origPushUnix ?? pushUnix;
		const delayMin = slipMin(pushUnix, origPush);
		times = {
			...times,
			pushed: true,
			pushUnix,
			push: clockAt(pushUnix, otz),
			delayMin,
			pushWas: delayMin != null && delayMin >= 5 ? clockAt(origPush, otz) : times.pushWas
		};
	}
	if (times.pushed || leftGate || times.airborne || (live && !live.onGround)) {
		const stamped = aware?.gateOut?.actual ?? times.pushUnix ?? pushLatch.get(landKey) ?? null;
		if (stamped) pushLatch.set(landKey, stamped);
		else if (leftGate) pushLatch.set(landKey, Date.now() / 1e3);
	}
	const latchedPush = pushLatch.get(landKey);
	if (latchedPush && !times.pushed) {
		const otz = tzOf(origin);
		const origPush = times.origPushUnix ?? latchedPush;
		const delayMin = slipMin(latchedPush, origPush);
		times = {
			...times,
			pushed: true,
			pushUnix: latchedPush,
			push: clockAt(latchedPush, otz),
			delayMin,
			pushWas: delayMin != null && delayMin >= 5 ? clockAt(origPush, otz) : times.pushWas
		};
	}
	if (!ourLanded && (ourAirborne || (live && !live.onGround)) && etaMin > 2) {
		const landUnix = Date.now() / 1e3 + etaMin * 60;
		times = {
			...times,
			landUnix,
			land: clockAt(landUnix, tzOf(dest))
		};
	}
	if (times.taxiOutKind !== "measured") {
		const wheelsUp = Boolean(live && !live.onGround) || (Boolean(aware?.takeoff?.actual) && !(live && live.onGround && origin && haversineNm({ lat: live.lat, lon: live.lon }, origin) < 12));
		if (wheelsUp) {
			const pushU = aware?.gateOut?.actual ?? times.pushUnix;
			const toU = aware?.takeoff?.actual ?? times.takeoffUnix;
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
			aware?.gateIn?.actual ||
			(live && live.onGround && (live.gsKt ?? 0) < 8 && dGate < 6)
		)
	);
	if (parkedAtGate) {
		const now = Date.now() / 1e3;
		const prev = gateLatch.get(landKey) ?? {};
		const landUnix = aware?.landing?.actual ?? prev.landUnix ?? times.landUnix ?? landedLatch.get(landKey) ?? now;
		const gateUnix = aware?.gateIn?.actual ?? prev.gateUnix ?? now;
		const pushUnix = aware?.gateOut?.actual ?? prev.pushUnix ?? times.pushUnix;
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
				land: clockAt(g.landUnix, tzOf(dest))
			};
		}
	}
	const inbound = buildInbound({
		live,
		ourTakeoffActual: aware?.takeoff.actual ?? null,
		ourGateOutActual: aware?.gateOut.actual ?? null,
		origin,
		inboundIdent: inboundAware?.ident ?? inboundIdent,
		inboundAware,
		inboundLive,
		snap
	});
	const lateWorst = samples.filter((s) => s.frac >= Math.max(progress, .68)).reduce((acc, s) => worse(acc, s.chop), "smooth");
	let comfort = comfortOf(samples, uniqHazards, dest, origin, progress, times, inbound.status);
	comfort = applyGradeTrend(`${query.toUpperCase().replace(/[^A-Z0-9]/g, "")}|${origin.iata}|${dest.iata}`, {
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
	const current = currentStageOf({
		live,
		remainingNm,
		dest,
		origin,
		ourTakeoffActual: aware?.takeoff.actual ?? null,
		ourLandingActual: aware?.landing.actual ?? null,
		ourLanded,
		inboundStatus: inbound.status,
		pushed: Boolean(times.pushed || leftGate),
		faAirborne: ourAirborne
	});
	const taxiQueue = await loadTaxiQueue({
		origin,
		dest,
		live,
		ourHex: live?.hex ?? aware?.hex ?? null,
		ourAirborne,
		pushed: Boolean(times.pushed || leftGate)
	});
	const airline = airlineOf(liveCs) ?? route?.airline?.name ?? null;
	let aircraft = live;
	if (ourLanded) {
		if (live && haversineNm({ lat: live.lat, lon: live.lon }, dest) < 20) aircraft = live;
		else {
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
	} else if (!aircraft && inboundLive && (inbound.status === "at_field" || inbound.status === "complete")) aircraft = inboundLive;
	else if (!aircraft && aware?.takeoff?.actual) {
		const p = pointAtFrac(path, progress) ?? start;
		const type = aware?.type ?? null;
		aircraft = {
			hex: aware?.hex ?? "",
			registration: aware?.tail ?? null,
			type,
			typeName: airframeOf(type)?.name ?? type,
			year: null,
			operator: null,
			lat: p.lat,
			lon: p.lon,
			altFt: null,
			gsKt: null,
			track: heading,
			vertFpm: null,
			onGround: false,
			phase: "cruise"
		};
	} else if (!aircraft && (aware?.type || aware?.tail)) {
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
	return {
		fetchedAt: Date.now(),
		query,
		callsign: liveCs,
		iata: displayIata(liveCs, parsed.iata ?? aware?.iataIdent ?? route?.callsign_iata ?? null),
		airline,
		live: Boolean(live),
		currentStage: current,
		aircraft,
		origin,
		dest,
		route: {
			totalNm,
			remainingNm,
			flownNm: Math.max(0, totalNm - remainingNm),
			etaMin,
			progress,
			heading,
			source: pathSource,
			samples
		},
		hazards: uniqHazards.slice(0, 12),
		comfort,
		inbound,
		times,
		taxiQueue,
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
			taxiQueue
		})
	};
}
function nearestKnown(live) {
	let best = null;
	let bestD = Infinity;
	for (const ap of Object.values(AIRPORT_BY_ICAO)) {
		const d = haversineNm({
			lat: live.lat,
			lon: live.lon
		}, ap);
		if (d < bestD) {
			bestD = d;
			best = {
				icao: ap.icao,
				iata: ap.iata,
				name: ap.name,
				city: ap.city,
				lat: ap.lat,
				lon: ap.lon,
				tz: ap.tz,
				decoded: null,
				rawMetar: null,
				nas: null,
				category: "UNK"
			};
		}
	}
	return best;
}
export async function loadFlightStory(query) {
	try {
		return await cached(`story38:${query.toUpperCase().replace(/[^A-Z0-9]/g, "")}`, 12e3, () => buildStory(query));
	} catch (err) {
		const msg = err instanceof Error && err.message && err.name !== "AbortError" ? err.message : "Could not load that flight. Try again.";
		throw new Error(msg);
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
			if (picked.size >= 8) break;
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
