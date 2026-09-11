import { useMemo, useState } from "react";
import { AIRPORTS } from "@/lib/airports";
import { fieldClock } from "@/lib/format";
import { useAirside } from "@/lib/store";

export function AirportPicker({ onClose }: { onClose: () => void }) {
  const icao = useAirside((s) => s.icao);
  const setIcao = useAirside((s) => s.setIcao);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return AIRPORTS;
    return AIRPORTS.filter((a) =>
      `${a.icao} ${a.iata} ${a.city} ${a.name}`.toLowerCase().includes(s),
    );
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close picker" className="absolute inset-0 bg-bg/70" onClick={onClose} />
      <div className="relative m-3 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface">
        <div className="border-b border-border p-4">
          <p className="font-display text-sm tracking-[0.18em] text-muted uppercase">Select field</p>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ORD, Heathrow, Tokyo…"
            className="mt-3 h-12 w-full rounded-md border border-border bg-bg px-3 text-fg placeholder:text-subtle"
          />
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {list.map((a) => {
            const active = a.icao === icao;
            return (
              <li key={a.icao}>
                <button
                  type="button"
                  onClick={() => {
                    setIcao(a.icao);
                    onClose();
                  }}
                  className={`flex min-h-14 w-full items-center justify-between rounded-md px-3 py-3 text-left ${
                    active ? "bg-surface-2" : "hover:bg-bg"
                  }`}
                >
                  <span>
                    <span className="block font-display text-xl tracking-wide text-fg">
                      {a.iata}
                      <span className="ml-2 font-sans text-sm font-normal text-muted">
                        {a.city}
                      </span>
                    </span>
                    <span className="block text-xs text-subtle">
                      {a.icao} · {a.name}
                    </span>
                  </span>
                  <span className="font-mono text-sm tabular-nums text-muted">{fieldClock(a.tz)}</span>
                </button>
              </li>
            );
          })}
          {list.length === 0 ? (
            <li className="px-3 py-8 text-center text-sm text-muted">No matching field</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
