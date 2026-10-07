import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { polishStory } from "./fixtures/presentation-polish.mjs";
import { freezeTestClock } from "./helpers/test-clock.mjs";
import { groundPositionQueryKey } from "../src/lib/ground-position-key.ts";
import { groundStoryObservation } from "../src/lib/ground-story-position.ts";
import { groundPollingEnabled } from "../src/lib/flight-polling.ts";
const repo = resolve(".");
let ui, directory;
before(async () => {
  directory = await mkdtemp(resolve("node_modules/.independent-freshness-"));
  await build({
    root: repo,
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": resolve(repo, "src") } },
    plugins: [
      {
        name: "independent-export",
        enforce: "pre",
        transform(code, id) {
          if (id === resolve(repo, "src/components/movement-map.tsx"))
            return code + "\nexport { GroundMovementMap, RouteMap };";
        },
      },
      react(),
    ],
    build: {
      ssr: resolve(repo, "src/components/movement-map.tsx"),
      outDir: directory,
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: "ui.mjs" } },
    },
  });
  ui = await import(pathToFileURL(join(directory, "ui.mjs")).href);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const base = polishStory();
  const origin = { ...base.origin, iata: "MCO", icao: "KMCO", lat: 28.4312, lon: -81.3081 };
  const aircraft = {
    ...base.aircraft,
    lat: origin.lat,
    lon: origin.lon,
    onGround: true,
    altFt: 0,
    gsKt: 3,
    seenSec: 5,
    track: 270,
  };
  return {
    ...base,
    origin,
    aircraft,
    currentStage: "origin_gate",
    times: { ...base.times, airborne: false },
    providers: {
      chosenPosition: "adsb",
      chosenPositionAgeSec: 5,
      chosenPositionSeenAt: base.fetchedAt / 1000 - 5,
    },
  };
}
function markup(story, elapsed = 0, ground = null, patch = {}) {
  const restore = freezeTestClock(story.fetchedAt + elapsed * 1000),
    realFetch = globalThis.fetch,
    client = new QueryClient();
  globalThis.fetch = () => {
    throw Error("INDEPENDENT TEST MUST NOT CALL PROVIDERS");
  };
  if (ground)
    client.setQueryData(
      groundPositionQueryKey({
        stateKey: story.stateKey,
        flightNumber: story.iata,
        registration: story.aircraft?.registration,
        hex: story.aircraft?.hex,
        airportIata: "MCO",
        movementKind: "departure",
      }),
      ground,
    );
  try {
    return renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client },
        h(ui.GroundMovementMap, {
          story,
          mode: { kind: "departure", airport: story.origin },
          trail: [],
          aircraft: story.aircraft,
          active: false,
          ...patch,
        }),
      ),
    );
  } finally {
    client.clear();
    globalThis.fetch = realFetch;
    restore();
  }
}
test("cached story render age advances 5 → 25 → 31 without changing payload", () => {
  const s = fixture();
  assert.match(markup(s), /5s/);
  assert.match(markup(s, 20), /25s/);
  assert.match(markup(s, 26), /Last seen 31s ago/);
});
test("31–120s renders last-seen frozen point; beyond 120s removes initial marker", () => {
  const s = fixture();
  for (const dt of [26, 55, 115]) {
    const html = markup(s, dt);
    assert.match(html, /Last seen/);
    assert.match(html, /frozen/);
    assert.match(html, /and aircraft position/);
  }
  const html = markup(s, 116);
  assert.match(html, /Awaiting aircraft/);
  assert.doesNotMatch(html, /and aircraft position/);
});
test("absolute observation clock defeats stale relative age on cache hit", () => {
  const s = fixture();
  s.providers.chosenPositionSeenAt = s.fetchedAt / 1000 - 80;
  assert.match(markup(s), /Last seen 1m ago/);
  assert.match(markup(s, 30), /Last seen 2m ago/);
});
test("fetchedAt anchors legacy relative age when observation timestamp absent", () => {
  const s = fixture();
  delete s.providers.chosenPositionSeenAt;
  assert.match(markup(s, 26), /Last seen 31s ago/);
  assert.match(markup(s, 116), /Awaiting aircraft/);
});
test("newer ground observation wins after repeated cached-story renders", () => {
  const s = fixture();
  const ground = { ...s.aircraft, provider: "adsb", gsKt: 17, seenAt: s.fetchedAt / 1000 + 15 };
  assert.match(markup(s, 20, ground), /17 kt/);
  assert.match(markup(s, 35, ground), /17 kt/);
  assert.match(markup(s, 35, ground), /20s/);
});
test("newer story observation wins against cached older ground observation", () => {
  const s = fixture();
  const ground = { ...s.aircraft, provider: "adsb", gsKt: 17, seenAt: s.fetchedAt / 1000 - 20 };
  assert.match(markup(s, 10, ground), /3 kt/);
  assert.doesNotMatch(markup(s, 10, ground), /17 kt/);
});
test("invalid timestamp plus invalid legacy ages never manufactures a live point", () => {
  for (const stamp of [NaN, Infinity, -1]) {
    const s = fixture();
    s.providers.chosenPositionSeenAt = stamp;
    s.providers.chosenPositionAgeSec = NaN;
    s.aircraft.seenSec = NaN;
    const html = markup(s);
    assert.doesNotMatch(html, /live movement/);
    assert.doesNotMatch(html, /and aircraft position/);
  }
});
test("poll policy switches only once age exceeds 30sec", () => {
  const s = fixture();
  for (const [dt, expected] of [
    [24.999, false],
    [25, false],
    [25.001, true],
    [26, true],
  ]) {
    const obs = groundStoryObservation(s, s.fetchedAt + dt * 1000);
    assert.equal(groundPollingEnabled(true, true, false, false, obs.ageSec <= 30, true), expected);
  }
});
test("source clock skew accepted to 10sec then rejected, invalid now rejected", () => {
  const s = fixture();
  s.providers.chosenPositionSeenAt = s.fetchedAt / 1000 + 10;
  assert.equal(groundStoryObservation(s, s.fetchedAt).ageSec, 0);
  s.providers.chosenPositionSeenAt += 0.01;
  assert.equal(groundStoryObservation(s, s.fetchedAt), null);
  assert.equal(groundStoryObservation(s, NaN), null);
});
test("far-future queried ground timestamp cannot become live", () => {
  const s = fixture();
  const ground = { ...s.aircraft, provider: "adsb", gsKt: 17, seenAt: s.fetchedAt / 1000 + 600 };
  assert.doesNotMatch(markup(s, 0, ground), /17 kt/);
});
test("immediately past 30sec cutoff is frozen even before label rounds to31", () => {
  const s = fixture();
  assert.match(markup(s, 25.1), /frozen/);
});
test("nonfinite queried timestamp cannot displace valid story", () => {
  const s = fixture();
  for (const seenAt of [Infinity, NaN, -1]) {
    const ground = { ...s.aircraft, provider: "adsb", gsKt: 17, seenAt };
    assert.doesNotMatch(markup(s, 0, ground), /17 kt/);
  }
});
test("cached query from a different airport cannot displace the current airport fix", () => {
  const s = fixture();
  for (const point of [{ lat: 41.9786, lon: -87.9048 }, { lat: NaN, lon: -81.3 }]) {
    const ground = { ...s.aircraft, ...point, provider: "adsb", gsKt: 17, seenAt: s.fetchedAt / 1000 - 1 };
    const html = markup(s, 0, ground);
    assert.doesNotMatch(html, /17 kt/);
    assert.match(html, /3 kt/);
  }
});

