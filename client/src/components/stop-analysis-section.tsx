import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useLinesAtStop, useLineHourlyAtStop, useLineDeparturesAtStop } from "@/hooks/use-journey-queries";
import { warmupDuckDB } from "@/hooks/use-duckdb";
import {
  useLatestDataDate, latestAvailableDate, primeParquetMetadata,
} from "@/hooks/use-parquet-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { Route, ChevronDown, ChevronUp } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Line, ReferenceLine, Legend } from "recharts";
import { cn, formatStopName, type RechartsTooltipProps } from "@/lib/utils";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { useYAxisDrag } from "@/components/scrollable-chart";
import { formatDateShortNO, formatWeekdayDateNO } from "@/lib/date-utils";
import { BusLoading } from "@/components/bus-loading";
import {
  TimeWindowPicker,
  type TimeWindow,
  windowToQuery,
  windowLabel,
  serializeWindow,
  parseWindow,
} from "@/components/time-window-picker";
import { useUrlParam } from "@/hooks/use-url-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StopStatsResponse = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number;
  totalDepartures: number;
  daily: Array<{
    date: string;
    avgDelayMin: number | null;
    maxDelayMin: number | null;
    minDelayMin: number | null;
    pctDelayed2plus: number | null;
    pctEarly: number | null;
    stddevDelayMin: number | null;
    numDepartures: number | null;
  }>;
  hourly: Array<{
    hour: number;
    avgDelayMin: number | null;
    maxAvgDelayMin: number | null;
    minAvgDelayMin: number | null;
    numSamples: number | null;
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delayColor(delay: number | null) {
  const d = delay ?? 0;
  if (d > 5) return "hsl(var(--destructive))";
  if (d > 2) return "hsl(var(--chart-4))";
  return "hsl(var(--primary))";
}

/** Formater én rå forsinkelsesobservasjon: "+3.2m" / "-0.5m" / "—". */
function ObsDelay({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const cls =
    value > 2 ? "text-destructive" : value < -1 ? "text-sky-600" : "text-emerald-600";
  return (
    <span className={cls}>
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}m
    </span>
  );
}

/** Wraps a responsive chart with Y-axis drag support + vertical slider */
function DraggableYChart({ yMax, setYMax, dataMax, height, children }: {
  yMax: number; setYMax: (v: number) => void; dataMax: number; height: number; children: React.ReactNode;
}) {
  const { onMouseDown, isDragging } = useYAxisDrag(yMax, setYMax, dataMax);
  return (
    <div className="flex items-stretch">
      <div
        className="flex-1 min-w-0"
        style={{ height, cursor: isDragging ? "ns-resize" : undefined }}
        onMouseDown={onMouseDown}
      >
        {children}
      </div>
      {dataMax > 2 && (
        <div className="flex flex-col items-center gap-1 ml-1" style={{ height }}>
          <button
            onClick={() => setYMax(dataMax)}
            className="text-[9px] text-muted-foreground hover:text-foreground transition-colors px-1"
            title="Tilbakestill Y-akse"
          >
            ↺
          </button>
          <input
            type="range"
            min={1}
            max={dataMax}
            step={0.5}
            value={yMax}
            onChange={(e) => setYMax(Number(e.target.value))}
            className="h-full w-4 accent-primary"
            style={{
              writingMode: "vertical-lr",
              direction: "rtl",
            } as React.CSSProperties}
            title={`Y-maks: ${yMax}m`}
          />
          <span className="text-[9px] text-muted-foreground font-mono">{yMax}m</span>
        </div>
      )}
    </div>
  );
}

type DailyTrendPoint = {
  date: string; label: string; avgDelay: number | null;
  maxDelay: number | null; minDelay: number | null; numDepartures: number | null;
};
function DailyTrendTooltip({ active, payload }: RechartsTooltipProps<DailyTrendPoint>) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[200px]">
      <p className="font-medium">{formatDateShortNO(d.date)}</p>
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        <p className="text-orange-500">Snitt: {d.avgDelay != null ? `${d.avgDelay.toFixed(2)}m` : "—"}</p>
        {d.maxDelay != null && <p className="text-destructive">Maks: {d.maxDelay.toFixed(2)}m</p>}
        {d.minDelay != null && <p className="text-emerald-500">Min: {d.minDelay.toFixed(2)}m</p>}
      </div>
      {d.numDepartures != null && (
        <p className="text-muted-foreground text-xs mt-1">{d.numDepartures.toLocaleString("nb-NO")} avganger</p>
      )}
    </div>
  );
}

