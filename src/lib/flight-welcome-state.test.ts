import test from "node:test";
import assert from "node:assert/strict";
import type { CompiledBrief } from "./brief-copy.ts";
import {
  dismissWelcomeSummary,
  shouldOpenWelcomeSummary,
  welcomeLegKey,
} from "./flight-welcome-state.ts";
import type { FlightStory } from "./types.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function story(overrides: Partial<FlightStory> = {}): FlightStory {
  return {
    stateKey: "leg:v1:UAL203|2026-10-03|OGG|ORD",
    fetchedAt: Date.UTC(2026, 9, 4, 2),
    query: "UA203",
    callsign: "UAL203",
    iata: "UA203",
    origin: { iata: "OGG", icao: "PHOG", tz: "Pacific/Honolulu" },
    dest: { iata: "ORD", icao: "KORD", tz: "America/Chicago" },
    times: { push: null, takeoff: null, taxiOutMin: null, land: null, taxiInMin: null, originGate: null, destGate: null },
    ...overrides,
  } as FlightStory;
}

function brief(log: CompiledBrief["log"] = []): CompiledBrief {
  return { lead: "Current flight information.", aircraft: null, why: null, snap: {}, segments: [], log } as unknown as CompiledBrief;
}

test("a persisted fallback dismissal migrates to the canonical leg across restore", () => {
  const storage = memoryStorage();
  const fallback = story({ stateKey: "leg:unvalidated:UAL203|OGG|ORD|2026-10-04" });
  assert.equal(shouldOpenWelcomeSummary(fallback, brief(), { storage }), true);
  dismissWelcomeSummary(fallback, brief(), fallback.fetchedAt, { storage });
  const current = story({ times: { pushUnix: Date.UTC(2026, 9, 4, 2) / 1000, pushKind: "scheduled" } as FlightStory["times"] });

  for (const restored of [
    { ...current },
    { ...current, fetchedAt: current.fetchedAt + 60_000, route: { etaMin: 300 } },
    { ...current, flightId: "provider-id-after-handoff" },
  ]) {
    assert.equal(shouldOpenWelcomeSummary(restored as FlightStory, brief(), { storage }), false);
    assert.equal(welcomeLegKey(restored as FlightStory), welcomeLegKey(current));
  }

  const tomorrow = story({ stateKey: "leg:v1:UAL203|2026-10-04|OGG|ORD", schedule: { status: "current", confirmedAt: current.fetchedAt, serviceDate: "2026-10-04" } });
  assert.equal(shouldOpenWelcomeSummary(tomorrow, brief(), { storage }), true);
});

test("Welcome dismissal is isolated by flight, date, and route", () => {
  const storage = memoryStorage();
  const current = story();
  dismissWelcomeSummary(current, brief(), current.fetchedAt, { storage });
  assert.equal(shouldOpenWelcomeSummary(story({ query: "UA204", callsign: "UAL204", iata: "UA204", stateKey: "leg:v1:UAL204|2026-10-03|OGG|ORD" }), brief(), { storage }), true);
  assert.equal(shouldOpenWelcomeSummary(story({ stateKey: "leg:v1:UAL203|2026-10-04|OGG|ORD" }), brief(), { storage }), true);
  assert.equal(shouldOpenWelcomeSummary(story({ stateKey: "leg:v1:UAL203|2026-10-03|OGG|DEN", dest: { iata: "DEN", icao: "KDEN", tz: "America/Denver" } as FlightStory["dest"] }), brief(), { storage }), true);
});

test("A genuinely new curated Briefing event can reopen Welcome, but routine poll churn cannot", () => {
  const storage = memoryStorage();
  const current = story();
  const initial = brief([{ at: current.fetchedAt - 60_000, kind: "stage", text: "In flight" }]);
  dismissWelcomeSummary(current, initial, current.fetchedAt, { storage });

  assert.equal(shouldOpenWelcomeSummary({ ...current, fetchedAt: current.fetchedAt + 30_000, route: { etaMin: 299 } } as FlightStory, initial, { storage }), false);
  const changed = brief([...initial.log, { at: current.fetchedAt + 60_000, kind: "schedule", text: "Arrival gate changed to B17" }]);
  assert.equal(shouldOpenWelcomeSummary(current, changed, { storage }), true);
  dismissWelcomeSummary(current, changed, current.fetchedAt + 60_001, { storage });
  assert.equal(shouldOpenWelcomeSummary(current, changed, { storage }), false);
});

