import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const surfaceSource = readFileSync(new URL("./route-airport-surface.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("./route-map.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("airport detailed geography uses the exact journey basemap land and water tokens", () => {
  assert.match(surfaceSource, /fill="var\(--journey-land\)"/);
  assert.match(surfaceSource, /fill="var\(--journey-water\)"/);
  assert.match(routeSource, /style=\{\{ fill: "var\(--journey-water\)" \}\}/);
  assert.match(stylesSource, /--journey-water:\s*#071c30;/);
  assert.match(stylesSource, /--journey-land:\s*#193346;/);
  assert.match(stylesSource, /--journey-water:\s*#c7e3ed;/);
  assert.match(stylesSource, /--journey-land:\s*#e9eee1;/);
});

test("detailed geography fades with airport detail and airport surfaces draw above it", () => {
  assert.match(surfaceSource, /data-airport-detailed-geography/);
  assert.match(surfaceSource, /data-airport-coastline-fallback/);
  assert.match(surfaceSource, /opacity=\{opacity\}/);
  const geographyAt = surfaceSource.indexOf("data-airport-detailed-geography");
  const airportGeometryAt = surfaceSource.lastIndexOf("{geometry}");
  assert.ok(geographyAt >= 0 && airportGeometryAt > geographyAt, "airport detail must draw above land/water");
});