type HourlyPoint = { hour: string; avgDelay: number | null; maxAvgDelay: number | null; minAvgDelay: number | null; numSamples: number | null };
function HourlyTooltip({ active, payload }: RechartsTooltipProps<HourlyPoint>) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
      <p className="font-medium">{d.hour}</p>
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        <p className="text-orange-500">Snitt: {d.avgDelay != null ? `${d.avgDelay.toFixed(2)}m` : "—"}</p>
        {d.maxAvgDelay != null && <p className="text-destructive">Verste dag: {d.maxAvgDelay.toFixed(2)}m</p>}
        {d.minAvgDelay != null && <p className="text-emerald-500">Beste dag: {d.minAvgDelay.toFixed(2)}m</p>}
      </div>
      {d.numSamples != null && <p className="text-muted-foreground text-xs mt-1">{d.numSamples.toLocaleString("nb-NO")} stoppbesøk</p>}
      <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">Verste/beste dag = høyeste/laveste dagsnitt for denne timen siste 30 dager</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/**
 * Stoppstedsanalyse for et gitt stopp — utvidet, kort-basert visning med
 * trend/timesprofil/linjer. Brukes som seksjon under avgangslisten på
 * /avganger og /stops (se pages/departures.tsx), som deler ett søk mellom
 * de to seksjonene. Platform-velgeren fra den tidligere frittstående
 * stoppanalyse-siden er droppet her — Entur-geocoderet (delt søk) gir ikke
 * quay-lister, kun retningsvelgeren (som hentes uavhengig) er beholdt.
 */
