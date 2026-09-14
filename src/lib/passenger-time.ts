export function destinationGateTime(gateUnix: number | null | undefined, gateText: string | null | undefined, timeZone?: string): string {
  if (gateUnix != null && Number.isFinite(gateUnix)) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(gateUnix * 1000);
    } catch { /* Use the already formatted provider display below. */ }
  }
  return gateText || "Awaiting update";
}
