/** Use the reported kind, even when an estimate happens to equal the schedule. */
export function timeKindLabel(kind: string | null | undefined, event?: string): string {
  const label = kind === "actual" ? "Actual" : kind === "estimated" ? "Estimated" : kind === "scheduled" ? "Scheduled" : "";
  if (!event) return label;
  return label ? `${label} ${event}` : event.charAt(0).toUpperCase() + event.slice(1);
}

/** Milliseconds; without a zone, update clocks use the device's local zone. */
export function formatClockTime(at: number, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(at);
  }
}
