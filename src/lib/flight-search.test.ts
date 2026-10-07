import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver, focusManager, onlineManager } from "@tanstack/react-query";
import { flightStoryQueryKey, stopFlightSearch, flightStoryRequest, flightSearchCanPoll, flightSearchShouldRetry, flightNotFound, verifiedFlightNotFoundPage, INITIAL_FLIGHT_SEARCH_MS, TEMPORARY_FLIGHT_RETRY_MS } from "./flight-search.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test("leaving aborts the pending transport, removes only this story, and cannot schedule retries after focus/reconnect", async () => {
  const client = new QueryClient(); client.mount();
  client.setQueryData(flightStoryQueryKey("UA219"), { live: true });
  let requests = 0, transport: AbortSignal | undefined;
  const key = flightStoryQueryKey("US5558");
  const observer = new QueryObserver(client, { queryKey: key,
    queryFn: ({ signal }) => flightStoryRequest(signal, async sent => {
      requests++; transport = sent;
      return new Promise<never>(() => {});
    }), retry: 2, retryDelay: 1 });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await tick(); assert.equal(requests, 1);
    stopFlightSearch(client, "US5558"); unsubscribe();
    assert.equal(transport?.aborted, true);
    assert.equal(client.getQueryCache().find({ queryKey: key, exact: true }), undefined);
    assert.deepEqual(client.getQueryData(flightStoryQueryKey("UA219")), { live: true });
    focusManager.setFocused(false); focusManager.setFocused(true);
    onlineManager.setOnline(false); onlineManager.setOnline(true);
    await tick(); await tick(); assert.equal(requests, 1);
  } finally { unsubscribe(); client.unmount(); client.clear(); focusManager.setFocused(undefined); }
});

test("a dated link stops only its exact leg query", () => {
  const client = new QueryClient();
  const dated = flightStoryQueryKey("UA203", "2026-10-03");
  client.setQueryData(dated, { date: "2026-10-03" });
  client.setQueryData(flightStoryQueryKey("UA203"), { date: "current" });
  stopFlightSearch(client, "UA203", "2026-10-03");
  assert.equal(client.getQueryData(dated), undefined);
  assert.deepEqual(client.getQueryData(flightStoryQueryKey("UA203")), { date: "current" });
  client.clear();
});

test("a not-found query makes one request and stays stopped on focus/reconnect; explicit retry can recover", async () => {
  const client = new QueryClient(); client.mount(); let requests = 0, found = false;
  const observer = new QueryObserver(client, { queryKey: flightStoryQueryKey("US5558"),
    queryFn: async () => { requests++; if (!found) throw new Error("[flight_not_found] No flight found for US5558."); return { live: true }; },
    enabled: q => flightSearchCanPoll(q.state.data, q.state.error),
    retry: (_, error) => !flightNotFound(error), retryDelay: 1,
    refetchOnWindowFocus: q => flightSearchCanPoll(q.state.data, q.state.error),
    refetchOnReconnect: q => flightSearchCanPoll(q.state.data, q.state.error) });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await tick(); assert.equal(observer.getCurrentResult().isError, true); assert.equal(requests, 1);
    focusManager.setFocused(false); focusManager.setFocused(true);
    onlineManager.setOnline(false); onlineManager.setOnline(true);
    await tick(); assert.equal(requests, 1);
    found = true; await observer.refetch(); assert.equal(requests, 2);
    assert.deepEqual(observer.getCurrentResult().data, { live: true });
  } finally { unsubscribe(); client.unmount(); client.clear(); focusManager.setFocused(undefined); }
});

