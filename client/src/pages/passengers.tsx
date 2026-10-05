import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Area, Line, LineChart, XAxis, YAxis, Tooltip,
  CartesianGrid, Legend,
} from "recharts";
import {
  Users, Clock, Hourglass, CheckCircle, AlertTriangle, Check, ChevronsUpDown, Copy, Link2, Bus, TrendingUp,
  MapPin, Info,
} from "lucide-react";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { InfoTip } from "@/components/info-tip";
import { BusLoading } from "@/components/bus-loading";
import { useRegion } from "@/lib/RegionContext";
import { cn } from "@/lib/utils";
import {
  PAX_ENABLED, PAX_OPERATORS, isPaxOperator, usePaxSummary, usePaxLine, crowdLevel,
  formatMonthLong, formatMonthShort, fmtInt, fmtMin, DAY_TYPE_NO, HOURS_PER_WORK_YEAR,
  type PaxOperator, type PaxSummary, type PaxLineSummary, type PaxLine, type PaxDeparture,
} from "@/lib/pax";

// Leaflet lastes først når kartet faktisk vises
const PaxStopMap = lazy(() => import("@/components/pax-stop-map"));

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  borderRadius: "8px",
  border: "1px solid hsl(var(--border))",
  fontSize: 12,
};

/** Linjer med færre påstigninger enn dette per måned holdes utenfor topplisten. */
const MIN_BOARDINGS_FOR_RANKING = 2000;

function lineLabel(l: { code: string | null; name: string | null; lineRef: string }): string {
  return `${l.code ?? l.lineRef.split(":").pop()}${l.name ? ` · ${l.name}` : ""}`;
}


/** Les én URL-parameter. */
function useParam(key: string): string {
  const search = useSearch();
  return useMemo(() => new URLSearchParams(search).get(key) ?? "", [search, key]);
}

/**
 * Sett flere URL-parametere i ÉN navigasjon. useUrlParam() leser `search` fra
 * render-tidspunktet, så to kall etter hverandre overskriver hverandre — her
 * leses window.location.search ferskt ved hvert kall.
 */
function useSetParams() {
  const [location, navigate] = useLocation();
  return useCallback((updates: Record<string, string>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const qs = params.toString();
    navigate(`${location}${qs ? `?${qs}` : ""}`, { replace: true });
  }, [location, navigate]);
}

// ---------------------------------------------------------------------------
// Side
// ---------------------------------------------------------------------------

