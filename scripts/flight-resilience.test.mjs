import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { readFlightResume, resumeFromStory } from "../src/lib/flight-resume.ts";

// Exercise the actual server aggregator with controlled upstream responses.
// No live provider traffic or deployment credentials are used by this suite.
let directory, moduleNumber = 0, server, now, upstream, aircraft, requests;
const realFetch = globalThis.fetch;
const realNow = Date.now;
const initialNow = Date.parse("2026-09-13T17:00:00Z");
const stamp = (scheduled, actual = null) => ({ scheduled, estimated: null, actual });
function resume() {
  const sec = now / 1000;
  return {
    version: 1, callsign: "SWA1111", ident: "SWA1111", confirmedAt: now - 60_000,
    originIcao: "KMDW", destIcao: "KMSP", originGate: "B10", destGate: "H3",
    originIata: "MDW", destIata: "MSP", originLat: 41.7868, originLon: -87.7522,
    destLat: 44.8848, destLon: -93.2223, destTz: "America/Chicago", destCity: "Minneapolis",
    gateOut: stamp(sec - 600), takeoff: stamp(sec - 300), landing: stamp(sec + 3600), gateIn: stamp(sec + 4200),
    tail: "N12345", hex: "a12345", type: "B738", waypoints: [],
  };
}
function page(context) {
  const record = {
    ident: context.ident, iataIdent: "WN1111", aircraft: { tail: context.tail, type: context.type }, hexid: context.hex,
    origin: { icao: context.originIcao, iata: context.originIcao.slice(1), gate: context.originGate, coord: [context.originLon, context.originLat] },
    destination: { icao: context.destIcao, iata: context.destIcao.slice(1), gate: context.destGate, coord: [context.destLon, context.destLat] },
    gateDepartureTimes: context.gateOut, takeoffTimes: context.takeoff,
    landingTimes: context.landing, gateArrivalTimes: context.gateIn,
  };
  return new Response("trackpollBootstrap = " + JSON.stringify({ flights: { SWA1111: record } }) + ";", { status: 200 });
}
before(async () => {
  directory = await mkdtemp(resolve("node_modules/.inbound-feed-test-"));
  await build({ configFile: false, logLevel: "silent", build: {
    ssr: resolve("src/lib/story.server.ts"), outDir: directory,
    rollupOptions: { output: { entryFileNames: "story.mjs" } },
  } });
});
beforeEach(async () => {
  now = initialNow;
  upstream = 402;
  requests = [];
  aircraft = { hex: "a12345", flight: "SWA1111", r: "N12345", t: "B738", lat: 41.787, lon: -87.752,
    gs: 0, alt_baro: "ground", track: 310, seen: 1, seen_pos: 1 };
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.hostname === "www.flightaware.com") return upstream === 200 ? page(resume()) : new Response(null, { status: upstream });
    if (/adsb\.fi|adsb\.lol|airplanes\.live/.test(url.hostname) && !url.pathname.includes("trace_")) return Response.json({ ac: aircraft ? [aircraft] : [] });
    if (url.hostname === "aviationweather.gov") {
      if (url.pathname.endsWith("/metar")) return Response.json([{ icaoId: url.searchParams.get("ids"), rawOb: "KMDW 131651Z 27008KT 10SM CLR 24/14 A3000", visib: "10+", clouds: [], wspd: 8, wdir: 270, temp: 24, dewp: 14 }]);
      if (url.pathname.endsWith("/taf")) return Response.json([]);
      return Response.json({ features: [] });
    }
    if (url.hostname === "external-api.faa.gov") return Response.json({ Status: [] });
    if (url.hostname === "api.adsbdb.com") return Response.json({ response: { flightroute: {
      origin: { icao_code: "KORD", iata_code: "ORD", latitude: 41.98, longitude: -87.9 },
      destination: { icao_code: "KLAX", iata_code: "LAX", latitude: 33.94, longitude: -118.4 },
    } } });
    if (url.pathname.includes("trace_")) return Response.json({ timestamp: now / 1000, trace: [] });
    throw new Error("Unexpected test upstream: " + url);
  };
  server = await import(pathToFileURL(join(directory, "story.mjs")).href + "?case=" + ++moduleNumber);
  await globalThis.__pgBootstrapPromise__;
  const pg = await globalThis.__pgliteInstance__;
  await pg.exec("delete from flight_phase_state");
});
after(async () => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("schedule outage resilience", { concurrency: false }, () => {
  it("keeps an overdue departure at the gate until fresh movement, then detects takeoff", async () => {
    const saved = resume();
    const first = await server.loadFlightStory("WN1111", { resume: saved, fresh: true });
    assert.equal(first.currentStage, "origin_gate");
    assert.equal(first.times.pushed, false);
    assert.equal(first.times.airborne, false);
    assert.equal(first.schedule.status, "saved");
    assert.equal(first.schedule.confirmedAt, saved.confirmedAt);
    assert.equal(first.origin.icao, "KMDW");
    assert.equal(first.dest.icao, "KMSP");
    assert.match(first.origin.rawMetar, /131651Z/);
    assert.ok(requests.some(url => url.includes("/gairmet")));

    now += 10_000;
    aircraft = { ...aircraft, lat: 41.788, lon: -87.751, gs: 10 };
    const moving = await server.loadFlightStory("WN1111", { resume: first.resume, fresh: true });
    assert.equal(moving.currentStage, "push");
    assert.equal(moving.times.pushed, true);
    assert.notEqual(moving.times.pushKind, "actual");
    assert.equal(moving.times.airborne, false);
    assert.equal(moving.schedule.confirmedAt, saved.confirmedAt);

    now += 10_000;
    aircraft = { ...aircraft, lat: 41.789, lon: -87.75, gs: 10 };
    const taxiing = await server.loadFlightStory("WN1111", { resume: moving.resume, fresh: true });
    assert.equal(taxiing.currentStage, "taxi");

    now += 180_000;
    aircraft = { ...aircraft, lat: 42.2, lon: -88.3, alt_baro: 12000, gs: 300, baro_rate: 1500 };
    const flying = await server.loadFlightStory("WN1111", { resume: taxiing.resume, fresh: true });
    assert.equal(flying.currentStage, "ride");
    assert.equal(flying.times.airborne, true);
    assert.equal(flying.live, true);
    assert.equal(flying.schedule.confirmedAt, saved.confirmedAt);
    assert.ok(flying.fetchedAt > first.fetchedAt);
  });
  it("does not invent a new flight's route from the ADS-B route database", async () => {
    await assert.rejects(server.loadFlightStory("WN1111"), /HTTP 402/);
  });
  it("rejects another flight, expired context, and future actual events", async () => {
    await assert.rejects(server.loadFlightStory("WN1112", { resume: resume() }), /HTTP 402/);
    await assert.rejects(server.loadFlightStory("WN1111", { resume: { ...resume(), confirmedAt: now - 3 * 3600_000 } }), /HTTP 402/);
    const invalid = resume();
    invalid.takeoff.actual = now / 1000 + 600;
    await assert.rejects(server.loadFlightStory("WN1111", { resume: invalid }), /HTTP 402/);
    assert.equal(readFlightResume({ ...resume(), confirmedAt: now + 3600_000 }, "WN1111"), undefined);
    assert.equal(readFlightResume({ ...resume(), destIcao: "../../metadata" }, "WN1111"), undefined);
    assert.equal(readFlightResume({ ...resume(), destIcao: "KZZZ", destIata: "ZZZ", destLat: Infinity }, "WN1111"), undefined);
  });
  it("does not present a fresh flight stage when both schedule and position are unavailable", async () => {
    aircraft = null;
    await assert.rejects(server.loadFlightStory("WN1111", { resume: resume() }), /no fresh position/);
  });
  it("never shares device context through the normal story cache and resumes the provider when it recovers", async () => {
    const saved = resume();
    saved.gateOut.actual = now / 1000 - 90;
    const partial = await server.loadFlightStory("WN1111", { resume: saved });
    assert.equal(partial.schedule.status, "saved");
    assert.equal(partial.currentStage, "push");
    await assert.rejects(server.loadFlightStory("WN1111"), /HTTP 402/);
    now += 61_000;
    upstream = 200;
    const fresh = await server.loadFlightStory("WN1111", { resume: saved, fresh: true });
    assert.equal(fresh.schedule.status, "current");
    assert.equal(fresh.schedule.confirmedAt, now);
    assert.equal(fresh.resume.confirmedAt, now);
    assert.equal(fresh.times.pushed, false);
    // A later failure can use the server's own recent verified schedule too.
    now += 10_000;
    upstream = 402;
    const bridged = await server.loadFlightStory("WN1111", { fresh: true });
    assert.equal(bridged.schedule.status, "saved");
    assert.equal(bridged.schedule.confirmedAt, fresh.schedule.confirmedAt);
  });
  it("isolates different saved legs even with the same flight number", async () => {
    const a = await server.loadFlightStory("WN1111", { resume: resume() });
    const b = await server.loadFlightStory("WN1111", { resume: { ...resume(), destIcao: "KDEN", destIata: "DEN" } });
    assert.equal(a.dest.icao, "KMSP");
    assert.equal(b.dest.icao, "KDEN");
  });
  it("expires the original schedule even while partial refreshes keep succeeding", async () => {
    const saved = resume();
    const partial = await server.loadFlightStory("WN1111", { resume: saved });
    now += 60 * 60_000;
    const later = await server.loadFlightStory("WN1111", { resume: resumeFromStory(partial, "WN1111"), fresh: true });
    assert.equal(later.schedule.confirmedAt, saved.confirmedAt);
    now += 61 * 60_000;
    assert.equal(resumeFromStory(later, "WN1111"), undefined);
    await assert.rejects(server.loadFlightStory("WN1111", { resume: later.resume, fresh: true }), /HTTP 402/);
  });
  it("migrates legacy saved data without upgrading inferred event times to reported actuals", async () => {
    upstream = 200;
    const story = await server.loadFlightStory("WN1111");
    delete story.resume;
    delete story.schedule;
    story.times.pushKind = "actual";
    const legacy = resumeFromStory(story, "WN1111");
    assert.equal(legacy.confirmedAt, story.fetchedAt);
    assert.equal(legacy.gateOut.actual, null);
    assert.equal(legacy.gateOut.estimated, story.times.pushUnix);
    assert.equal(resumeFromStory(story, "AA1111"), undefined);
  });
});
