import { airportByIcao } from "@/lib/airports";
import { useAirside } from "@/lib/store";
import type { Traffic } from "@/lib/types";
import { cn } from "@/lib/utils";

const CX = 50;
const CY = 50;
const RR = 46;

function polar(bearing: number, distNm: number, rangeNm: number) {
  const t = (bearing * Math.PI) / 180;
  const p = Math.min(distNm / rangeNm, 1.05);
  return {
    x: CX + Math.sin(t) * RR * p,
    y: CY - Math.cos(t) * RR * p,
  };
}

export function RadarScope({
  traffic,
  loading,
}: {
  traffic: Traffic[];
  loading: boolean;
}) {
  const rangeNm = useAirside((s) => s.rangeNm);
  const selectedHex = useAirside((s) => s.selectedHex);
  const select = useAirside((s) => s.select);
  const icao = useAirside((s) => s.icao);
  const ap = airportByIcao(icao);
  const inRange = traffic.filter((t) => t.distNm <= rangeNm + 0.4);
  const labels = inRange
    .filter((t) => !t.onGround && (t.interesting || t.hex === selectedHex))
    .slice(0, 7);

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface">
      <svg
        viewBox="0 0 100 100"
        className="block aspect-square w-full"
        role="img"
        aria-label={`Radar at ${ap?.iata ?? icao}, ${rangeNm} nautical miles`}
      >
        <defs>
          <radialGradient id="radarFill" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.08" />
            <stop offset="70%" stopColor="currentColor" stopOpacity="0.02" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="100" height="100" className="fill-bg" />
        <circle cx={CX} cy={CY} r={RR} fill="url(#radarFill)" className="text-accent" />
        {[0.33, 0.66, 1].map((f) => (
          <circle
            key={f}
            cx={CX}
            cy={CY}
            r={RR * f}
            fill="none"
            className="stroke-border"
            strokeWidth={0.35}
          />
        ))}
        <line x1={CX} y1={CY - RR} x2={CX} y2={CY + RR} className="stroke-border" strokeWidth={0.3} />
        <line x1={CX - RR} y1={CY} x2={CX + RR} y2={CY} className="stroke-border" strokeWidth={0.3} />
        <g className="radar-sweep" style={{ transformOrigin: "50px 50px" }}>
          <path
            d={`M ${CX} ${CY} L ${CX} ${CY - RR} A ${RR} ${RR} 0 0 1 ${CX + RR * 0.34} ${CY - RR * 0.94} Z`}
            className="fill-accent"
            opacity={0.12}
          />
        </g>
        <text
          x={CX}
          y={CY - RR + 4.2}
          textAnchor="middle"
          className="fill-muted"
          fontSize={2.6}
          fontFamily="IBM Plex Mono, monospace"
        >
          N
        </text>
        <text
          x={CX}
          y={CY + 1.2}
          textAnchor="middle"
          className="fill-accent"
          fontSize={2.4}
          fontFamily="Barlow Condensed, sans-serif"
        >
          {ap?.iata}
        </text>

        {inRange.map((t) => {
          const { x, y } = polar(t.bearing, t.distNm, rangeNm);
          const selected = t.hex === selectedHex;
          const rot = t.track ?? t.bearing;
          const fill = t.onGround ? "var(--color-subtle)" : t.widebody ? "var(--color-accent)" : "var(--color-fg)";
          return (
            <g
              key={t.hex}
              transform={`translate(${x} ${y})`}
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                select(selected ? null : t.hex);
              }}
            >
              {selected ? (
                <circle r={3.4} fill="none" stroke="var(--color-accent)" strokeWidth={0.4} opacity={0.9} />
              ) : null}
              {t.onGround ? (
                <rect x={-0.7} y={-0.7} width={1.4} height={1.4} fill={fill} opacity={0.7} />
              ) : (
                <polygon
                  points="0,-1.8 1.3,1.6 0,0.7 -1.3,1.6"
                  fill={fill}
                  transform={`rotate(${rot})`}
                  opacity={t.interesting ? 1 : 0.75}
                />
              )}
            </g>
          );
        })}

        {labels.map((t) => {
          const { x, y } = polar(t.bearing, t.distNm, rangeNm);
          const label = (t.callsign || t.registration || t.type || "").slice(0, 8);
          if (!label) return null;
          return (
            <text
              key={`l-${t.hex}`}
              x={x + 2.2}
              y={y - 1.6}
              className={t.hex === selectedHex ? "fill-accent" : "fill-muted"}
              fontSize={2.3}
              fontFamily="IBM Plex Mono, monospace"
            >
              {label}
            </text>
          );
        })}
      </svg>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <p className="font-mono text-xs tracking-widest text-muted">
          {String(rangeNm).padStart(2, "0")} NM
        </p>
        <p className="font-mono text-xs tracking-widest text-muted">
          {loading ? "ACQ" : `${inRange.filter((t) => !t.onGround).length} TFC`}
        </p>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 p-3">
        {[12, 25, 38].map((nm) => (
          <button
            key={nm}
            type="button"
            onClick={() => useAirside.getState().setRange(nm)}
            className={cn(
              "h-11 min-w-11 rounded-full px-3 font-mono text-xs tracking-wide",
              rangeNm === nm
                ? "bg-accent text-accent-fg"
                : "border border-border bg-bg/80 text-muted",
            )}
          >
            {nm}
          </button>
        ))}
      </div>
    </div>
  );
}
