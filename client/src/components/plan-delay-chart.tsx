// ---------------------------------------------------------------------------
// Forsinkelse-langs-ruten-graf for et reiseforslag (plan A/B/C... i
// reiseplanleggeren). Forbedret utgave av stopp-profilen i avgangsanalysen:
// viser P50/P80/P95-forsinkelse per stopp langs hele reisen, med
// leggegrenser markert og klokkeslett-estimater i tooltip.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { legStops, type TripPattern, type DuckDelayRow } from "@/lib/trip-shared";
import { MODES_WITH_DELAY_DATA } from "@/components/mode-icon";

type ChartPoint = {
  idx: number;
  name: string;
  lineCode: string | null;
  legStart: boolean;      // første stopp på et nytt legg
  aimedIso: string | null;
  p50: number | null;
  p80: number | null;
  p95: number | null;
  n: number | null;
  legNo: number;
  /** Seriene per legg: p50_<legNo>, p80_<legNo>, p95_<legNo>, base_/range_<legNo>
   *  (stablet bånd P50→P80). Hvert legg er et eget kjøretøy og får sin EGEN
   *  kurve — én sammenhengende kurve så ut som at toget «tok igjen» forsinkelsen
   *  når det egentlig var neste buss som startet i rute (2026-11-25). */
  [series: string]: number | string | boolean | null;
};

function fmtHM(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addMinutes(iso: string, min: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Math.round(min));
  return d.toISOString();
}

function DelayTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const est = (v: number | null) =>
    v != null && p.aimedIso ? `${fmtHM(addMinutes(p.aimedIso, v))} (${v >= 0 ? "+" : ""}${v.toFixed(1)}m)` : null;
  return (
    <div className="bg-popover border border-border rounded-md shadow-md px-3 py-2 text-xs space-y-0.5">
      <p className="font-medium">
        {p.name}
        {p.lineCode && <span className="text-muted-foreground font-normal"> · linje {p.lineCode}</span>}
      </p>
      {p.aimedIso && <p className="text-muted-foreground">Rutetid: <span className="font-mono">{fmtHM(p.aimedIso)}</span></p>}
      {est(p.p50) && <p className="text-amber-500">~P50: <span className="font-mono">{est(p.p50)}</span></p>}
      {est(p.p80) && <p className="text-red-500">P80: <span className="font-mono">{est(p.p80)}</span></p>}
      {est(p.p95) && <p className="text-violet-500">P95: <span className="font-mono">{est(p.p95)}</span></p>}
      {p.n != null && <p className="text-muted-foreground/70">{p.n} observasjoner</p>}
    </div>
  );
}

/**
 * stats: Map<`${stopRef}|${lineRef}`, DuckDelayRow> — samme form som
 * useTripDelayDistribution returnerer. Stopp uten data får hull i linjene
 * (connectNulls tegner over dem).
 */
