/**
 * Paid FlightAware AeroAPI is opt-in.
 *
 * Keeping a key in Vercel is not enough to spend against the account. The
 * explicit flag is required so accidental env drift cannot restart paid calls.
 */
export function flightAwarePaidApiKey(): string {
  if (process.env.FLIGHTAWARE_PAID_API_ENABLED !== "1") return "";
  return process.env.FLIGHTAWARE_AEROAPI_KEY?.trim()
    || process.env.FLIGHTAWARE_API_KEY?.trim()
    || "";
}

export function flightAwarePaidApiConfigured(): boolean {
  return Boolean(flightAwarePaidApiKey());
}
