import { useQuery } from "@tanstack/react-query";
import {
  useJourneysForLine,
  useWorstStopsForLine,
  useRouteVariants,
  useLineStopProfile,
  useWorstJourneysForLine,
  useBestJourneysForLine,
  useJourneyProfile,
  type JourneyEntry,
} from "@/hooks/use-journey-queries";
import Layout from "@/components/layout";
import { RegionSelector } from "@/components/region-selector";
import { warmupDuckDB } from "@/hooks/use-duckdb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useState, useEffect, useMemo, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import { Search, Clock, CheckCircle, AlertCircle, AlertTriangle, ChevronsUpDown, Check, MapPin, ArrowRight, CalendarDays, TrendingUp, TrendingDown, Map, BarChart2 } from "lucide-react";
import { cn, formatStopName, type RechartsTooltipProps } from "@/lib/utils";
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Area, ComposedChart, Line, ReferenceLine } from "recharts";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { InfoTip } from "@/components/info-tip";
import { ScrollableChart, useYAxisDrag } from "@/components/scrollable-chart";
import { formatDateShortNO, formatDateNO } from "@/lib/date-utils";
import { BusLoading } from "@/components/bus-loading";
import {
  TimeWindowPicker,
  type TimeWindow,
  windowToQuery,
  windowDays as windowDaysFn,
  windowLabel,
  serializeWindow,
  parseWindow,
} from "@/components/time-window-picker";
import { useUrlParam } from "@/hooks/use-url-state";

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
  pctEarly: number | null;
  numDepartures: number | null;
  pctRealtimeCoverage: number | null;
  stddevDelayMin: number | null;
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

type JourneyStop = {
  stopRef: string;
  stopSequence: number;
  aimedTime: string | null;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  numSamples: number | null;
  numJourneys?: number | null;
  stopName: string | null;
  avgDelayArrivalMin?: number | null;
  avgDelayDepartureMin?: number | null;
  avgDwellTimeSec?: number | null;
  stddevDelayMin?: number | null;
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
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
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

// Time-window now uses shared TimeWindowPicker (5 presets + custom range).
// See client/src/components/time-window-picker.tsx

type JdHourlyPoint = { hour: string; avgDelay: number | null; maxAvgDelay: number | null; minAvgDelay: number | null; numSamples: number | null };
function HourlyTooltip({ active, payload, periodLabel }: RechartsTooltipProps<JdHourlyPoint> & { periodLabel?: string }) {
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
      <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">Verste/beste dag = høyeste/laveste dagsnitt for denne timen ({periodLabel ?? "valgt periode"})</p>
    </div>
  );
}

