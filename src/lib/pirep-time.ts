const MAX_REPORT_AGE_MS = 2 * 60 * 60 * 1000;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/** Report occurrence time, in milliseconds; future observations are unusable. */
export function isFreshPilotReport(observedAt: number | undefined, now = Date.now()): boolean {
  return typeof observedAt === "number" && Number.isFinite(observedAt) && observedAt > 0 &&
    Number.isFinite(now) && observedAt <= now && now - observedAt <= MAX_REPORT_AGE_MS;
}

/**
 * AWC's JSON/GeoJSON obsTime is a numeric UNIX epoch in seconds. receiptTime
 * is a separate UTC string: https://aviationweather.gov/data/schema/openapi.yaml
 * Raw /TM has only four UTC digits: https://aviationweather.gov/help/data/#pireps
 */
export function observationTime(
  properties: Record<string, unknown> | null | undefined,
  raw: string,
  now = Date.now(),
): number | null {
  if (!Number.isFinite(now)) return null;
  const supplied = properties?.obsTime;
  if (supplied != null) {
    // Do not reinterpret malformed/future structured data or rejuvenate a
    // dated stale report using the undated /TM field.
    if (typeof supplied !== "number" || !Number.isFinite(supplied) || supplied <= 0) return null;
    const stamp = supplied * 1000;
    return Number.isFinite(stamp) && stamp <= now ? stamp : null;
  }

  // The API does not document its default age window. A recent, dated receipt
  // anchors raw-only /TM; fetch time alone cannot establish an occurrence date.
  const receipt = properties?.receiptTime;
  if (typeof receipt !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/i.test(receipt)) return null;
  const normalized = receipt.replace(" ", "T");
  const receivedAt = Date.parse(normalized);
  if (!isFreshPilotReport(receivedAt, now) ||
    new Date(receivedAt).toISOString().slice(0, 19) !== normalized.slice(0, 19)) return null;
  const times = [...raw.matchAll(/\/TM\s*(\d{2})(\d{2})(?=\s|\/|$)/gi)];
  if (times.length !== 1) return null;
  const hour = Number(times[0]![1]), minute = Number(times[0]![2]);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(receivedAt);
  let stamp = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  // Resolve a report received after UTC midnight to the latest occurrence
  // before receipt, then reject it unless it still lies in the two-hour window.
  if (stamp > receivedAt) stamp -= UTC_DAY_MS;
  return isFreshPilotReport(stamp, now) ? stamp : null;
}
