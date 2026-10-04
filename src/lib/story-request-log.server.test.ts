import { test } from "node:test";
import assert from "node:assert/strict";
import { withStoryRequest, noteStoryCache, noteStorySchedule, noteStoryFallback, type StoryRequestLog } from "./story-request-log.server.ts";

test("each cache hit/miss/coalesced request logs duration, schedule source, fallback outcome and category", async () => {
  const logs: StoryRequestLog[] = [];
  for (const cache of ["hit", "miss", "inflight"] as const) {
    const result = await withStoryRequest("UA 219", false, async () => {
      noteStoryCache(cache); return { providers: { scheduleSource: "flightstats_public" as const } };
    }, record => logs.push(record));
    assert.equal(result.providers.scheduleSource, "flightstats_public");
    const log = logs.at(-1)!;
    assert.equal(log.requested, "UA219"); assert.equal(log.cacheStatus, cache);
    assert.equal(log.scheduleSource, "flightstats_public"); assert.equal(log.fallbackOutcome, "flightstats_used");
    assert.equal(log.errorCategory, null); assert.equal(log.outcome, "ok"); assert(log.durationMs >= 0);
  }
  for (const [message, category] of [["[flight_not_found] No flight today", "not_found"], ["Flight data request timed out", "timeout"],
    ["Current flight route unavailable", "source_unavailable"], ["Unexpected database failure", "unexpected"]]) {
    await assert.rejects(withStoryRequest("WN421", true, async () => {
      noteStoryCache("miss");noteStorySchedule("unavailable");noteStoryFallback("flightstats_unavailable");throw new Error(message);
    }, record => logs.push(record)), new RegExp(message.replace(/[\[\]]/g, "\\$&")));
    const log = logs.at(-1)!;assert.equal(log.errorCategory, category);assert.equal(log.outcome, "error");
    assert.equal(log.fallbackOutcome, category === "not_found" ? "not_found" : "flightstats_unavailable");
  }
  assert.equal(logs.length, 7);
});

test("overlapping flights keep request diagnostics isolated, including failure and cached-source recovery", async () => {
  const logs: StoryRequestLog[] = [];
  let release!: () => void;const wait = new Promise<void>(resolve => { release = resolve; });
  const first = withStoryRequest("DL4820", false, async () => {
    noteStoryCache("miss");noteStorySchedule("fr24_live");await wait;
    return { providers: { scheduleSource: "fr24_live" as const } };
  }, record => logs.push(record));
  await withStoryRequest("UA219", false, async () => {
    noteStoryCache("hit");return { providers: { scheduleSource: "saved_resume" as const } };
  }, record => logs.push(record));
  release();await first;
  assert.deepEqual(logs.map(l => [l.requested, l.cacheStatus, l.scheduleSource, l.fallbackOutcome]),
    [["UA219", "hit", "saved_resume", "resume_used"], ["DL4820", "miss", "fr24_live", "fr24_used"]]);
});

test("a poll logs one compact, deduplicated list when weather sources failed", async () => {
  const requestLogs: StoryRequestLog[] = [];
  const weatherLogs: string[][] = [];
  await withStoryRequest("UA203", false, async () => ({
    weatherCoverage: { failedSources: ["Pilot reports", "Storm forecasts", "Pilot reports"] },
  }), record => requestLogs.push(record), sources => weatherLogs.push(sources));
  await withStoryRequest("UA203", false, async () => ({
    weatherCoverage: { failedSources: [] },
  }), record => requestLogs.push(record), sources => weatherLogs.push(sources));

  assert.equal(requestLogs.length, 2);
  assert.deepEqual(weatherLogs, [["Pilot reports", "Storm forecasts"]]);
});

test("weather diagnostics never break a successful flight poll", async () => {
  const result = await withStoryRequest("UA203", false, async () => ({
    weatherCoverage: { failedSources: ["Local advisories"] }, ok: true,
  }), () => {}, () => { throw new Error("log sink unavailable"); });
  assert.equal(result.ok, true);
});
