import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { QueryClient } from "@tanstack/react-query";
import { resolveGroundIdentity } from "../src/lib/ground-position-identity.ts";
import { groundPositionQueryKey } from "../src/lib/ground-position-key.ts";

// Execute the production effect itself, with real React Query cache/deduplication
// and fixture-only ground reads. No browser or upstream provider is involved.
const source = readFileSync(new URL("../src/components/filed-app.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("filed-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0]?.getText(ast).includes("const bootstrap = groundBootstrapQ.data;")) {
    effect = node.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(effect, "production bootstrap effect is present");
const execute = new Function("groundBootstrapQ", "story", "flightTab", "groundBootstrapPrefetchRef",
  "queryClient", "flightKey", "resolveGroundIdentity", "groundPositionQueryKey", "getGroundPosition",
  "logGroundTiming", "console", ts.transpile(`return (${effect})();`, { target: ts.ScriptTarget.ES2022 }));

const bootstrap = {
  landKey: "leg:v1:AAL3362|2026-10-07|ORD|AVP", serviceDate: "2026-10-07",
  requestedIdent: "AA3362", airportIata: "ORD", originIata: "ORD", destIata: "AVP",
  movementKind: "departure", airportLat: 41.98, airportLon: -87.9,
  registration: null, hex: null, callsign: "AAL3362", lastPosition: null,
};
const initialStory = { stateKey: bootstrap.landKey, flightId: null, callsign: "AAL3362", aircraft: null };
const operatingFlightId = "ENY3362-1791178352-airline-1320p:0";
const position = { seenAt: 1791408000, callsign: "ENY3362", lat: 41.98, lon: -87.9 };
const acquire = data => data.flightId === operatingFlightId || data.callsign === "ENY3362" ? position : null;

function harness(t, read = acquire) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let cleanup;
  t.after(() => { cleanup?.(); queryClient.clear(); });
  const ref = { current: "" };
  const requests = [];
  const timings = [];
  const pending = new Set();
  const prefetch = queryClient.prefetchQuery.bind(queryClient);
  queryClient.prefetchQuery = options => {
    const task = prefetch(options);
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };
  const run = (story = initialStory, tab = "Route", saved = bootstrap) => {
    cleanup?.();
    cleanup = execute(
      { data: saved }, story, tab, ref, queryClient, "AA3362", resolveGroundIdentity, groundPositionQueryKey,
      async ({ data }) => { requests.push(data); return read(data, requests.length); },
      async ({ data }) => { timings.push(data); }, { info() {} },
    );
  };
  const settle = async () => { while (pending.size) await Promise.all([...pending]); };
  const cached = () => queryClient.getQueryData(groundPositionQueryKey({
    stateKey: bootstrap.landKey, flightNumber: bootstrap.requestedIdent,
    airportIata: bootstrap.airportIata, movementKind: bootstrap.movementKind,
  }));
  return { run, settle, requests, timings, cached };
}

for (const [identity, enrichment] of [
  ["operating flightId", { flightId: operatingFlightId }],
  ["callsign", { callsign: "ENY3362" }],
]) {
  test(`a bootstrap miss retries once when the same leg gains its ${identity}`, async t => {
    const h = harness(t);
    h.run();
    await h.settle();
    assert.equal(h.cached(), null);
    const enriched = { ...initialStory, ...enrichment };
    h.run(enriched);
    await h.settle();
    assert.equal(h.requests.length, 2, "new lookup evidence must get a ground request after the miss");
    assert.deepEqual(h.cached(), position, "the original leg cache receives the recovered position");
    assert.equal(h.requests[1].flightNumber, "AA3362", "passenger identity remains canonical");
    for (let render = 0; render < 20; render++) h.run({ ...enriched });
    await h.settle();
    assert.equal(h.requests.length, 2, "unchanged identity must not trigger repeated prefetches");
  });
}

test("identity arriving during a pending bootstrap miss is not lost to cache deduplication", async t => {
  let finishFirst;
  const h = harness(t, (data, attempt) => attempt === 1
    ? new Promise(resolve => { finishFirst = () => resolve(null); }) : acquire(data));
  h.run();
  const enriched = { ...initialStory, flightId: operatingFlightId };
  for (let render = 0; render < 20; render++) h.run({ ...enriched });
  finishFirst();
  await h.settle();
  assert.equal(h.requests.length, 2, "one follow-on request uses the identity learned during the miss");
  assert.equal(h.timings.length, 2, "deduplicated renders do not send extra timing requests");
  assert.deepEqual(h.cached(), position);
  h.run(enriched);
  await h.settle();
  assert.equal(h.requests.length, 2);
});

test("leaving the Route tab cancels queued enrichment and returning can recover it", async t => {
  let finishFirst;
  const h = harness(t, (data, attempt) => attempt === 1
    ? new Promise(resolve => { finishFirst = () => resolve(null); }) : acquire(data));
  h.run();
  const enriched = { ...initialStory, flightId: operatingFlightId };
  h.run(enriched);
  h.run(enriched, "Overview");
  finishFirst();
  await h.settle();
  assert.equal(h.requests.length, 1, "dismissed work must not issue a background retry");
  h.run(enriched);
  await h.settle();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.cached(), position);
});

test("an enriched lookup that also misses remains bounded across repeated renders", async t => {
  const h = harness(t, () => null);
  h.run();
  await h.settle();
  const enriched = { ...initialStory, flightId: operatingFlightId, callsign: "ENY3362" };
  h.run(enriched);
  await h.settle();
  for (let render = 0; render < 20; render++) h.run({ ...enriched });
  h.run({ ...enriched, flightId: ` ${operatingFlightId.toLowerCase()} `, callsign: " eny3362 " });
  await h.settle();
  assert.equal(h.requests.length, 2, "misses and equivalent identity spelling do not create a retry loop");
  assert.equal(h.cached(), null);
});

test("bootstrap enrichment stays limited to the active Route tab and matching dated leg", async t => {
  const h = harness(t);
  h.run(initialStory, "Overview");
  h.run({ ...initialStory, stateKey: "leg:v1:AAL3362|2026-10-08|ORD|AVP" });
  h.run(initialStory, "Route", null);
  await h.settle();
  assert.equal(h.requests.length, 0);
});