test("verified not-found stops; empty/402/ambiguous-404 source failures retain bounded retries", () => {
  assert.equal(INITIAL_FLIGHT_SEARCH_MS, 20_000);
  for (const message of ["Flight not found", "No matching flight", "[flight_not_found] No flight today", "Try a flight number like AA 1"]) {
    assert.equal(flightNotFound(new Error(message)), true);
    assert.equal(flightSearchCanPoll({ live: true }, new Error(message)), false);
  }
  const offline = new Error("Network unavailable");
  assert.equal(flightSearchCanPoll(undefined, offline), true);
  assert.equal(flightSearchCanPoll(undefined, offline, false, 5), false);
  assert.equal(flightSearchCanPoll({ live: true }, offline), true);
  assert.equal(flightSearchCanPoll(undefined, null, true), false);
  assert.equal(flightSearchCanPoll({ live: true }, null), true);
  for (const message of ["schedule provider returned no flight data", "HTTP 402", "HTTP 404", "Try another number"]) {
    const error = new Error(message); assert.equal(flightNotFound(error), false);
    assert.equal(flightSearchShouldRetry(0, error), true); assert.equal(flightSearchShouldRetry(4, error), false);
  }
  assert.equal(TEMPORARY_FLIGHT_RETRY_MS, 30_000);
  assert.equal(verifiedFlightNotFoundPage(404, "<h1>Flight not found</h1>"), true);
  assert.equal(verifiedFlightNotFoundPage(200, "<p>We couldn't find this flight.</p>"), true);
  assert.equal(verifiedFlightNotFoundPage(404, "<h1>Page not found</h1>"), false);
  assert.equal(verifiedFlightNotFoundPage(402, "<h1>Flight not found</h1>"), false);
  assert.equal(verifiedFlightNotFoundPage(200, '<script>"Flight not found"</script>'), false);
});

test("an initial temporary outage makes at most five requests and focus/reconnect cannot reset the budget", async () => {
  const client = new QueryClient(); client.mount(); let requests = 0;
  const observer = new QueryObserver(client, { queryKey: flightStoryQueryKey("WN421"),
    queryFn: async () => { requests++; throw new Error("HTTP 402; FlightStats unavailable"); },
    enabled: q => flightSearchCanPoll(q.state.data, q.state.error, false, q.state.fetchFailureCount),
    retry: flightSearchShouldRetry, retryDelay: 1,
    refetchOnWindowFocus: q => Boolean(q.state.data), refetchOnReconnect: q => Boolean(q.state.data) });
  const unsubscribe = observer.subscribe(() => {});
  try {
    for (let i = 0; i < 10 && !observer.getCurrentResult().isError; i++) await tick();
    assert.equal(requests, 5); assert.equal(observer.getCurrentResult().failureCount, 5);
    focusManager.setFocused(false);focusManager.setFocused(true);onlineManager.setOnline(false);onlineManager.setOnline(true);
    await tick();assert.equal(requests, 5);
  } finally {unsubscribe();client.unmount();client.clear();focusManager.setFocused(undefined);}
});

test("the existing 35-second transport deadline aborts, and an already-cancelled search never starts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(); let requests = 0, transport: AbortSignal | undefined;
  const pending = flightStoryRequest(controller.signal, async sent => {
    requests++; transport = sent; return new Promise<never>(() => {});
  });
  const rejected = assert.rejects(pending, /timed out/);
  await Promise.resolve(); t.mock.timers.tick(20_000); assert.equal(transport?.aborted, false);
  t.mock.timers.tick(15_000); await rejected;
  assert.equal(transport?.aborted, true); assert.equal(requests, 1);
  controller.abort();
  await assert.rejects(flightStoryRequest(controller.signal, async () => { requests++; return {}; }), /abort/i);
  assert.equal(requests, 1);
});

test("leaving FR24 Preview cancels its exact session query without touching other sessions", async () => {
  const client = new QueryClient();
  const key = [...flightStoryQueryKey("UA1036"), "fr24-only", "session-a"];
  const other = [...flightStoryQueryKey("UA1036"), "fr24-only", "session-b"];
  client.setQueryData(key, { live: true }); client.setQueryData(other, { live: true });
  stopFlightSearch(client, "UA1036", null, key);
  assert.equal(client.getQueryData(key), undefined); assert.ok(client.getQueryData(other)); client.clear();
});
