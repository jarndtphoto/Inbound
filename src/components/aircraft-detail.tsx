import { toast } from "sonner";
import { airframeOf } from "@/lib/aircraft";
import { airportByIcao } from "@/lib/airports";
import { compass16, feetPretty, formatNm } from "@/lib/geo";
import { headingText } from "@/lib/format";
import { useAirside } from "@/lib/store";
import type { Traffic } from "@/lib/types";
import { Button } from "./ui/button";

export function AircraftDetail({ traffic }: { traffic: Traffic[] }) {
  const selectedHex = useAirside((s) => s.selectedHex);
  const select = useAirside((s) => s.select);
  const addLog = useAirside((s) => s.addLog);
  const icao = useAirside((s) => s.icao);
  const ap = airportByIcao(icao);
  const t = traffic.find((x) => x.hex === selectedHex);
  if (!t) return null;
  const frame = airframeOf(t.type);
  const title = t.callsign || t.registration || t.hex.toUpperCase();

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-bg/70"
        onClick={() => select(null)}
      />
      <div className="relative m-3 w-full max-w-lg rounded-xl border border-border bg-surface p-5 shadow-none">
        <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">
          {t.airline ?? "Traffic"} · {t.hex.toUpperCase()}
        </p>
        <h2 className="mt-1 font-display text-4xl tracking-tight text-fg">{title}</h2>
        <p className="mt-1 text-sm text-muted">
          {t.registration ? `${t.registration} · ` : ""}
          {t.typeName || t.type || "Unknown type"}
          {t.year ? ` · ${t.year}` : ""}
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Distance" value={formatNm(t.distNm)} />
          <Stat label="Bearing" value={`${headingText(t.bearing)} ${compass16(t.bearing)}`} />
          <Stat label="Altitude" value={t.onGround ? "Ground" : t.altFt ? feetPretty(t.altFt) : "—"} />
          <Stat label="Speed" value={t.gsKt != null ? `${Math.round(t.gsKt)} kt` : "—"} />
          <Stat label="Track" value={headingText(t.track)} />
          <Stat
            label="Vertical"
            value={
              t.vertFpm == null || t.onGround
                ? "—"
                : `${t.vertFpm > 0 ? "+" : ""}${Math.round(t.vertFpm)} fpm`
            }
          />
        </dl>

        {frame ? (
          <p className="mt-5 text-sm leading-relaxed text-muted">{frame.note}</p>
        ) : t.operator ? (
          <p className="mt-5 text-sm text-muted">{t.operator}</p>
        ) : null}

        <div className="mt-6 flex gap-2">
          <Button
            className="flex-1"
            onClick={() => {
              addLog({
                kind: "sighting",
                airport: ap?.iata ?? icao,
                callsign: t.callsign ?? undefined,
                registration: t.registration ?? undefined,
                type: t.type ?? undefined,
                typeName: t.typeName ?? undefined,
              });
              toast("Saved to your log");
              select(null);
            }}
          >
            Log this
          </Button>
          <Button variant="secondary" onClick={() => select(null)}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg px-3 py-3">
      <dt className="font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums text-fg">{value}</dd>
    </div>
  );
}
