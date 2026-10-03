import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FlightStory, RouteSample } from "./types.ts";
import { scheduledTimes } from "./scheduled-times.ts";
import { formatClockTime, timeKindLabel } from "./presentation-time.ts";
import { upcomingWeatherEvents, eventWeatherCopy, weatherOutlook } from "./weather-presentation.ts";
import { rideOutlook } from "./traveler.ts";
import { agoLabel } from "./format.ts";

function story(times: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { times, ...extra } as unknown as FlightStory;
}
const empty = { pushUnix: null, takeoffUnix: null, landUnix: null };

describe("schedule-only presentation memory", () => {
  for (const kind of ["actual", "estimated"]) it(`never remembers ${kind}-only push, takeoff, or landing as scheduled`, () => {
    assert.deepEqual(scheduledTimes(story({ pushKind: kind, pushUnix: 1000, takeoffKind: kind, takeoffUnix: 2000, landKind: kind, landUnix: 3000 })), empty);
  });
  it("remembers original schedules, and explicitly scheduled posted values", () => {
    assert.deepEqual(scheduledTimes(story({ origPushUnix: 1000, takeoffKind: "scheduled", takeoffUnix: 2000, origLandUnix: 3000 })), { pushUnix: 1000, takeoffUnix: 2000, landUnix: 3000 });
  });
  it("uses explicit stamps to reject unscheduled server orig* seeds, including matching actual values", () => {
    const stamp = { scheduled: null, estimated: null, actual: 3000 };
    assert.deepEqual(scheduledTimes(story({ origPushUnix: 3000, origTakeoffUnix: 3000, origLandUnix: 3000 }, { resume: { gateOut: stamp, takeoff: stamp, landing: stamp } })), empty);
  });
  it("hides unproven orig* seeds when the server schedule cannot supply explicit stamps", () => {
    assert.deepEqual(scheduledTimes(story({ origLandUnix: 3000, landKind: "actual", landUnix: 3000 }, { schedule: { status: "current" } })), empty);
  });
  it("keeps a known schedule across provider gaps without letting an earlier estimate replace it", () => {
    const previous = { pushUnix: 1000, takeoffUnix: 2000, landUnix: 3000 };
    assert.deepEqual(scheduledTimes(story({ pushKind: "actual", pushUnix: 1100, takeoffKind: "estimated", takeoffUnix: 1900, landKind: "actual", landUnix: 2900 }), previous), previous);
  });
  it("accepts a schedule equal to an actual when explicitly proven, including landing without pushback", () => {
    assert.equal(scheduledTimes(story({ landKind: "actual", landUnix: 3000 }, { resume: { landing: { scheduled: 3000 } } })).landUnix, 3000);
  });
  it("rejects nonfinite values", () => {
    assert.deepEqual(scheduledTimes(story({ origPushUnix: NaN, origTakeoffUnix: Infinity, landKind: "scheduled", landUnix: Infinity })), empty);
  });
});

describe("shared time labels and local clocks", () => {
  it("uses the reported kind rather than guessing from equal clock times", () => {
    for (const kind of ["scheduled", "estimated", "actual"]) {
      const label = timeKindLabel(kind);
      assert.equal(timeKindLabel(kind, "gate arrival"), `${label} gate arrival`);
      assert.equal(timeKindLabel(kind, "landing"), `${label} landing`);
    }
    assert.equal(timeKindLabel(null, "gate arrival"), "Gate arrival");
    assert.equal(timeKindLabel("unknown"), "");
  });
  it("adds the device-local abbreviation to update clocks, including daylight saving and UTC", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/Chicago";
      assert.equal(formatClockTime(Date.UTC(2026, 9, 3, 14, 6)), "9:06 AM CDT");
      assert.equal(formatClockTime(Date.UTC(2026, 0, 3, 15, 6)), "9:06 AM CST");
      process.env.TZ = "UTC";
      assert.equal(formatClockTime(Date.UTC(2026, 9, 3, 14, 6)), "2:06 PM UTC");
      assert.match(agoLabel(Date.now() - 240_000, false), /^Data from 4 min ago$/);
    } finally { if (before == null) delete process.env.TZ; else process.env.TZ = before; }
  });
});

describe("next weather before strongest weather", () => {
  const sample = (frac: number, etaMin: number, chop: RouteSample["chop"], extra = {}) => ({ frac, etaMin, lat: 30 + frac, lon: -120 + frac, chop, convective: false, cloud: false, note: null, ...extra }) as RouteSample;
  const samples = [sample(0, 0, "smooth"), sample(0.1, 11, "light"), sample(0.2, 21, "smooth"), sample(0.6, 228, "moderate"), sample(0.7, 248, "smooth"), sample(1, 300, "smooth")];
  it("leads with light at 11 minutes, then moderate at 3h 48m, using the map/Weather copy", () => {
    const events = upcomingWeatherEvents(samples, 0);
    const lines = weatherOutlook(events, "Honolulu");
    assert.deepEqual(lines, ["Light bumps possible in about 11 min.", "Moderate bumps later, about 3h 48m ahead."]);
    assert.ok(lines[0].startsWith(eventWeatherCopy(events[0], "Honolulu").mapLabel));
    assert.ok(lines[1].startsWith(eventWeatherCopy(events[1], "Honolulu").mapLabel));
    const outlook = rideOutlook({ route: { samples, progress: 0 }, weatherCoverage: { failedSources: [] }, dest: { city: "Honolulu" } } as unknown as FlightStory);
    assert.match(outlook, /^Light bumps possible in about 11 min\.\nModerate bumps later, about 3h 48m ahead\./);
  });
  it("removes passed events, includes an event starting now, and does not mutate samples", () => {
    const snapshot = structuredClone(samples);
    assert.match(weatherOutlook(upcomingWeatherEvents(samples.map(s => s.frac === 0.1 ? { ...s, etaMin: 0 } : s), 0.1), "Honolulu")[0], /Light bumps possible around now/);
    assert.equal(upcomingWeatherEvents(samples, 0.3)[0].key, "turbulence:moderate");
    assert.deepEqual(samples, snapshot);
  });
  it("does not invent a stronger secondary event for equal or weaker weather", () => {
    const events = upcomingWeatherEvents(samples.map(s => ({ ...s, chop: s.chop === "moderate" ? "light" : s.chop })), 0);
    assert.equal(weatherOutlook(events, "Honolulu").length, 1);
    assert.deepEqual(weatherOutlook([], "Honolulu"), []);
  });
});
