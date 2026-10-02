import ends from "./runway-ends.json" with { type: "json" };
import { pickArrivalRunway, type AtisEntry, type ExpectedArrivalRunway, type RunwayEnd } from "./arrival-runway.ts";

const TTL = 5 * 60_000;
const cache = new Map<string, { expires: number; value: Promise<AtisEntry[]> }>();
const choices = new Map<string, { at: number; runway: ExpectedArrivalRunway; side?: number }>();
export async function loadArrivalAtis(icao: string): Promise<AtisEntry[]> {
  if (!/^[A-Z0-9]{4}$/.test(icao)) return [];
  const existing = cache.get(icao);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = (async () => {
    try {
      // Public JSON API; datis.clowd.io remains the compatible endpoint for atis.info.
      const res = await fetch(`https://datis.clowd.io/api/${icao}`, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
      if (!res.ok) return [];
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return [];
      return data.filter((e): e is AtisEntry => {
        if (e?.airport !== icao || typeof e?.datis !== "string" || typeof e?.type !== "string") return false;
        const stamp = typeof e.updatedAt === "string" ? Date.parse(e.updatedAt.endsWith("Z") ? e.updatedAt : e.updatedAt + "Z") : NaN;
        // Unknown or stale bulletin times must fall through, never look current.
        if (!Number.isFinite(stamp) || Date.now() - stamp > 90 * 60_000 || stamp > Date.now() + 60_000) return false;
        const hhmm = e.datis.match(/\b(\d{2})(\d{2})Z\b/);
        if (!hhmm || +hhmm[1] > 23 || +hhmm[2] > 59) return false;
        const issued = new Date(); issued.setUTCHours(+hhmm[1], +hhmm[2], 0, 0);
        if (issued.getTime() > Date.now() + 5 * 60_000) issued.setUTCDate(issued.getUTCDate() - 1);
        return Date.now() - issued.getTime() <= 90 * 60_000;
      });
    } catch { return []; }
  })();
  if (cache.size > 100) for (const [key, v] of cache) if (v.expires <= Date.now()) cache.delete(key);
  cache.set(icao, { expires: Date.now() + TTL, value });
  return value;
}
export async function expectedArrivalRunway(icao: string, flightKey: string, input: Omit<Parameters<typeof pickArrivalRunway>[0], "ends" | "atis" | "previous">) {
  const runways = (ends as Record<string, RunwayEnd[]>)[icao] ?? [];
  if (!runways.length) return { runway: null, side: undefined };
  for (const [key, v] of choices) if (Date.now() - v.at > 30 * 60_000) choices.delete(key);
  const previous = choices.get(flightKey);
  const runway = pickArrivalRunway({ ...input, ends: runways, atis: await loadArrivalAtis(icao), previous: previous?.runway });
  if (runway) choices.set(flightKey, { at: Date.now(), runway, ...(previous?.runway.runway === runway.runway ? { side: previous.side } : {}) });
  return { runway, side: choices.get(flightKey)?.side };
}
export function rememberArrivalSide(flightKey: string, side: number) {
  const existing = choices.get(flightKey); if (existing) existing.side = side;
}
