/**
 * Byggeklossene i linjeanalysen (journey-details.tsx) fra 2026-10-27:
 * nøkkeltall med svaret først, fordeling, varmekart ukedag × time, dag for dag
 * og «Alle stopp»-visningen av ruteprofilen. Dataene kommer fra
 * lib/line-distribution.ts (én DuckDB-spørring) og useLineStopProfile.
 */
import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { MapPin } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InfoTip } from "@/components/info-tip";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatDateShortNO } from "@/lib/date-utils";
import {
  type DailyPoint, type HeatCell, type HistBar, type LineDistribution,
  cellKey, DOW_LONG, DOW_SHORT, fmtPct, fmtSignedMin, shareInWords,
} from "@/lib/line-distribution";

// Fargene følger resten av siden: grønn = i rute, gul = for tidlig,
// oransje = forsinket, rød = kraftig forsinket.
export const ZONE_COLOR: Record<HistBar["zone"], string> = {
  early: "hsl(38 92% 50%)",
  punctual: "hsl(160 84% 39%)",
  late: "hsl(25 95% 53%)",
  late10: "hsl(var(--destructive))",
};

const tooltipBox = "bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[240px]";

// ---------------------------------------------------------------------------
// Nøkkeltall
// ---------------------------------------------------------------------------

export type SummaryNumbers = {
  pctPunctual: number | null;
  pctEarly: number | null;
  pctLate10: number | null;
  mean: number | null;
  sd: number | null;
  p50: number | null;
  p80: number | null;
  p95: number | null;
  deps: number | null;
};

function Kpi({ label, value, hint, tone, info }: {
  label: string; value: string; hint: string; tone?: "good" | "warn" | "bad"; info?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-background/50 px-3 py-2.5 min-w-0">
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {label}
        {info && <InfoTip>{info}</InfoTip>}
      </div>
      <div className={cn(
        "text-xl sm:text-2xl font-bold font-mono tabular-nums mt-0.5 whitespace-nowrap",
        tone === "good" && "text-emerald-600",
        tone === "warn" && "text-amber-600",
        tone === "bad" && "text-destructive",
      )}>
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground leading-snug">{hint}</div>
    </div>
  );
}

