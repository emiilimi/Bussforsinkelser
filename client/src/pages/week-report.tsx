// ---------------------------------------------------------------------------
// «Uka som gikk» — en kort, delbar ukerapport per region.
//
// Regnes i nettleseren fra artefaktene aggregate_stats.py allerede lager
// (stats_summary.json + stats_line_names.json) — ingen ny pipeline, ingen
// DuckDB. Sammenligner siste 7 dager med de 7 før, og finner busslinjer der
// siste uke skiller seg tydelig fra siste 30 dager.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, TrendingUp, TrendingDown, Share2, Check, ArrowRight, Minus } from "lucide-react";
import Layout from "@/components/layout";
import { RegionSelector } from "@/components/region-selector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BusLoading } from "@/components/bus-loading";
import { PARQUET_BASE } from "@/hooks/use-parquet-query";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { formatWeekdayDateNO, lineNumber, cleanLineName, isRailOperator } from "@/lib/date-utils";
import { cn } from "@/lib/utils";

type DailyRow = {
  date: string; operator: string; avgDelayMin: number | null; pctOnTime: number | null;
  totalJourneys: number; n: number; totalCancellations?: number | null;
};
type LineRow = {
  lineRef: string; mode: string; window: number; avgDelayMin: number | null;
  pctOnTime: number | null; pctEarly: number | null; totalDepartures: number;
};
type Summary = { dates: { min: string; max: string }; daily: DailyRow[]; lines: LineRow[] };

