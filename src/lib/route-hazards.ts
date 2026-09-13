import type { Hazard } from "./types.ts";

/** Display only provider-supplied validity times, never the app fetch time. */
export function advisoryTiming(properties: Record<string, unknown> | null | undefined): string {
  const format = (value: unknown): string | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const compact = value.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/);
    const stamp = Date.parse(compact
      ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:00Z`
      : value);
    if (!Number.isFinite(stamp)) return null;
    return new Date(stamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  };
  const from = format(properties?.validTimeFrom);
  const to = format(properties?.validTimeTo);
  if (from || to) return [from && `Valid from ${from}`, to && `until ${to}`].filter(Boolean).join(" · ");
  const at = format(properties?.validTime);
  return at ? `Forecast valid at ${at}` : "Validity time unavailable";
}

/** Keep upcoming warnings distinct from otherwise identical warnings passed. */
export function distinctRouteHazards(hazards: Hazard[]): Hazard[] {
  const seen = new Set<string>();
  return hazards.filter((hazard) => {
    const key = `${hazard.kind}:${hazard.label}:${hazard.chop}:${hazard.remaining}:${hazard.validity ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function upcomingStorms(hazards: Hazard[]): Hazard[] {
  return hazards.filter((h) => h.remaining && h.kind === "convective" &&
    Number.isFinite(h.lat) && Number.isFinite(h.lon)).slice(0, 6);
}
