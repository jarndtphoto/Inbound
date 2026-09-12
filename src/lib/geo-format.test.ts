import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { densifyPath, formatMiles, greatCirclePoints, haversineNm, nmToMiles, polylineLengthNm } from "./geo.ts";

describe("passenger miles", () => {
  it("rounds the same way for a long remaining distance", () => {
    const nm = 3070;
    assert.equal(Math.round(nmToMiles(nm)), 3533);
    assert.equal(formatMiles(nm), "3,533 miles");
    assert.equal(formatMiles(nm), formatMiles(nm));
  });

  it("handles short remaining distance", () => {
    assert.match(formatMiles(4), /miles?$/);
  });
});

describe("long-route cache subsample", () => {
  it("keeps Hawaii to Chicago connected after even thinning", () => {
    const hnl = { lat: 21.3187, lon: -157.9224 };
    const ord = { lat: 41.9786, lon: -87.9048 };
    const path = densifyPath(greatCirclePoints(hnl, ord, 24), 20);
    assert.ok(path.length > 96);
    const prefix = path.slice(0, 80);
    assert.ok(haversineNm(prefix[prefix.length - 1]!, ord) > 800);
    const slim = [path[0]!];
    const last = path[path.length - 1]!;
    const step = (path.length - 1) / 94;
    for (let i = 1; i < 94; i++) slim.push(path[Math.round(i * step)]!);
    slim.push(last);
    assert.ok(haversineNm(slim[0]!, hnl) < 5);
    assert.ok(haversineNm(slim[slim.length - 1]!, ord) < 5);
    const full = polylineLengthNm(path);
    const kept = polylineLengthNm(slim);
    assert.ok(full > 3500);
    assert.ok(kept > full * 0.9);
  });
});
