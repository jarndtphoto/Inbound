import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMiles, nmToMiles } from "./geo.ts";

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