test("routine stage progression never reopens a dismissed Welcome", () => {
  const storage = memoryStorage();
  const current = story();
  const push = brief([{ at: current.fetchedAt, kind: "stage", text: "Pushback" }]);
  dismissWelcomeSummary(current, push, current.fetchedAt, { storage });

  for (const text of ["Taxiing out", "In flight", "Final approach", "Landed at ORD at 11:04 AM CDT", "Taxiing in", "At the gate"]) {
    const next = brief([...push.log, { at: current.fetchedAt + 60_000, kind: "stage", text }]);
    assert.equal(shouldOpenWelcomeSummary(current, next, { storage }), false, text);
  }

  const measuredTaxi = brief([...push.log, { at: current.fetchedAt + 60_000, kind: "schedule", text: "Taxi out was 18 minutes" }]);
  assert.equal(shouldOpenWelcomeSummary(current, measuredTaxi, { storage }), false);
});

test("a genuine new passenger alert still reopens a dismissed Welcome", () => {
  const storage = memoryStorage();
  const current = story();
  dismissWelcomeSummary(current, brief(), current.fetchedAt, { storage });

  const weather = brief([{ at: current.fetchedAt + 60_000, kind: "weather", text: "Turbulence easing — ride looks smooth" }]);
  assert.equal(shouldOpenWelcomeSummary(current, weather, { storage }), true);
  dismissWelcomeSummary(current, weather, current.fetchedAt + 60_001, { storage });

  const gate = brief([...weather.log, { at: current.fetchedAt + 120_000, kind: "schedule", text: "Arrival gate changed to B17" }]);
  assert.equal(shouldOpenWelcomeSummary(current, gate, { storage }), true);
});

test("the dismissal baseline prevents its current events reopening, but a repeated event is new", () => {
  const storage = memoryStorage();
  const current = story();
  const initial = brief([{ at: current.fetchedAt - 120_000, kind: "delay", text: "Delay at the arrival airport — wind" }]);
  dismissWelcomeSummary(current, initial, current.fetchedAt, { storage });
  assert.equal(shouldOpenWelcomeSummary(current, initial, { storage }), false);

  const repeated = brief([{ at: current.fetchedAt + 13 * 60_000, kind: "delay", text: "Delay at the arrival airport — wind" }]);
  assert.equal(shouldOpenWelcomeSummary(current, repeated, { storage }), true);
});

test("the same asynchronously compiled alert does not reopen after a fast close", () => {
  const storage = memoryStorage();
  const current = story();
  const atClose = brief([{ at: current.fetchedAt, kind: "delay", text: "Delay at the departure airport — wind" }]);
  dismissWelcomeSummary(current, atClose, current.fetchedAt, { storage });
  const pendingCompile = brief([{ at: current.fetchedAt + 1000, kind: "delay", text: "Delay at the departure airport — wind" }]);
  assert.equal(shouldOpenWelcomeSummary(current, pendingCompile, { storage }), false);
});

test("blocked or malformed browser storage fails soft and keeps this-tab dismissal memory", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const current = story({ query: "UA999", callsign: "UAL999", iata: "UA999", stateKey: "leg:v1:UAL999|2026-10-03|OGG|ORD" });
  assert.equal(shouldOpenWelcomeSummary(current, brief(), { storage: broken }), true);
  dismissWelcomeSummary(current, brief(), current.fetchedAt, { storage: broken });
  assert.equal(shouldOpenWelcomeSummary(current, brief(), { storage: broken }), false);

  const quota = { getItem: () => null, setItem() { throw new Error("quota"); } };
  const quotaFlight = story({ query: "UA997", callsign: "UAL997", iata: "UA997", stateKey: "leg:v1:UAL997|2026-10-03|OGG|ORD" });
  dismissWelcomeSummary(quotaFlight, brief(), quotaFlight.fetchedAt, { storage: quota });
  assert.equal(shouldOpenWelcomeSummary(quotaFlight, brief(), { storage: quota }), false);

  const malformed = { getItem: () => JSON.stringify({ bad: { dismissedAt: 1, seen: {} } }), setItem() {} };
  assert.equal(shouldOpenWelcomeSummary(story({ query: "UA998", callsign: "UAL998", iata: "UA998" }), brief(), { storage: malformed }), true);
});

test("a provider-reparsed diversion does not become new only because reportedAt changed", () => {
  const storage = memoryStorage();
  const diverted = story({ diversion: { source: "flightaware", reportedAt: 1000, originalDestination: "ORD", destination: "DEN" } });
  dismissWelcomeSummary(diverted, brief(), diverted.fetchedAt, { storage });
  assert.equal(shouldOpenWelcomeSummary({ ...diverted, diversion: { ...diverted.diversion!, reportedAt: 2000 } }, brief(), { storage }), false);
});
