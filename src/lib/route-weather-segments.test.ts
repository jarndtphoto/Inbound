import { test } from "node:test";
import assert from "node:assert/strict";
import { routeWeatherSegments, sampleWeather, turbulenceBand } from "./route-weather-segments.ts";
import { routeWeatherEvents, weatherEventMarker, weatherEventNumber } from "./weather-events.ts";
import type { Chop, RouteSample } from "./types.ts";
import { readFileSync } from "node:fs";

const sample = (i: number, chop: Chop, extras = {}): RouteSample => ({ lat: 40 + i / 10, lon: -88 + i / 10, frac: i / 10, distNm: i, remainingNm: 10 - i, etaMin: i, chop, cloud: false, convective: false, note: null, fix: false, ...extras });

test("light and explicit light-to-moderate are yellow; moderate-to-severe is red", () => {
  assert.equal(turbulenceBand("smooth"), "smooth");
  assert.equal(turbulenceBand("light"), "light");
  assert.equal(turbulenceBand("light-moderate"), "light");
  for (const intensity of ["moderate", "moderate-severe", "severe"] as const) assert.equal(turbulenceBand(intensity), "moderate");
  assert.equal(sampleWeather(sample(1, "moderate", { note: "PIREP LGT-MOD turbulence" })).band, "light");
  assert.equal(sampleWeather(sample(1, "severe", { note: "MOD-SEV turbulence" })).band, "moderate");
});

test("a continuous light-then-moderate event has one marker and changes color at the moderate sample", () => {
  const samples = [sample(0, "smooth"), sample(1, "light"), sample(2, "light"), sample(3, "moderate"), sample(4, "smooth")];
  const segments = routeWeatherSegments(samples), events = routeWeatherEvents(samples);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, "turbulence:light-moderate");
  assert.equal(weatherEventNumber(events, events[0]), 1);
  assert.equal(segments.find(s => s.band === "light")!.points[0], samples[1]);
  assert.equal(segments.find(s => s.band === "moderate")!.points[0], samples[3]);
  assert.equal(segments.find(s => s.band === "light")!.points.at(-1), samples[3]);
  assert.deepEqual(weatherEventMarker(events[0]), { lat: samples[1].lat, lon: samples[1].lon, frac: samples[1].frac, etaMin: samples[1].etaMin });
});

test("a smooth gap of five minutes or less splits numbers and stays teal", () => {
  const samples = [sample(0, "light"), sample(1, "smooth"), sample(2, "moderate"), sample(3, "smooth")];
  const events = routeWeatherEvents(samples), segments = routeWeatherSegments(samples);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => weatherEventNumber(events, e)), [1, 2]);
  assert.ok(events.every(e => !e.gaps));
  assert.equal(segments[1].band, "smooth");
  assert.equal(segments[1].points[0], samples[1]);
});

test("storm-only and cloud-only events have icons, not turbulence numbers", () => {
  const samples = [sample(0, "smooth", { convective: true }), sample(1, "smooth"), sample(2, "smooth", { cloud: true }), sample(3, "light")];
  const events = routeWeatherEvents(samples);
  assert.deepEqual(events.map(e => e.key), ["storms", "clouds", "turbulence:light"]);
  assert.deepEqual(events.map(e => weatherEventNumber(events, e)), [0, 0, 1]);
  assert.deepEqual(routeWeatherSegments(samples).map(s => s.kind), ["storms", "smooth", "clouds", "turbulence"]);
});

test("each marker is exactly the first point of its segment, including unsorted samples and partial progress", () => {
  const samples = [sample(0, "smooth"), sample(1, "light"), sample(2, "moderate"), sample(3, "smooth"), sample(4, "light"), sample(5, "smooth", { convective: true }), sample(6, "smooth")].reverse();
  for (const progress of [-Infinity, 0.15, 0.35]) {
    const segments = routeWeatherSegments(samples, progress);
    for (const event of routeWeatherEvents(samples, progress)) {
      const marker = weatherEventMarker(event);
      const segment = segments.find(s => !s.past && s.points[0].frac === marker.frac)!;
      assert.ok(segment);
      assert.equal(marker.lat, segment.points[0].lat);
      assert.equal(marker.lon, segment.points[0].lon);
    }
  }
});

test("explicit light-to-moderate retains its yellow range label instead of becoming plain moderate", () => {
  const samples = [sample(0, "moderate", { note: "PIREP LIGHT-MODERATE" }), sample(1, "smooth")];
  assert.equal(routeWeatherEvents(samples)[0].key, "turbulence:light-moderate");
  assert.equal(routeWeatherSegments(samples)[0].band, "light");
});

test("yellow and red tokens contrast with both themes and the radar outline background", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const luminance = (hex: string) => hex.match(/[\da-f]{2}/gi)!.map(c => parseInt(c, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((v, c, i) => v + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const tokens = (name: string) => [...css.matchAll(new RegExp(`--color-${name}: (#[\\da-f]{6});`, "gi"))].map(m => m[1]);
  for (const name of ["turbulence-light", "turbulence-moderate"]) {
    const [dark, light] = tokens(name);
    assert.ok(contrast(dark, "081725") >= 4.5, `${name} dark text and outline`);
    assert.ok(contrast(light, "fcfaf5") >= 4.5, `${name} light text and outline`);
    assert.ok(contrast(dark, "193346") >= 3, `${name} dark terrain`);
    assert.ok(contrast(light, "e9eee1") >= 3, `${name} light terrain`);
  }
});
