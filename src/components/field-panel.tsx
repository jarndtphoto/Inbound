import { useMutation } from "@tanstack/react-query";
import { Cloud, Eye, Gauge, Thermometer, Wind } from "lucide-react";
import { useEffect, useState } from "react";
import { airportByIcao } from "@/lib/airports";
import { briefField } from "@/lib/brief";
import { fieldClock, fieldDate } from "@/lib/format";
import { useAirside } from "@/lib/store";
import type { FieldSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";

const catColor = {
  VFR: "text-vfr",
  MVFR: "text-mvfr",
  IFR: "text-ifr",
  LIFR: "text-ifr",
  UNK: "text-muted",
} as const;

export function FieldPanel({ snap }: { snap: FieldSnapshot | undefined }) {
  const icao = useAirside((s) => s.icao);
  const ap = airportByIcao(icao);
  const decoded = snap?.weather.decoded;
  const [brief, setBrief] = useState<string | null>(null);
  useEffect(() => {
    setBrief(null);
  }, [icao]);
  const mutation = useMutation({
    mutationFn: () => briefField({ data: { icao } }),
    onSuccess: (res) => {
      if (res.ok) setBrief(res.text);
      else setBrief(res.error);
    },
    onError: () => setBrief("Briefing failed. Try again in a moment."),
  });

  if (!ap) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="relative overflow-hidden rounded-xl border border-border">
        <img
          src="/images/terminal.jpg"
          alt=""
          className="h-44 w-full object-cover sm:h-56"
        />
        <div className="absolute inset-0 bg-bg/30" />
        <div className="absolute inset-x-0 bottom-0 h-36 bg-bg/80" />
        <div className="absolute inset-x-0 bottom-0 p-5">
          <p className="font-mono text-xs tracking-[0.22em] text-accent">
            {ap.iata} · {ap.icao} · {fieldClock(ap.tz)}
          </p>
          <h2 className="mt-1 font-display text-4xl leading-none tracking-tight text-fg sm:text-5xl">
            {ap.name}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted">{ap.oneLiner}</p>
        </div>
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-sm tracking-[0.18em] text-muted uppercase">
              Field conditions
            </h3>
            <p
              className={cn(
                "mt-2 font-display text-3xl leading-none tracking-tight",
                decoded ? catColor[decoded.category] : "text-fg",
              )}
            >
              {decoded?.category ?? "—"}
            </p>
            <p className="mt-2 text-sm text-muted">{decoded?.categoryLabel ?? "Waiting on METAR"}</p>
          </div>
          <p className="font-mono text-xs text-subtle">{fieldDate(ap.tz)}</p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Wx icon={Wind} label="Wind" value={decoded?.wind ?? "—"} />
          <Wx icon={Eye} label="Visibility" value={decoded?.vis ?? "—"} />
          <Wx icon={Cloud} label="Ceiling" value={decoded?.ceiling ?? "—"} />
          <Wx icon={Thermometer} label="Temp" value={decoded?.temp ?? "—"} />
        </div>

        <p className="mt-5 text-sm leading-relaxed text-fg">{snap?.weather.delayHint}</p>

        {snap?.weather.metar?.rawOb ? (
          <p className="mt-4 overflow-x-auto font-mono text-xs leading-relaxed text-subtle">
            {snap.weather.metar.rawOb}
          </p>
        ) : null}

        {snap?.weather.taf?.rawTAF ? (
          <p className="mt-3 overflow-x-auto font-mono text-xs leading-relaxed text-subtle">
            {snap.weather.taf.rawTAF}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-accent" />
          <h3 className="font-display text-sm tracking-[0.18em] text-muted uppercase">
            Passenger brief
          </h3>
        </div>
        {brief ? (
          <p className="mt-4 text-sm leading-relaxed text-fg">{brief}</p>
        ) : (
          <p className="mt-4 text-sm text-muted">
            Translate the METAR, the inbound mix, and this field’s quirks into plain language.
          </p>
        )}
        <Button
          className="mt-4"
          variant={brief ? "secondary" : "primary"}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Briefing…" : brief ? "Refresh brief" : "Brief this field"}
        </Button>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Tip title="45 minutes" body={ap.layover.m45} />
        <Tip title="90 minutes" body={ap.layover.m90} />
        <Tip title="3 hours" body={ap.layover.m180} />
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-sm tracking-[0.18em] text-muted uppercase">How it works</h3>
        <ul className="mt-4 space-y-4 text-sm leading-relaxed">
          <Item k="Terminals" v={ap.terminals} />
          <Item k="Security" v={ap.security} />
          <Item k="Connections" v={ap.connection} />
          <Item k="Watch" v={ap.watch} />
          <Item k="Window" v={ap.skyline} />
          <Item k="Heavies" v={ap.heavies} />
        </ul>
      </section>
    </div>
  );
}

function Wx({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Wind;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md bg-bg px-3 py-3">
      <div className="flex items-center gap-2 text-subtle">
        <Icon className="size-3.5" />
        <p className="font-mono text-[10px] tracking-[0.16em] uppercase">{label}</p>
      </div>
      <p className="mt-2 text-sm leading-snug text-fg">{value}</p>
    </div>
  );
}

function Tip({ title, body }: { title: string; body: string }) {
  return (
    <article className="rounded-xl border border-border bg-surface p-5">
      <h3 className="font-display text-sm tracking-[0.18em] text-accent uppercase">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-muted">{body}</p>
    </article>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <li>
      <p className="font-mono text-[10px] tracking-[0.18em] text-subtle uppercase">{k}</p>
      <p className="mt-1 text-fg">{v}</p>
    </li>
  );
}
