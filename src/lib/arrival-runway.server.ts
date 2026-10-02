import ends from "./runway-ends.json" with { type: "json" };
import { arrivalRunways, normalizeRunway, pickArrivalRunway, type AtisEntry, type ExpectedArrivalRunway, type RunwayEnd } from "./arrival-runway.ts";
import { arrivalStateStore } from "./arrival-state-store.server.ts";

const TTL = 5 * 60_000;
const cache = new Map<string, { expires: number; value: Promise<AtisEntry[]> }>();
export function clearArrivalAtisMemoryCache() { cache.clear(); }
export async function loadArrivalAtis(icao: string, store = arrivalStateStore): Promise<AtisEntry[]> {
  if (!/^[A-Z0-9]{4}$/.test(icao)) return [];
  const existing = cache.get(icao);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = (async () => {
    const recent = await store.loadAtis(icao, Date.now(), 5 * 60_000);
    if (recent.length) return recent;
    try {
      // Public JSON API; datis.clowd.io remains the compatible endpoint for atis.info.
      const res = await fetch(`https://datis.clowd.io/api/${icao}`, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`ATIS HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid ATIS response");
      const entries = data.filter((e): e is AtisEntry => {
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
      if (entries.length) { await store.saveAtis(icao, entries); return entries; }
      return await store.loadAtis(icao);
    } catch (error) {
      const held = await store.loadAtis(icao);
      console.info("[arrival-atis] fetch fallback", { airport: icao, held: held.length > 0, error: String(error) });
      return held;
    }
  })();
  if (cache.size > 100) for (const [key, v] of cache) if (v.expires <= Date.now()) cache.delete(key);
  cache.set(icao, { expires: Date.now() + TTL, value });
  return value;
}
export async function expectedArrivalRunway(icao: string, input: Omit<Parameters<typeof pickArrivalRunway>[0], "ends" | "atis">, store = arrivalStateStore) {
  const runways = (ends as Record<string, RunwayEnd[]>)[icao] ?? [];
  if (!runways.length) return null;
  const atis = await loadArrivalAtis(icao, store);
  const arrivals = atis.filter(e => !["dep", "departure"].includes(e.type)).flatMap(e => arrivalRunways(e.datis));
  const reported = runways.find(r => normalizeRunway(r.ident) === normalizeRunway(input.providerRunway ?? ""));
  // An explicitly reported runway supersedes an estimate. Missing ATIS or
  // changing wind cannot revoke an already selected arrival runway.
  if (reported) return pickArrivalRunway({ ...input, ends: runways, actualLanding: true });
  if (input.previous && (!arrivals.length || arrivals.includes(input.previous.runway))) return input.previous;
  return pickArrivalRunway({ ...input, ends: runways, atis });
}