export function StopAnalysisSection({ stopRef, stopName, operators, lat, lng }: {
  stopRef: string; stopName: string; operators: string[];
  lat?: number | null; lng?: number | null;
}) {
  const [, navigate] = useLocation();
  const opStr = operators.length ? `operator=${operators.join(",")}` : "";
  const [direction, setDirection] = useUrlParam("stopDirection", "all");
  const DEFAULT_STOP_WINDOW: TimeWindow = { kind: "preset", days: 30, label: "Siste måned" };
  const [stopWindowParam, setStopWindowParam] = useUrlParam("stopWindow", serializeWindow(DEFAULT_STOP_WINDOW));
  const window = parseWindow(stopWindowParam, DEFAULT_STOP_WINDOW);
  const setWindow = (w: TimeWindow) => setStopWindowParam(serializeWindow(w));
  const [expandedLine, setExpandedLine] = useState<string | null>(null);

  useEffect(() => {
    warmupDuckDB();
    // Primingen gir oss MAX(date) (ankeret for «Siste N dager», se
    // stopFromDate under) og varmer samtidig parquet-footerne, som er det
    // som gjør den FØRSTE ekte spørringen rask. Kun "by-stop" — alle
    // spørringene på denne siden bruker den familien.
    primeParquetMetadata("by-stop");
    setExpandedLine(null);
    setDirection("all");
  }, [stopRef]);

  // name=... følger med på alle stopp-spørringer: NSR-IDer slås periodisk
  // sammen/erstattes, så geocoderets ref kan avvike fra den artefakten
  // (stats_stops_map.json) kjenner til — navnet brukes som fallback for å
  // finne stoppet likevel. Se resolveStopQuays i stats-adapter.ts.
  // lat/lng følger med samme sted: flere fysisk urelaterte stoppesteder i
  // Norge deler navn (f.eks. "Kringsjå" i Oslo/Bergen/Fredrikstad), så
  // navnematchen alene kan plukke opp feil by — koordinatet brukes til å
  // luke ut treff utenfor NAME_MATCH_RADIUS_M i stats-adapter.ts.
  const nameQ = `name=${encodeURIComponent(stopName)}`;
  const coordQ = lat != null && lng != null ? `lat=${lat}&lng=${lng}` : "";
  const { data: availableDirections = [] } = useQuery<string[]>({
    queryKey: [`/api/stop/${encodeURIComponent(stopRef)}/directions?${[nameQ, coordQ, opStr].filter(Boolean).join("&")}`],
  });
  const stopStatsUrl = `/api/stop/${encodeURIComponent(stopRef)}?${[nameQ, coordQ, windowToQuery(window), opStr, direction !== "all" ? `direction=${direction}` : ""].filter(Boolean).join("&")}`;

  // isFetching (ikke isLoading): med keepPreviousData går status rett til
  // "success" med FORRIGE vindus data, så isLoading er false under hele
  // ombyttet. Uten isFetching har UI-et ingen måte å vise at det jobber —
  // og siden spørringene tar titalls sekunder, så det ut som om «Siste uke»
  // og «Siste 2 uker» ga nøyaktig samme tall (meldt inn 2026-08-21).
  const {
    data: stats, isLoading: statsLoading, isError: statsError, isFetching: statsFetching,
  } = useQuery<StopStatsResponse>({
    queryKey: [stopStatsUrl],
    placeholderData: keepPreviousData, // keep old charts visible while switching direction/window
  });

  const { data: allLines = [] } = useQuery<Array<{ lineRef: string; lineName: string | null }>>({
    queryKey: [`/api/lines/all${opStr ? `?${opStr}` : ""}`],
  });

  const lineNameMap = Object.fromEntries(allLines.map(l => [l.lineRef, l.lineName]));
  function lineNumber(ref: string) { return ref.split(":").pop() ?? ref; }

  // «Siste N dager» må ankres på SISTE DAG MED DATA, ikke på dagens dato.
  // Ingesten ligger typisk noen dager bak (målt 21. aug 2026: ferskeste
  // by-stop-data var 18. aug), og med dagens dato som anker ble vinduet
  // stille forkortet i den ene enden: «Siste uke» ga da 5 dager med data,
  // ikke 7. Verre var at panelene på SAMME side var uenige — dagstrend og
  // timesprofil går via stats-adapterens daysAgoFromLatest(), som allerede
  // ankret riktig, mens listene under (linjer/enkeltavganger) brukte denne
  // beregningen. Nå bruker begge samme anker. Samme grep som trip-planner.
  const measuredLatest = useLatestDataDate("by-stop");
  const dataAnchor = measuredLatest ?? latestAvailableDate("by-stop");
  const stopFromDate = (() => {
    if (window.kind === "custom") return window.from;
    const base = dataAnchor ? new Date(`${dataAnchor}T00:00:00Z`) : new Date();
    base.setUTCDate(base.getUTCDate() - Math.max(window.days - 1, 0));
    return base.toISOString().slice(0, 10);
  })();

  const { data: linesAtStop = [], isFetching: linesFetching } =
    useLinesAtStop(stopRef, stopFromDate, stopName, lat, lng);
  const { data: lineHourlyRaw = [], isFetching: hourlyFetching } =
    useLineHourlyAtStop(stopRef, stopFromDate, stopName, lat, lng);

  // Noe er på vei inn mens vi allerede viser tall fra forrige valg.
  // (Førstegangslasting dekkes av den store BusLoading-en lenger nede — der
  // finnes det ingen «gammel» visning å merke som utdatert.)
  const refreshing = (statsFetching || linesFetching || hourlyFetching) && !!stats;
  const refreshTarget = [
    windowLabel(window).toLowerCase(),
    direction !== "all" ? `retning ${direction}` : null,
  ].filter(Boolean).join(" · ");

  const { data: lineDeps = [], isLoading: lineDepsLoading } = useLineDeparturesAtStop(
    expandedLine ?? "",
    stopRef,
    stopFromDate,
    expandedLine != null,
    stopName,
    lat,
    lng,
  );

  const trendData = (stats?.daily ?? []).map((r) => ({
    date: r.date,
    label: formatWeekdayDateNO(r.date),
    avgDelay: r.avgDelayMin,
    maxDelay: r.maxDelayMin,
    minDelay: r.minDelayMin,
    numDepartures: r.numDepartures,
    bandBase: r.minDelayMin ?? r.avgDelayMin ?? 0,
    bandRange: Math.max(0, (r.maxDelayMin ?? r.avgDelayMin ?? 0) - (r.minDelayMin ?? r.avgDelayMin ?? 0)),
  }));

  const hourlyData = (stats?.hourly ?? []).map((r) => {
    const avg = r.avgDelayMin ?? 0;
    const max = r.maxAvgDelayMin ?? avg;
    const min = r.minAvgDelayMin ?? avg;
    return {
      hour: `${r.hour}:00`,
      avgDelay: r.avgDelayMin,
      maxAvgDelay: r.maxAvgDelayMin,
      minAvgDelay: r.minAvgDelayMin,
      numSamples: r.numSamples,
      bandBase: min,
      bandRange: Math.max(0, max - min),
    };
  });

  const trendDataMax = Math.ceil(Math.max(...trendData.map(d => Math.max(d.maxDelay ?? 0, d.avgDelay ?? 0)), 1));
  const hourlyDataMax = Math.ceil(Math.max(...hourlyData.map(d => Math.max(d.maxAvgDelay ?? 0, d.avgDelay ?? 0)), 1));
  const [trendYMax, setTrendYMax] = useState(1);
  const [hourlyYMax, setHourlyYMax] = useState(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setTrendYMax(trendDataMax); }, [trendDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setHourlyYMax(hourlyDataMax); }, [hourlyDataMax]);

  const avgPctDelayed =
    stats && stats.daily.length > 0
      ? stats.daily.reduce((s, r) => s + (r.pctDelayed2plus ?? 0), 0) / stats.daily.length
      : null;

  // «For tidlig» faller utenfor både «forsinket >2 min» og dagens i rute-
  // definisjon, så uten dette tallet er en avgang du umulig kunne rukket
  // usynlig ved stoppet.
  const avgPctEarly =
    stats && stats.daily.length > 0
      ? stats.daily.reduce((s, r) => s + (r.pctEarly ?? 0), 0) / stats.daily.length
      : null;

  const avgStddev = (() => {
    if (!stats || stats.daily.length === 0) return null;
    let num = 0, den = 0;
    for (const r of stats.daily) {
      if (r.stddevDelayMin != null && r.numDepartures != null) {
        num += r.stddevDelayMin * r.numDepartures;
        den += r.numDepartures;
      }
    }
    return den > 0 ? num / den : null;
  })();

  const maxLineDelay = linesAtStop.reduce((m, l) => Math.max(m, l.avgDelayMin ?? 0), 0.01);

  const LINE_COLORS = ["hsl(var(--primary))", "hsl(var(--destructive))", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#06b6d4"];
  const lineDepartures = new Map<string, number>();
  lineHourlyRaw.forEach(r => lineDepartures.set(r.lineRef, (lineDepartures.get(r.lineRef) ?? 0) + (r.numSamples ?? 0)));
  const uniqueLines = Array.from(new Set(lineHourlyRaw.map((r) => r.lineRef)))
    .sort((a, b) => (lineDepartures.get(b) ?? 0) - (lineDepartures.get(a) ?? 0))
    .slice(0, 7);
  const lineHourlyPivot: Record<string, any>[] = [];
  if (uniqueLines.length > 0) {
    const hoursSet = new Set(lineHourlyRaw.map((r) => r.hour));
    Array.from(hoursSet).sort((a, b) => a - b).forEach((h) => {
      const row: Record<string, any> = { hour: `${h}:00` };
      uniqueLines.forEach((lRef) => {
        const match = lineHourlyRaw.find((r) => r.lineRef === lRef && r.hour === h);
        row[lRef] = match?.avgDelayMin ?? null;
      });
      lineHourlyPivot.push(row);
    });
  }

  return (
    <div className="space-y-6">
      {availableDirections.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Retning:</span>
          {["all", ...availableDirections].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={direction === d ? "default" : "outline"}
              onClick={() => setDirection(d)}
              className="h-7 px-3 text-xs"
            >
              {d === "all" ? "Begge" : `Retning ${d}`}
            </Button>
          ))}
        </div>
      )}

      <TimeWindowPicker value={window} onChange={setWindow} />

      {/* Oppdateringsstripe: vises ØVERST, over den gamle statistikken, når
          et nytt tidsvindu/retning hentes. Uten den blir forrige visning
          stående uendret (keepPreviousData) i de titalls sekundene
          spørringene tar, og det ser ut som om valget ikke gjorde noe. */}
      {refreshing && (
        <div
          className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
          role="status"
          aria-live="polite"
        >
          <BusLoading label="" scale={0.32} className="shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Laster data for {refreshTarget}</p>
            <p className="text-xs text-muted-foreground">
              Viser forrige visning inntil de nye tallene er klare.
            </p>
          </div>
        </div>
      )}

      {statsLoading && !stats && (
        <div className="flex justify-center py-6">
          <BusLoading label="Laster data" scale={0.8} />
        </div>
      )}

      {!statsLoading && (statsError || !stats) && (
        <div className="flex flex-col items-start gap-3 py-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertCircle className="h-5 w-5 text-orange-500" />
            <span className="font-medium">Ingen data funnet for dette stoppestedet</span>
          </div>
          <p className="text-sm text-muted-foreground max-w-md">
            {direction !== "all"
              ? <>Det finnes ingen forsinkelsesdata for <span className="font-medium">{stopName}</span> i retning {direction}. Prøv en annen retning.</>
              : <>Ingen data for dette stoppestedet funnet. Dette kan skyldes at dette stoppet ikke har noen avganger, eller at kollektivselskapet ikke har lastet opp forsinkelsesdata for dette stoppet.</>
            }
          </p>
          {direction !== "all" && (
            <Button variant="default" size="sm" onClick={() => setDirection("all")}>
              Tilbake til alle retninger
            </Button>
          )}
        </div>
      )}

      {stats && (
        <div className="grid gap-6 animate-in slide-in-from-bottom-4 duration-300">
          {stats.daily.length > 0 && (
            <DataQualityBanner
              date={stats.daily[stats.daily.length - 1].date}
              operator={operators[0]}
              stopRef={stopRef}
            />
          )}

          {statsLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Oppdaterer...
            </div>
          )}

          {/* ---- Stat cards ---- */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Snitt forsinkelse</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono text-destructive">{stats.avgDelayMin.toFixed(1)}m</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Standardavvik (σ)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono">
                  {avgStddev != null ? `±${avgStddev.toFixed(1)}m` : "—"}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1 leading-tight">
                  Spredning i forsinkelse — lavt = forutsigbart.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Totale avganger</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono">{stats.totalDepartures.toLocaleString("nb-NO")}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Forsinket &gt;2 min</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono text-orange-500">
                  {avgPctDelayed != null ? `${avgPctDelayed.toFixed(1)}%` : "—"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Gikk for tidlig</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold font-mono text-amber-600">
                  {avgPctEarly != null ? `${avgPctEarly.toFixed(1)}%` : "—"}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1 leading-tight">
                  Mer enn 1 min før rutetid — dem kan du ikke rekke.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* ---- Daily trend ---- */}
          <Card>
            <CardHeader>
              <CardTitle>Forsinkelse over tid</CardTitle>
              <CardDescription>Daglig gjennomsnittlig forsinkelse ved {formatStopName(stats.stopName, stats.stopRef)}</CardDescription>
            </CardHeader>
            <CardContent>
              <DraggableYChart yMax={trendYMax} setYMax={setTrendYMax} dataMax={trendDataMax} height={300}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} domain={["auto", trendYMax]} allowDataOverflow />
                    <Tooltip content={<DailyTrendTooltip />} />
                    <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                    <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--destructive))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                    <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                  </ComposedChart>
                </ResponsiveContainer>
              </DraggableYChart>
            </CardContent>
          </Card>

          {/* ---- Hourly pattern ---- */}
          {hourlyData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Forsinkelse etter time på dagen</CardTitle>
                <CardDescription>
                  Snittforsinkelse per time siste 30 dager. Det skyggelagte båndet viser spennet mellom beste og verste enkeltdag i perioden.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DraggableYChart yMax={hourlyYMax} setYMax={setHourlyYMax} dataMax={hourlyDataMax} height={250}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={hourlyData} margin={{ left: 0, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} domain={["auto", hourlyYMax]} allowDataOverflow />
                      <Tooltip content={<HourlyTooltip />} />
                      <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                      <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--destructive))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                      <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 2, fill: "hsl(var(--destructive))" }} activeDot={{ r: 4 }} isAnimationActive={false} />
                      <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </DraggableYChart>
              </CardContent>
            </Card>
          )}

          {/* ---- Lines serving this stop ---- */}
          {linesAtStop.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Linjer ved dette stoppestedet</CardTitle>
                <CardDescription>
                  Gjennomsnittlig forsinkelse per linje ved {formatStopName(stats.stopName, stats.stopRef)} ({windowLabel(window)}).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {linesAtStop.map((line) => (
                    <div key={line.lineRef} className="space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5 w-44 flex-shrink-0 min-w-0">
                          <Badge
                            variant="outline"
                            className="w-14 justify-center font-mono text-xs flex-shrink-0"
                          >
                            {lineNumber(line.lineRef)}
                          </Badge>
                          <span className="text-xs text-muted-foreground truncate">
                            {lineNameMap[line.lineRef] ?? ""}
                          </span>
                        </div>
                        <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${Math.max(2, ((line.avgDelayMin ?? 0) / maxLineDelay) * 100)}%`,
                              backgroundColor: delayColor(line.avgDelayMin),
                            }}
                          />
                        </div>
                        <span className={cn(
                          "text-sm font-mono font-semibold w-14 text-right flex-shrink-0",
                          (line.avgDelayMin ?? 0) > 5 ? "text-destructive" : "text-orange-500",
                        )}>
                          {line.avgDelayMin != null ? `${line.avgDelayMin.toFixed(1)}m` : "—"}
                        </span>
                        <span className="text-xs text-muted-foreground w-20 text-right flex-shrink-0">
                          {line.numSamples?.toLocaleString("nb-NO")} avg.
                        </span>
                        <button
                          onClick={() =>
                            setExpandedLine(expandedLine === line.lineRef ? null : line.lineRef)
                          }
                          className={cn(
                            "flex items-center gap-1 text-xs transition-colors flex-shrink-0",
                            expandedLine === line.lineRef
                              ? "text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          title="Vis enkeltavgangene bak snittet"
                        >
                          {expandedLine === line.lineRef ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                          <span className="hidden sm:inline">Detaljer</span>
                        </button>
                        <button
                          onClick={() => navigate(`/journey?line=${encodeURIComponent(line.lineRef)}`)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                          title="Åpne avgangsanalyse for denne linjen"
                        >
                          <Route className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Avgangsanalyse</span>
                        </button>
                      </div>

                      {expandedLine === line.lineRef && (
                        <div className="rounded-md border border-border bg-muted/30 p-2">
                          {lineDepsLoading ? (
                            <p className="text-xs text-muted-foreground py-1 px-2 flex items-center gap-2">
                              <Loader2 className="h-3 w-3 animate-spin" /> Henter enkeltavganger…
                            </p>
                          ) : lineDeps.length === 0 ? (
                            <p className="text-xs text-muted-foreground py-1 px-2">
                              Ingen enkeltavganger funnet i valgt tidsvindu.
                            </p>
                          ) : (
                            <>
                              <div className="max-h-64 overflow-y-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground text-left">
                                      <th className="py-1 px-2 font-medium">Dato</th>
                                      <th className="py-1 px-2 font-medium">Planlagt</th>
                                      <th className="py-1 px-2 font-medium text-right">Ankomst</th>
                                      <th className="py-1 px-2 font-medium text-right">Avgang</th>
                                    </tr>
                                  </thead>
                                  <tbody className="font-mono">
                                    {lineDeps.map((d, i) => (
                                      <tr
                                        key={`${d.date}-${d.serviceJourneyId ?? i}`}
                                        className="border-t border-border/50"
                                        title={d.serviceJourneyId ?? undefined}
                                      >
                                        <td className="py-1 px-2 whitespace-nowrap">
                                          {formatWeekdayDateNO(d.date)}
                                        </td>
                                        <td className="py-1 px-2">{d.aimedTime ?? "—"}</td>
                                        <td className="py-1 px-2 text-right">
                                          <ObsDelay value={d.delayArrivalMin} />
                                        </td>
                                        <td className="py-1 px-2 text-right">
                                          <ObsDelay value={d.delayDepartureMin} />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-1 px-2">
                                Rå enkeltobservasjoner for linjen ved dette stoppestedet,{" "}
                                {windowLabel(window).toLowerCase()}
                                {lineDeps.length >= 100 ? " — viser de 100 nyeste" : ""}. Hold
                                musepekeren over en rad for avgangs-ID.
                              </p>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ---- Multi-line hourly chart ---- */}
          {lineHourlyPivot.length > 0 && uniqueLines.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Forsinkelse per linje etter time</CardTitle>
                <CardDescription>
                  Gjennomsnittlig forsinkelse per time for hver linje ved {formatStopName(stats.stopName, stats.stopRef)} ({windowLabel(window)}, fra reisedata).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={lineHourlyPivot} margin={{ left: 0, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: number, name: string) => {
                          const lineName = lineNameMap[name];
                          const num = lineNumber(name);
                          const label = lineName ? `${num} — ${lineName}` : `Linje ${num}`;
                          return [`${v?.toFixed(2)} min`, label];
                        }}
                      />
                      <Legend formatter={(v) => {
                        const num = lineNumber(v);
                        const name = lineNameMap[v];
                        return name ? `${num} — ${name}` : `Linje ${num}`;
                      }} />
                      <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      {uniqueLines.map((lRef, i) => (
                        <Line
                          key={lRef}
                          type="monotone"
                          dataKey={lRef}
                          stroke={LINE_COLORS[i % LINE_COLORS.length]}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
