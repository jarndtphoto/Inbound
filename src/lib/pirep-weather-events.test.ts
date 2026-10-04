import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlightStory, RouteSample } from "./types.ts";
import { routeWeatherEvents } from "./weather-events.ts";
import { eventWeatherCopy, eventWeatherSource, flightWeatherSummary, pilotReportTiming, weatherOutlook } from "./weather-presentation.ts";
import { rideOutlook } from "./traveler.ts";

const now = Date.UTC(2026, 9, 4, 3);
const report = { id: "report-1", chop: "moderate" as const, observedAt: now - 60 * 60_000, detail: "MOD turbulence reported" };
function point(frac: number, overrides: Partial<RouteSample> = {}): RouteSample {
  return { lat: 40 + frac, lon: -90 + frac, frac, etaMin: frac * 480, distNm: frac * 1000,
    remainingNm: (1 - frac) * 1000, chop: "smooth", cloud: false, convective: false, note: null, fix: false, ...overrides };
}
function story(samples: RouteSample[]): FlightStory {
  return { route: { samples, progress: 0 }, weatherCoverage: { failedSources: [] } } as unknown as FlightStory;
}

test("a fresh report creates an observation event without changing the forecast samples", () => {
  const samples = [point(0), point(.75, { pilotReports: [report] }), point(.79), point(1)];
  const original = structuredClone(samples), events = routeWeatherEvents(samples, 0, 0, now);
  assert.equal(events.length, 1); assert.equal(events[0].source, "observed");
  assert.equal(eventWeatherSource(events[0]), "Reported by another aircraft");
  assert.deepEqual(eventWeatherCopy(events[0], "Honolulu"), { headline: "Reported by another aircraft", body: null, mapLabel: "Moderate bumps reported" });
  assert.deepEqual(samples, original);
  assert.equal(flightWeatherSummary(story(samples), now), "Smooth now · moderate bumps reported ahead");
  assert.match(weatherOutlook(events, "Honolulu").join(" "), /You'll pass this area in about 6h/);
  assert.doesNotMatch(weatherOutlook(events, "Honolulu").join(" "), /possible|duration/);
});

test("untimed, future and more-than-two-hour-old reports create no event", () => {
  for (const observedAt of [undefined, NaN, now + 1, now - 2 * 60 * 60_000 - 1]) {
    const samples = [point(.75, { pilotReports: [{ ...report, observedAt: observedAt as number }] }), point(1)];
    assert.equal(routeWeatherEvents(samples, 0, 0, now).length, 0);
    assert.equal(pilotReportTiming(observedAt, now), null);
  }
  assert.match(pilotReportTiming(now - 2 * 60 * 60_000, now, "UTC")!, /about 2 hr ago/);
});

test("a moderate report stays separate from a light advisory's intensity and title", () => {
  const samples = [point(0), point(.75, { chop: "light", note: "Turbulence AIRMET", pilotReports: [report] }), point(.79), point(1)];
  const [event] = routeWeatherEvents(samples, 0, 0, now);
  assert.equal(event.source, "advisory"); assert.equal(event.strongestChop, "light");
  assert.equal(event.key, "turbulence:light"); assert.deepEqual(event.pilotReports, [report]);
  assert.equal(eventWeatherSource(event), "Aviation weather advisory");
  assert.notEqual(eventWeatherCopy(event, "Honolulu").headline, "Reported by another aircraft");
  assert.ok(Math.abs(event.endEtaMin - event.startEtaMin - 19.2) < .001, "independent advisory retains its forecast span");
  assert.equal(flightWeatherSummary(story(samples), now), "Smooth now · moderate bumps reported ahead");
});

test("reports deduplicate within an event and expire from a saved story at display time", () => {
  const samples = [point(0), point(.75, { pilotReports: [report, report] }), point(.76, { pilotReports: [report] }), point(1)];
  assert.deepEqual(routeWeatherEvents(samples, 0, 0, now)[0].pilotReports, [report]);
  assert.equal(flightWeatherSummary(story(samples), now + 61 * 60_000), "Smooth now");
  assert.equal(routeWeatherEvents(samples, 0, 0, now + 61 * 60_000).length, 0);
});

test("a later forecast or advisory prevents the whole-flight summary from claiming smooth conditions", () => {
  const samples = [point(0), point(.75, { chop: "moderate", note: "Turbulence SIGMET" }), point(1)];
  assert.equal(flightWeatherSummary(story(samples), now), "Smooth now · moderate bumps possible later");
  assert.equal(eventWeatherSource(routeWeatherEvents(samples, 0, 0, now)[0]), "Official aviation weather alert");
  const clouds = [point(0), point(.75, { cloud: true }), point(1)];
  assert.equal(flightWeatherSummary(story(clouds), now), "Smooth now · clouds possible later");
});

test("observation clock uses the viewer's timezone independently of encounter ETA", () => {
  assert.equal(pilotReportTiming(report.observedAt, now, "America/Chicago"), "Reported 9:00 PM CDT · about 1 hr ago");
  assert.equal(pilotReportTiming(report.observedAt, now, "UTC"), "Reported 2:00 AM UTC · about 1 hr ago");
});

test("the summary respects entry weather and retains a stronger condition later in one continuous event", () => {
  const flight = story([point(.1, { chop: "light", etaMin: -15 }), point(.3, { chop: "moderate", etaMin: 5 }), point(.5, { etaMin: 25 })]);
  flight.route.progress = .25;
  assert.equal(flightWeatherSummary(flight, now), "Light bumps possible now · moderate bumps possible later");
});

test("an observation inside an ongoing advisory retains its own area ETA", () => {
  const flight = story([point(.1, { chop: "light", etaMin: 0 }), point(.4, { chop: "light", etaMin: 30, pilotReports: [report] }), point(.5, { etaMin: 40 })]);
  flight.route.progress = .1;
  assert.equal(flightWeatherSummary(flight, now), "Light bumps possible now · moderate bumps reported ahead");
});

test("non-route-advisory feed failures keep the normal current ride wording", () => {
  const flight = story([point(0, { chop: "light" }), point(1)]);
  flight.weatherCoverage = { failedSources: ["Pilot reports", "Storm forecasts", "Local advisories"] };
  assert.equal(flightWeatherSummary(flight, now), "Light bumps possible now");
  assert.match(rideOutlook(flight), /Projected ride is currently choppy/);
  assert.doesNotMatch(rideOutlook(flight), /current ride is uncertain/);
});

test("a failed turbulence or storm advisory feed makes the current ride uncertain", () => {
  for (const source of ["Turbulence advisories", "Storm advisories"]) {
    const flight = story([point(0, { chop: "moderate" }), point(1)]);
    flight.weatherCoverage = { failedSources: ["Pilot reports", source] };
    assert.equal(flightWeatherSummary(flight, now), "Current ride uncertain");
    assert.match(rideOutlook(flight), /Weather coverage is incomplete, so the current ride is uncertain/);
    assert.doesNotMatch(rideOutlook(flight), /currently choppy|Storms are possible near the current route/);
  }
});
