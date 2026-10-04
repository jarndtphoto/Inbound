import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hazard } from "./types.ts";
import { distinctRouteHazards } from "./route-hazards.ts";

const report: Hazard = { id: "report-a", kind: "pirep", chop: "moderate", label: "moderate chop reported",
  detail: "UA /TM2355 /FL350 /TB MOD", observedAt: Date.parse("2026-10-03T23:55:00Z"), remaining: true,
  lat: 41, lon: -89, source: "observed" };

test("identical report labels retain distinct report IDs, occurrence times and coordinates", () => {
  const reports = [report, { ...report, id: "report-b" }, { ...report, observedAt: report.observedAt! + 60_000 },
    { ...report, lon: -88 }, { ...report, lat: 42 }, { ...report, remaining: false }];
  assert.deepEqual(distinctRouteHazards(reports), reports);
});

test("the same PIREP returned in overlapping route boxes appears once", () => {
  assert.deepEqual(distinctRouteHazards([report, { ...report }]), [report]);
});

test("forecast advisory deduplication still collapses repeated route samples", () => {
  const forecast: Hazard = { ...report, id: "forecast-1", kind: "turb", source: "advisory", observedAt: undefined, validity: "same window" };
  assert.deepEqual(distinctRouteHazards([forecast, { ...forecast, id: "forecast-2", lat: 43 }]), [forecast]);
});
