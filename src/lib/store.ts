import { create } from "zustand";
import { AIRPORT_BY_ICAO, DEFAULT_ICAO } from "./airports";
import type { LogEntry, TabId } from "./types";

const Q_KEY = "filed-q-v1";
const RECENTS_KEY = "filed-recents-v1";
const WX_KEY = "filed-wx-v1";
const STAGE_KEY = "filed-stage-v1";
const LOG_KEY = "airside-log-v1";
const ICAO_KEY = "airside-icao-v1";

type StagePref = "auto" | "inbound" | "push" | "taxi" | "ride" | "arrival" | "gate";

function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

type FiledState = {
  query: string;
  recents: string[];
  stage: StagePref;
  hydrated: boolean;
  weatherOn: boolean;
  setQuery: (q: string) => void;
  setStage: (s: FiledState["stage"]) => void;
  setWeatherOn: (on: boolean) => void;
  hydrate: () => void;
};

export const useFiled = create<FiledState>((set, get) => ({
  query: "AA 1",
  recents: [],
  stage: "auto",
  hydrated: false,
  weatherOn: false,
  setQuery: (q) => {
    const query = q.trim();
    const recents = [query, ...get().recents.filter((r) => r.toUpperCase() !== query.toUpperCase())].slice(0, 6);
    set({ query, recents, stage: "auto" });
    lsSet(Q_KEY, query);
    lsSet(RECENTS_KEY, JSON.stringify(recents));
    lsSet(STAGE_KEY, "auto");
  },
  setStage: (stage) => {
    set({ stage });
    lsSet(STAGE_KEY, stage);
  },
  setWeatherOn: (weatherOn) => {
    set({ weatherOn });
    lsSet(WX_KEY, weatherOn ? "1" : "0");
  },
  hydrate: () => {
    try {
      const q = localStorage.getItem(Q_KEY);
      const raw = localStorage.getItem(RECENTS_KEY);
      const wx = localStorage.getItem(WX_KEY);
      set({
        query: q && q.length < 20 ? q : get().query || "AA 1",
        recents: raw ? (JSON.parse(raw) as string[]) : [],
        weatherOn: wx === "1",
        stage: "auto",
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },
}));

type AirsideState = {
  icao: string;
  tab: TabId;
  selectedHex: string | null;
  rangeNm: number;
  log: LogEntry[];
  hydrated: boolean;
  setIcao: (icao: string) => void;
  setTab: (tab: TabId) => void;
  select: (hex: string | null) => void;
  setRange: (nm: number) => void;
  addLog: (e: Omit<LogEntry, "id" | "at"> & { at?: number; id?: string }) => void;
  removeLog: (id: string) => void;
  hydrate: () => void;
};

export const useAirside = create<AirsideState>((set, get) => ({
  icao: DEFAULT_ICAO,
  tab: "sky",
  selectedHex: null,
  rangeNm: 25,
  log: [],
  hydrated: false,
  setIcao: (icao) => {
    set({ icao, selectedHex: null });
    try {
      localStorage.setItem(ICAO_KEY, icao);
    } catch {
      /* ignore */
    }
  },
  setTab: (tab) => set({ tab }),
  select: (hex) => set({ selectedHex: hex }),
  setRange: (nm) => set({ rangeNm: nm }),
  addLog: (e) => {
    const entry: LogEntry = {
      id: e.id ?? (crypto.randomUUID?.() ?? String(Date.now())),
      at: e.at ?? Date.now(),
      kind: e.kind,
      airport: e.airport,
      callsign: e.callsign,
      registration: e.registration,
      type: e.type,
      typeName: e.typeName,
      notes: e.notes,
      from: e.from,
      to: e.to,
    };
    const log = [entry, ...get().log].slice(0, 200);
    set({ log });
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch {
      /* ignore */
    }
  },
  removeLog: (id) => {
    const log = get().log.filter((x) => x.id !== id);
    set({ log });
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch {
      /* ignore */
    }
  },
  hydrate: () => {
    if (get().hydrated) return;
    try {
      const icao = localStorage.getItem(ICAO_KEY);
      const raw = localStorage.getItem(LOG_KEY);
      set({
        icao: icao && AIRPORT_BY_ICAO[icao] ? icao : DEFAULT_ICAO,
        log: raw ? (JSON.parse(raw) as LogEntry[]) : [],
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },
}));
