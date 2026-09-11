import { useEffect, useMemo, useState } from "react";
import { AIRPORTS, airportByIcao } from "@/lib/airports";
import {
  compass16,
  haversineNm,
  initialBearing,
  solarAzimuth,
  solarElevation,
  wingSide,
  relativeBearing,
} from "@/lib/geo";
import { useAirside } from "@/lib/store";
import { cn } from "@/lib/utils";

type When = "now" | "morning" | "afternoon" | "night";

function whenDate(tz: string, when: When): Date {
  if (when === "now") return new Date();
  const hour = when === "morning" ? 8 : when === "afternoon" ? 15 : 21;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const local = `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:00:00`;
  return new Date(local);
}

export function SeatPanel() {
  const icao = useAirside((s) => s.icao);
  const originDefault = airportByIcao(icao)?.icao ?? "KORD";
  const [fromIcao, setFrom] = useState(originDefault);
  const [toIcao, setTo] = useState(fromIcao === "KLAX" ? "KJFK" : "KLAX");
  const [when, setWhen] = useState<When>("now");

  useEffect(() => {
    setFrom(originDefault);
  }, [originDefault]);

  const from = airportByIcao(fromIcao);
  const to = airportByIcao(toIcao);

  const result = useMemo(() => {
    if (!from || !to || from.icao === to.icao) return null;
    const heading = initialBearing(from, to);
    const nm = haversineNm(from, to);
    const hours = nm / 470;
    const date = whenDate(from.tz, when);
    const sunAz = solarAzimuth(from, date);
    const sunEl = solarElevation(from, date);
    const rel = relativeBearing(heading, sunAz);
    const side = sunEl < 0 ? null : wingSide(rel);
    const destRel = 0; // destination is ahead on the great-circle
    void destRel;
    const sit =
      side === "starboard"
        ? "right"
        : side === "port"
          ? "left"
          : side === "ahead"
            ? "either — sun is over the nose"
            : side === "astern"
              ? "either — sun is behind"
              : "either";
    const shade =
      sit === "left" ? "right" : sit === "right" ? "left" : "either";
    return { heading, nm, hours, sunAz, sunEl, rel, side, sit, shade, date };
  }, [from, to, when]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">Window brief</p>
        <h2 className="mt-1 font-display text-4xl tracking-tight text-fg">Which side to sit</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
          Cruise heading and the sun — not a seat map. Use it to pick a wing for light, shade, or a
          city on departure. Runways still have the last word.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="From" value={fromIcao} onChange={setFrom} />
        <SelectField label="To" value={toIcao} onChange={setTo} />
      </div>

      <div className="flex flex-wrap gap-2">
        {(["now", "morning", "afternoon", "night"] as When[]).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWhen(w)}
            className={cn(
              "h-11 rounded-full px-4 text-sm capitalize",
              when === w ? "bg-accent text-accent-fg" : "border border-border bg-surface text-muted",
            )}
          >
            {w}
          </button>
        ))}
      </div>

      {result && from && to ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="font-mono text-xs tracking-[0.18em] text-muted uppercase">
            {from.iata} → {to.iata} · {Math.round(result.nm)} nm · {result.hours < 1.5 ? `${Math.round(result.hours * 60)} min` : `${result.hours.toFixed(1)} h`}
          </p>
          <p className="mt-4 font-display text-5xl leading-none tracking-tight text-fg">
            {result.sunEl < 0 ? "Night sector" : result.sit === "either — sun is over the nose" || result.sit === "either — sun is behind" || result.sit === "either" ? "Either side" : `Sit ${result.sit}`}
          </p>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            {result.sunEl < -6
              ? "The sun is down. Pick a wing for the view instead — city lights on departure, or the destination on arrival."
              : result.sit === "left" || result.sit === "right"
                ? `On a typical heading of ${Math.round(result.heading)}° (${compass16(result.heading)}), the sun sits off the ${result.sit} wing. Sit ${result.shade} if you want shade to sleep or work.`
                : `Heading ${Math.round(result.heading)}° (${compass16(result.heading)}). The sun is more ahead or behind than off a wing — light will wash the cabin evenly.`}
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Mini k="Course" v={`${String(Math.round(result.heading)).padStart(3, "0")}°`} />
            <Mini k="Sun" v={result.sunEl < 0 ? "Below horizon" : `${compass16(result.sunAz)} / ${Math.round(result.sunEl)}°`} />
            <Mini k="From" v={from.skyline} span />
          </dl>

          <p className="mt-5 text-sm leading-relaxed text-muted">
            Arrival note at {to.iata}: {to.skyline}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">Pick two different fields.</p>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 h-12 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
      >
        {AIRPORTS.map((a) => (
          <option key={a.icao} value={a.icao}>
            {a.iata} · {a.city}
          </option>
        ))}
      </select>
    </label>
  );
}

function Mini({ k, v, span }: { k: string; v: string; span?: boolean }) {
  return (
    <div className={cn("rounded-md bg-bg px-3 py-3", span && "sm:col-span-2")}>
      <dt className="font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">{k}</dt>
      <dd className="mt-1 text-sm text-fg">{v}</dd>
    </div>
  );
}