export function PlanDelayChart({
  pattern,
  stats,
  loading = false,
}: {
  pattern: TripPattern;
  stats: Map<string, DuckDelayRow> | undefined;
  /** Statistikken er ikke hentet ennå — vis det, ikke «ingen data». */
  loading?: boolean;
}) {
  const data = useMemo<ChartPoint[]>(() => {
    const out: ChartPoint[] = [];
    let legNo = -1;
    for (const leg of pattern.legs) {
      if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      const stops = legStops(leg);
      legNo++;
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        const row = stats?.get(`${s.id}|${leg.line.id}`);
        const isLast = i === stops.length - 1;
        // Siste stopp har ingen avgang — bruk ankomstforsinkelsen der.
        const p50 = (isLast ? row?.p50_arr : row?.p50_dep) ?? null;
        const p80 = (isLast ? row?.p80_arr : row?.p80_dep) ?? null;
        const p95 = (isLast ? row?.p95_arr : row?.p95_dep) ?? null;
        out.push({
          idx: out.length,
          name: s.name,
          lineCode: leg.line.publicCode ?? null,
          legStart: i === 0 && out.length > 0,
          aimedIso: s.aimedTime,
          p50, p80, p95,
          n: row?.n ?? null,
          legNo,
          [`p50_${legNo}`]: p50,
          [`p80_${legNo}`]: p80,
          [`p95_${legNo}`]: p95,
          [`base_${legNo}`]: p50 != null && p80 != null ? p50 : null,
          [`range_${legNo}`]: p50 != null && p80 != null ? p80 - p50 : null,
        });
      }
    }
    return out;
  }, [pattern, stats]);

  const hasAnyData = data.some((d) => d.p50 != null || d.p80 != null);
  const legNos = Array.from(new Set(data.map((d) => d.legNo)));
  if (data.length < 2) return null;
  if (!hasAnyData && loading) {
    return (
      <p className="text-[10px] text-muted-foreground/70 italic py-2 animate-pulse">
        Henter historikk for grafen …
      </p>
    );
  }
  if (!hasAnyData) {
    return (
      <p className="text-[10px] text-muted-foreground/60 italic py-2">
        Ingen historiske observasjoner langs denne ruten ennå — graf kan ikke tegnes.
      </p>
    );
  }

  // Bredde skalerer med antall stopp så lange ruter kan scrolles horisontalt.
  const width = Math.max(300, data.length * 36);

  return (
    <div className="overflow-x-auto">
      <div style={{ width, height: 190 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 14, left: 0, right: 12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis
              dataKey="idx"
              type="number"
              domain={[0, data.length - 1]}
              tickFormatter={(i: number) => {
                const p = data[Math.round(i)];
                return p?.aimedIso ? fmtHM(p.aimedIso) : "";
              }}
              stroke="hsl(var(--muted-foreground))"
              fontSize={9}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              tickCount={Math.min(data.length, 8)}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              width={34}
              tickFormatter={(v: number) => `${v}m`}
            />
            <Tooltip content={<DelayTooltip />} />
            {/* Leggegrenser (overganger) */}
            {data.filter((d) => d.legStart).map((d) => (
              <ReferenceLine
                key={d.idx}
                x={d.idx}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 2"
                strokeOpacity={0.5}
                label={{
                  value: d.lineCode ? `linje ${d.lineCode}` : "bytte",
                  position: "top",
                  fontSize: 9,
                  fill: "hsl(var(--muted-foreground))",
                }}
              />
            ))}
            {/* Én kurve per legg. connectNulls bygger bro over stopp uten data
                INNE i et legg; de andre leggenes punkter er null i serien, så
                kurven går aldri over et bytte. */}
            {legNos.flatMap((k) => [
              <Area key={`b${k}`} type="monotone" dataKey={`base_${k}`} stackId={`band${k}`} stroke="none" fill="transparent" legendType="none" isAnimationActive={false} connectNulls />,
              <Area key={`r${k}`} type="monotone" dataKey={`range_${k}`} stackId={`band${k}`} stroke="none" fill="#ef4444" fillOpacity={0.10} legendType="none" isAnimationActive={false} connectNulls />,
              <Line key={`9${k}`} type="monotone" dataKey={`p95_${k}`} stroke="#8b5cf6" strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} connectNulls />,
              <Line key={`8${k}`} type="monotone" dataKey={`p80_${k}`} stroke="#ef4444" strokeWidth={1.5} dot={{ r: 1.5 }} isAnimationActive={false} connectNulls />,
              <Line key={`5${k}`} type="monotone" dataKey={`p50_${k}`} stroke="#f59e0b" strokeWidth={2} dot={{ r: 1.5 }} isAnimationActive={false} connectNulls />,
            ])}
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-muted-foreground/80 leading-snug mt-1">
        Hvor mange minutter etter rutetid linja pleier å være ved hvert stopp.{" "}
        <span className="text-amber-500">Oransje</span>: vanlig dag (halvparten er senere).{" "}
        <span className="text-red-500">Rød</span>: dårlig dag (4 av 5 er innenfor).{" "}
        <span className="text-violet-500">Lilla</span>: verste 1 av 20.
        Hvert legg er et eget kjøretøy med egen kurve — starter neste kurve lavere, er det
        neste buss/tog som pleier å gå i rute, ikke at du tar igjen tid.
      </p>
    </div>
  );
}
