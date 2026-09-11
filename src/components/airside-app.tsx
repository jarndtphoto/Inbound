import { useQuery } from "@tanstack/react-query";
import { BookOpen, CloudSun, Radar, Rows3 } from "lucide-react";
import { useEffect, useState } from "react";
import { airportByIcao } from "@/lib/airports";
import { fieldClock } from "@/lib/format";
import { getField } from "@/lib/sky";
import { useAirside } from "@/lib/store";
import type { TabId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AircraftDetail } from "./aircraft-detail";
import { AirportPicker } from "./airport-picker";
import { FieldPanel } from "./field-panel";
import { LogPanel } from "./log-panel";
import { RadarScope } from "./radar-scope";
import { SeatPanel } from "./seat-panel";
import { TrafficList } from "./traffic-list";

const TABS: { id: TabId; label: string; icon: typeof Radar }[] = [
  { id: "sky", label: "Sky", icon: Radar },
  { id: "field", label: "Field", icon: CloudSun },
  { id: "seat", label: "Seat", icon: Rows3 },
  { id: "log", label: "Log", icon: BookOpen },
];

export function AirsideApp() {
  const icao = useAirside((s) => s.icao);
  const tab = useAirside((s) => s.tab);
  const setTab = useAirside((s) => s.setTab);
  const hydrate = useAirside((s) => s.hydrate);
  const [picker, setPicker] = useState(false);
  const [ready, setReady] = useState(false);
  const ap = airportByIcao(icao);

  useEffect(() => {
    hydrate();
    setReady(true);
  }, [hydrate]);

  const query = useQuery({
    queryKey: ["field", icao],
    queryFn: () => getField({ data: { icao } }),
    enabled: ready,
    refetchInterval: 20_000,
  });

  const snap = query.data;
  const traffic = snap?.traffic ?? [];
  const rangeNm = useAirside((s) => s.rangeNm);
  const inRange = traffic.filter((t) => t.distNm <= rangeNm + 0.4);
  const airborne = inRange.filter((t) => !t.onGround).length;
  const onField = inRange.filter((t) => t.onGround).length;
  const heavies = inRange.filter((t) => t.widebody).length;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="font-display text-2xl leading-none tracking-[0.18em] text-fg">AIRSIDE</p>
            <p className="mt-1 text-xs text-muted">The hour around the flight</p>
          </div>
          <button
            type="button"
            aria-label="Select field"
            onClick={() => setPicker(true)}
            className="flex h-12 min-w-12 items-center gap-3 rounded-md border border-border bg-surface px-3 text-left"
          >
            <span>
              <span className="block font-display text-xl leading-none tracking-wide text-fg">
                {ap?.iata ?? icao}
              </span>
              <span className="block font-mono text-xs tabular-nums text-muted">
                {ap ? fieldClock(ap.tz) : "—"}
              </span>
            </span>
          </button>
        </div>
        <nav className="mx-auto hidden max-w-6xl px-4 pb-3 lg:block">
          <TabRow tab={tab} onTab={setTab} />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 lg:pb-12">
        {tab === "sky" ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
            <div className="stagger-in">
              <RadarScope traffic={traffic} loading={query.isLoading} />
              <dl className="mt-3 grid grid-cols-3 gap-2">
                <Stat k="Airborne" v={query.isLoading && !snap ? "—" : airborne} />
                <Stat k="On field" v={query.isLoading && !snap ? "—" : onField} />
                <Stat k="Heavies" v={query.isLoading && !snap ? "—" : heavies} />
              </dl>
              {snap?.error ? <p className="mt-3 text-sm text-mvfr">{snap.error}</p> : null}
              {query.isError ? (
                <p className="mt-3 text-sm text-ifr">Could not reach the sky feed. Try another field.</p>
              ) : null}
            </div>
            <div className="stagger-in">
              {query.isLoading && !snap ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-14 rounded-lg border border-border bg-surface" />
                  ))}
                </div>
              ) : (
                <TrafficList traffic={traffic} />
              )}
            </div>
          </div>
        ) : null}
        {tab === "field" ? <FieldPanel snap={snap} /> : null}
        {tab === "seat" ? <SeatPanel /> : null}
        {tab === "log" ? <LogPanel /> : null}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <TabRow tab={tab} onTab={setTab} />
      </nav>

      {picker ? <AirportPicker onClose={() => setPicker(false)} /> : null}
      <AircraftDetail traffic={traffic} />
    </div>
  );
}

function TabRow({ tab, onTab }: { tab: TabId; onTab: (t: TabId) => void }) {
  return (
    <div className="flex">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={cn(
              "flex h-14 flex-1 flex-col items-center justify-center gap-1 text-xs md:h-11 md:flex-row md:rounded-full md:px-4",
              active ? "text-fg" : "text-subtle",
            )}
          >
            <Icon className="size-4" />
            <span className="font-medium tracking-wide">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-3">
      <dt className="font-mono text-xs tracking-[0.16em] text-subtle uppercase">{k}</dt>
      <dd className="mt-1 font-display text-2xl tabular-nums leading-none text-fg">{v}</dd>
    </div>
  );
}