/** Samme terskler som Oversikt: minst 5 avganger per dag, og >120 min er datafeil. */
const MIN_PER_DAY = 5;
const IMPLAUSIBLE = 120;
/** Endring siste 7 mot siste 30 dager som regnes som «tydelig» (minutter). */
const CHANGE_MIN = 1;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmt(n: number | null | undefined, digits = 1): string {
  return n == null ? "—" : n.toLocaleString("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function combine(rows: DailyRow[]) {
  let n = 0, wDelay = 0, wOnTime = 0, nOnTime = 0, journeys = 0, canc = 0;
  for (const r of rows) {
    if (r.avgDelayMin != null && r.n > 0) { wDelay += r.avgDelayMin * r.n; n += r.n; }
    if (r.pctOnTime != null && r.n > 0) { wOnTime += r.pctOnTime * r.n; nOnTime += r.n; }
    journeys += r.totalJourneys ?? 0;
    canc += r.totalCancellations ?? 0;
  }
  return {
    avgDelay: n ? wDelay / n : null,
    onTime: nOnTime ? wOnTime / nOnTime : null,
    journeys,
    cancellations: canc,
  };
}

export default function WeekReport() {
  const { operators, regions } = useRegion();
  const summaryQ = useQuery<Summary>({
    queryKey: ["week-report", "summary"],
    queryFn: async () => {
      const r = await fetch(`${PARQUET_BASE}/stats_summary.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`stats_summary.json: ${r.status}`);
      return r.json();
    },
    staleTime: Infinity,
  });
  const namesQ = useQuery<Record<string, string>>({
    queryKey: ["week-report", "names"],
    queryFn: async () => {
      const r = await fetch(`${PARQUET_BASE}/stats_line_names.json`);
      return r.ok ? r.json() : {};
    },
    staleTime: Infinity,
  });

  const regionName = regions.length === 0
    ? "hele landet"
    : regions.map((r) => REGION_LABEL[r]).join(", ");

  const report = useMemo(() => {
    const s = summaryQ.data;
    if (!s) return null;
    const end = s.dates.max;
    const startA = addDays(end, -6);
    const endB = addDays(end, -7);
    const startB = addDays(end, -13);
    const inOps = (op: string) => operators.length === 0 || operators.includes(op);
    const rows = s.daily.filter((d) => inOps(d.operator));
    const weekA = rows.filter((d) => d.date >= startA && d.date <= end);
    const weekB = rows.filter((d) => d.date >= startB && d.date <= endB);
    const a = combine(weekA);
    const b = combine(weekB);

    // Per dag i siste uke
    const byDay = new Map<string, DailyRow[]>();
    for (const r of weekA) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
    const days = Array.from(byDay.entries())
      .map(([date, rs]) => ({ date, ...combine(rs) }))
      .filter((d) => d.avgDelay != null)
      .sort((x, y) => x.date.localeCompare(y.date));
    const worstDay = days.reduce<typeof days[number] | null>((w, d) => (!w || (d.avgDelay ?? 0) > (w.avgDelay ?? 0) ? d : w), null);
    const bestDay = days.reduce<typeof days[number] | null>((w, d) => (!w || (d.avgDelay ?? 0) < (w.avgDelay ?? 0) ? d : w), null);

    // Busslinjer: siste 7 mot siste 30 dager
    const l7 = new Map<string, LineRow>();
    const l30 = new Map<string, LineRow>();
    for (const l of s.lines) {
      if (l.mode !== "bus" || !inOps(l.lineRef.split(":")[0])) continue;
      if (l.window === 7) l7.set(l.lineRef, l);
      else if (l.window === 30) l30.set(l.lineRef, l);
    }
    const changes: { lineRef: string; d7: number; d30: number; delta: number; onTime7: number | null; deps7: number }[] = [];
    for (const [ref, w7] of Array.from(l7.entries())) {
      const w30 = l30.get(ref);
      if (!w30 || w7.avgDelayMin == null || w30.avgDelayMin == null) continue;
      if (w7.totalDepartures < MIN_PER_DAY * 7 || w30.totalDepartures < MIN_PER_DAY * 30) continue;
      if (Math.abs(w7.avgDelayMin) > IMPLAUSIBLE || Math.abs(w30.avgDelayMin) > IMPLAUSIBLE) continue;
      changes.push({
        lineRef: ref, d7: w7.avgDelayMin, d30: w30.avgDelayMin, delta: w7.avgDelayMin - w30.avgDelayMin,
        onTime7: w7.pctOnTime, deps7: w7.totalDepartures,
      });
    }
    const worse = changes.filter((c) => c.delta >= CHANGE_MIN).sort((x, y) => y.delta - x.delta).slice(0, 6);
    const better = changes.filter((c) => c.delta <= -CHANGE_MIN).sort((x, y) => x.delta - y.delta).slice(0, 6);
    const worstNow = [...changes].sort((x, y) => y.d7 - x.d7)[0] ?? null;

    return { end, startA, a, b, days, worstDay, bestDay, worse, better, worstNow, nLines: changes.length };
  }, [summaryQ.data, operators]);

  const names = namesQ.data ?? {};
  const lineLabel = (ref: string) => {
    // «INN 111: Dokka - Lillehammer» → «Dokka - Lillehammer» (koden vises for seg)
    const nm = cleanLineName(names[ref])?.replace(/^[A-ZÆØÅ]{2,4}\s*[^:]*:\s*/, "") || null;
    // Listene er bare buss — en toglinje her er buss for tog
    return { code: lineNumber(ref), name: isRailOperator(ref) ? `Buss for tog: ${nm ?? ""}`.trim() : nm };
  };

  const shareText = report
    ? `Uka som gikk (${formatWeekdayDateNO(report.startA)}–${formatWeekdayDateNO(report.end)}), ${regionName}: ` +
      `bussene var i snitt ${fmt(report.a.avgDelay)} min forsinket` +
      (report.b.avgDelay != null && report.a.avgDelay != null
        ? ` (${report.a.avgDelay - report.b.avgDelay >= 0 ? "+" : ""}${fmt(report.a.avgDelay - report.b.avgDelay)} fra uka før)` : "") +
      `. ${report.worstDay ? `Verste dag: ${formatWeekdayDateNO(report.worstDay.date).replace(/\.$/, "")}.` : ""}` +
      (report.worse[0] ? ` Mest forverret: linje ${lineLabel(report.worse[0].lineRef).code} (+${fmt(report.worse[0].delta)} min).` : "")
    : "";

  return (
    <Layout>
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
              <CalendarDays className="h-7 w-7" /> Uka som gikk
            </h1>
            <p className="text-muted-foreground max-w-2xl">
              Siste sju dager mot uka før, for {regionName}. Hvilke dager var verst, og hvilke busslinjer ble tydelig verre eller bedre?
            </p>
          </div>
          <RegionSelector />
        </header>

        {summaryQ.isLoading ? (
          <div className="py-16 flex justify-center"><BusLoading label="Henter ukas tall" /></div>
        ) : !report || report.a.avgDelay == null ? (
          <Card><CardContent className="py-8 text-sm text-muted-foreground">Fant ingen data for valgt region.</CardContent></Card>
        ) : (
          <>
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardDescription>
                  {formatWeekdayDateNO(report.startA)} – {formatWeekdayDateNO(report.end)}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <Delta label="Snitt forsinkelse" now={report.a.avgDelay} before={report.b.avgDelay} unit=" min" lowerIsBetter />
                <Delta label="Andel i rute" now={report.a.onTime} before={report.b.onTime} unit=" %" digits={0} />
                <Delta label="Avganger" now={report.a.journeys} before={report.b.journeys} digits={0} neutral />
                <Delta label="Innstilt" now={report.a.cancellations} before={report.b.cancellations} digits={0} lowerIsBetter />
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle>Dag for dag</CardTitle>
                  <CardDescription>Snitt forsinkelse per dag. Høyden er relativ til ukas verste dag.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {report.days.map((d) => {
                    const max = Math.max(...report.days.map((x) => x.avgDelay ?? 0), 0.1);
                    const isWorst = d.date === report.worstDay?.date;
                    const isBest = d.date === report.bestDay?.date;
                    return (
                      <div key={d.date} className="flex items-center gap-2 text-sm">
                        <span className={cn("w-20 shrink-0", isWorst ? "text-destructive font-medium" : isBest ? "text-emerald-600 font-medium" : "text-muted-foreground")}
                          title={isWorst ? "Ukas verste dag" : isBest ? "Ukas beste dag" : undefined}>
                          {formatWeekdayDateNO(d.date)}
                        </span>
                        <div className="flex-1 min-w-[40px] h-3 rounded bg-muted overflow-hidden">
                          <div className={cn("h-full rounded", isWorst ? "bg-destructive" : isBest ? "bg-emerald-500" : "bg-primary/60")}
                            style={{ width: `${Math.max(3, (100 * (d.avgDelay ?? 0)) / max)}%` }} />
                        </div>
                        <span className="w-12 text-right font-mono tabular-nums shrink-0">{fmt(d.avgDelay)}m</span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle>Del uka</CardTitle>
                  <CardDescription>En setning du kan lime inn hvor som helst.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-[15px] leading-relaxed rounded-lg border bg-muted/30 p-4">{shareText}</p>
                  <ShareButton text={shareText} />
                  {report.worstNow && (
                    <p className="text-xs text-muted-foreground">
                      Mest forsinkede busslinje siste uke: <Link className="underline" href={`/journey?line=${encodeURIComponent(report.worstNow.lineRef)}`}>
                        {lineLabel(report.worstNow.lineRef).code}{lineLabel(report.worstNow.lineRef).name ? ` ${lineLabel(report.worstNow.lineRef).name}` : ""}
                      </Link>{" "}
                      ({fmt(report.worstNow.d7)} min i snitt).
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <ChangeCard
                title="Blitt verre denne uka"
                icon={<TrendingUp className="h-5 w-5 text-destructive" />}
                rows={report.worse}
                lineLabel={lineLabel}
                empty="Ingen busslinjer ble tydelig verre (minst 1 min) denne uka."
              />
              <ChangeCard
                title="Blitt bedre denne uka"
                icon={<TrendingDown className="h-5 w-5 text-emerald-500" />}
                rows={report.better}
                lineLabel={lineLabel}
                empty="Ingen busslinjer ble tydelig bedre (minst 1 min) denne uka."
              />
            </div>

            <p className="text-xs text-muted-foreground max-w-3xl">
              Endringer er siste 7 dager mot siste 30 dager, for busslinjer med minst {MIN_PER_DAY} avganger per dag
              ({report.nLines} linjer). Snitt over {IMPLAUSIBLE} min regnes som datafeil og er tatt ut. En enkelt uke kan
              skyldes veiarbeid, vær eller arrangementer, så les det som et varsel og ikke som en dom.
            </p>
          </>
        )}
      </div>
    </Layout>
  );
}

function Delta({ label, now, before, unit = "", digits = 1, lowerIsBetter = false, neutral = false }: {
  label: string; now: number | null; before: number | null; unit?: string; digits?: number; lowerIsBetter?: boolean; neutral?: boolean;
}) {
  const diff = now != null && before != null ? now - before : null;
  const good = diff == null || neutral ? null : lowerIsBetter ? diff < 0 : diff > 0;
  const small = diff != null && Math.abs(diff) < (digits === 0 ? 1 : 0.05);
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold font-mono whitespace-nowrap">{fmt(now, digits)}{unit}</div>
      {diff != null && (
        <div className={cn(
          "text-xs inline-flex items-center gap-1",
          small || good == null ? "text-muted-foreground" : good ? "text-emerald-600" : "text-destructive",
        )}>
          {small ? <Minus className="h-3 w-3" /> : diff > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {diff > 0 ? "+" : ""}{fmt(diff, digits)}{unit} fra uka før
        </div>
      )}
    </div>
  );
}

function ChangeCard({ title, icon, rows, lineLabel, empty }: {
  title: string; icon: React.ReactNode;
  rows: { lineRef: string; d7: number; d30: number; delta: number; onTime7: number | null }[];
  lineLabel: (ref: string) => { code: string; name: string | null };
  empty: string;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{icon}{title}</CardTitle>
        <CardDescription>Snitt forsinkelse siste 7 dager mot siste 30.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">{empty}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => {
              const { code, name } = lineLabel(r.lineRef);
              return (
                <li key={r.lineRef}>
                  <Link href={`/journey?line=${encodeURIComponent(r.lineRef)}`} className="flex items-center gap-3 py-2 hover:bg-muted/50 rounded px-1">
                    <span className="font-mono font-semibold bg-foreground text-background rounded px-1.5 py-0.5 text-xs shrink-0">{code}</span>
                    <span className="truncate flex-1 text-sm">{name ?? r.lineRef}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">{fmt(r.d30)}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="font-mono text-sm tabular-nums whitespace-nowrap">{fmt(r.d7)} min</span>
                    <span className={cn("font-mono text-xs tabular-nums w-12 text-right", r.delta > 0 ? "text-destructive" : "text-emerald-600")}>
                      {r.delta > 0 ? "+" : ""}{fmt(r.delta)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ShareButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) { await navigator.share({ title: "Uka som gikk — Sen Tur", text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch { /* avbrutt */ }
  }
  return (
    <Button size="sm" variant="outline" onClick={share}>
      {done ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Share2 className="h-3.5 w-3.5 mr-1.5" />}
      {done ? "Kopiert" : "Del"}
    </Button>
  );
}