function ProfileTooltip({ active, payload, numVariants }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as JourneyStop & { label: string };
  const lowCoverage = numVariants != null && d.numSamples != null && d.numSamples < numVariants;
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[200px]">
      <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
      {d.aimedTime && <p className="text-muted-foreground text-xs mt-1">Planlagt: {d.aimedTime}</p>}
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        {d.maxDelayMin != null && <p className="text-destructive">Maks: {d.maxDelayMin.toFixed(1)}m</p>}
        {d.avgDelayMin != null && <p className="text-orange-500">Snitt: {d.avgDelayMin.toFixed(1)}m</p>}
        {(d as any).stddevDelayMin != null && <p className="text-primary/70">σ: ±{((d as any).stddevDelayMin as number).toFixed(1)}m</p>}
        {d.minDelayMin != null && <p className="text-emerald-500">Min: {d.minDelayMin.toFixed(1)}m</p>}
      </div>
      {d.numSamples != null && (
        <p className="text-muted-foreground text-xs mt-1">
          {d.numSamples.toLocaleString("nb-NO")} stoppbesøk
          {lowCoverage && (
            <span className="text-amber-500/80"> (av {numVariants})</span>
          )}
        </p>
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

type JdDailyTrendPoint = {
  date: string;
  label: string;
  avgDelay: number | null;
  maxDelay: number | null;
  minDelay: number | null;
  numDepartures: number | null;
};
function DailyTrendTooltip({ active, payload }: RechartsTooltipProps<JdDailyTrendPoint>) {
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JourneyDetails() {
  const { region, operators } = useRegion();
  // Comma-separated operator list, or empty when "Alle regioner" — used in URL query.
  const opStr = operators.length ? `operator=${operators.join(",")}` : "";
  const [, navigate] = useLocation();
  const search = useSearch();

  // Direction filter for stats charts ('all' = both directions aggregated)
  const [direction, setDirection] = useUrlParam("direction", "all");

  // Time window (5 presets + custom range).
  const DEFAULT_TW: TimeWindow = { kind: "preset", days: 30, label: "Siste måned" };
  const [twParam, setTwParam] = useUrlParam("tw", serializeWindow(DEFAULT_TW));
  const tw = parseWindow(twParam, DEFAULT_TW);
  const setTw = (w: TimeWindow) => setTwParam(serializeWindow(w));
  const wq = windowToQuery(tw);
  // fromDate: ISO date string used by DuckDB hooks (replaces server-side week window)
  const fromDate = tw.kind === "custom"
    ? tw.from
    : (() => { const d = new Date(); d.setDate(d.getDate() - tw.days); return d.toISOString().slice(0, 10); })();
  const _daysVal = windowDaysFn(tw); void _daysVal;

  // Line picker state
  const [lineOpen, setLineOpen] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string>("");
  const [fetchedLine, setFetchedLine] = useState<string>("");

  // Lat DuckDB-init: WASM-en lastes først når en linje faktisk er valgt —
  // linjelisten kommer fra en lett JSON-artefakt og trenger ikke DuckDB.
  useEffect(() => {
    if (fetchedLine) warmupDuckDB();
  }, [fetchedLine]);

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
    queryKey: [`/api/lines/all${opStr ? `?${opStr}` : ""}`],
  });

  // Bytter du operatør, hører den analyserte linja plutselig til en annen
  // operatør enn den du ser på. Uten dette ble HELE analysen stående: valgte
  // du Avinor mens linje 20 var analysert, viste nedtrekket en flylinje og
  // overskriften «Avinor (fly)», mens tallene og retningsknappene fortsatt
  // var linje 20 sine (Storavatnet ↔ Nesttun). Ingenting sa fra.
  //
  // Vi tømmer bare når lista faktisk er lastet og linja ikke finnes i den —
  // ellers ville et tomt mellomresultat under lasting nullstilt et gyldig valg.
  useEffect(() => {
    if (!fetchedLine || allLines.length === 0) return;
    if (allLines.some((l) => l.lineRef === fetchedLine)) return;
    setFetchedLine("");
    setSelectedLine("");
    setSelectedJourney(null);
    setDirection("all");
    setStopProfileDir("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLines, fetchedLine]);

  const lineStatsUrl = fetchedLine
    ? `/api/line/${encodeURIComponent(fetchedLine)}?${wq}${direction !== "all" ? `&direction=${direction}` : ""}`
    : null;

  const { data: lineStats, isLoading: lineStatsLoading } = useQuery<LineStatsResponse>({
    queryKey: [lineStatsUrl],
    enabled: lineStatsUrl != null,
  });

  const { data: journeys = [] } = useJourneysForLine(fetchedLine, fromDate);

  const { data: worstStops = [] } = useWorstStopsForLine(fetchedLine, fromDate);

  const [stopProfileDir, setStopProfileDir] = useUrlParam("stopProfileDir", "");
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>(undefined);

  // Route variants for the current line + direction
  const { data: routeVariants = [] } = useRouteVariants(
    fetchedLine,
    stopProfileDir,
    fromDate,
  );

  // Auto-select the dominant variant (most samples), reset when direction changes
  useEffect(() => {
    if (routeVariants.length > 0) {
      setSelectedVariant(routeVariants[0].variantId);
    } else {
      setSelectedVariant(undefined);
    }
  }, [routeVariants]);



  // "single" = enkeltobservasjoner (kan være én dags avvik), "recurring" =
  // krever minst 5 observerte dager for et mer pålitelig "verste"-bilde.
  const [journeyRankingMode, setJourneyRankingMode] = useState<"single" | "recurring">("single");
  const journeyRankingMinObs = journeyRankingMode === "recurring" ? 5 : 1;

  const { data: worstJourneys = [] } = useWorstJourneysForLine(
    fetchedLine, stopProfileDir, fromDate, 5, journeyRankingMinObs,
  );

  const { data: bestJourneys = [] } = useBestJourneysForLine(
    fetchedLine, stopProfileDir, fromDate, 5, journeyRankingMinObs,
  );

  const { data: lineStopProfile = [], isLoading: lineStopProfileLoading } = useLineStopProfile(
    fetchedLine, stopProfileDir, fromDate, selectedVariant,
  );

  const { data: journeyProfile = [] } = useJourneyProfile(
    fetchedLine,
    selectedJourney?.directionRef ?? "",
    selectedJourney?.firstStopTime ?? "",
    fromDate,
  );

  const handleSearch = () => {
    setFetchedLine(selectedLine);
    setSelectedJourney(null);
    setDirection("all");
    setStopProfileDir("");
    // Lagre valget i URL-en, slik at det består om man navigerer bort (f.eks.
    // til kartet) og tilbake — se ?line=-lesingen i useEffect over.
    navigate(`/journey?line=${encodeURIComponent(selectedLine)}`, { replace: true });
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
  // «For tidlig» teller som «i rute» i dagens definisjon (<= 2 min), så uten
  // dette tallet er en avgang du umulig kunne rukket usynlig i statistikken.
  const avgPctEarly = daily.length
    ? daily.reduce((s, r) => s + (r.pctEarly ?? 0), 0) / daily.length
    : null;

  // Worst and best days
  const worstDay = daily.length > 0
    ? daily.reduce((worst, r) => (r.avgDelayMin ?? 0) > (worst.avgDelayMin ?? 0) ? r : worst, daily[0])
    : null;
  const bestDay = daily.length > 0
    ? daily.reduce((best, r) => (r.avgDelayMin ?? Infinity) < (best.avgDelayMin ?? Infinity) ? r : best, daily[0])
    : null;
  const totalDepartures = daily.reduce((s, r) => s + (r.numDepartures ?? 0), 0);

  // Weighted average stddev across days (a measure of how unpredictable the line is).
  const avgStddev = (() => {
    let num = 0, den = 0;
    for (const r of daily) {
      if (r.stddevDelayMin != null && r.numDepartures != null) {
        num += r.stddevDelayMin * r.numDepartures;
        den += r.numDepartures;
      }
    }
    return den > 0 ? num / den : null;
  })();

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
    // First pass: prefer journeys with both names
    for (const j of journeys) {
      if (!labels[j.directionRef] && j.firstStopName && j.lastStopName) {
        labels[j.directionRef] = `${j.firstStopName} → ${j.lastStopName}`;
      }
    }
    // Fallback: ensure every direction in journeys has at least a generic label,
    // so the direction picker (and stop-profile chart) renders even when
    // firstStopName/lastStopName are missing from the journeys endpoint.
    for (const j of journeys) {
      if (!labels[j.directionRef]) {
        labels[j.directionRef] = `Retning ${j.directionRef}`;
      }
    }
    return labels;
  }, [journeys]);

  /**
   * Knappene i retningsvelgeren.
   *
   * Har linja bare ÉN retning, vises KUN «Begge». Å tilby et retningsvalg da
   * er i beste fall støy — knappene ville filtrert på samme datasett — og i
   * verste fall villedende: kilder som ikke sender directionRef får den fylt
   * med "0", så begge reiseveier havner under samme retning. Etiketten
   * «A → B» ville da påstått at tallene gjelder én vei når de dekker begge.
   */
  const directionOptions = useMemo(() => {
    const dirs = Object.keys(directionLabels).sort();
    return dirs.length > 1 ? ["all", ...dirs] : ["all"];
  }, [directionLabels]);

  // Står et retningsvalg igjen fra forrige linje (eller en delt URL) på en
  // linje som bare har én retning, ville tallene blitt filtrert på en retning
  // brukeren ikke lenger kan se eller endre. Fall tilbake til «Begge».
  useEffect(() => {
    if (direction !== "all" && !directionOptions.includes(direction)) {
      setDirection("all");
    }
  }, [directionOptions, direction, setDirection]);

  // Y-axis max states (declared early; updated via useEffect after data is computed below)
  const [trendYMax, setTrendYMax] = useState<number>(1);
  const [stopProfileCumYMax, setStopProfileCumYMax] = useState<number>(1);
  const [stopProfileDerYMax, setStopProfileDerYMax] = useState<number>(1);
  const [stopProfileDerYMin, setStopProfileDerYMin] = useState<number>(0);
  const [stopProfileDwellYMax, setStopProfileDwellYMax] = useState<number>(30);
  const [profileMode, setProfileMode] = useState<"cumulative" | "derivative" | "dwell">("cumulative");
  const [profileYMax, setProfileYMax] = useState<number>(1);
  const [profileYMin, setProfileYMin] = useState<number>(0);
  const [profileDerYMax, setProfileDerYMax] = useState<number>(1);
  const [profileDerYMin, setProfileDerYMin] = useState<number>(0);
  const [profileDwellYMax, setProfileDwellYMax] = useState<number>(30);
  const [hourlyYMax, setHourlyYMax] = useState<number>(1);

  // ---- Journey profile chart data ----
  const profileData = useMemo(() => {
    return (journeyProfile as JourneyStop[]).map((s, i, arr) => {
      const prev = i > 0 ? arr[i - 1] : null;
      // Derivative: delay change from previous stop
      const delayGain = prev != null ? (s.avgDelayMin ?? 0) - (prev.avgDelayMin ?? 0) : 0;
      // Stddev upper bound for inner band
      const avg = s.avgDelayMin ?? 0;
      const stddev = s.stddevDelayMin ?? 0;
      const rawMin = s.minDelayMin ?? avg;
      const rawMax = s.maxDelayMin ?? avg;
      // Inner band: symmetric avg±σ in VALUE (not in percentile).
      // For normally-distributed weekly means this covers ~68% of weeks.
      // For skewed delay distributions this is an approximation.
      const innerBandBase = avg - stddev;
      const innerBandRange = 2 * stddev;
      // Outer band: cap raw min/max at avg±2σ to filter genuine outlier weeks.
      const cappedMin = Math.max(rawMin, avg - 2 * stddev);
      const cappedMax = Math.min(rawMax, avg + 2 * stddev);
      const outerBandBase = cappedMin;
      const outerBandRange = Math.max(0, cappedMax - cappedMin);
      // Raw extremes — drawn as faint dashed lines so the absolute worst/best
      // weeks remain visible even when they exceed the ±2σ cap.
      const extremeMin = rawMin;
      const extremeMax = rawMax;
      return {
        ...s,
        label: s.aimedTime ?? String(s.stopSequence),
        shortName: s.stopName
          ? s.stopName.length > 14 ? s.stopName.slice(0, 13) + "\u2026" : s.stopName
          : s.stopRef,
        // Outer band (capped at ±2σ): transparent base + visible range
        bandBase: outerBandBase,
        bandRange: outerBandRange,
        // Inner band (±σ): transparent base + 2σ-wide range
        innerBandBase,
        innerBandRange,
        avgPlusSigma: avg + stddev, // kept for profileDataMax calculation
        // Absolute extremes (raw min/max across all weeks) — drawn as dashed lines
        extremeMin,
        extremeMax,
        // Derivative mode
        delayGain,
        // Dwell mode (seconds, raw — shown with "sek" label)
        dwellTimeSec: s.avgDwellTimeSec ?? null,
      };
    });
  }, [journeyProfile]);
  const profileWidth = Math.max(700, profileData.length * 44);

  // ---- Line stop profile chart data (all stops in route order) ----
  const [stopProfileMode, setStopProfileMode] = useState<"cumulative" | "derivative" | "dwell">("cumulative");

  const stopProfileData = useMemo(() => {
    const base = lineStopProfile.map((s, i) => {
      const prev = i > 0 ? lineStopProfile[i - 1] : null;
      // Derivative: delay gained between this stop and the previous
      const delayGain = prev
        ? (s.avgDelayMin ?? 0) - (prev.avgDelayMin ?? 0)
        : 0;
      // Dwell delay: departure_delay - arrival_delay (time lost at the stop itself)
      const dwellDelay = (s.avgDelayDepartureMin != null && s.avgDelayArrivalMin != null)
        ? s.avgDelayDepartureMin - s.avgDelayArrivalMin
        : null;
      // Transit delay: arrival_delay[N] - departure_delay[N-1] (time lost between stops)
      const transitDelay = (prev?.avgDelayDepartureMin != null && s.avgDelayArrivalMin != null)
        ? s.avgDelayArrivalMin - prev.avgDelayDepartureMin
        : null;
      return {
        ...s,
        shortName: s.stopName
          ? s.stopName.length > 14 ? s.stopName.slice(0, 13) + "\u2026" : s.stopName
          : s.stopRef,
        bandBase: s.minDelayMin ?? s.avgDelayMin ?? 0,
        bandRange: Math.max(0, (s.maxDelayMin ?? s.avgDelayMin ?? 0) - (s.minDelayMin ?? s.avgDelayMin ?? 0)),
        delayGain,
        dwellDelay,
        transitDelay,
        dwellTimeSec: s.avgDwellTimeSec,
      };
    });
    return base;
  }, [lineStopProfile]);

  const stopProfileWidth = Math.max(700, stopProfileData.length * 44);

  // Compute Y-axis maxes after data is available and sync to state
  const trendDataMax = Math.ceil(Math.max(...trendData.map(d => Math.max(d.maxDelay ?? 0, d.avgDelay ?? 0)), 1));
  const stopProfileCumDataMax = Math.ceil(Math.max(...stopProfileData.map(d => Math.max(d.maxDelayMin ?? 0, d.avgDelayMin ?? 0)), 1));
  const stopProfileDerDataMax = Math.ceil(Math.max(...stopProfileData.map(d => Math.abs(d.delayGain ?? 0)), 1));
  // Min for derivative mode (can be negative when bus recovers time):
  const stopProfileDerDataMin = Math.floor(Math.min(...stopProfileData.map(d => d.delayGain ?? 0), 0));
  const stopProfileDwellDataMax = Math.ceil(Math.max(...stopProfileData.map(d => d.dwellTimeSec ?? 0), 30));
  const profileDataMax = Math.ceil(Math.max(...profileData.map(d => Math.max(d.bandBase + d.bandRange, d.avgPlusSigma ?? 0, d.avgDelayMin ?? 0, d.extremeMax ?? 0)), 1));
  // Min also accounts for avg-σ inner band lower edge AND raw extreme min (can be negative when avg is small)
  const profileDataMin = Math.floor(Math.min(...profileData.map(d => Math.min(d.bandBase, d.innerBandBase, d.extremeMin ?? 0, d.avgDelayMin ?? 0)), 0));
  const profileDerDataMax = Math.ceil(Math.max(...profileData.map(d => Math.abs(d.delayGain ?? 0)), 1));
  const profileDerDataMin = Math.floor(Math.min(...profileData.map(d => d.delayGain ?? 0), 0));
  const profileDwellDataMax = Math.ceil(Math.max(...profileData.map(d => d.dwellTimeSec ?? 0), 30));
  const hourlyDataMax = Math.ceil(Math.max(...hourlyData.map(d => Math.max(d.maxAvgDelay ?? 0, d.avgDelay ?? 0)), 1));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setTrendYMax(trendDataMax); }, [trendDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setStopProfileCumYMax(stopProfileCumDataMax); }, [stopProfileCumDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setStopProfileDerYMin(stopProfileDerDataMin); }, [stopProfileDerDataMin]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setStopProfileDerYMax(stopProfileDerDataMax); }, [stopProfileDerDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setStopProfileDwellYMax(stopProfileDwellDataMax); }, [stopProfileDwellDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setProfileYMax(profileDataMax); }, [profileDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setProfileYMin(profileDataMin); }, [profileDataMin]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setProfileDerYMax(profileDerDataMax); }, [profileDerDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setProfileDerYMin(profileDerDataMin); }, [profileDerDataMin]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setProfileDwellYMax(profileDwellDataMax); }, [profileDwellDataMax]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setHourlyYMax(hourlyDataMax); }, [hourlyDataMax]);
  // Reset to dataMax when switching modes so stale yMax from previous mode doesn't leak
  useEffect(() => {
    if (stopProfileMode === "cumulative") setStopProfileCumYMax(stopProfileCumDataMax);
    else if (stopProfileMode === "derivative") setStopProfileDerYMax(stopProfileDerDataMax);
    else if (stopProfileMode === "dwell") setStopProfileDwellYMax(stopProfileDwellDataMax);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopProfileMode]);
  // Reset profile Y-axis on mode change
  useEffect(() => {
    if (profileMode === "cumulative") { setProfileYMax(profileDataMax); setProfileYMin(profileDataMin); }
    else if (profileMode === "derivative") { setProfileDerYMax(profileDerDataMax); setProfileDerYMin(profileDerDataMin); }
    else if (profileMode === "dwell") setProfileDwellYMax(profileDwellDataMax);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileMode]);

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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Linjeanalyse — {REGION_LABEL[region]}</h2>
            <p className="text-muted-foreground mt-1">Historisk forsinkelsesstatistikk per linje.</p>
          </div>
          <RegionSelector />
        </div>

        {/* ---- Line picker ---- */}
        <Card>
          <CardHeader>
            <CardTitle>Velg linje</CardTitle>
            <CardDescription>Velg en linje for å se historisk ytelse. Tidsperiode justeres med knappene under.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-4 items-end">
              <div className="grid gap-2 flex-1 min-w-0">
                <label className="text-sm font-medium">Linje</label>
                <Popover open={lineOpen} onOpenChange={setLineOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={lineOpen}
                      className="w-full min-w-0 justify-between font-normal"
                    >
                      <span className="truncate">
                        {selectedLine
                          ? (() => { const l = allLines.find(l => l.lineRef === selectedLine); return l ? `${lineNumber(l.lineRef)} — ${l.lineName ?? l.lineRef}` : selectedLine; })()
                          : "Søk etter linje..."}
                      </span>
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
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Retning:</span>
              {/* Har linja bare ÉN retning, er et retningsvalg meningsløst: alle
                  knappene ville vist nøyaktig samme datasett. Verre for kilder
                  som ikke sender directionRef i det hele tatt (fylles med "0"),
                  der begge reiseveier ligger under samme retning — da ville
                  etiketten «A → B» direkte lyve om hva tallene dekker.
                  Målt uke 32–33: gjelder ALLE linjer hos AVI (94), VYG (22),
                  FLI (8) og NBU (3), samt 124 av 129 hos KOL. */}
              {directionOptions.map((d) => (
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
            <TimeWindowPicker value={tw} onChange={setTw} />
            <p className="text-[11px] text-muted-foreground -mt-1">
              Reiseprofiler dekker inntil 13 uker med rådata.
            </p>
          </div>
        )}

        {/* Loading / no data */}
        {fetchedLine.length > 0 && !lineStats && (
          lineStatsLoading ? (
            <div className="flex justify-center py-6">
              <BusLoading
                label={direction !== "all" ? `Laster data for ${directionLabels[direction] ?? `retning ${direction}`}` : "Laster linjedata"}
                scale={0.65}
              />
            </div>
          ) : direction !== "all" ? (
            <p className="text-sm text-muted-foreground">
              Ingen data for {directionLabels[direction] ?? `retning ${direction}`}. Prøv en annen retning.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Ingen data funnet for denne linjen.</p>
          )
        )}

        {/* ---- Stats + charts ---- */}
        {lineStats && (
          <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            {daily.length > 0 && (
              <DataQualityBanner
                date={daily[daily.length - 1].date}
                operator={operators[0]}
                lineRef={fetchedLine}
              />
            )}

            {coverageWarning && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-3.5 py-2.5 text-sm flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <span className="text-amber-700 dark:text-amber-400">{coverageWarning}</span>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Snitt forsinkelse</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold font-mono ${(avgDelay ?? 0) > 5 ? "text-destructive" : ""}`}>
                    {avgDelay != null ? `${avgDelay.toFixed(1)}m` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Snitt ({windowLabel(tw)}) · {totalDepartures.toLocaleString("nb-NO")} avganger</p>
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
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Gikk for tidlig</CardTitle>
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-amber-600">
                    {avgPctEarly != null ? `${avgPctEarly.toFixed(1)}%` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Avganger mer enn 1 min før rutetid — dem kan du ikke rekke
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Pålitelighet (σ)</CardTitle>
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold font-mono ${(avgStddev ?? 0) > 5 ? "text-destructive" : (avgStddev ?? 0) > 3 ? "text-amber-500" : "text-emerald-600"}`}>
                    {avgStddev != null ? `±${avgStddev.toFixed(1)}m` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Standardavvik · lavt = forutsigbar</p>
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
                    Snittforsinkelse per time ({windowLabel(tw)}). Det skyggelagte båndet viser spennet mellom beste og verste enkeltdag i perioden.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DraggableYChart yMax={hourlyYMax} setYMax={setHourlyYMax} dataMax={hourlyDataMax} height={280}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={hourlyData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} domain={["auto", hourlyYMax]} allowDataOverflow />
                        <Tooltip content={<HourlyTooltip periodLabel={windowLabel(tw)} />} />
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
                    Topp 5 stoppsteder med høyest gjennomsnittlig forsinkelse for {selectedLineName ?? fetchedLine} ({windowLabel(tw)}).
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
                    Båndet viser spennet mellom beste og verste enkeltavgang i valgt tidsvindu.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Direction picker — derived from actual directions in data.
                      Skjules helt når linja bare har én retning: da er det ingen
                      ting å velge mellom, og en enslig «A → B»-knapp ville
                      påstått at profilen gjelder én vei selv om begge ligger i
                      samme retning (se directionOptions). */}
                  {directionOptions.length > 1 && (
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
                  )}
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
                    lineStopProfileLoading ? (
                      <div className="flex justify-center py-4">
                        <BusLoading label={`Laster stopp-data for retning ${stopProfileDir}`} scale={0.65} />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground py-4">
                        Ingen stopp-data for retning {stopProfileDir}.
                      </p>
                    )
                  )}
                  {stopProfileData.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                          {stopProfileData.length} stopp · {stopProfileData.reduce((s, r) => s + (r.numSamples ?? 0), 0).toLocaleString("nb-NO")} stoppbesøk ({Math.max(...stopProfileData.map(r => r.numSamples ?? 0), 0).toLocaleString("nb-NO")} avganger)
                          <InfoTip learnMoreHref="/metode#dwell-time">
                            <strong>Forsinkelse</strong>: snitt-forsinkelse ved hvert stopp.<br />
                            <strong>Forsinkelsesendring</strong>: hvor mye forsinkelse bygges opp eller tas igjen mellom stopp.<br />
                            <strong>Stopptid</strong>: hvor lenge bussen står stille ved stoppet (dwell time, sekunder).
                          </InfoTip>
                        </div>
                        <div className="flex gap-1">
                          {(["cumulative", "derivative", "dwell"] as const).map((mode) => (
                            <Button
                              key={mode}
                              size="sm"
                              variant={stopProfileMode === mode ? "default" : "outline"}
                              onClick={() => setStopProfileMode(mode)}
                              className="h-6 px-2 text-xs"
                            >
                              {mode === "cumulative" ? "Forsinkelse" : mode === "derivative" ? "Forsinkelsesendring" : "Stopptid"}
                            </Button>
                          ))}
                        </div>
                      </div>
                      {stopProfileMode === "cumulative" && (
                        <ScrollableChart
                          chartWidth={stopProfileWidth}
                          chartHeight={320}
                          yMax={stopProfileCumYMax}
                          setYMax={setStopProfileCumYMax}
                          dataMax={stopProfileCumDataMax}
                        >
                          <ComposedChart
                            width={stopProfileWidth}
                            height={320}
                            data={stopProfileData}
                            margin={{ top: 10, right: 10, bottom: 80, left: 60 }}
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
                              padding={{ left: 20, right: 10 }}
                            />
                            <YAxis hide domain={["auto", stopProfileCumYMax]} allowDataOverflow width={0} />
                            <Tooltip content={<ProfileTooltip />} />
                            <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                            <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />
                            <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--primary))" }} activeDot={{ r: 5 }} isAnimationActive={false} />
                            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                          </ComposedChart>
                        </ScrollableChart>
                      )}
                      {stopProfileMode === "derivative" && (
                        <ScrollableChart
                          chartWidth={stopProfileWidth}
                          chartHeight={320}
                          yMax={stopProfileDerYMax}
                          setYMax={setStopProfileDerYMax}
                          dataMax={stopProfileDerDataMax}
                          yMin={stopProfileDerYMin}
                        >
                          <ComposedChart
                            width={stopProfileWidth}
                            height={320}
                            data={stopProfileData}
                            margin={{ top: 10, right: 10, bottom: 80, left: 60 }}
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
                              padding={{ left: 20, right: 10 }}
                            />
                            <YAxis hide domain={[stopProfileDerYMin, stopProfileDerYMax]} width={0} />
                            <Tooltip
                              content={({ active, payload }: any) => {
                                if (!active || !payload?.[0]) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
                                    <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
                                    <div className="font-mono mt-1 space-y-0.5 text-xs">
                                      <p className={d.delayGain > 0.1 ? "text-destructive" : d.delayGain < -0.1 ? "text-emerald-500" : "text-muted-foreground"}>
                                        Endring: {d.delayGain >= 0 ? "+" : ""}{d.delayGain.toFixed(2)} min
                                      </p>
                                      {d.dwellDelay != null && (
                                        <p className="text-amber-500">Stoppforsinkling: {d.dwellDelay >= 0 ? "+" : ""}{d.dwellDelay.toFixed(2)} min</p>
                                      )}
                                      {d.transitDelay != null && (
                                        <p className="text-blue-500">Kjoreforsinkling: {d.transitDelay >= 0 ? "+" : ""}{d.transitDelay.toFixed(2)} min</p>
                                      )}
                                    </div>
                                    <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">
                                      Positiv = forsinkelse oppstar her. Negativ = bussen tar igjen tid.
                                    </p>
                                  </div>
                                );
                              }}
                            />
                            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                            {/* Bar chart: red for delay generators, green for recovery */}
                            <Area
                              type="monotone"
                              dataKey="delayGain"
                              stroke="none"
                              fill="hsl(var(--primary))"
                              fillOpacity={0.3}
                              isAnimationActive={false}
                            />
                            <Line
                              type="monotone"
                              dataKey="delayGain"
                              stroke="hsl(var(--primary))"
                              strokeWidth={2}
                              dot={({ cx, cy, payload }: any) => {
                                const color = (payload.delayGain ?? 0) > 0.1 ? "hsl(var(--destructive))" : (payload.delayGain ?? 0) < -0.1 ? "hsl(142, 76%, 36%)" : "hsl(var(--muted-foreground))";
                                return <circle cx={cx} cy={cy} r={4} fill={color} stroke="none" />;
                              }}
                              activeDot={{ r: 6 }}
                              isAnimationActive={false}
                            />
                          </ComposedChart>
                        </ScrollableChart>
                      )}
                      {stopProfileMode === "dwell" && (
                        <ScrollableChart
                          chartWidth={stopProfileWidth}
                          chartHeight={320}
                          yMax={stopProfileDwellYMax}
                          setYMax={setStopProfileDwellYMax}
                          dataMax={stopProfileDwellDataMax}
                        >
                          <ComposedChart
                            width={stopProfileWidth}
                            height={320}
                            data={stopProfileData}
                            margin={{ top: 10, right: 10, bottom: 80, left: 60 }}
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
                              padding={{ left: 20, right: 10 }}
                            />
                            <YAxis hide domain={[0, stopProfileDwellYMax]} allowDataOverflow width={0} />
                            <Tooltip
                              content={({ active, payload }: any) => {
                                if (!active || !payload?.[0]) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
                                    <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
                                    <div className="font-mono mt-1 text-xs">
                                      <p>{d.dwellTimeSec != null ? `${d.dwellTimeSec.toFixed(0)} sek` : "Ingen data"}</p>
                                    </div>
                                    <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">
                                      Gjennomsnittlig tid bussen star pa stoppet (ankomst til avgang)
                                    </p>
                                  </div>
                                );
                              }}
                            />
                            <Line
                              type="monotone"
                              dataKey="dwellTimeSec"
                              stroke="hsl(var(--chart-4))"
                              strokeWidth={2}
                              dot={{ r: 3, fill: "hsl(var(--chart-4))" }}
                              activeDot={{ r: 5 }}
                              isAnimationActive={false}
                              connectNulls
                            />
                          </ComposedChart>
                        </ScrollableChart>
                      )}
                      {stopProfileMode !== "cumulative" && (
                        <p className="text-xs text-muted-foreground mt-2">
                          {stopProfileMode === "derivative"
                            ? "Viser endring i forsinkelse mellom hvert stopp. Rodt = forsinkelsen oker, gront = bussen tar igjen tid."
                            : "Viser gjennomsnittlig tid (sekunder) bussen star pa hvert stopp. Krever ankomst- og avgangsdata fra sanntidssystemet."}
                          {" "}Krever re-ingest med oppdatert pipeline for a vise data.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ---- Worst & best individual departures ---- */}
            {fetchedLine.length > 0 && stopProfileDir !== "" && stopProfileDir !== "all" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">Visning:</span>
                  <Tabs value={journeyRankingMode} onValueChange={(v) => setJourneyRankingMode(v as "single" | "recurring")}>
                    <TabsList>
                      <TabsTrigger value="single" className="text-xs">Enkeltavganger</TabsTrigger>
                      <TabsTrigger value="recurring" className="text-xs">Gjentakende (min. 5 dager)</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <InfoTip>
                    "Enkeltavganger" kan vise en avgang som bare er observert én dag — ett uvanlig
                    avvik, ikke nødvendigvis et mønster. "Gjentakende" krever minst 5 observerte
                    dager for den samme avgangen, og gir et mer pålitelig bilde av hva som faktisk
                    går igjen.
                  </InfoTip>
                </div>
              <div className="grid gap-6 lg:grid-cols-2">
                {[
                  { title: "Verste enkeltavganger", desc: "Mest forsinkede", data: worstJourneys, isWorst: true },
                  { title: "Beste enkeltavganger", desc: "Mest punktlige", data: bestJourneys, isWorst: false },
                ].map((section) => (
                  <Card key={section.title}>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        {section.isWorst ? <TrendingUp className="h-5 w-5 text-destructive" /> : <CheckCircle className="h-5 w-5 text-emerald-600" />}
                        {section.title}
                      </CardTitle>
                      <CardDescription>
                        {section.desc} for {selectedLineName ?? fetchedLine}, retning {stopProfileDir} · {windowLabel(tw)} (inntil 13 uker).
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {section.data.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">
                          Ingen data i valgt tidsvindu.{" "}
                          {windowDaysFn(tw) < 14 && (
                            <span>Prøv et lengre tidsvindu.</span>
                          )}
                        </p>
                      ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-muted-foreground text-xs">
                              <th className="text-left pb-2 font-medium">Avgang</th>
                              <th className="text-left pb-2 font-medium hidden md:table-cell">Rute</th>
                              <th className="text-right pb-2 font-medium">Snitt</th>
                              <th className="text-right pb-2 font-medium hidden sm:table-cell" title="Antall ganger denne avgangen er observert i valgt tidsvindu">Avg. obs.</th>
                            </tr>
                          </thead>
                          <tbody>
                            {section.data.map((j, i) => (
                              <tr
                                key={`${j.departureTime}-${j.firstStopName}-${j.lastStopName}`}
                                className="border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                                onClick={() => {
                                  if (!j.departureTime) return;
                                  setSelectedJourney({
                                    directionRef: stopProfileDir,
                                    firstStopTime: j.departureTime,
                                    numVariants: 1,
                                    firstStopName: j.firstStopName,
                                    lastStopName: j.lastStopName,
                                  });
                                  setTimeout(() => journeyProfileRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                                }}
                                title="Klikk for å se avgangsanalyse"
                              >
                                <td className="py-2 font-mono">
                                  <span className="inline-block w-5 text-xs text-muted-foreground mr-2">{i + 1}.</span>
                                  {j.departureTime ?? "—"}
                                  <ArrowRight className="inline-block ml-1.5 h-3 w-3 text-muted-foreground opacity-50" />
                                  {j.lastDate && (
                                    <div className="text-[10px] text-muted-foreground font-normal ml-7">
                                      {j.observedDepartures === 1
                                        ? `${formatDateShortNO(j.lastDate)} — kun 1 observasjon`
                                        : `sist ${formatDateShortNO(j.lastDate)}`}
                                    </div>
                                  )}
                                </td>
                                <td className="py-2 text-muted-foreground text-xs hidden md:table-cell max-w-[180px] truncate">
                                  {j.firstStopName && j.lastStopName
                                    ? `${j.firstStopName} → ${j.lastStopName}`
                                    : j.firstStopName ?? j.lastStopName ?? "—"}
                                </td>
                                <td className="py-2 text-right">
                                  <span className={`font-mono font-semibold ${j.avgDelayMin > 5 ? "text-destructive" : j.avgDelayMin > 2 ? "text-amber-500" : "text-emerald-600"}`}>
                                    {j.avgDelayMin > 0 ? "+" : ""}{j.avgDelayMin.toFixed(1)}m
                                  </span>
                                </td>
                                <td className="py-2 text-right text-muted-foreground hidden sm:table-cell">
                                  {j.observedDepartures.toLocaleString("nb-NO")}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
              </div>
            )}

            {/* ---- A: Journey profile ---- */}
            {journeys.length > 0 && (
              <Card ref={journeyProfileRef}>
                <CardHeader>
                  <CardTitle>Avgangsanalyse</CardTitle>
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
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                          <ArrowRight className="h-3 w-3" />
                          <span>{profileData.length} stopp</span>
                          <span>·</span>
                          <span>
                            {profileData[0]?.aimedTime} → {profileData[profileData.length - 1]?.aimedTime}
                          </span>
                          {selectedJourney && (() => {
                            const observed = Math.max(...profileData.map(r => r.numSamples ?? 0), 0);
                            const total = selectedJourney.numVariants;
                            const partial = observed < total;
                            return (
                              <span className="ml-1">
                                <span className="text-muted-foreground/60">· snitt av </span>
                                <span className={partial ? "text-amber-500" : "text-muted-foreground/60"}>
                                  {partial ? `${observed} av ${total}` : observed}
                                </span>
                                <span className="text-muted-foreground/60"> avganger</span>
                                {partial && (
                                  <span className="text-muted-foreground/40 ml-1" title={`${total - observed} avganger manglet sanntidsdata`}>
                                    ({Math.round(observed / total * 100)}% dekning)
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {(["cumulative", "derivative", "dwell"] as const).map((mode) => (
                            <Button
                              key={mode}
                              size="sm"
                              variant={profileMode === mode ? "default" : "outline"}
                              onClick={() => setProfileMode(mode)}
                              className="h-6 px-2 text-xs"
                            >
                              {mode === "cumulative" ? "Forsinkelse" : mode === "derivative" ? "Forsinkelsesendring" : "Stopptid"}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {/* Cumulative mode: min/max outer band + avg±σ inner band + avg line */}
                      {profileMode === "cumulative" && (
                        <ScrollableChart
                          chartWidth={profileWidth}
                          chartHeight={320}
                          yMax={profileYMax}
                          setYMax={setProfileYMax}
                          dataMax={profileDataMax}
                          yMin={profileYMin}
                        >
                          <ComposedChart
                            width={profileWidth}
                            height={320}
                            data={profileData}
                            margin={{ top: 10, right: 10, bottom: 80, left: 60 }}
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
                              padding={{ left: 20, right: 10 }}
                            />
                            <YAxis hide domain={[profileYMin, profileYMax]} allowDataOverflow width={0} />
                            <Tooltip content={(props: any) => <ProfileTooltip {...props} numVariants={selectedJourney?.numVariants} />} />
                            {/* Outer band: capped at avg±2σ (≈95% of weeks, filters outlier weeks) */}
                            <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                            <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--muted-foreground))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                            {/* Inner band: avg±σ symmetric (≈68% of weeks) */}
                            <Area type="monotone" dataKey="innerBandBase" stackId="inner" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                            <Area type="monotone" dataKey="innerBandRange" stackId="inner" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.28} legendType="none" isAnimationActive={false} />
                            {/* Absolute extremes (raw min/max across all weeks) — faint dashed lines */}
                            <Line type="monotone" dataKey="extremeMax" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.55} dot={false} activeDot={false} legendType="none" isAnimationActive={false} connectNulls />
                            <Line type="monotone" dataKey="extremeMin" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.55} dot={false} activeDot={false} legendType="none" isAnimationActive={false} connectNulls />
                            {/* Main average line */}
                            <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--primary))" }} activeDot={{ r: 5 }} isAnimationActive={false} />
                            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                          </ComposedChart>
                        </ScrollableChart>
                      )}

                      {/* Inline explanation of the cumulative-mode statistics */}
                      {profileMode === "cumulative" && (
                        <div className="text-xs text-muted-foreground mt-2 space-y-1.5 leading-snug">
                          <p>
                            <span className="font-medium text-foreground">Hva viser grafen?</span>{" "}
                            Heltrukken linje er <span className="font-medium">vektet snitt</span> av forsinkelsen
                            (ikke median) over alle ukene i tidsvinduet, vektet etter antall observasjoner per uke.
                          </p>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "hsl(var(--primary))", opacity: 0.28 }} />
                              <span>Indre bånd: snitt ± 1σ (≈ 68 % av ukene hvis normalfordelt)</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="inline-block w-3 h-2 rounded-sm" style={{ background: "hsl(var(--muted-foreground))", opacity: 0.12 }} />
                              <span>Ytre bånd: kappet til snitt ± 2σ (≈ 95 %, filtrerer ekstrem-uker)</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="inline-block w-4 border-t border-dashed border-muted-foreground/70" />
                              <span>Stiplet: faktisk min/maks-uke (snø, streik, e.l.)</span>
                            </span>
                          </div>
                          <p className="text-muted-foreground/80">
                            Båndet er <span className="italic">symmetrisk i verdi</span> (samme antall minutter
                            opp som ned) — ikke i prosentil. Forsinkelser er gjerne høyreskeive, så hvis snittet
                            ligger langt over 0 dekker det øvre båndet typisk litt mer enn 68 %, det nedre litt
                            mindre. For ekte prosentiler (P50/P80/P95), bruk reiseplanleggeren.
                          </p>
                        </div>
                      )}

                      {/* Derivative mode: delay change between stops */}
                      {profileMode === "derivative" && (
                        <ScrollableChart
                          chartWidth={profileWidth}
                          chartHeight={320}
                          yMax={profileDerYMax}
                          setYMax={setProfileDerYMax}
                          dataMax={profileDerDataMax}
                          yMin={profileDerYMin}
                        >
                          <ComposedChart
                            width={profileWidth}
                            height={320}
                            data={profileData}
                            margin={{ top: 10, right: 10, bottom: 80, left: 60 }}
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
                              padding={{ left: 20, right: 10 }}
                            />
                            <YAxis hide domain={[profileDerYMin, profileDerYMax]} width={0} />
                            <Tooltip
                              content={({ active, payload }: any) => {
                                if (!active || !payload?.[0]) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
                                    <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
                                    {d.aimedTime && <p className="text-muted-foreground text-xs mt-1">Planlagt: {d.aimedTime}</p>}
                                    <div className="font-mono mt-1 space-y-0.5 text-xs">
                                      <p className={d.delayGain > 0.1 ? "text-destructive" : d.delayGain < -0.1 ? "text-emerald-500" : "text-muted-foreground"}>
                                        Endring: {d.delayGain >= 0 ? "+" : ""}{(d.delayGain ?? 0).toFixed(2)} min
                                      </p>
                                    </div>
                                    <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">
                                      Positiv = forsinkelse oppstår her. Negativ = bussen tar igjen tid.
                                    </p>
                                  </div>
                                );
                              }}
                            />
                            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                            <Area
                              type="monotone"
                              dataKey="delayGain"
                              stroke="none"
                              fill="hsl(var(--primary))"
                              fillOpacity={0.3}
                              isAnimationActive={false}
                            />
                            <Line
                              type="monotone"
                              dataKey="delayGain"
                              stroke="hsl(var(--primary))"
                              strokeWidth={2}
                              dot={({ cx, cy, payload }: any) => {
                                const color = (payload.delayGain ?? 0) > 0.1 ? "hsl(var(--destructive))" : (payload.delayGain ?? 0) < -0.1 ? "hsl(142, 76%, 36%)" : "hsl(var(--muted-foreground))";
                                return <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={4} fill={color} stroke="none" />;
                              }}
                              activeDot={{ r: 6 }}
                              isAnimationActive={false}
                            />
                          </ComposedChart>
                        </ScrollableChart>
                      )}

                      {/* Dwell mode: average dwell time per stop in seconds */}
                      {profileMode === "dwell" && (
                        <ScrollableChart
                          chartWidth={profileWidth}
                          chartHeight={320}
                          yMax={profileDwellYMax}
                          setYMax={setProfileDwellYMax}
                          dataMax={profileDwellDataMax}
                        >
                          <ComposedChart
                            width={profileWidth}
                            height={320}
                            data={profileData}
                            margin={{ top: 10, right: 10, bottom: 80, left: 60 }}
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
                              padding={{ left: 20, right: 10 }}
                            />
                            <YAxis hide domain={[0, profileDwellYMax]} allowDataOverflow width={0} />
                            <Tooltip
                              content={({ active, payload }: any) => {
                                if (!active || !payload?.[0]) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
                                    <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
                                    {d.aimedTime && <p className="text-muted-foreground text-xs mt-1">Planlagt: {d.aimedTime}</p>}
                                    <div className="font-mono mt-1 text-xs">
                                      <p>{d.dwellTimeSec != null ? `${d.dwellTimeSec.toFixed(0)} sek` : "Ingen data"}</p>
                                    </div>
                                    <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">
                                      Gjennomsnittlig tid bussen står på stoppet (ankomst til avgang)
                                    </p>
                                  </div>
                                );
                              }}
                            />
                            <Line
                              type="monotone"
                              dataKey="dwellTimeSec"
                              stroke="hsl(var(--chart-4))"
                              strokeWidth={2}
                              dot={{ r: 3, fill: "hsl(var(--chart-4))" }}
                              activeDot={{ r: 5 }}
                              isAnimationActive={false}
                              connectNulls
                            />
                          </ComposedChart>
                        </ScrollableChart>
                      )}

                      {profileMode !== "cumulative" && (
                        <p className="text-xs text-muted-foreground mt-2">
                          {profileMode === "derivative"
                            ? "Viser endring i forsinkelse mellom hvert stopp. Rødt = forsinkelsen øker, grønt = bussen tar igjen tid."
                            : "Viser gjennomsnittlig tid (sekunder) bussen står på hvert stopp. Krever ankomst- og avgangsdata fra sanntidssystemet."}
                        </p>
                      )}
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
