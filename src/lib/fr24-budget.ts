const DAY_MS = 24 * 60 * 60_000;
const INITIAL_REMAINING_CREDITS = 9_000;
const INITIAL_DAYS_UNTIL_RESET = 7;
const DEFAULT_MONTHLY_CREDITS = 60_000;
const DEFAULT_BILLING_DAYS = 30;

export type Fr24Endpoint =
  | "/live/flight-positions/full"
  | "/flight-tracks"
  | "/flight-summary/full"
  | "/flight-summary/light"
  | "unknown";

function positiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** Emergency default from the Oct 6 account snapshot: 9,000 credits remained
 * and the portal said roughly seven days until renewal. The portal did not
 * establish an exact timestamp, so there is deliberately no hard-coded reset
 * date here. FR24_CREDIT_RESET_AT plus FR24_REMAINING_CREDITS can provide the
 * exact rolling calculation once the account date is confirmed; an explicit
 * FR24_DAILY_CREDIT_CAP always wins. */
export function fr24DailyCreditCap(now = Date.now(), env: NodeJS.ProcessEnv = process.env): number {
  const explicit = positiveInt(env.FR24_DAILY_CREDIT_CAP);
  if (explicit) return explicit;
  const configuredReset = Date.parse(env.FR24_CREDIT_RESET_AT ?? "");
  const configuredRemaining = positiveInt(env.FR24_REMAINING_CREDITS);
  if (configuredRemaining && Number.isFinite(configuredReset) && configuredReset > now) {
    const days = Math.max(1, Math.ceil((configuredReset - now) / DAY_MS));
    return Math.max(1, Math.floor((configuredRemaining / days) * 0.8));
  }
  if (!Number.isFinite(configuredReset)) {
    // Keep the emergency allowance flat. Re-dividing the original snapshot by
    // fewer assumed days would spend the same "remaining" credits repeatedly.
    return Math.max(1, Math.floor((INITIAL_REMAINING_CREDITS / INITIAL_DAYS_UNTIL_RESET) * 0.8));
  }
  const monthly = positiveInt(env.FR24_MONTHLY_CREDIT_LIMIT) ?? DEFAULT_MONTHLY_CREDITS;
  const billingDays = positiveInt(env.FR24_BILLING_PERIOD_DAYS) ?? DEFAULT_BILLING_DAYS;
  return Math.max(1, Math.floor((monthly / billingDays) * 0.8));
}

export function fr24Endpoint(path: string): Fr24Endpoint {
  const endpoint = path.split("?")[0];
  if (endpoint === "/live/flight-positions/full" || endpoint === "/flight-tracks"
    || endpoint === "/flight-summary/full" || endpoint === "/flight-summary/light") return endpoint;
  return "unknown";
}

function rows(value: any): any[] {
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value)) return value;
  return [];
}

function historicAgeDays(row: any, now: number): number {
  const raw = row?.first_seen ?? row?.datetime_takeoff ?? row?.datetime_landed ?? row?.last_seen;
  const at = typeof raw === "number" ? raw * 1000 : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? Math.max(0, (now - at) / DAY_MS) : 0;
}

export function fr24CreditsForResponse(path: string, value: unknown, now = Date.now()): { credits: number; resultCount: number } {
  const endpoint = fr24Endpoint(path);
  if (endpoint === "/flight-tracks") {
    const present = Array.isArray((value as any)?.tracks) || Array.isArray((value as any)?.data?.[0]?.tracks);
    return { credits: present ? 40 : 1, resultCount: present ? 1 : 0 };
  }
  const data = rows(value);
  if (!data.length) return { credits: 1, resultCount: 0 };
  if (endpoint === "/live/flight-positions/full") return { credits: data.length * 8, resultCount: data.length };
  if (endpoint === "/flight-summary/light" || endpoint === "/flight-summary/full") {
    const full = endpoint.endsWith("/full");
    const credits = data.reduce((sum, row) => {
      if (row?.flight_ended === false) return sum + (full ? 2 : 1);
      const old = historicAgeDays(row, now) > 30;
      return sum + (full ? old ? 6 : 3 : old ? 3 : 2);
    }, 0);
    return { credits, resultCount: data.length };
  }
  return { credits: 1, resultCount: data.length };
}

/** Pessimistic reservation made before the response reveals its exact cost. */
export function fr24MaxCredits(path: string): number {
  const endpoint = fr24Endpoint(path);
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  const limit = Math.max(1, Math.min(20, Number(params.get("limit")) || 1));
  if (endpoint === "/live/flight-positions/full") return 8 * limit;
  if (endpoint === "/flight-tracks") return 40;
  if (endpoint === "/flight-summary/full") return 6 * Math.min(limit, 10);
  if (endpoint === "/flight-summary/light") return 3 * Math.min(limit, 10);
  return 1;
}
