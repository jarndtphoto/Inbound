/** Safe diagnostics: never include provider response bodies, URLs, or credentials. */
export function flightFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reported = message.match(/\bFLIGHT_[A-Z_]+\b/);
  if (reported) return reported[0];
  if (/timed? out|timeout|taking too long|aborted/i.test(message)) return "FLIGHT_TIMEOUT";
  if (/429|rate limit/i.test(message)) return "FLIGHT_RATE_LIMIT";
  if (/401|403|forbidden|unauthorized/i.test(message)) return "FLIGHT_ACCESS";
  if (/route unavailable|no flight data/i.test(message)) return "FLIGHT_ROUTE_UNAVAILABLE";
  if (/Try another number|flight number like|Enter a flight number|Flight number is too long/i.test(message)) return "FLIGHT_NUMBER";
  if (/is not defined|Cannot (read|access)|is not a function/i.test(message)) return "FLIGHT_PROCESSING";
  if (/fetch|network|Load failed/i.test(message)) return "FLIGHT_NETWORK";
  return "FLIGHT_UNKNOWN";
}
export function flightFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // Only preserve a bare JavaScript identifier for actionable programming errors.
  return message.match(/^[A-Za-z_$][\w$]* is not defined$/)?.[0] ?? flightFailureCode(error);
}
export function flightDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const ref = message.match(/ref=[a-f0-9-]{36}/)?.[0];
  return flightFailureCode(error) + (ref ? " · " + ref : "");
}
