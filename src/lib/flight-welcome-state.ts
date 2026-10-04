import type { CompiledBrief } from "./brief-copy.ts";
import { operationalDepartureUnix } from "./flight-story-date.ts";
import { parseFlightQuery } from "./flight-parse.ts";
import { storyLegDate } from "./flight-story-date.ts";
import type { FlightStory } from "./types.ts";

const STORAGE_KEY = "inbound-welcome-dismissals-v1";
const MAX_RECORDS = 30;
const MAX_SIGNALS = 80;

type WelcomeSignal = { key: string; at: number };
type WelcomeDismissal = { dismissedAt: number; seen: string[]; stateKey?: string | null };
type WelcomeRecords = Record<string, WelcomeDismissal>;
type WelcomeStorage = Pick<Storage, "getItem" | "setItem">;
type WelcomeOptions = { storage?: WelcomeStorage; legDate?: string | null };
let volatileRecords: WelcomeRecords = {};
const blockedStorage = new WeakSet<object>();

function storageOrNull(storage?: WelcomeStorage): WelcomeStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readRecords(storage?: WelcomeStorage): WelcomeRecords {
  try {
    const target = storageOrNull(storage);
    if (!target) return volatileRecords;
    if (blockedStorage.has(target)) return volatileRecords;
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, WelcomeDismissal] => {
      const value = entry[1] as Partial<WelcomeDismissal> | null;
      return Boolean(value && Number.isFinite(value.dismissedAt) && Array.isArray(value.seen)
        && value.seen.every((signal) => typeof signal === "string")
        && (value.stateKey == null || typeof value.stateKey === "string"));
    }));
  } catch {
    return volatileRecords;
  }
}

function writeRecords(records: WelcomeRecords, storage?: WelcomeStorage) {
  const latest = Object.entries(records)
    .filter(([, value]) => Number.isFinite(value?.dismissedAt) && Array.isArray(value?.seen))
    .sort((a, b) => b[1].dismissedAt - a[1].dismissedAt)
    .slice(0, MAX_RECORDS);
  const next = Object.fromEntries(latest);
  try {
    const target = storageOrNull(storage);
    if (!target) {
      volatileRecords = next;
      return;
    }
    target.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Preserve the dismissal for this tab when browser storage is blocked.
    const target = storageOrNull(storage);
    if (target) blockedStorage.add(target);
    volatileRecords = next;
  }
}

/** Stable requested, dated leg identity; provider IDs never participate. */
export function welcomeLegKey(story: FlightStory, legDate?: string | null): string {
  const requested = welcomeIdent(story);
  const date = legDate ?? storyLegDate(story, story.origin.tz || "UTC")
    ?? storyLegDate(story)
    ?? new Date(story.fetchedAt).toISOString().slice(0, 10);
  return `welcome:v1:${requested}|${date}|${story.origin.iata}|${story.dest.iata}`;
}

function welcomeIdent(story: FlightStory) {
  return parseFlightQuery(story.query)?.callsign
    ?? parseFlightQuery(story.iata)?.callsign
    ?? story.callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function matchingFallbackAlias(story: FlightStory, primaryKey: string, records: WelcomeRecords) {
  if (!story.stateKey?.startsWith("leg:v1:")) return null;
  const unix = operationalDepartureUnix(story);
  if (unix == null) return null;
  const date = new Date(unix * 1000).toISOString().slice(0, 10);
  const aliasKey = welcomeLegKey(story, date);
  if (aliasKey === primaryKey) return null;
  const record = records[aliasKey];
  const expectedStateKey = `leg:unvalidated:${welcomeIdent(story)}|${story.origin.iata}|${story.dest.iata}|${date}`;
  return record?.stateKey === expectedStateKey ? { aliasKey, record } : null;
}

function sameSignal(left: string, right: string) {
  if (left === right) return true;
  const parse = (key: string) => key.match(/^brief:(\d+):([^:]+):(.*)$/s);
  const a = parse(left), b = parse(right);
  if (!a || !b || a[2] !== b[2] || a[3] !== b[3]) return false;
  // Mirrors Briefing's existing duplicate gate: identical stage milestones
  // are one event, while other repeated wording qualifies again after 12 min.
  return a[2] === "stage" || Math.abs(Number(a[1]) - Number(b[1])) < 12 * 60_000;
}

/** Curated Briefing entries are the app's existing meaningful-update gate. */
export function welcomeSummarySignals(story: FlightStory, brief: CompiledBrief | null): WelcomeSignal[] {
  const signals: WelcomeSignal[] = (brief?.log ?? []).map((entry) => ({
    key: `brief:${entry.at}:${entry.kind}:${entry.text}`,
    at: Number.isFinite(entry.at) ? entry.at : story.fetchedAt,
  }));
  if (story.diversion) signals.push({
    key: `diversion:${story.diversion.originalDestination ?? ""}:${story.diversion.destination ?? ""}`,
    at: story.diversion.reportedAt,
  });
  if (story.inboundDiversion) signals.push({
    key: `inbound-diversion:${story.inboundDiversion.flightId}:${story.inboundDiversion.destination ?? ""}`,
    at: story.inboundDiversion.reportedAt,
  });
  return [...new Map(signals.map((signal) => [signal.key, signal])).values()];
}

export function welcomeSummaryVersion(story: FlightStory, brief: CompiledBrief | null): string {
  return welcomeSummarySignals(story, brief)
    .map((signal) => signal.key)
    .sort()
    .join("\n");
}

export function dismissWelcomeSummary(
  story: FlightStory,
  brief: CompiledBrief | null,
  now = Date.now(),
  options: WelcomeOptions = {},
) {
  const records = readRecords(options.storage);
  records[welcomeLegKey(story, options.legDate)] = {
    dismissedAt: now,
    seen: welcomeSummarySignals(story, brief).map((signal) => signal.key).slice(-MAX_SIGNALS),
    stateKey: story.stateKey,
  };
  writeRecords(records, options.storage);
}

export function shouldOpenWelcomeSummary(
  story: FlightStory,
  brief: CompiledBrief | null,
  options: WelcomeOptions = {},
): boolean {
  const records = readRecords(options.storage);
  const key = welcomeLegKey(story, options.legDate);
  let record = records[key];
  if (!record && options.legDate == null) {
    const alias = matchingFallbackAlias(story, key, records);
    if (alias) {
      record = alias.record;
      records[key] = alias.record;
      delete records[alias.aliasKey];
      writeRecords(records, options.storage);
    }
  }
  if (!record) return true;
  const signals = welcomeSummarySignals(story, brief);
  const unseen = signals.filter((signal) => !record.seen.some((seen) => sameSignal(signal.key, seen)));
  return unseen.length > 0;
}
