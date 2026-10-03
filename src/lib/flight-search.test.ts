import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver, focusManager, onlineManager } from "@tanstack/react-query";
import { flightStoryQueryKey, stopFlightSearch, flightStoryRequest, flightSearchCanPoll, flightNotFound, INITIAL_FLIGHT_SEARCH_MS } from "./flight-search.ts";

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

test("a not-found query makes one request and stays stopped on focus/reconnect; explicit retry can recover", async () => {
  const client = new QueryClient(); client.mount(); let requests = 0, found = false;
  const observer = new QueryObserver(client, { queryKey: flightStoryQueryKey("US5558"),
    queryFn: async () => { requests++; if (!found) throw new Error("No flight data"); return { live: true }; },
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

test("no-story error and expired searches stop polling; loaded transient failures can still update", () => {
  assert.equal(INITIAL_FLIGHT_SEARCH_MS, 20_000);
  for (const message of ["Flight not found", "No matching flight", "schedule provider returned no flight data", "Try another number", "HTTP 404"]) {
    assert.equal(flightNotFound(new Error(message)), true);
    assert.equal(flightSearchCanPoll({ live: true }, new Error(message)), false);
  }
  const offline = new Error("Network unavailable");
  assert.equal(flightSearchCanPoll(undefined, offline), false);
  assert.equal(flightSearchCanPoll({ live: true }, offline), true);
  assert.equal(flightSearchCanPoll(undefined, null, true), false);
  assert.equal(flightSearchCanPoll({ live: true }, null), true);
});

test("the existing 35-second transport deadline aborts, and an already-cancelled search never starts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(); let requests = 0, transport: AbortSignal | undefined;
  const pending = flightStoryRequest(controller.signal, async sent => {
    requests++; transport = sent; return new Promise<never>(() => {});
  });
  const rejected = assert.rejects(pending, /timed out/);
  await Promise.resolve(); t.mock.timers.tick(35_000); await rejected;
  assert.equal(transport?.aborted, true); assert.equal(requests, 1);
  controller.abort();
  await assert.rejects(flightStoryRequest(controller.signal, async () => { requests++; return {}; }), /abort/i);
  assert.equal(requests, 1);
});
