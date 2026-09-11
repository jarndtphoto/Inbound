import { type ReactNode } from "react";
import { airframeOf } from "@/lib/aircraft";
import { feetPretty, formatNm } from "@/lib/geo";
import { headingText } from "@/lib/format";
import { useAirside } from "@/lib/store";
import type { Traffic } from "@/lib/types";
import { cn } from "@/lib/utils";

function phaseLabel(t: Traffic) {
  if (t.phase === "parked") return "On stand";
  if (t.phase === "taxi") return "Taxi";
  if (t.phase === "approach") return "On approach";
  if (t.phase === "descent") return "Descending";
  if (t.phase === "climb") return "Climbing";
  return "Airborne";
}

export function TrafficList({ traffic }: { traffic: Traffic[] }) {
  const rangeNm = useAirside((s) => s.rangeNm);
  const selectedHex = useAirside((s) => s.selectedHex);
  const select = useAirside((s) => s.select);
  const visible = traffic.filter((t) => t.distNm <= rangeNm + 0.4);
  const air = visible.filter((t) => !t.onGround);
  const gnd = visible.filter((t) => t.onGround);

  if (!visible.length) {
    return (
      <p className="px-1 py-8 text-sm text-muted">
        No transponder traffic inside {rangeNm} miles. Widen the ring, or the field may just be quiet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Section title="Airborne" count={air.length}>
        {air.map((t) => (
          <Row key={t.hex} t={t} selected={t.hex === selectedHex} onSelect={select} />
        ))}
      </Section>
      {gnd.length ? (
        <Section title="On the field" count={gnd.length}>
          {gnd.slice(0, 18).map((t) => (
            <Row key={t.hex} t={t} selected={t.hex === selectedHex} onSelect={select} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="font-display text-sm tracking-widest text-muted uppercase">{title}</h2>
        <span className="font-mono text-xs tabular-nums text-subtle">{count}</span>
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

function Row({
  t,
  selected,
  onSelect,
}: {
  t: Traffic;
  selected: boolean;
  onSelect: (hex: string | null) => void;
}) {
  const frame = airframeOf(t.type);
  const title = t.callsign || t.registration || t.hex.toUpperCase();
  const sub = [t.airline, t.typeName || t.type, t.year].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(selected ? null : t.hex)}
        className={cn(
          "flex w-full min-h-14 items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors duration-150",
          selected
            ? "border-accent/50 bg-surface-2"
            : "border-border bg-surface hover:bg-surface-2",
        )}
      >
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-sm font-mono text-xs tracking-wide",
            t.widebody ? "bg-accent text-accent-fg" : "bg-bg text-muted",
          )}
        >
          {t.type?.slice(0, 4) || "AC"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-fg">{title}</span>
            {t.widebody ? (
              <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-xs tracking-widest text-accent">
                HEAVY
              </span>
            ) : null}
            {frame?.kind === "biz" ? (
              <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-xs tracking-widest text-muted">
                BIZ
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted">{sub || phaseLabel(t)}</span>
        </span>
        <span className="shrink-0 text-right font-mono text-xs tabular-nums text-subtle">
          <span className="block text-fg">{t.onGround ? phaseLabel(t) : formatNm(t.distNm)}</span>
          <span className="block">
            {t.onGround
              ? t.gsKt
                ? `${Math.round(t.gsKt)} kt`
                : t.registration ?? ""
              : t.altFt
                ? feetPretty(t.altFt)
                : headingText(t.track)}
          </span>
        </span>
      </button>
    </li>
  );
}