export default function Passengers() {
  const summaryQ = usePaxSummary();
  const { operators: regionOps } = useRegion();
  const opParam = useParam("op");
  const lineParam = useParam("line");
  const setParams = useSetParams();
  const explorerRef = useRef<HTMLDivElement>(null);

  const defaultOp: PaxOperator = (regionOps.find((o) => isPaxOperator(o)) as PaxOperator | undefined) ?? "KOL";
  const op: PaxOperator = isPaxOperator(opParam) ? opParam : defaultOp;

  const summary = summaryQ.data ?? null;
  const opSummary = summary?.operators.find((o) => o.code === op) ?? null;
  const opLines = useMemo(() => (summary?.lines ?? []).filter((l) => l.op === op), [summary, op]);

  function selectLine(lineRef: string, opts?: { scroll?: boolean; dt?: string; dep?: string }) {
    setParams({ line: lineRef, dt: opts?.dt ?? "", dep: opts?.dep ?? "", dir: "" });
    if (opts?.scroll) setTimeout(() => explorerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  return (
    <Layout>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Users className="h-7 w-7" />
            Passasjerer
          </h1>
          <p className="text-muted-foreground max-w-3xl">
            Hvem rammes av forsinkelsene? Vi kobler Enturs passasjertellinger med forsinkelsesdataene våre,
            og ser på hvor fulle bussene er, og hvor mye tid passasjerene faktisk taper.
          </p>
        </header>

        {!PAX_ENABLED ? (
          <Card><CardContent className="py-8 text-sm text-muted-foreground">
            Passasjerdata er ikke aktivert i dette bygget (VITE_PAX_BASE_URL er ikke satt).
          </CardContent></Card>
        ) : summaryQ.isLoading ? (
          <div className="py-16 flex justify-center"><BusLoading label="Henter passasjertall" /></div>
        ) : !summary || !opSummary ? (
          <Card><CardContent className="py-8 text-sm text-muted-foreground">
            Fant ikke passasjerdata{summaryQ.error ? ` (${String(summaryQ.error)})` : ""}.
          </CardContent></Card>
        ) : (
          <>
            <BetaNotice summary={summary} />

            <div className="flex flex-wrap items-center gap-2">
              {PAX_OPERATORS.map((code) => {
                const o = summary.operators.find((x) => x.code === code);
                if (!o) return null;
                return (
                  <button
                    key={code}
                    onClick={() => setParams({ op: code === defaultOp ? "" : code, line: "", dt: "", dep: "", dir: "" })}
                    className={cn(
                      "px-3 py-1.5 rounded-full border text-sm transition-colors",
                      code === op ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted",
                    )}
                  >
                    {o.name} <span className="opacity-70">· {o.county}</span>
                  </button>
                );
              })}
            </div>

            <KpiRow op={opSummary} />

            <div className="grid gap-6 lg:grid-cols-5">
              <div className="lg:col-span-3 min-w-0">
                <CostlyLinesCard lines={opLines} month={opSummary.latestMonth} onSelect={(r) => selectLine(r, { scroll: true })} />
              </div>
              <div className="lg:col-span-2 min-w-0">
                <LoadDelayCard summary={summary} op={op} />
              </div>
            </div>

            <div ref={explorerRef} className="scroll-mt-20 md:scroll-mt-4 min-w-0">
              <LineExplorer
                lines={opLines}
                lineRef={opLines.some((l) => l.lineRef === lineParam) ? lineParam : opLines[0]?.lineRef ?? null}
                onLineChange={(r) => selectLine(r)}
              />
            </div>

            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5" /> Hvor taper folk tid?</CardTitle>
                <CardDescription>Hvert stopp, sortert etter hvor mange som bruker det og hvor mye forsinkelse de merker. Klikk en sirkel for tall.</CardDescription>
              </CardHeader>
              <CardContent>
                <Suspense fallback={<div className="h-[460px] flex items-center justify-center text-sm text-muted-foreground">Laster kart …</div>}>
                  <PaxStopMap op={op} opName={opSummary.name} />
                </Suspense>
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <CrowdedCard summary={summary} op={op} onSelect={(r, dt, dep) => selectLine(r, { scroll: true, dt, dep })} />
              <MunicipalityCard summary={summary} op={op} />
            </div>

            <HistoryCard op={opSummary} />

            <MethodCard summary={summary} />
          </>
        )}
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// Beta-merknad
// ---------------------------------------------------------------------------

function BetaNotice({ summary }: { summary: PaxSummary }) {
  return (
    <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-900 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex gap-3">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p>
          <strong>Beta.</strong> Passasjertallene er månedstall fra{" "}
          <a href={summary.source.url} target="_blank" rel="noopener noreferrer" className="underline">samferdselsdata.no</a>{" "}
          (Entur), foreløpig bare for {summary.operators.map((o) => o.name).join(", ")}. Skyss og Ruter er ikke med ennå.
        </p>
        <p className="text-xs opacity-80">
          Tellingene kommer fra sensorer over dørene og kan ha feil. Belegg er et snitt over månedens turer, ikke en
          garanti for din tur. <a href="#metode-pax" className="underline">Slik regner vi</a>.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nøkkeltall
// ---------------------------------------------------------------------------

function KpiRow({ op }: { op: PaxSummary["operators"][number] }) {
  const k = op.kpi[op.kpi.length - 1];
  const prev = op.kpi.length > 1 ? op.kpi[op.kpi.length - 2] : null;
  const workYears = k.paxHoursLost != null ? k.paxHoursLost / HOURS_PER_WORK_YEAR : null;
  const gap = k.paxDelay != null && k.stopDelay != null ? k.paxDelay - k.stopDelay : null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:gap-4 grid-cols-2 lg:grid-cols-4">
        <Kpi
          title="Påstigninger"
          icon={Users}
          accent="border-l-primary"
          value={fmtInt(k.boardings)}
          sub={`${formatMonthLong(k.month)}${prev ? ` · ${formatMonthShort(prev.month)}: ${fmtInt(prev.boardings)}` : ""}`}
          tip="Antall påstigninger registrert av passasjertellerne i måneden, summert over alle linjer og stopp vi har tall for."
        />
        <Kpi
          title="Merket forsinkelse"
          icon={Clock}
          accent="border-l-amber-500"
          value={fmtMin(k.paxDelay)}
          sub={`Snittbussen: ${fmtMin(k.stopDelay)} per stopp`}
          tip="Forsinkelsen slik passasjerene merker den: snitt ankomstforsinkelse vektet med hvor mange som gikk av ved hvert stopp. «Snittbussen» er det vanlige tallet på resten av siden: hver stopp-passering teller likt, enten bussen er full eller tom."
        />
        <Kpi
          title="Timer tapt"
          icon={Hourglass}
          accent="border-l-destructive"
          value={fmtInt(k.paxHoursLost)}
          sub={workYears != null ? `≈ ${workYears.toLocaleString("nb-NO", { maximumFractionDigits: 0 })} årsverk på én måned` : ""}
          tip={`Passasjertimer tapt: summen av forsinkelse for alle som gikk av: avstigende × snitt forsinkelse ved stoppet (tidlige ankomster teller som 0). Et årsverk regnes som ${HOURS_PER_WORK_YEAR} timer.`}
        />
        <Kpi
          title="Framme i rute"
          icon={CheckCircle}
          accent="border-l-emerald-500"
          value={k.paxOnTime != null ? `${k.paxOnTime.toFixed(0)} %` : "—"}
          sub={`${k.paxLate5 != null ? `${k.paxLate5.toFixed(0)} % mer enn 5 min for sent` : ""}`}
          tip="Andel passasjerer (av de avstigende) som kom fram høyst 2 minutter etter rutetid. Sammenlign med andel stopp-passeringer i rute på Oversikt-siden."
        />
      </div>
      {k.uncountedDeps != null && k.uncountedDeps >= 5 && (
        <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {k.uncountedDeps.toFixed(0)} % av avgangene i {formatMonthLong(k.month)} har ingen telling (0 på og 0 av hele måneden).
          Påstigninger og timer tapt er derfor for lave. Belegg og forsinkelse regnes bare for avganger som ble telt.
        </p>
      )}
      {gap != null && gap > 0.2 && (
        <p className="text-sm text-muted-foreground max-w-4xl">
          <strong className="text-foreground">Passasjerene merker mer forsinkelse enn bussene viser.</strong>{" "}
          I {formatMonthLong(k.month)} var passasjerene hos {op.name} i snitt {fmtMin(k.paxDelay)} forsinket da de gikk av,
          mens snittbussen var {fmtMin(k.stopDelay)} forsinket per stopp. Forskjellen på {fmtMin(gap)} kommer av at
          folk reiser der og når bussene er mest forsinket: i rushet, på de travleste linjene, og langt ut på ruten.
        </p>
      )}
    </div>
  );
}

function Kpi({ title, icon: Icon, accent, value, sub, tip }: {
  title: string; icon: React.ComponentType<{ className?: string }>; accent: string; value: string; sub: string; tip: string;
}) {
  return (
    <Card className={cn("border-l-4 shadow-sm", accent)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 pb-1 md:p-6 md:pb-2">
        <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {title}
          <InfoTip>{tip}</InfoTip>
        </CardTitle>
        <Icon className="hidden sm:block h-4 w-4 text-muted-foreground shrink-0" />
      </CardHeader>
      <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
        <div className="text-lg sm:text-2xl font-bold font-mono whitespace-nowrap">{value}</div>
        <p className="text-[11px] md:text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Linjene som koster mest
// ---------------------------------------------------------------------------

function CostlyLinesCard({ lines, month, onSelect }: { lines: PaxLineSummary[]; month: string; onSelect: (lineRef: string) => void }) {
  const [sortBy, setSortBy] = useState<"hours" | "delay">("hours");
  const ranked = useMemo(() => {
    const eligible = lines.filter((l) => l.boardings >= MIN_BOARDINGS_FOR_RANKING && l.stopDelay != null);
    const byHours = [...eligible].sort((a, b) => (b.paxHoursLost ?? 0) - (a.paxHoursLost ?? 0));
    const byDelay = [...eligible].sort((a, b) => (b.stopDelay ?? 0) - (a.stopDelay ?? 0));
    const rankHours = new Map(byHours.map((l, i) => [l.lineRef, i + 1]));
    const rankDelay = new Map(byDelay.map((l, i) => [l.lineRef, i + 1]));
    return { list: (sortBy === "hours" ? byHours : byDelay).slice(0, 12), rankHours, rankDelay, n: eligible.length };
  }, [lines, sortBy]);
  const maxHours = Math.max(1, ...ranked.list.map((l) => l.paxHoursLost ?? 0));
  // Største sprang blant de fem øverste etter timer tapt — brukes i ingressen
  const jumpLine = useMemo(() => {
    let best: { l: PaxLineSummary; h: number; d: number } | null = null;
    for (const [ref, h] of Array.from(ranked.rankHours.entries())) {
      if (h > 5) continue;
      const d = ranked.rankDelay.get(ref) ?? 0;
      const l = lines.find((x) => x.lineRef === ref);
      if (l && d - h >= 10 && (!best || d - h > best.d - best.h)) best = { l, h, d };
    }
    return best;
  }, [ranked, lines]);

  return (
    <Card className="shadow-sm h-full">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2"><Hourglass className="h-5 w-5 text-destructive" /> Linjene som koster passasjerene mest tid</CardTitle>
            <CardDescription className="mt-1">
              {formatMonthLong(month)}. En full buss som er 5 minutter for sein koster mer enn en tom buss som er 10 minutter for sein.
              {jumpLine && (
                <span className="block mt-1 text-foreground/80">
                  Linje {jumpLine.l.code} er nr. {jumpLine.h} her, men bare nr. {jumpLine.d} på en vanlig toppliste. Den er ikke
                  spesielt forsinket, men den frakter {fmtInt(jumpLine.l.boardings)} passasjerer i måneden.
                </span>
              )}
            </CardDescription>
          </div>
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button onClick={() => setSortBy("hours")} className={cn("px-2.5 py-1 rounded", sortBy === "hours" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
              Passasjertimer tapt
            </button>
            <button onClick={() => setSortBy("delay")} className={cn("px-2.5 py-1 rounded", sortBy === "delay" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
              Snitt per avgang
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-left font-medium py-2 pr-2">Linje</th>
                <th className="text-right font-medium py-2 px-2 whitespace-nowrap">Påstigninger</th>
                <th className="text-left font-medium py-2 px-2 whitespace-nowrap min-w-[140px]">Timer tapt</th>
                <th className="text-right font-medium py-2 px-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">Merket<InfoTip>Snitt forsinkelse for dem som gikk av (passasjervektet).</InfoTip></span>
                </th>
                <th className="text-right font-medium py-2 px-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">Per avgang<InfoTip>Vanlig snitt: hver stopp-passering teller likt.</InfoTip></span>
                </th>
                <th className="text-right font-medium py-2 pl-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {sortBy === "hours" ? "Vanlig liste" : "Etter timer"}
                    <InfoTip>{sortBy === "hours"
                      ? "Plassen linjen ville fått på en vanlig toppliste, sortert på snitt forsinkelse per avgang."
                      : "Plassen linjen får når vi sorterer på passasjertimer tapt."}</InfoTip>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ranked.list.map((l, i) => {
                const other = sortBy === "hours" ? ranked.rankDelay.get(l.lineRef) : ranked.rankHours.get(l.lineRef);
                const jump = other != null ? other - (i + 1) : 0;
                return (
                  <tr key={l.lineRef} className="border-b last:border-0 hover:bg-muted/50 cursor-pointer" onClick={() => onSelect(l.lineRef)}>
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
                        <span className="font-mono font-semibold bg-foreground text-background rounded px-1.5 py-0.5 text-xs shrink-0">{l.code ?? "?"}</span>
                        <span className="truncate max-w-[220px]" title={l.name ?? undefined}>{l.name ?? l.lineRef}</span>
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono tabular-nums">{fmtInt(l.boardings)}</td>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 rounded bg-destructive/70" style={{ width: `${Math.max(2, (100 * (l.paxHoursLost ?? 0)) / maxHours)}%`, maxWidth: 90 }} />
                        <span className="font-mono tabular-nums text-xs">{fmtInt(l.paxHoursLost)}</span>
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono tabular-nums">{fmtMin(l.paxDelay)}</td>
                    <td className="py-2 px-2 text-right font-mono tabular-nums text-muted-foreground">{fmtMin(l.stopDelay)}</td>
                    <td className={cn("py-2 pl-2 text-right font-mono tabular-nums text-xs", Math.abs(jump) >= 10 && "font-semibold text-foreground")}>
                      {other != null ? `nr. ${other}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          {ranked.n} linjer med minst {fmtInt(MIN_BOARDINGS_FOR_RANKING)} påstigninger i måneden. Klikk en linje for å se belegget avgang for avgang.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Last vs forsinkelse
// ---------------------------------------------------------------------------

function LoadDelayCard({ summary, op }: { summary: PaxSummary; op: PaxOperator }) {
  const [scope, setScope] = useState<"op" | "ALL">("ALL");
  const rows = summary.loadDelay.filter((r) => r.op === (scope === "ALL" ? "ALL" : op));
  const buckets = summary.method.loadBuckets;
  const data = buckets.map((b) => {
    const rush = rows.find((r) => r.bucket === b && r.rush);
    const off = rows.find((r) => r.bucket === b && !r.rush);
    return { bucket: b, rush: rush?.meanDelay ?? null, off: off?.meanDelay ?? null, nRush: rush?.n ?? 0, nOff: off?.n ?? 0 };
  });
  const opName = summary.operators.find((o) => o.code === op)?.name ?? op;

  return (
    <Card className="shadow-sm h-full">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-amber-500" /> Fulle busser er senere</CardTitle>
            <CardDescription className="mt-1">
              Snitt forsinkelse per avgang, etter hvor mange som typisk er om bord på det fulleste.
            </CardDescription>
          </div>
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button onClick={() => setScope("ALL")} className={cn("px-2.5 py-1 rounded", scope === "ALL" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>Alle tre</button>
            <button onClick={() => setScope("op")} className={cn("px-2.5 py-1 rounded", scope === "op" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>{opName}</button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="bucket" interval={0} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false}
                label={{ value: "personer om bord", position: "insideBottom", offset: -2, fontSize: 11, fill: "hsl(var(--muted-foreground))" }} height={36} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}m`} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: number, name: string, item: any) => [
                  `${v?.toFixed(1)} min (${fmtInt(name === "Rush" ? item.payload.nRush : item.payload.nOff)} avganger)`, name,
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="off" name="Utenom rush" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="rush" name="Rush" fill="hsl(var(--chart-4))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Rush = {summary.method.rushHours}. Rushet forklarer en del, men også innenfor rushet og utenfor rushet går fulle
          busser senere. Det er en sammenheng, ikke bevis for årsak: travle linjer har også mer trafikk og flere lyskryss.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Linjeutforsker
// ---------------------------------------------------------------------------

function LinePicker({ lines, value, onChange }: { lines: PaxLineSummary[]; value: string | null; onChange: (r: string) => void }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...lines].sort((a, b) => b.boardings - a.boardings), [lines]);
  const current = lines.find((l) => l.lineRef === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full sm:w-[360px] justify-between">
          <span className="truncate">{current ? lineLabel(current) : "Velg linje"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Søk linjenummer eller navn…" />
          <CommandList>
            <CommandEmpty>Fant ingen linje.</CommandEmpty>
            <CommandGroup heading="Sortert etter antall passasjerer">
              {sorted.map((l) => (
                <CommandItem
                  key={l.lineRef}
                  value={`${l.code ?? ""} ${l.name ?? ""} ${l.lineRef}`}
                  onSelect={() => { onChange(l.lineRef); setOpen(false); }}
                >
                  <Check className={cn("mr-2 h-4 w-4", l.lineRef === value ? "opacity-100" : "opacity-0")} />
                  <span className="font-mono font-semibold mr-2">{l.code}</span>
                  <span className="truncate flex-1">{l.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">{fmtInt(l.boardings)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function LineExplorer({ lines, lineRef, onLineChange }: { lines: PaxLineSummary[]; lineRef: string | null; onLineChange: (r: string) => void }) {
  const lineQ = usePaxLine(lineRef);
  const line = lineQ.data ?? null;
  const dtParam = useParam("dt");
  const depParam = useParam("dep");
  const setParams = useSetParams();
  const setDt = (v: string) => setParams({ dt: v, dep: "", dir: "" });
  const setDep = (v: string) => setParams({ dep: v });

  const dayTypes = useMemo(() => {
    const set = new Set((line?.deps ?? []).map((d) => d.dt ?? "weekday"));
    return ["weekday", "saturday", "sunday", "holiday"].filter((x) => set.has(x));
  }, [line]);
  const dt = dayTypes.includes(dtParam) ? dtParam : dayTypes[0] ?? "weekday";
  const depsOfDay = useMemo(() => (line?.deps ?? []).filter((d) => (d.dt ?? "weekday") === dt && d.l.length > 1), [line, dt]);
  // Retning = endestoppet. Headsign varierer med «via …», endestoppet gjør ikke det.
  const endOf = useCallback((d: PaxDeparture) => line?.stops[d.s[d.s.length - 1]]?.[1] ?? "?", [line]);
  const directions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of depsOfDay) counts.set(endOf(d), (counts.get(endOf(d)) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  }, [depsOfDay, endOf]);
  const dirParam = useParam("dir");
  const selectedDep = depsOfDay.find((d) => d.k === depParam);
  const dir = selectedDep
    ? endOf(selectedDep)
    : directions.some((x) => x.name === dirParam) ? dirParam : directions[0]?.name ?? "";
  // Samme klokkeslett og retning kan finnes to ganger i en måned når ruteplanen
  // byttes midt i måneden (sommerrute → høstrute i august). Vis den med flest turer.
  const deps = useMemo(() => {
    const best = new Map<string, PaxDeparture>();
    for (const d of depsOfDay) {
      if (endOf(d) !== dir) continue;
      const prev = best.get(d.t ?? d.k);
      if (!prev || (d.runs ?? 0) > (prev.runs ?? 0)) best.set(d.t ?? d.k, d);
    }
    if (selectedDep && endOf(selectedDep) === dir) best.set(selectedDep.t ?? selectedDep.k, selectedDep);
    return Array.from(best.values()).sort((a, b) => (a.t ?? "").localeCompare(b.t ?? ""));
  }, [depsOfDay, dir, endOf, selectedDep]);
  const busiest = useMemo(() => deps.reduce<PaxDeparture | null>((best, d) => {
    const p = Math.max(...d.l.map((x) => x ?? 0));
    return !best || p > Math.max(...best.l.map((x) => x ?? 0)) ? d : best;
  }, null), [deps]);
  const dep = selectedDep ?? busiest;


  const kpi = lines.find((l) => l.lineRef === lineRef);

  return (
    <Card className="shadow-sm">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2"><Bus className="h-5 w-5" /> Hvor full er bussen?</CardTitle>
            <CardDescription className="mt-1">Belegg og forsinkelse avgang for avgang, stopp for stopp. Snitt over {line?.month ? formatMonthLong(line.month) : "måneden"}.</CardDescription>
          </div>
          <LinePicker lines={lines} value={lineRef} onChange={onLineChange} />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {lineQ.isLoading ? (
          <div className="py-10 flex justify-center"><BusLoading label="Henter linjen" scale={0.6} /></div>
        ) : !line ? (
          <p className="text-sm text-muted-foreground py-6">Ingen avgangsdetaljer for denne linjen.</p>
        ) : (
          <>
            {kpi && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <MiniStat label="Påstigninger i måneden" value={fmtInt(kpi.boardings)} />
                <MiniStat label="Merket forsinkelse" value={fmtMin(kpi.paxDelay)} hint={`per avgang: ${fmtMin(kpi.stopDelay)}`} />
                <MiniStat label="Framme i rute" value={kpi.paxOnTime != null ? `${kpi.paxOnTime.toFixed(0)} %` : "—"} hint="av dem som gikk av" />
                <MiniStat label="Passasjertimer tapt" value={fmtInt(kpi.paxHoursLost)} hint={`${fmtInt(kpi.crowdedDeps)} avganger med 50+ om bord`} />
              </div>
            )}

            {kpi?.uncountedShare != null && kpi.uncountedShare >= 20 && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {kpi.uncountedShare.toFixed(0)} % av avgangene på linjen ble ikke telt i måneden og vises ikke under.
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              {dayTypes.map((x) => (
                <button key={x} onClick={() => setDt(x === dayTypes[0] ? "" : x)}
                  className={cn("px-3 py-1 rounded-full border text-xs", x === dt ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted")}>
                  {DAY_TYPE_NO[x] ?? x}
                </button>
              ))}
            </div>

            <HourProfile line={line} dt={dt} />

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="text-sm font-medium">Velg avgang <span className="text-muted-foreground font-normal">(farge = typisk belegg på det fulleste)</span></div>
                {directions.length > 1 && (
                  <div className="inline-flex flex-wrap rounded-md border p-0.5 text-xs">
                    {directions.slice(0, 4).map((x) => (
                      <button key={x.name} onClick={() => setParams({ dir: x.name, dep: "" })}
                        className={cn("px-2.5 py-1 rounded", x.name === dir ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                        mot {x.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
                {deps.map((d) => {
                  const peak = Math.max(...d.l.map((x) => x ?? 0));
                  const lvl = crowdLevel(peak);
                  return (
                    <button
                      key={`${d.k}-${d.dt}`}
                      onClick={() => setDep(d.k)}
                      title={`${d.t} mot ${d.hs ?? "?"} · ${Math.round(peak)} om bord`}
                      className={cn(
                        "shrink-0 rounded-md border px-2 py-1 text-xs font-mono tabular-nums transition-all",
                        lvl?.className,
                        dep?.k === d.k ? "ring-2 ring-primary ring-offset-1" : "opacity-80 hover:opacity-100",
                      )}
                    >
                      {d.t}
                    </button>
                  );
                })}
              </div>
            </div>

            {dep && <RouteProfile line={line} dep={dep} />}
            {dep && kpi && <YourBusCard line={line} dep={dep} kpi={kpi} dt={dt} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono font-semibold text-base">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function HourProfile({ line, dt }: { line: PaxLine; dt: string }) {
  const data = useMemo(() => {
    const rows = line.hourly.filter((h) => h.dt === dt);
    return rows.map((h) => ({ hour: `${String(h.h).padStart(2, "0")}`, peak: h.peak, delay: h.delay, n: h.n }));
  }, [line, dt]);
  if (data.length < 2) return null;
  return (
    <div>
      <div className="text-sm font-medium mb-1">Gjennom dagen</div>
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ left: -10, right: 0, top: 6 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(h) => `${h}`} />
            <YAxis yAxisId="l" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis yAxisId="d" orientation="right" stroke="hsl(var(--chart-4))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}m`} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(h) => `Avganger kl. ${h}`}
              formatter={(v: number, name: string) => [name === "Forsinkelse" ? `${v?.toFixed(1)} min` : `${Math.round(v)} personer`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="l" dataKey="peak" name="Om bord på det fulleste" fill="hsl(var(--primary))" fillOpacity={0.75} radius={[3, 3, 0, 0]} />
            <Line yAxisId="d" dataKey="delay" name="Forsinkelse" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RouteProfile({ line, dep }: { line: PaxLine; dep: PaxDeparture }) {
  const data = dep.s.map((si, i) => ({
    i,
    stop: line.stops[si]?.[1] ?? line.stops[si]?.[0] ?? "?",
    load: dep.l[i],
    board: dep.b[i],
    alight: dep.a[i],
    delay: dep.d[i],
    time: dep.t && dep.o[i] != null ? addMin(dep.t, dep.o[i]!) : null,
  }));
  const peak = Math.max(...dep.l.map((x) => x ?? 0));
  const lvl = crowdLevel(peak);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <div className="text-sm font-medium">
          {dep.t} mot {dep.hs ?? "?"} <span className="text-muted-foreground font-normal">· {DAY_TYPE_NO[dep.dt ?? ""] ?? dep.dt} · {dep.runs != null ? `${Math.round(dep.runs)} turer i måneden` : ""}</span>
        </div>
        {lvl && <span className={cn("text-xs border rounded-full px-2 py-0.5", lvl.className)}>{lvl.label}</span>}
      </div>
      {lvl?.key === "multi" && (
        <p className="text-xs text-muted-foreground mb-2">
          Over 120 om bord i snitt er mer enn én buss har plass til. Det betyr nesten alltid at flere busser kjører på samme avgang
          (innsatsbusser, for eksempel til skolestart), og tellingene er slått sammen.
        </p>
      )}
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ left: -10, right: 0, top: 6, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="i" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
              tickFormatter={(i) => shortStop(data[i]?.stop)} interval="preserveStartEnd" minTickGap={24} />
            <YAxis yAxisId="l" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis yAxisId="d" orientation="right" stroke="hsl(var(--chart-4))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}m`} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(i) => {
                const r = data[i as number];
                return r ? `${r.stop}${r.time ? ` (${r.time})` : ""}` : "";
              }}
              formatter={(v: number, name: string) => {
                if (name === "Forsinkelse") return [v != null ? `${v.toFixed(1)} min` : "—", name];
                return [v != null ? v.toFixed(1) : "—", name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area yAxisId="l" dataKey="load" name="Om bord etter stoppet" type="stepAfter" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.2} strokeWidth={2} />
            <Bar yAxisId="l" dataKey="board" name="Går på" fill="hsl(var(--chart-2))" barSize={4} />
            <Bar yAxisId="l" dataKey="alight" name="Går av" fill="hsl(var(--muted-foreground))" fillOpacity={0.5} barSize={4} />
            <Line yAxisId="d" dataKey="delay" name="Forsinkelse" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} type="monotone" connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function addMin(hhmm: string, add: number): string {
  const t = (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + add) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function shortStop(name: string | undefined): string {
  if (!name) return "";
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}

// ---------------------------------------------------------------------------
// «Din buss»-kort
// ---------------------------------------------------------------------------

function YourBusCard({ line, dep, kpi, dt }: { line: PaxLine; dep: PaxDeparture; kpi: PaxLineSummary; dt: string }) {
  const [copied, setCopied] = useState<"text" | "link" | null>(null);
  const peak = Math.max(...dep.l.map((x) => x ?? 0));
  const peakIdx = dep.l.findIndex((x) => x === peak);
  const peakStop = line.stops[dep.s[peakIdx]]?.[1];
  const boardTotal = dep.b.reduce<number>((s, x) => s + (x ?? 0), 0);
  // Passasjervektet forsinkelse for denne avgangen
  let wSum = 0, w = 0;
  dep.a.forEach((a, i) => { const d = dep.d[i]; if (a != null && d != null) { wSum += a * d; w += a; } });
  const paxDelay = w > 0 ? wSum / w : null;
  const lostHours = dep.runs != null ? dep.a.reduce<number>((s, a, i) => s + (a ?? 0) * Math.max(0, dep.d[i] ?? 0), 0) * dep.runs / 60 : null;
  const lvl = crowdLevel(peak);

  const text =
    `Linje ${line.code} kl. ${dep.t} mot ${dep.hs} (${(DAY_TYPE_NO[dt] ?? dt).toLowerCase()}er): ` +
    `i snitt ${Math.round(boardTotal)} påstigende per tur og ${Math.round(peak)} om bord på det fulleste` +
    (peakStop ? ` (etter ${peakStop})` : "") + ". " +
    (paxDelay != null ? `De som gikk av var i snitt ${paxDelay.toFixed(1).replace(".", ",")} min forsinket. ` : "") +
    (lostHours != null && lostHours >= 1 ? `Til sammen tapte passasjerene på denne avgangen ${Math.round(lostHours)} timer i ${formatMonthLong(line.month)}.` : "");

  const url = typeof window !== "undefined" ? window.location.href : "";

  async function copy(what: "text" | "link") {
    try {
      await navigator.clipboard.writeText(what === "text" ? `${text} ${url}` : url);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* utklippstavle blokkert — ignorer */
    }
  }

  return (
    <div className="rounded-xl border-2 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-4 md:p-5">
      <div className="flex items-start gap-4">
        <div className="hidden sm:flex flex-col items-center justify-center rounded-lg bg-foreground text-background px-3 py-2 min-w-[64px]">
          <span className="text-[10px] uppercase tracking-wide opacity-70">Linje</span>
          <span className="font-mono text-2xl font-bold leading-none">{line.code}</span>
          <span className="font-mono text-sm mt-1">{dep.t}</span>
        </div>
        <div className="flex-1 space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Din buss, i tall</div>
          <p className="text-[15px] leading-relaxed">{text}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {lvl && <span className={cn("text-xs border rounded-full px-2 py-0.5", lvl.className)}>{lvl.label}</span>}
            {kpi.peakP90 != null && (
              <span className="text-xs text-muted-foreground">
                9 av 10 avganger på linjen har færre enn {Math.round(kpi.peakP90)} om bord på det fulleste.
              </span>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => copy("text")}>
              {copied === "text" ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
              {copied === "text" ? "Kopiert" : "Kopier tekst"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => copy("link")}>
              {copied === "link" ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
              {copied === "link" ? "Kopiert" : "Kopier lenke"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fulleste avganger og kommuner
// ---------------------------------------------------------------------------

function CrowdedCard({ summary, op, onSelect }: {
  summary: PaxSummary; op: PaxOperator; onSelect: (lineRef: string, dt: string, dep: string) => void;
}) {
  const rows = summary.crowded.filter((c) => c.op === op).slice(0, 10);
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Fulleste avganger</CardTitle>
        <CardDescription>Flest om bord på det fulleste, snitt over måneden (minst 3 turer).</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {rows.map((c) => {
            const lvl = crowdLevel(c.peak);
            return (
              <li key={`${c.lineRef}-${c.depKey}-${c.dayType}`}>
                <button
                  className="w-full flex items-center gap-3 py-2 text-left hover:bg-muted/50 rounded px-1"
                  onClick={() => onSelect(c.lineRef, c.dayType === "weekday" ? "" : c.dayType ?? "", c.depKey)}
                >
                  <span className="font-mono text-sm tabular-nums w-12 shrink-0">{c.time}</span>
                  <span className="font-mono font-semibold bg-foreground text-background rounded px-1.5 py-0.5 text-xs shrink-0">{c.code}</span>
                  <span className="truncate flex-1 text-sm">mot {c.headsign}<span className="text-muted-foreground"> · {DAY_TYPE_NO[c.dayType ?? ""] ?? c.dayType}</span></span>
                  <span className="font-mono text-sm tabular-nums">{fmtInt(c.peak)}</span>
                  {lvl && <span className={cn("hidden sm:inline text-[10px] border rounded-full px-1.5 py-0.5 whitespace-nowrap", lvl.className)}>{lvl.short}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function MunicipalityCard({ summary, op }: { summary: PaxSummary; op: PaxOperator }) {
  const rows = summary.municipalities.filter((m) => m.op === op && m.boardings >= 1000).slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.paxHoursLost ?? 0));
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5" /> Kommuner</CardTitle>
        <CardDescription>Passasjertimer tapt, etter kommunen der folk gikk av.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-left font-medium py-2">Kommune</th>
                <th className="text-right font-medium py-2 px-2">Påstigninger</th>
                <th className="text-left font-medium py-2 px-2 min-w-[120px]">Timer tapt</th>
                <th className="text-right font-medium py-2">Merket</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.municipality} className="border-b last:border-0">
                  <td className="py-2">{m.municipality}</td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums">{fmtInt(m.boardings)}</td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 rounded bg-destructive/60" style={{ width: `${Math.max(2, (100 * (m.paxHoursLost ?? 0)) / max)}%`, maxWidth: 80 }} />
                      <span className="font-mono tabular-nums text-xs">{fmtInt(m.paxHoursLost)}</span>
                    </div>
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">{fmtMin(m.paxDelay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Historikk
// ---------------------------------------------------------------------------

function HistoryCard({ op }: { op: PaxSummary["operators"][number] }) {
  const data = op.history.map(([m, b]) => ({ m, b }));
  if (data.length < 3) return null;
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Påstigninger per måned hos {op.name}</CardTitle>
        <CardDescription>
          Hele historikken i datasettet. Endringer kan skyldes nye tellere og ny rapportering, ikke bare reisevaner. Sommermånedene er alltid lave.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ left: 10, right: 10, top: 6 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="m" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={formatMonthShort} minTickGap={30} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false}
                tickFormatter={(v) => `${(v / 1e6).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} mill`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(m) => formatMonthLong(m as string)} formatter={(v: number) => [fmtInt(v), "Påstigninger"]} />
              <Line dataKey="b" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Metode
// ---------------------------------------------------------------------------

function MethodCard({ summary }: { summary: PaxSummary }) {
  return (
    <Card id="metode-pax" className="shadow-sm scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Info className="h-5 w-5" /> Slik regner vi</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-3 max-w-4xl">
        <p>
          <strong className="text-foreground">Passasjertall:</strong> Enturs passasjertellinger (beta) på{" "}
          <a href={summary.source.url} target="_blank" rel="noopener noreferrer" className="underline">samferdselsdata.no</a>.
          De er månedstall per avgang og stopp: hvor mange som gikk på og av. Tellerne sitter over dørene, og operatørene
          kan i noen tilfeller bruke estimater. Ved stopp med få bosatte flyttes tellingen til neste stopp av personvernhensyn.
        </p>
        <p>
          <strong className="text-foreground">Kobling:</strong> Hver avgang kobles til forsinkelsesdataene våre på linje og siste
          ledd av avgangs-ID-en, som holder seg likt når ruteplanen republiseres. Over 99 % av passasjerene kobles.
        </p>
        <p>
          <strong className="text-foreground">Om bord:</strong> Påstigende minus avstigende, summert langs ruten og delt på antall
          turer i måneden. Antall turer er dagene vi så avgangen, justert for hele dager vi mangler data for. Det er et snitt:
          en enkelt tur kan være mye fullere eller tommere. Avganger med 0 på og 0 av hele måneden regnes som ikke telt (bussen
          hadde trolig ingen teller), ikke som tomme, og holdes utenfor.
        </p>
        <p>
          <strong className="text-foreground">Merket forsinkelse og timer tapt:</strong> Den som går av ved et stopp, merker
          forsinkelsen der. Vi vekter derfor snitt ankomstforsinkelse ved hvert stopp med antall avstigende. Timer tapt teller bare
          forsinkelse, ikke tidlige ankomster. Avvik over {summary.method.outlierMin} min regnes som datafeil og tas ut.
        </p>
        <p>
          <strong className="text-foreground">Ikke med:</strong> Ventetid på holdeplassen og tapte overganger. Det virkelige tidstapet er
          altså større. Forsinkelsesdata fra {summary.source.delayWindow.min} til {summary.source.delayWindow.max}; tallene laget{" "}
          {new Date(summary.generatedAt).toLocaleDateString("nb-NO")}.
        </p>
        <p>
          Les også om forsinkelsestallene på <Link href="/metode" className="underline">metodesiden</Link>.
        </p>
      </CardContent>
    </Card>
  );
}
