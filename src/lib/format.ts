export function fieldClock(tz: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function fieldDate(tz: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(date);
}

export function logWhen(ts: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
}

export function headingText(deg: number | null) {
  if (deg == null || !Number.isFinite(deg)) return "—";
  return `${String(Math.round(deg)).padStart(3, "0")}°`;
}

/** Passenger-facing slip vs the original push. Null = on time or unknown. */
export function delayPhrase(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min)) return null;
  const n = Math.round(min);
  if (n >= 5) return `+${n} min`;
  if (n <= -8) return `${Math.abs(n)} min early`;
  return null;
}

export function agoLabel(at: number, fetching: boolean): string {
  if (fetching) return "Checking weather, chop, and times";
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 8) return "Whole brief just updated";
  if (sec < 60) return `Brief from ${sec}s ago`;
  const min = Math.round(sec / 60);
  return `Brief from ${min} min ago`;
}