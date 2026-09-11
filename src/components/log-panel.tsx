import { useState } from "react";
import { toast } from "sonner";
import { AIRPORTS } from "@/lib/airports";
import { logWhen } from "@/lib/format";
import { useAirside } from "@/lib/store";
import { Button } from "./ui/button";

export function LogPanel() {
  const log = useAirside((s) => s.log);
  const addLog = useAirside((s) => s.addLog);
  const removeLog = useAirside((s) => s.removeLog);
  const icao = useAirside((s) => s.icao);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(icao);
  const [to, setTo] = useState("KLAX");
  const [flight, setFlight] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">Personal</p>
          <h2 className="mt-1 font-display text-4xl tracking-tight text-fg">Log</h2>
          <p className="mt-2 max-w-md text-sm text-muted">
            Tails you spotted, trips you flew. Stored on this device.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Add trip"}
        </Button>
      </header>

      {open ? (
        <form
          className="rounded-xl border border-border bg-surface p-5"
          onSubmit={(e) => {
            e.preventDefault();
            const o = AIRPORTS.find((a) => a.icao === from);
            const d = AIRPORTS.find((a) => a.icao === to);
            addLog({
              kind: "trip",
              airport: o?.iata ?? from,
              callsign: flight.trim().toUpperCase() || undefined,
              from: o?.iata ?? from,
              to: d?.iata ?? to,
              notes: notes.trim() || undefined,
            });
            toast("Trip saved");
            setFlight("");
            setNotes("");
            setOpen(false);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">From</span>
              <select
                className="mt-2 h-12 w-full rounded-md border border-border bg-bg px-3 text-fg"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                {AIRPORTS.map((a) => (
                  <option key={a.icao} value={a.icao}>
                    {a.iata} · {a.city}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">To</span>
              <select
                className="mt-2 h-12 w-full rounded-md border border-border bg-bg px-3 text-fg"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              >
                {AIRPORTS.map((a) => (
                  <option key={a.icao} value={a.icao}>
                    {a.iata} · {a.city}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-3 block text-sm">
            <span className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">
              Flight number
            </span>
            <input
              value={flight}
              onChange={(e) => setFlight(e.target.value)}
              placeholder="UA 215"
              className="mt-2 h-12 w-full rounded-md border border-border bg-bg px-3 text-fg placeholder:text-subtle"
            />
          </label>
          <label className="mt-3 block text-sm">
            <span className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">Note</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Window, 14A, A321neo…"
              className="mt-2 h-12 w-full rounded-md border border-border bg-bg px-3 text-fg placeholder:text-subtle"
            />
          </label>
          <Button className="mt-4" type="submit">
            Save trip
          </Button>
        </form>
      ) : null}

      {log.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          Log a tail from the sky tab, or add a trip you flew.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {log.map((e) => (
            <li
              key={e.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3"
            >
              <div className="min-w-0">
                <p className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">
                  {e.kind} · {logWhen(e.at)}
                </p>
                <p className="mt-1 font-medium text-fg">
                  {e.kind === "trip"
                    ? `${e.from ?? "?"} → ${e.to ?? "?"} ${e.callsign ? `· ${e.callsign}` : ""}`
                    : e.callsign || e.registration || "Sighting"}
                </p>
                <p className="truncate text-sm text-muted">
                  {[e.airport, e.registration, e.typeName || e.type, e.notes]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                className="h-11 px-2 text-xs text-subtle hover:text-fg"
                onClick={() => removeLog(e.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