export function LineSummaryCard({ lineLabel, periodLabel, nums, coveragePct }: {
  lineLabel: string;
  periodLabel: string;
  nums: SummaryNumbers;
  coveragePct: number | null;
}) {
  const { p80, p50, p95, pctEarly } = nums;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardDescription>{lineLabel} · {periodLabel}</CardDescription>
        <CardTitle className="text-xl leading-snug font-semibold">
          {p80 != null ? (
            <>
              4 av 5 ganger var linja mindre enn{" "}
              <span className="font-mono text-orange-600 dark:text-orange-400 whitespace-nowrap">{fmtSignedMin(p80).replace("+", "")}</span>{" "}
              forsinket
            </>
          ) : (
            <span className="text-muted-foreground">Regner ut fordelingen …</span>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Målt ved hvert stopp langs ruten.
          {p50 != null && <> Halvparten av gangene innen <span className="font-mono">{fmtSignedMin(p50)}</span>.</>}
          {p95 != null && <> 1 av 20 ganger mer enn <span className="font-mono">{fmtSignedMin(p95)}</span>.</>}
        </p>
        {pctEarly != null && pctEarly >= 1 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            <strong>{shareInWords(pctEarly)}</strong> ganger ({fmtPct(pctEarly, 1)}) gikk den mer enn 1 min før
            rutetid — da kan du ha mistet den selv om du var der i tide.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="I rute"
            value={fmtPct(nums.pctPunctual)}
            hint="Fra 1 min før til 2 min etter rutetid"
            tone="good"
          />
          <Kpi
            label="Gikk for tidlig"
            value={fmtPct(nums.pctEarly, 1)}
            hint="Mer enn 1 min før rutetid"
            tone={nums.pctEarly != null && nums.pctEarly >= 2 ? "warn" : undefined}
          />
          <Kpi
            label="Median"
            value={fmtSignedMin(nums.p50)}
            hint={nums.p95 != null ? `P95: ${fmtSignedMin(nums.p95)}` : "Halvparten er senere enn dette"}
            info={<>Median (P50): halvparten av gangene var forsinkelsen mindre enn dette. P95: bare 1 av 20 ganger var den større.</>}
          />
          <Kpi
            label="Kraftig forsinket"
            value={fmtPct(nums.pctLate10, 1)}
            hint="Mer enn 10 min etter rutetid"
            tone={nums.pctLate10 != null && nums.pctLate10 >= 2 ? "bad" : undefined}
          />
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1"><dt>Snitt</dt><dd className="font-mono text-foreground">{fmtSignedMin(nums.mean)}</dd></div>
          <div className="flex gap-1 items-center">
            <dt>Spredning (σ)</dt>
            <dd className="font-mono text-foreground">{nums.sd != null ? `±${nums.sd.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} min` : "—"}</dd>
            <InfoTip>Standardavvik. Lavt tall betyr at forsinkelsen er forutsigbar fra gang til gang.</InfoTip>
          </div>
          <div className="flex gap-1"><dt>Avganger</dt><dd className="font-mono text-foreground">{nums.deps != null ? nums.deps.toLocaleString("nb-NO") : "—"}</dd></div>
          <div className="flex gap-1 items-center">
            <dt>Datadekning</dt>
            <dd className={cn("font-mono", coveragePct != null && coveragePct < 70 ? "text-amber-600" : "text-foreground")}>
              {coveragePct != null ? `${coveragePct} %` : "—"}
            </dd>
            <InfoTip>Andelen rutetidsfestede avganger som faktisk sendte sanntidsdata. Avganger uten sanntid er ikke med i tallene.</InfoTip>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fordeling
// ---------------------------------------------------------------------------

function HistTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: HistBar & { x: number } }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const range = d.label.startsWith("≤") ? `Mer enn ${Math.abs(d.to)} min før rutetid`
    : d.label.startsWith("≥") ? `${d.from} min eller mer forsinket`
    : `${fmtSignedMin(d.from, 0)} til ${fmtSignedMin(d.to, 0)}`;
  const zoneText = { early: "For tidlig", punctual: "I rute", late: "Forsinket", late10: "Kraftig forsinket" }[d.zone];
  return (
    <div className={tooltipBox}>
      <p className="font-medium">{range}</p>
      <p className="font-mono text-xs mt-1">{fmtPct(d.pct, 1)} av gangene</p>
      <p className="text-xs text-muted-foreground">{d.n.toLocaleString("nb-NO")} målinger · {zoneText}</p>
    </div>
  );
}

export function DelayHistogram({ dist, periodLabel }: { dist: LineDistribution; periodLabel: string }) {
  // På mobil er det ikke plass til tallene ved strekene og i «for tidlig»-
  // feltet uten at de skriver over hverandre; de står i forklaringen under.
  const narrow = useIsMobile();
  const data = dist.hist.map((h) => ({ ...h, x: h.from + 0.5 }));
  const { p50, p80, p95, pctEarly } = dist.overall;
  const marks: Array<[string, number | null]> = [["P50", p50], ["P80", p80], ["P95", p95]];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Slik fordeler forsinkelsene seg</CardTitle>
        <CardDescription>
          Andel av alle stoppasseringer etter hvor mye linja var forsinket ({periodLabel}). Strekene viser
          medianen (P50), 4 av 5 (P80) og 19 av 20 (P95).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 22, right: 12, left: 0, bottom: 4 }} barCategoryGap={1}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              {/* To x-akser over samme bredde: søylene står på en skjult
                  kategoriakse (én søyle per minutt), mens strekene og
                  tallene under står på en numerisk akse. Med bare den
                  numeriske traff tooltipen feil søyle (Recharts finner
                  aktiv indeks dårlig for tall-akser i BarChart). Begge
                  dekker 26 like brede minutter, så de står kant i kant. */}
              <XAxis dataKey="label" xAxisId="bins" hide />
              <XAxis
                xAxisId="num"
                type="number"
                dataKey="x"
                domain={[-5, 21]}
                allowDataOverflow
                ticks={[-4, -1, 0, 2, 5, 10, 15, 20]}
                tickFormatter={(v) => (v > 0 ? `+${v}` : `${v}`.replace("-", "−"))}
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v} %`}
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <ReferenceArea
                xAxisId="num"
                x1={-5}
                x2={-1}
                fill={ZONE_COLOR.early}
                fillOpacity={0.08}
                label={narrow ? undefined : { value: `For tidlig ${fmtPct(pctEarly, 1)}`, position: "insideTop", fontSize: 11, fill: "hsl(38 92% 40%)" }}
              />
              <Tooltip content={<HistTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.5 }} />
              <Bar dataKey="pct" xAxisId="bins" isAnimationActive={false}>
                {data.map((d) => <Cell key={d.from} fill={ZONE_COLOR[d.zone]} fillOpacity={0.85} />)}
              </Bar>
              {marks.map(([name, v]) => v != null && (
                <ReferenceLine
                  key={name}
                  xAxisId="num"
                  x={Math.min(20.9, Math.max(-4.9, v))}
                  stroke="hsl(var(--foreground))"
                  strokeDasharray={name === "P80" ? undefined : "4 3"}
                  strokeOpacity={name === "P80" ? 0.9 : 0.5}
                  label={{ value: narrow ? name : `${name} ${fmtSignedMin(v)}`, position: "top", fontSize: 10, fill: "hsl(var(--foreground))" }}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
          {([
            ["early", "For tidlig (> 1 min før)", dist.overall.pctEarly],
            ["punctual", "I rute (−1 til +2 min)", dist.overall.pctPunctual],
            ["late", "Forsinket (2–10 min)", dist.overall.pctLate != null && dist.overall.pctLate10 != null ? dist.overall.pctLate - dist.overall.pctLate10 : null],
            ["late10", "Kraftig forsinket (> 10 min)", dist.overall.pctLate10],
          ] as const).map(([zone, text, pct]) => (
            <span key={zone} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: ZONE_COLOR[zone] }} />
              {text} <span className="font-mono text-foreground">{fmtPct(pct, 1)}</span>
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 font-mono">
          P50 {fmtSignedMin(p50)} · P80 {fmtSignedMin(p80)} · P95 {fmtSignedMin(p95)}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Varmekart ukedag × time
// ---------------------------------------------------------------------------

type HeatMetric = "p80" | "mean" | "punctual";
const MIN_CELL_N = 30;

function cellValue(c: HeatCell, m: HeatMetric): number | null {
  return m === "p80" ? c.p80 : m === "mean" ? c.mean : c.pctPunctual;
}

/** 0..1 — hvor «ille» cellen er, for fargestyrken. */
function cellBadness(c: HeatCell, m: HeatMetric): number {
  const v = cellValue(c, m);
  if (v == null) return 0;
  if (m === "punctual") return Math.min(1, Math.max(0, (90 - v) / 50));
  const cap = m === "p80" ? 10 : 6;
  return Math.min(1, Math.max(0, v / cap));
}

function describeCell(c: HeatCell): string {
  const hour = `${String(c.hour).padStart(2, "0")}–${String((c.hour + 1) % 24).padStart(2, "0")}`;
  return `${DOW_LONG[c.dow]} kl. ${hour}`;
}

export function WeekHourHeatmap({ dist, periodLabel }: { dist: LineDistribution; periodLabel: string }) {
  const [metric, setMetric] = useState<HeatMetric>("p80");
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const dows = useMemo(() => [1, 2, 3, 4, 5, 6, 7].filter((d) => dist.hours.some((h) => dist.cells.has(cellKey(d, h)))), [dist]);

  const worstKey = useMemo(() => {
    let best: HeatCell | null = null;
    dist.cells.forEach((c) => {
      if (c.dow === 0 || c.n < MIN_CELL_N || c.p80 == null) return;
      if (!best || c.p80 > best.p80!) best = c;
    });
    return best ? cellKey((best as HeatCell).dow, (best as HeatCell).hour) : null;
  }, [dist]);

  const activeKey = hovered ?? picked ?? worstKey;
  const active = activeKey ? dist.cells.get(activeKey) ?? null : null;

  const metricLabel = { p80: "P80", mean: "Snitt", punctual: "I rute" }[metric];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <CardTitle>Når er det verst?</CardTitle>
            <CardDescription>
              Ukedag × time på døgnet ({periodLabel}). Mørkere = verre. Pek eller trykk på en rute for tallene.
            </CardDescription>
          </div>
          <div className="flex gap-1 shrink-0">
            {(["p80", "mean", "punctual"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={metric === m ? "default" : "outline"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setMetric(m)}
              >
                {{ p80: "P80", mean: "Snitt", punctual: "I rute" }[m]}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto -mx-1 px-1">
          <div
            className="grid gap-[2px] min-w-[300px]"
            style={{ gridTemplateColumns: `2.5rem repeat(${dist.hours.length}, minmax(0, 1fr))` }}
            onMouseLeave={() => setHovered(null)}
          >
            {[...dows, 0].map((dow) => (
              <HeatRow
                key={dow}
                dow={dow}
                dist={dist}
                metric={metric}
                activeKey={activeKey}
                onHover={setHovered}
                onPick={(k) => setPicked((p) => (p === k ? null : k))}
              />
            ))}
            <div />
            {dist.hours.map((h, i) => (
              <div key={h} className="text-[10px] text-muted-foreground text-center font-mono pt-0.5">
                {i % 3 === 0 ? String(h).padStart(2, "0") : ""}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm min-h-[3.25rem]" aria-live="polite">
          {active ? (
            <>
              <p className="font-medium">
                {describeCell(active)}
                {activeKey === worstKey && !hovered && !picked && (
                  <span className="text-muted-foreground font-normal"> — verste time i perioden</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground font-mono mt-0.5 flex flex-wrap gap-x-3">
                <span>P80 <span className="text-foreground">{fmtSignedMin(active.p80)}</span></span>
                <span>Snitt <span className="text-foreground">{fmtSignedMin(active.mean)}</span></span>
                <span>I rute <span className="text-foreground">{fmtPct(active.pctPunctual)}</span></span>
                <span>For tidlig <span className="text-foreground">{fmtPct(active.pctEarly, 1)}</span></span>
                <span>{active.n.toLocaleString("nb-NO")} målinger{active.n < MIN_CELL_N ? " (for få til å stole på)" : ""}</span>
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">For lite data til å finne en verste time.</p>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Fargen viser {metricLabel === "I rute" ? "andelen som IKKE var i rute" : metricLabel}. Ruter med færre enn {MIN_CELL_N} målinger er skravert.
          Nederste rad slår sammen alle dager.
        </p>
      </CardContent>
    </Card>
  );
}

function HeatRow({ dow, dist, metric, activeKey, onHover, onPick }: {
  dow: number; dist: LineDistribution; metric: HeatMetric; activeKey: string | null;
  onHover: (k: string | null) => void; onPick: (k: string) => void;
}) {
  return (
    <>
      <div className={cn("text-[11px] text-muted-foreground flex items-center", dow === 0 && "font-medium text-foreground pt-1")}>
        {DOW_SHORT[dow]}
      </div>
      {dist.hours.map((h) => {
        const k = cellKey(dow, h);
        const c = dist.cells.get(k);
        if (!c) return <div key={k} className={cn("h-6 rounded-[3px] bg-muted/40", dow === 0 && "mt-1")} />;
        const thin = c.n < MIN_CELL_N;
        const a = cellBadness(c, metric);
        return (
          <button
            key={k}
            type="button"
            aria-label={`${describeCell(c)}: P80 ${fmtSignedMin(c.p80)}, ${fmtPct(c.pctPunctual)} i rute`}
            aria-pressed={activeKey === k}
            onMouseEnter={() => onHover(k)}
            onFocus={() => onHover(k)}
            onBlur={() => onHover(null)}
            onClick={() => onPick(k)}
            className={cn(
              "h-6 rounded-[3px] border border-transparent transition-[outline] outline-offset-1",
              activeKey === k && "outline outline-2 outline-foreground",
              dow === 0 && "mt-1",
            )}
            style={{
              background: thin
                ? "repeating-linear-gradient(45deg, hsl(var(--muted)), hsl(var(--muted)) 3px, transparent 3px, transparent 6px)"
                : `hsl(25 95% 53% / ${(0.08 + 0.85 * a).toFixed(2)})`,
            }}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Dag for dag
// ---------------------------------------------------------------------------

function DailyTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: DailyPoint }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className={tooltipBox}>
      <p className="font-medium">{formatDateShortNO(d.date)}</p>
      <div className="font-mono text-xs mt-1 space-y-0.5">
        <p>P80 <span className="text-orange-600 dark:text-orange-400">{fmtSignedMin(d.p80)}</span></p>
        <p>Median {fmtSignedMin(d.p50)}</p>
        <p>Snitt {fmtSignedMin(d.mean)}</p>
        <p className="text-emerald-600">I rute {fmtPct(d.pctPunctual)}</p>
        <p className="text-amber-600">For tidlig {fmtPct(d.pctEarly, 1)}</p>
      </div>
      {d.deps != null && <p className="text-xs text-muted-foreground mt-1">{d.deps.toLocaleString("nb-NO")} avganger</p>}
    </div>
  );
}

export function DailyChart({ daily, periodLabel }: { daily: DailyPoint[]; periodLabel: string }) {
  const data = daily.map((d) => ({ ...d, label: formatDateShortNO(d.date) }));
  // Aksen følger P80, ikke enkeltturenes maks: én avgang som sto en time i
  // kø skal ikke presse resten av grafen flat mot bunnen.
  const yMax = Math.max(2, Math.ceil(Math.max(...data.map((d) => d.p80 ?? 0)) * 1.15));
  const yMin = Math.min(0, Math.floor(Math.min(...data.map((d) => d.p50 ?? 0))));
  const worst = data.reduce<typeof data[number] | null>((w, d) => (d.p80 != null && (!w || d.p80 > (w.p80 ?? -Infinity)) ? d : w), null);
  const best = data.reduce<typeof data[number] | null>((w, d) => (d.p80 != null && (!w || d.p80 < (w.p80 ?? Infinity)) ? d : w), null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dag for dag</CardTitle>
        <CardDescription>
          Median og P80 per dag ({periodLabel}). Pek på en dag for flere tall.
          {worst && best && worst.date !== best.date && (
            <> Verst: <span className="font-medium text-foreground">{formatDateShortNO(worst.date)}</span> (P80 {fmtSignedMin(worst.p80)}).
              Best: <span className="font-medium text-foreground">{formatDateShortNO(best.date)}</span> (P80 {fmtSignedMin(best.p80)}).</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis
                domain={[yMin, yMax]}
                allowDataOverflow
                tickFormatter={(v) => `${v} m`}
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip content={<DailyTooltip />} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="p80" name="P80" stroke={ZONE_COLOR.late} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="p50" name="Median" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground mt-2">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2" style={{ borderColor: ZONE_COLOR.late }} />P80 (4 av 5 ganger under)</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-primary" />Median</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Alle stopp
// ---------------------------------------------------------------------------

export type RouteStop = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number | null;
  delayGain: number;
  dwellTimeSec: number | null | undefined;
  numSamples: number | null;
};

export function RouteStopsDialog({ open, onOpenChange, title, stops, onOpenStop }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  stops: RouteStop[];
  onOpenStop: (s: RouteStop) => void;
}) {
  const maxAbs = Math.max(1, ...stops.map((s) => Math.abs(s.avgDelayMin ?? 0)));
  const maxGain = Math.max(0.5, ...stops.map((s) => Math.abs(s.delayGain)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle>Alle stopp langs ruten</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto px-2 sm:px-3 py-2">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-left font-medium py-2 pl-2 w-8">#</th>
                <th className="text-left font-medium py-2">Stopp</th>
                <th className="text-left font-medium py-2 w-[34%]">Snitt forsinkelse</th>
                <th className="text-right font-medium py-2 hidden sm:table-cell">Endring</th>
                <th className="text-right font-medium py-2 hidden md:table-cell">Stopptid</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {stops.map((s, i) => {
                const v = s.avgDelayMin ?? 0;
                const w = (Math.abs(v) / maxAbs) * 100;
                const gainTone = s.delayGain > 0.1 ? "text-destructive" : s.delayGain < -0.1 ? "text-emerald-600" : "text-muted-foreground";
                return (
                  <tr key={`${s.stopRef}-${i}`} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="py-1.5 pl-2 text-xs text-muted-foreground font-mono">{i + 1}</td>
                    <td className="py-1.5 pr-2">
                      <div className="leading-tight">{s.stopName ?? s.stopRef}</div>
                      <div className={cn("sm:hidden text-[11px] font-mono", gainTone)}>
                        {i > 0 ? `${fmtSignedMin(s.delayGain, 2)} fra forrige` : "Første stopp"}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-2">
                        <div className="relative h-2 flex-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${w}%`, background: v > 5 ? ZONE_COLOR.late10 : v > 2 ? ZONE_COLOR.late : v < -1 ? ZONE_COLOR.early : ZONE_COLOR.punctual }}
                          />
                        </div>
                        <span className="font-mono text-xs tabular-nums w-[4.5rem] text-right">{fmtSignedMin(s.avgDelayMin)}</span>
                      </div>
                    </td>
                    <td className={cn("py-1.5 text-right font-mono text-xs hidden sm:table-cell", gainTone)}>
                      {i > 0 ? (
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <span
                            className="inline-block h-1.5 rounded-full"
                            style={{ width: `${(Math.abs(s.delayGain) / maxGain) * 28}px`, background: "currentColor", opacity: 0.6 }}
                          />
                          {fmtSignedMin(s.delayGain, 2)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs text-muted-foreground hidden md:table-cell">
                      {s.dwellTimeSec != null ? `${Math.round(s.dwellTimeSec)} s` : "—"}
                    </td>
                    <td className="py-1.5 text-right pr-1">
                      <button
                        type="button"
                        onClick={() => onOpenStop(s)}
                        className="p-1 text-muted-foreground hover:text-foreground"
                        title="Åpne stoppanalysen"
                        aria-label={`Åpne stoppanalysen for ${s.stopName ?? s.stopRef}`}
                      >
                        <MapPin className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
