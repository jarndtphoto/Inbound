import { AsyncLocalStorage } from "node:async_hooks";
import { flightNotFound } from "./flight-search.ts";
import type { FlightScheduleSource } from "./types.ts";

type CacheStatus = "hit" | "miss" | "inflight";
type FallbackOutcome = "not_needed" | "flightstats_used" | "flightstats_unavailable" | "fr24_used" | "resume_used" | "unavailable" | "not_found";
type RequestTrace = { cacheStatus?: CacheStatus; scheduleSource: FlightScheduleSource; fallbackOutcome: FallbackOutcome };
export type StoryRequestLog = RequestTrace & {
  event: "story_request"; requested: string; fresh: boolean; durationMs: number;
  outcome: "ok" | "error"; errorCategory: "not_found" | "timeout" | "aborted" | "source_unavailable" | "unexpected" | null;
};
type WeatherFailureEmitter = (sources: string[]) => void;
const requests = new AsyncLocalStorage<RequestTrace>();

export function noteStoryCache(status: CacheStatus) {
  const trace = requests.getStore();
  if (trace && trace.cacheStatus == null) trace.cacheStatus = status;
}
export function noteStorySchedule(source: FlightScheduleSource) {
  const trace = requests.getStore(); if (!trace) return;
  trace.scheduleSource = source;
  const outcome = { flightstats_public: "flightstats_used", fr24_live: "fr24_used", saved_resume: "resume_used" } as const;
  if (source in outcome) trace.fallbackOutcome = outcome[source as keyof typeof outcome];
  else if (source === "unavailable" && trace.fallbackOutcome === "not_needed") trace.fallbackOutcome = "unavailable";
}
export function noteStoryFallback(outcome: FallbackOutcome) {
  const trace = requests.getStore(); if (trace) trace.fallbackOutcome = outcome;
}
function errorCategory(error: unknown): StoryRequestLog["errorCategory"] {
  if (flightNotFound(error)) return "not_found";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/provider|feed|route unavailable|network|temporarily unavailable|HTTP \d{3}|schedule updates are delayed/i.test(message)) return "source_unavailable";
  return "unexpected";
}

/** One record per caller, including cached/coalesced results and failures.
 * Async context prevents overlapping flight requests from mixing diagnostics. */
export async function withStoryRequest<T>(query: string, fresh: boolean, load: () => Promise<T>,
  emit: (record: StoryRequestLog) => void = record => console.info("[story-request] " + JSON.stringify(record)),
  emitWeatherFailures: WeatherFailureEmitter = sources => console.info("[weather-coverage] " + sources.join(","))): Promise<T> {
  const trace: RequestTrace = { scheduleSource: "unknown", fallbackOutcome: "not_needed" };
  const started = performance.now();
  return requests.run(trace, async () => {
    let category: StoryRequestLog["errorCategory"] = null;
    try {
      const result = await load();
      const source = (result as { providers?: { scheduleSource?: FlightScheduleSource } })?.providers?.scheduleSource;
      if (source) noteStorySchedule(source); // Cache hits retain the original source.
      const failedSources = (result as { weatherCoverage?: { failedSources?: unknown } })?.weatherCoverage?.failedSources;
      if (Array.isArray(failedSources)) {
        const names = [...new Set(failedSources.filter((name): name is string => typeof name === "string" && name.length > 0))];
        if (names.length) {
          try { emitWeatherFailures(names); } catch { /* Diagnostics must not break a flight poll. */ }
        }
      }
      return result;
    } catch (error) {
      category = errorCategory(error);
      if (category === "not_found") trace.fallbackOutcome = "not_found";
      throw error;
    } finally {
      emit({ ...trace, cacheStatus: trace.cacheStatus ?? "miss", event: "story_request",
        requested: String(query ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0,16), fresh,
        durationMs: Math.max(0, Math.round(performance.now() - started)), outcome: category ? "error" : "ok", errorCategory: category });
    }
  });
}
