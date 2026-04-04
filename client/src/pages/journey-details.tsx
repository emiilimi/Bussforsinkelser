import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useState, useEffect, useMemo, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import { Search, Clock, CheckCircle, AlertCircle, ChevronsUpDown, Check, MapPin, ArrowRight, CalendarDays, TrendingUp, TrendingDown, Map, BarChart2 } from "lucide-react";
import { cn, formatStopName } from "@/lib/utils";
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Area, ComposedChart, Line, ReferenceLine } from "recharts";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { ScrollableChart, useYAxisDrag } from "@/components/scrollable-chart";
import { formatDateShortNO, formatDateNO } from "@/lib/date-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LineRef = { lineRef: string; lineName: string | null };

type LineDaily = {
  date: string;
  lineRef: string;
  lineName: string | null;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  numDepartures: number | null;
};

type HourlyProfile = {
  lineRef: string;
  directionRef?: string;
  hour: number;
  avgDelayMin: number | null;
  maxAvgDelayMin: number | null;
  minAvgDelayMin: number | null;
  numSamples: number | null;
};

type LineStatsResponse = { daily: LineDaily[]; hourly: HourlyProfile[] };

type JourneyEntry = {
  directionRef: string;
  firstStopTime: string;
  numVariants: number;
  firstStopName: string | null;
  lastStopName: string | null;
};

type JourneyStop = {
  stopRef: string;
  stopSequence: number;
  aimedTime: string | null;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  numSamples: number | null;
  stopName: string | null;
};

type WorstStop = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number | null;
  numSamples: number | null;
};

type LineStopProfile = {
  stopRef: string;
  stopSequence: number;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  numSamples: number | null;
  stopName: string | null;
};

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function delayColor(delay: number | null) {
  const d = delay ?? 0;
  if (d > 5) return "hsl(var(--destructive))";
  if (d > 2) return "hsl(var(--chart-4))";
  return "hsl(var(--primary))";
}

function HourlyTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as { hour: string; avgDelay: number | null; maxAvgDelay: number | null; minAvgDelay: number | null; numSamples: number | null };
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
      <p className="font-medium">{d.hour}</p>
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        <p className="text-orange-500">Snitt: {d.avgDelay != null ? `${d.avgDelay.toFixed(2)}m` : "—"}</p>
        {d.maxAvgDelay != null && <p className="text-destructive">Verste dag: {d.maxAvgDelay.toFixed(2)}m</p>}
        {d.minAvgDelay != null && <p className="text-emerald-500">Beste dag: {d.minAvgDelay.toFixed(2)}m</p>}
      </div>
      {d.numSamples != null && <p className="text-muted-foreground text-xs mt-1">{d.numSamples} avganger totalt</p>}
      <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">Verste/beste dag = høyeste/laveste dagsnitt for denne timen siste 30 dager</p>
    </div>
  );
}

function ProfileTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as JourneyStop & { label: string };
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[200px]">
      <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
      {d.aimedTime && <p className="text-muted-foreground text-xs mt-1">Planlagt: {d.aimedTime}</p>}
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        {d.maxDelayMin != null && <p className="text-destructive">Maks: {d.maxDelayMin.toFixed(1)}m</p>}
        {d.avgDelayMin != null && <p className="text-orange-500">Snitt: {d.avgDelayMin.toFixed(1)}m</p>}
        {d.minDelayMin != null && <p className="text-emerald-500">Min: {d.minDelayMin.toFixed(1)}m</p>}
      </div>
      {d.numSamples != null && (
        <p className="text-muted-foreground text-xs mt-1">{d.numSamples} målinger</p>
      )}
    </div>
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

function DailyTrendTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as {
    date: string;
    label: string;
    avgDelay: number | null;
    maxDelay: number | null;
    minDelay: number | null;
    numDepartures: number | null;
  };
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JourneyDetails() {
  const { region, operator } = useRegion();
  const [, navigate] = useLocation();
  const search = useSearch();

  // Direction filter for stats charts ('all' = both directions aggregated)
  const [direction, setDirection] = useState<string>("all");

  // Line picker state
  const [lineOpen, setLineOpen] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string>("");
  const [fetchedLine, setFetchedLine] = useState<string>("");

  // Pre-select line from ?line= URL param (e.g. navigated from stop analysis)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const lineParam = params.get("line");
    if (lineParam && !fetchedLine) {
      setSelectedLine(lineParam);
      setFetchedLine(lineParam);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Journey picker state
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [selectedJourney, setSelectedJourney] = useState<JourneyEntry | null>(null);
  const journeyProfileRef = useRef<HTMLDivElement>(null);

  const { data: allLines = [] } = useQuery<LineRef[]>({
    queryKey: [`/api/lines/all?operator=${operator}`],
  });

  const lineStatsUrl = fetchedLine
    ? `/api/line/${encodeURIComponent(fetchedLine)}${direction !== "all" ? `?direction=${direction}` : ""}`
    : null;

  const { data: lineStats } = useQuery<LineStatsResponse>({
    queryKey: [lineStatsUrl],
    enabled: lineStatsUrl != null,
  });

  const { data: journeys = [] } = useQuery<JourneyEntry[]>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/journeys`],
    enabled: fetchedLine.length > 0,
  });

  const { data: worstStops = [] } = useQuery<WorstStop[]>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/stops`],
    enabled: fetchedLine.length > 0,
  });

  const [stopProfileDir, setStopProfileDir] = useState<string>("");
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>(undefined);

  // Route variants for the current line + direction
  const { data: routeVariants = [] } = useQuery<Array<{
    variantId: string;
    firstStopName: string | null;
    lastStopName: string | null;
    numStops: number;
    totalSamples: number;
    exampleTime: string | null;
  }>>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/route-variants?direction=${stopProfileDir}`],
    enabled: fetchedLine.length > 0 && stopProfileDir !== "" && stopProfileDir !== "all",
  });

  // Auto-select the dominant variant (most samples), reset when direction changes
  useEffect(() => {
    if (routeVariants.length > 0) {
      setSelectedVariant(routeVariants[0].variantId);
    } else {
      setSelectedVariant(undefined);
    }
  }, [routeVariants]);

  const { data: worstJourneys = [] } = useQuery<Array<{
    serviceJourneyId: string;
    departureTime: string | null;
    firstStopName: string | null;
    lastStopName: string | null;
    avgDelayMin: number;
    totalSamples: number;
    numStops: number;
  }>>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/worst-journeys?direction=${stopProfileDir}`],
    enabled: fetchedLine.length > 0 && stopProfileDir !== "" && stopProfileDir !== "all",
  });

  const stopProfileUrl = selectedVariant
    ? `/api/line/${encodeURIComponent(fetchedLine)}/stop-profile?direction=${stopProfileDir}&variant=${encodeURIComponent(selectedVariant)}`
    : `/api/line/${encodeURIComponent(fetchedLine)}/stop-profile?direction=${stopProfileDir}`;

  const { data: lineStopProfile = [] } = useQuery<LineStopProfile[]>({
    queryKey: [stopProfileUrl],
    enabled: fetchedLine.length > 0 && stopProfileDir !== "",
  });

  const journeyProfileUrl = selectedJourney
    ? `/api/journey?line=${encodeURIComponent(fetchedLine)}&dir=${encodeURIComponent(selectedJourney.directionRef)}&time=${encodeURIComponent(selectedJourney.firstStopTime)}`
    : null;

  const { data: journeyProfile = [] } = useQuery<JourneyStop[]>({
    queryKey: [journeyProfileUrl],
    enabled: journeyProfileUrl != null,
  });

  const handleSearch = () => {
    setFetchedLine(selectedLine);
    setSelectedJourney(null);
    setDirection("all");
    setStopProfileDir("");
  };

  // ---- Derived data for existing charts ----
  const daily = lineStats?.daily ?? [];
  const avgDelay = daily.length
    ? daily.reduce((s, r) => s + (r.avgDelayMin ?? 0), 0) / daily.length
    : null;
  const avgPctOnTime = daily.length
    ? daily.reduce((s, r) => s + (r.pctOnTime ?? 0), 0) / daily.length
    : null;
  const avgPctDelayed10 = daily.length
    ? daily.reduce((s, r) => s + (r.pctDelayed10plus ?? 0), 0) / daily.length
    : null;

  // Worst and best days
  const worstDay = daily.length > 0
    ? daily.reduce((worst, r) => (r.avgDelayMin ?? 0) > (worst.avgDelayMin ?? 0) ? r : worst, daily[0])
    : null;
  const bestDay = daily.length > 0
    ? daily.reduce((best, r) => (r.avgDelayMin ?? Infinity) < (best.avgDelayMin ?? Infinity) ? r : best, daily[0])
    : null;
  const totalDepartures = daily.reduce((s, r) => s + (r.numDepartures ?? 0), 0);

  // Real-time data coverage: % of scheduled stop-visits that had actual GPS times
  // Comes directly from pct_realtime_coverage computed in ingest.py
  const { coveragePct, coverageWarning } = useMemo(() => {
    const vals = daily.map(r => (r as any).pctRealtimeCoverage).filter((v): v is number => v != null);
    if (vals.length === 0) return { coveragePct: null, coverageWarning: null };
    const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    const warning = avg < 70
      ? `Sanntidsdekning ${avg}% — over 30% av avgangene mangler GPS-data. Forsinkelsesstatistikk kan være ufullstendig.`
      : null;
    return { coveragePct: avg, coverageWarning: warning };
  }, [daily]);

  const hourlyData = (lineStats?.hourly ?? []).map((r) => {
    const avg = r.avgDelayMin ?? 0;
    const max = r.maxAvgDelayMin ?? avg;
    const min = r.minAvgDelayMin ?? avg;
    return {
      hour: `${r.hour}:00`,
      avgDelay: r.avgDelayMin,
      maxAvgDelay: r.maxAvgDelayMin,
      minAvgDelay: r.minAvgDelayMin,
      numSamples: r.numSamples,
      // stacked area band: transparent base from 0 to min, then fill from min to max
      bandBase: min,
      bandRange: Math.max(0, max - min),
    };
  });

  const trendData = daily.map((r) => ({
    date: r.date,
    label: formatDateShortNO(r.date),
    avgDelay: r.avgDelayMin,
    maxDelay: r.maxDelayMin,
    minDelay: r.minDelayMin,
    numDepartures: r.numDepartures,
    bandBase: r.minDelayMin ?? r.avgDelayMin ?? 0,
    bandRange: ((r.maxDelayMin ?? r.avgDelayMin ?? 0) - (r.minDelayMin ?? r.avgDelayMin ?? 0)),
  }));

  const selectedLineName = allLines.find((l) => l.lineRef === fetchedLine)?.lineName;

  // Helper: extract line number from lineRef (e.g. "SKY:Line:6" → "6")
  function lineNumber(ref: string) { return ref.split(":").pop() ?? ref; }

  // Sort lines numerically by line number
  const sortedLines = [...allLines].sort((a, b) => {
    const na = Number(lineNumber(a.lineRef));
    const nb = Number(lineNumber(b.lineRef));
    if (isNaN(na) && isNaN(nb)) return lineNumber(a.lineRef).localeCompare(lineNumber(b.lineRef));
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return na - nb;
  });

  // Direction labels derived from journey first/last stop names
  const directionLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const j of journeys) {
      if (!labels[j.directionRef] && j.firstStopName && j.lastStopName) {
        labels[j.directionRef] = `${j.firstStopName} → ${j.lastStopName}`;
      }
    }
    return labels;
  }, [journeys]);

  // Y-axis max states (declared early; updated via useEffect after data is computed below)
  const [trendYMax, setTrendYMax] = useState<number>(1);
  const [stopProfileYMax, setStopProfileYMax] = useState<number>(1);
  const [hourlyYMax, setHourlyYMax] = useState<number>(1);

  // ---- Journey profile chart data ----
  const profileData = journeyProfile.map((s) => ({
    ...s,
    label: s.aimedTime ?? String(s.stopSequence),
    shortName: s.stopName
      ? s.stopName.length > 14 ? s.stopName.slice(0, 13) + "…" : s.stopName
      : s.stopRef,
    // Stacked band: transparent base (minDelayMin), then rangeSize to reach maxDelayMin
    bandBase: s.minDelayMin ?? s.avgDelayMin ?? 0,
    bandRange: ((s.maxDelayMin ?? s.avgDelayMin ?? 0) - (s.minDelayMin ?? s.avgDelayMin ?? 0)),
  }));
  const profileWidth = Math.max(700, profileData.length * 44);

  // ---- Line stop profile chart data (all stops in route order) ----
  const stopProfileData = lineStopProfile.map((s) => ({
    ...s,
    shortName: s.stopName
      ? s.stopName.length > 14 ? s.stopName.slice(0, 13) + "…" : s.stopName
      : s.stopRef,
    bandBase: s.minDelayMin ?? s.avgDelayMin ?? 0,
    bandRange: Math.max(0, (s.maxDelayMin ?? s.avgDelayMin ?? 0) - (s.minDelayMin ?? s.avgDelayMin ?? 0)),
  }));
  const stopProfileWidth = Math.max(700, stopProfileData.length * 44);

  // Compute Y-axis maxes after data is available and sync to state
  const trendDataMax = Math.ceil(Math.max(...trendData.map(d => Math.max(d.maxDelay ?? 0, d.avgDelay ?? 0)), 1));
  const stopProfileDataMax = Math.ceil(Math.max(...stopProfileData.map(d => Math.max(d.maxDelayMin ?? 0, d.avgDelayMin ?? 0)), 1));
  const hourlyDataMax = Math.ceil(Math.max(...hourlyData.map(d => Math.max(d.maxAvgDelay ?? 0, d.avgDelay ?? 0)), 1));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setTrendYMax(trendDataMax); }, [trendDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setStopProfileYMax(stopProfileDataMax); }, [stopProfileDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setHourlyYMax(hourlyDataMax); }, [hourlyDataMax]);

  // Set/switch stop profile direction to first available when current has no journey data
  useEffect(() => {
    const dirs = Object.keys(directionLabels).sort();
    if (dirs.length > 0 && !directionLabels[stopProfileDir]) {
      setStopProfileDir(dirs[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directionLabels]);

  // ---- Journey label helper ----
  function journeyLabel(j: JourneyEntry) {
    const from = j.firstStopName ?? "?";
    const to = j.lastStopName ?? "?";
    return `${j.firstStopTime}: ${from} → ${to}`;
  }

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Linjeanalyse — {REGION_LABEL[region]}</h2>
          <p className="text-muted-foreground mt-1">Historisk forsinkelsesstatistikk per linje.</p>
        </div>

        {/* ---- Line picker ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Velg linje</CardTitle>
            <CardDescription>Velg en linje for å se historisk ytelse de siste 30 dagene.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-4 items-end">
              <div className="grid gap-2 flex-1">
                <label className="text-sm font-medium">Linje</label>
                <Popover open={lineOpen} onOpenChange={setLineOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={lineOpen}
                      className="w-full justify-between font-normal"
                    >
                      {selectedLine
                        ? (() => { const l = allLines.find(l => l.lineRef === selectedLine); return l ? `${lineNumber(l.lineRef)} — ${l.lineName ?? l.lineRef}` : selectedLine; })()
                        : "Søk etter linje..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Søk etter linjenavn..." />
                      <CommandList>
                        <CommandEmpty>Ingen linjer funnet.</CommandEmpty>
                        <CommandGroup>
                          {sortedLines.map((line) => (
                            <CommandItem
                              key={line.lineRef}
                              value={`${line.lineName ?? ""} ${line.lineRef}`}
                              onSelect={() => {
                                setSelectedLine(line.lineRef);
                                setLineOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedLine === line.lineRef ? "opacity-100" : "opacity-0",
                                )}
                              />
                              {lineNumber(line.lineRef)} — {line.lineName ?? line.lineRef}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <Button onClick={handleSearch} disabled={!selectedLine} className="w-full md:w-auto">
                <Search className="mr-2 h-4 w-4" /> Analyser
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Direction toggle — always visible once a line is loaded */}
        {fetchedLine.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Retning:</span>
            {["all", ...Object.keys(directionLabels).sort()].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={direction === d ? "default" : "outline"}
                onClick={() => setDirection(d)}
                className="h-7 px-3 text-xs"
              >
                {d === "all" ? "Begge" : (directionLabels[d] ?? `Retning ${d}`)}
              </Button>
            ))}
          </div>
        )}

        {/* No data for selected direction */}
        {fetchedLine.length > 0 && !lineStats && direction !== "all" && (
          <p className="text-sm text-muted-foreground">
            Ingen data for {directionLabels[direction] ?? `retning ${direction}`}. Prøv en annen retning.
          </p>
        )}

        {/* ---- Stats + charts ---- */}
        {lineStats && (
          <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            {daily.length > 0 && (
              <DataQualityBanner
                date={daily[daily.length - 1].date}
                operator={operator}
                lineRef={fetchedLine}
              />
            )}

            {coverageWarning && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-3.5 py-2.5 text-sm flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <span className="text-amber-700 dark:text-amber-400">{coverageWarning}</span>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Snitt forsinkelse</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold font-mono ${(avgDelay ?? 0) > 5 ? "text-destructive" : ""}`}>
                    {avgDelay != null ? `${avgDelay.toFixed(1)}m` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Snitt siste 30 dager · {totalDepartures.toLocaleString("nb-NO")} avganger</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Andel i rute</CardTitle>
                  <CheckCircle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-emerald-600">
                    {avgPctOnTime != null ? `${avgPctOnTime.toFixed(1)}%` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Avganger &lt; 2 min forsinkelse</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Kraftig forsinket</CardTitle>
                  <AlertCircle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-destructive">
                    {avgPctDelayed10 != null ? `${avgPctDelayed10.toFixed(1)}%` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Avganger &gt; 10 min forsinkelse</p>
                </CardContent>
              </Card>
              <Card className={coveragePct != null && coveragePct < 70 ? "border-l-4 border-l-amber-500" : ""}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Datadekning</CardTitle>
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold font-mono ${coveragePct != null && coveragePct < 70 ? "text-amber-500" : coveragePct != null && coveragePct >= 90 ? "text-emerald-600" : ""}`}>
                    {coveragePct != null ? `${coveragePct}%` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Avganger med GPS-data
                    {coveragePct != null && coveragePct < 70 && " ⚠️"}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Worst / best day info */}
            {worstDay && bestDay && (
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="border-l-4 border-l-destructive">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Verste dag</CardTitle>
                    <TrendingUp className="h-4 w-4 text-destructive" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold font-mono text-destructive">
                      {worstDay.avgDelayMin?.toFixed(1) ?? "—"}m
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      <CalendarDays className="h-3 w-3 inline mr-1" />
                      {formatDateNO(worstDay.date)}
                      {worstDay.pctOnTime != null && <> · {worstDay.pctOnTime.toFixed(0)}% i rute</>}
                      {worstDay.numDepartures != null && <> · {worstDay.numDepartures} avganger</>}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border-l-4 border-l-emerald-500">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Beste dag</CardTitle>
                    <TrendingDown className="h-4 w-4 text-emerald-500" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold font-mono text-emerald-600">
                      {bestDay.avgDelayMin?.toFixed(1) ?? "—"}m
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      <CalendarDays className="h-3 w-3 inline mr-1" />
                      {formatDateNO(bestDay.date)}
                      {bestDay.pctOnTime != null && <> · {bestDay.pctOnTime.toFixed(0)}% i rute</>}
                      {bestDay.numDepartures != null && <> · {bestDay.numDepartures} avganger</>}
                    </p>
                  </CardContent>
                </Card>
              </div>
            )}

            {hourlyData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Forsinkelse etter time på dagen</CardTitle>
                  <CardDescription>
                    Snittforsinkelse per time siste 30 dager. Det skyggelagte båndet viser spennet mellom beste og verste enkeltdag i perioden.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DraggableYChart yMax={hourlyYMax} setYMax={setHourlyYMax} dataMax={hourlyDataMax} height={280}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={hourlyData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} domain={["auto", hourlyYMax]} allowDataOverflow />
                        <Tooltip content={<HourlyTooltip />} />
                        <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                        <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2, fill: "hsl(var(--primary))" }} activeDot={{ r: 4 }} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </DraggableYChart>
                </CardContent>
              </Card>
            )}

            {trendData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Daglig trend</CardTitle>
                  <CardDescription>Gjennomsnittlig forsinkelse per dag for {selectedLineName ?? fetchedLine}.</CardDescription>
                </CardHeader>
                <CardContent>
                  <DraggableYChart yMax={trendYMax} setYMax={setTrendYMax} dataMax={trendDataMax} height={250}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={trendData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} domain={["auto", trendYMax]} allowDataOverflow />
                        <Tooltip content={<DailyTrendTooltip />} />
                        <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                        <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </DraggableYChart>
                </CardContent>
              </Card>
            )}

            {/* ---- B: Worst stops on the line ---- */}
            {worstStops.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Verste stopp på ruten</CardTitle>
                  <CardDescription>
                    Topp 5 stoppsteder med høyest gjennomsnittlig forsinkelse for {selectedLineName ?? fetchedLine} (siste 4 uker).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {worstStops.slice(0, 5).map((stop, i) => (
                      <div
                        key={stop.stopRef}
                        className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 transition-colors"
                      >
                        <span className="text-sm font-mono text-muted-foreground w-5 text-right flex-shrink-0">
                          {i + 1}
                        </span>
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="text-sm flex-1 truncate">
                          {formatStopName(stop.stopName, stop.stopRef)}
                        </span>
                        <span className={cn(
                          "text-sm font-mono font-semibold flex-shrink-0",
                          (stop.avgDelayMin ?? 0) > 5 ? "text-destructive" : "text-orange-500",
                        )}>
                          {stop.avgDelayMin != null ? `${stop.avgDelayMin.toFixed(1)}m` : "—"}
                        </span>
                        <span className="text-xs text-muted-foreground flex-shrink-0 w-20 text-right">
                          {stop.numSamples?.toLocaleString("nb-NO")} avg.
                        </span>
                        <button
                          onClick={() => navigate(`/stops?stop=${encodeURIComponent(stop.stopRef)}&name=${encodeURIComponent(formatStopName(stop.stopName, stop.stopRef))}`)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                          title="Se stoppstedsanalyse"
                        >
                          <MapPin className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- C: Line stop profile (all stops in route order) ---- */}
            {fetchedLine.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Forsinkelsesprofil langs ruten</CardTitle>
                  <CardDescription>
                    Gjennomsnittlig forsinkelse per stopp langs hele ruten — viser hvor forsinkelsen bygger seg opp.
                    Båndet viser spennet mellom beste og verste enkeltavgang siste 4 uker.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Direction picker — derived from actual directions in data */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Retning:</span>
                    {Object.keys(directionLabels).sort().map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={stopProfileDir === d ? "default" : "outline"}
                        onClick={() => setStopProfileDir(d)}
                        className="h-7 px-3 text-xs"
                      >
                        {directionLabels[d] ?? `Retning ${d}`}
                      </Button>
                    ))}
                  </div>
                  {/* Variant picker — shown when multiple route patterns exist */}
                  {routeVariants.length > 1 && stopProfileDir !== "" && stopProfileDir !== "all" && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-muted-foreground">Rutevariant:</span>
                        <select
                          className="text-xs border rounded px-2 py-1 bg-background"
                          value={selectedVariant ?? ""}
                          onChange={(e) => setSelectedVariant(e.target.value || undefined)}
                        >
                          {routeVariants.map((v, i) => (
                            <option key={v.variantId} value={v.variantId}>
                              {v.firstStopName ?? "?"} → {v.lastStopName ?? "?"} ({v.numStops} stopp, {v.totalSamples.toLocaleString("nb-NO")} målinger)
                              {i === 0 ? " ★" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Denne linjen har {routeVariants.length} ulike rutevarianter. Velg variant for å se korrekt stopprekkefølge.
                      </p>
                    </div>
                  )}
                  {stopProfileData.length === 0 && stopProfileDir !== "" && (
                    <p className="text-sm text-muted-foreground py-4">
                      Ingen stopp-data for retning {stopProfileDir}.
                    </p>
                  )}
                  {stopProfileData.length > 0 && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">
                        {stopProfileData.length} stopp · {stopProfileData.reduce((s, r) => s + (r.numSamples ?? 0), 0).toLocaleString("nb-NO")} målinger totalt
                      </div>
                      <ScrollableChart
                        chartWidth={stopProfileWidth}
                        chartHeight={320}
                        yMax={stopProfileYMax}
                        setYMax={setStopProfileYMax}
                        dataMax={stopProfileDataMax}
                      >
                        <ComposedChart
                          width={stopProfileWidth}
                          height={320}
                          data={stopProfileData}
                          margin={{ top: 10, right: 10, bottom: 80, left: 35 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis
                            dataKey="shortName"
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={9}
                            tickLine={false}
                            axisLine={false}
                            angle={-50}
                            textAnchor="end"
                            interval={0}
                            tick={{ dy: 6 }}
                          />
                          <YAxis
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(v) => `${v.toFixed(0)}m`}
                            domain={["auto", stopProfileYMax]}
                            allowDataOverflow
                          />
                          <Tooltip content={<ProfileTooltip />} />
                          <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                          <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />
                          <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--primary))" }} activeDot={{ r: 5 }} isAnimationActive={false} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                        </ComposedChart>
                      </ScrollableChart>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ---- Worst individual departures ---- */}
            {worstJourneys.length > 0 && stopProfileDir !== "" && stopProfileDir !== "all" && (
              <Card>
                <CardHeader>
                  <CardTitle>Verste enkeltavganger</CardTitle>
                  <CardDescription>
                    De mest forsinkede tidsatte avgangene for {selectedLineName ?? fetchedLine}, retning {stopProfileDir} — snitt forsinkelse langs hele ruten (siste 13 uker).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground text-xs">
                          <th className="text-left pb-2 font-medium">Avgang</th>
                          <th className="text-left pb-2 font-medium hidden md:table-cell">Rute</th>
                          <th className="text-right pb-2 font-medium">Snitt forsinkelse</th>
                          <th className="text-right pb-2 font-medium hidden sm:table-cell">Målinger</th>
                          <th className="text-right pb-2 font-medium hidden sm:table-cell">Stopp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {worstJourneys.map((j, i) => (
                          <tr
                            key={j.serviceJourneyId}
                            className="border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                            onClick={() => {
                              if (!j.departureTime) return;
                              setSelectedJourney({
                                directionRef: stopProfileDir,
                                firstStopTime: j.departureTime,
                                numVariants: 1,
                                firstStopName: null,
                                lastStopName: null,
                              });
                              setTimeout(() => journeyProfileRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                            }}
                            title="Klikk for å se reiseprofil"
                          >
                            <td className="py-2 font-mono">
                              <span className={`inline-block w-5 text-xs text-muted-foreground mr-2`}>{i + 1}.</span>
                              {j.departureTime ?? "—"}
                              <ArrowRight className="inline-block ml-1.5 h-3 w-3 text-muted-foreground opacity-50" />
                            </td>
                            <td className="py-2 text-muted-foreground text-xs hidden md:table-cell max-w-[200px] truncate">
                              {j.firstStopName && j.lastStopName
                                ? `${j.firstStopName} → ${j.lastStopName}`
                                : j.firstStopName ?? j.lastStopName ?? "—"}
                            </td>
                            <td className="py-2 text-right">
                              <span className={`font-mono font-semibold ${j.avgDelayMin > 5 ? "text-destructive" : j.avgDelayMin > 2 ? "text-amber-500" : "text-emerald-600"}`}>
                                {j.avgDelayMin > 0 ? "+" : ""}{j.avgDelayMin.toFixed(1)} min
                              </span>
                            </td>
                            <td className="py-2 text-right text-muted-foreground hidden sm:table-cell">
                              {j.totalSamples.toLocaleString("nb-NO")}
                            </td>
                            <td className="py-2 text-right text-muted-foreground hidden sm:table-cell">
                              {j.numStops}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- A: Journey profile ---- */}
            {journeys.length > 0 && (
              <Card ref={journeyProfileRef}>
                <CardHeader>
                  <CardTitle>Reiseprofil</CardTitle>
                  <CardDescription>
                    Velg en enkeltavgang for å se forsinkelse stopp for stopp langs ruten.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Journey picker */}
                  <div className="grid gap-2 max-w-sm">
                    <label className="text-sm font-medium">Avgang</label>
                    <Popover open={journeyOpen} onOpenChange={setJourneyOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={journeyOpen}
                          className="w-full justify-between font-normal"
                        >
                          {selectedJourney ? journeyLabel(selectedJourney) : "Velg avgang..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[280px] p-0" align="start">
                        <Command>
                          <CommandInput placeholder="Søk etter avgangstid..." />
                          <CommandList>
                            <CommandEmpty>Ingen avganger funnet.</CommandEmpty>
                            <CommandGroup>
                              {journeys.map((j) => (
                                <CommandItem
                                  key={`${j.directionRef}-${j.firstStopTime}`}
                                  value={journeyLabel(j)}
                                  onSelect={() => {
                                    setSelectedJourney(j);
                                    setJourneyOpen(false);
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      selectedJourney?.firstStopTime === j.firstStopTime &&
                                      selectedJourney?.directionRef === j.directionRef
                                        ? "opacity-100"
                                        : "opacity-0",
                                    )}
                                  />
                                  {journeyLabel(j)}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>

                  {/* Journey profile chart */}
                  {profileData.length > 0 && (
                    <>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <ArrowRight className="h-3 w-3" />
                        <span>{profileData.length} stopp</span>
                        <span>·</span>
                        <span>
                          {profileData[0]?.aimedTime} → {profileData[profileData.length - 1]?.aimedTime}
                        </span>
                        {selectedJourney && (
                          <span className="ml-1 text-muted-foreground/60">
                            · snitt av {selectedJourney.numVariants} avganger
                          </span>
                        )}
                      </div>
                      <ScrollableChart
                        chartWidth={profileWidth}
                        chartHeight={320}
                        yMax={Math.ceil(Math.max(...profileData.map(d => Math.max(d.maxDelayMin ?? 0, d.avgDelayMin ?? 0)), 1))}
                        setYMax={() => {}}
                        dataMax={Math.ceil(Math.max(...profileData.map(d => Math.max(d.maxDelayMin ?? 0, d.avgDelayMin ?? 0)), 1))}
                      >
                        <ComposedChart
                          width={profileWidth}
                          height={320}
                          data={profileData}
                          margin={{ top: 10, right: 10, bottom: 80, left: 35 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis
                            dataKey="shortName"
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={9}
                            tickLine={false}
                            axisLine={false}
                            angle={-50}
                            textAnchor="end"
                            interval={0}
                            tick={{ dy: 6 }}
                          />
                          <YAxis
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(v) => `${v.toFixed(0)}m`}
                          />
                          <Tooltip content={<ProfileTooltip />} />
                          <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                          <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />
                          <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--primary))" }} activeDot={{ r: 5 }} isAnimationActive={false} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                        </ComposedChart>
                      </ScrollableChart>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