function previewFixture() {
  const s = fixture();
  s.providers = { ...s.providers, chosenPosition: "fr24", previewMode: "fr24-only", fr24Preview: {sessionId:"fixture-session"} };
  return s;
}
test("FR24-only Ground ignores newer ADS-B query cache and ages genuine observation", () => {
  const s = previewFixture();
  const ground = { ...s.aircraft, provider: "adsb", gsKt: 99, seenAt: s.fetchedAt / 1000 };
  assert.doesNotMatch(markup(s, 0, ground), /99 kt/);
  assert.match(markup(s, 26, ground), /Last seen 31s ago/);
  assert.match(markup(s, 116, ground), /Awaiting aircraft/);
});
test("FR24-only Flight uses actual arrival coordinates and expires surface marker at30s", () => {
  const s = previewFixture(); s.live = true;
  s.currentStage = "taxi_in";
  s.aircraft = { ...s.aircraft, lat:s.dest.lat+0.005, lon:s.dest.lon+0.005 };
  const render = elapsed => { const restore=freezeTestClock(s.fetchedAt+elapsed*1000);try{return renderToStaticMarkup(h(ui.RouteMap,{story:s}));}finally{restore();} };
  assert.match(render(0), /data-map-aircraft/);
  assert.doesNotMatch(render(26), /data-map-aircraft/);
  const actual = render(0).match(/data-map-aircraft[^>]*transform="([^"]+)"/)[1];
  const marker = { ...s.aircraft }; s.aircraft={...marker,lat:s.dest.lat,lon:s.dest.lon};
  const center = render(0).match(/data-map-aircraft[^>]*transform="([^"]+)"/)[1];
  assert.notEqual(actual,center,"aircraft must not be pinned to airport center");
});
