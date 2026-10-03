import type { QueryClient } from "@tanstack/react-query";

export const INITIAL_FLIGHT_SEARCH_MS = 20_000;
export const INITIAL_FLIGHT_SEARCH_ATTEMPTS = 5;
export const TEMPORARY_FLIGHT_RETRY_MS = 30_000;
export const flightStoryQueryKey = (query: string) => ["story", query] as const;

export function flightNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^\[flight_not_found\]|^Flight not found[.!]?$|^No matching flight(?: for today)?[.!]?$|^Try a flight number|^Enter a flight number|^Flight number is too long/i.test(message);
}

/** A blank, blocked or rate-limited provider page is not a negative flight
 * result. Require an explicit flight-specific message in rendered HTML. */
export function verifiedFlightNotFoundPage(status: number, html: string): boolean {
  if (status !== 200 && status !== 404) return false;
  const text = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<!--[^]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return /\bFlight(?: information)? not found\b|\bNo flights (?:were )?found\b|\bcould(?:n['’]t| not) find (?:this|that|the|your|a) flight\b/i.test(text);
}

export function flightSearchCanPoll(data: unknown, error: unknown, stopped = false, failures = 0): boolean {
  return !stopped && !flightNotFound(error) && Boolean(data || failures < INITIAL_FLIGHT_SEARCH_ATTEMPTS);
}

export function flightSearchShouldRetry(failures: number, error: unknown, stopped = false): boolean {
  return !stopped && !flightNotFound(error) && failures < INITIAL_FLIGHT_SEARCH_ATTEMPTS - 1;
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
