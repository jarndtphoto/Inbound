import type { QueryClient } from "@tanstack/react-query";

export const INITIAL_FLIGHT_SEARCH_MS = 20_000;
export const flightStoryQueryKey = (query: string) => ["story", query] as const;

export function flightNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not found|could(?:n't| not) find|no (?:matching )?flight(?: data)?|try another number|try a flight number|enter a flight number|flight number is too long|HTTP 404\b/i.test(message);
}

export function flightSearchCanPoll(data: unknown, error: unknown, stopped = false): boolean {
  return !stopped && !(error && (!data || flightNotFound(error)));
}

export function stopFlightSearch(client: QueryClient, query: string): void {
  const filters = { queryKey: flightStoryQueryKey(query), exact: true };
  void client.cancelQueries(filters);
  client.removeQueries(filters);
}

/** Abort the transport too, including when a deadline wins the race. */
export async function flightStoryRequest<T>(signal: AbortSignal, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Flight data request timed out. Please try again.")), 35_000);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return request(controller.signal);
    }), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
