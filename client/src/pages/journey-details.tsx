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
  type RouteVariant,
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
import { Clock, CheckCircle, AlertCircle, AlertTriangle, ChevronsUpDown, Check, MapPin, ArrowRight, CalendarDays, TrendingUp, TrendingDown, ListOrdered, ZoomIn, BarChart2, Signal, Route, Map as MapIcon } from "lucide-react";
import { cn, formatStopName, type RechartsTooltipProps } from "@/lib/utils";
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Area, ComposedChart, Line, ReferenceLine, Brush, Bar, Cell } from "recharts";
import { parseDistribution, fmtSignedMin, fmtPct, type DistRow } from "@/lib/line-distribution";
import {
  LineSummaryCard, DelayHistogram, WeekHourHeatmap, DailyChart, RouteStopsDialog, type RouteStop, type SummaryNumbers,
} from "@/components/line-analysis";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { InfoTip } from "@/components/info-tip";
import { useYAxisDrag } from "@/components/scrollable-chart";
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
import { useLineGeometry } from "@/hooks/use-line-geometry";
import { LineRouteMap, type StopDelayMap } from "@/components/line-route-map";
import { DayTypePicker } from "@/components/day-type-picker";
import { BandToggle } from "@/components/band-toggle";
import { LinePaxCard } from "@/components/line-pax-card";
import { dayTypeFilterLabel, parseDayTypeFilter } from "@/lib/day-type";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Verste stopp vises som topp 5, men SAMME spørring gir fargene til rutekartet
// (se stopDelays lenger nede), så vi henter hele linjens stopp. Spørringen
// grupperer uansett over alt — LIMIT kutter bare resultatet, ingen ekstra kost.
const WORST_STOPS_LIMIT = 400;

type LineRef = { lineRef: string; lineName: string | null };

/** Ferdigaggregerte stat-kort for én linje (stats_summary.json). Null når
 *  artefakten ikke kan svare presist — se apiLineSummary i stats-adapter.ts. */
type LineSummary = {
  lineRef: string;
  lineName: string | null;
  window: number;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  pctEarly: number | null;
  stddevDelayMin: number | null;
  totalDepartures: number;
  pctRealtimeCoverage: number | null;
};

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

/** Plassholder for en graf som fortsatt regnes. Beholder korttittelen og
 *  høyden så siden ikke hopper når grafen lander. */
function ChartPlaceholder({ title, label }: { title: string; label: string }) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex justify-center items-center h-[250px]">
          <BusLoading label={label} scale={0.55} />
        </div>
      </CardContent>
    </Card>
  );
}

// Time-window now uses shared TimeWindowPicker (5 presets + custom range).
// See client/src/components/time-window-picker.tsx

/** Y-aksetekst i minutter med norsk desimalkomma: «2 m», «1,5 m». */
const axisMin = (v: number) => `${v.toLocaleString("nb-NO", { maximumFractionDigits: 1 })} m`;

type JdHourlyPoint = { hour: string; avgDelay: number | null; maxAvgDelay: number | null; minAvgDelay: number | null; numSamples: number | null };
function HourlyTooltip({ active, payload, periodLabel }: RechartsTooltipProps<JdHourlyPoint> & { periodLabel?: string }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[240px]">
      <p className="font-medium">Kl. {d.hour}</p>
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        <p>Snitt <span className="font-semibold">{fmtSignedMin(d.avgDelay, 2)}</span></p>
        {d.maxAvgDelay != null && <p className="text-destructive">Verste dag {fmtSignedMin(d.maxAvgDelay, 2)}</p>}
        {d.minAvgDelay != null && <p className="text-emerald-600">Beste dag {fmtSignedMin(d.minAvgDelay, 2)}</p>}
      </div>
      {d.numSamples != null && <p className="text-muted-foreground text-xs mt-1">{d.numSamples.toLocaleString("nb-NO")} passeringer</p>}
      <p className="text-muted-foreground/70 text-xs mt-1 leading-tight">Verste/beste dag = høyeste/laveste dagssnitt for denne timen ({periodLabel ?? "valgt periode"})</p>
    </div>
  );
}

/** Responsiv graf med dra-bar Y-akse og loddrett glider. */
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
            className="text-[9px] text-muted-foreground hover:text-foreground transition-colors px-1 disabled:opacity-30 disabled:cursor-default disabled:hover:text-muted-foreground"
            title="Tilbakestill Y-akse"
            aria-label="Tilbakestill Y-akse"
            disabled={yMax === dataMax}
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
            title={`Y-maks: ${axisMin(yMax)}`}
            aria-label="Y-maks"
          />
          <span className="text-[9px] text-muted-foreground font-mono">{axisMin(yMax)}</span>
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
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[220px]">
      <p className="font-medium">{formatDateShortNO(d.date)}</p>
      <div className="font-mono mt-1 space-y-0.5 text-xs">
        <p>Snitt <span className="font-semibold">{fmtSignedMin(d.avgDelay, 2)}</span></p>
        {d.maxDelay != null && <p className="text-destructive">Maks {fmtSignedMin(d.maxDelay)}</p>}
        {d.minDelay != null && <p className="text-emerald-600">Min {fmtSignedMin(d.minDelay)}</p>}
      </div>
      {d.numDepartures != null && (
        <p className="text-muted-foreground text-xs mt-1">{d.numDepartures.toLocaleString("nb-NO")} avganger</p>
      )}
    </div>
  );
}

/** Ett nøkkeltallskort i samme stil som Oversikt (dashboard.tsx). */
function StatCard({ title, icon: Icon, edge, value, valueClass, hint, info }: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  edge: string;
  value: string;
  valueClass?: string;
  hint: React.ReactNode;
  info?: React.ReactNode;
}) {
  return (
    <Card className={cn("border-l-4 shadow-sm hover:shadow-md transition-shadow", edge)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {title}
          {info && <InfoTip>{info}</InfoTip>}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      </CardHeader>
      <CardContent>
        <div className={cn("text-xl sm:text-2xl font-bold font-mono tabular-nums whitespace-nowrap", valueClass)}>{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{hint}</p>
      </CardContent>
    </Card>
  );
}

/** Tooltip for ruteprofilen: alle tallene for stoppet uansett hvilken visning
 *  som er valgt, med visningens eget tall øverst. Med en avgang valgt kommer
 *  planlagt tid, spredning og sammenlikning med alle avganger i tillegg. */
function RouteTooltip({ active, payload, mode, numVariants }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const gainTone = d.delayGain > 0.1 ? "text-destructive" : d.delayGain < -0.1 ? "text-emerald-600" : "text-muted-foreground";
  const lowCoverage = d.isDeparture && numVariants != null && d.numSamples != null && d.numSamples < numVariants;
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[260px]">
      <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
      {d.aimedTime && <p className="text-muted-foreground text-xs mt-1">Planlagt: {d.aimedTime}</p>}
      <div className="font-mono mt-1.5 space-y-0.5 text-xs">
        {mode === "dwell" && <p>Stopptid {d.dwellTimeSec != null ? `${Math.round(d.dwellTimeSec)} s` : "—"}</p>}
        <p>Snitt <span className="font-semibold">{fmtSignedMin(d.avgDelayMin)}</span></p>
        {d.isDeparture && d.stddevDelayMin != null && <p className="text-muted-foreground">σ ±{(d.stddevDelayMin as number).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} min</p>}
        {d.isDeparture && d.maxDelayMin != null && <p className="text-destructive">Verste dag {fmtSignedMin(d.maxDelayMin)}</p>}
        {d.isDeparture && d.minDelayMin != null && <p className="text-emerald-600">Beste dag {fmtSignedMin(d.minDelayMin)}</p>}
        {d.lineAvgDelayMin != null && <p className="text-muted-foreground">Alle avganger {fmtSignedMin(d.lineAvgDelayMin)}</p>}
        {d.p50DelayMin != null && <p className="text-muted-foreground">Median {fmtSignedMin(d.p50DelayMin)}</p>}
        {d.p80DelayMin != null && <p className="text-orange-600 dark:text-orange-400">P80 {fmtSignedMin(d.p80DelayMin)}</p>}
        <p className={gainTone}>Endring fra forrige {fmtSignedMin(d.delayGain, 2)}</p>
        {d.dwellDelay != null && <p className="text-muted-foreground">· på stoppet {fmtSignedMin(d.dwellDelay, 2)}</p>}
        {d.transitDelay != null && <p className="text-muted-foreground">· på veien hit {fmtSignedMin(d.transitDelay, 2)}</p>}
        {mode !== "dwell" && d.dwellTimeSec != null && <p className="text-muted-foreground">Stopptid {Math.round(d.dwellTimeSec)} s</p>}
      </div>
      {d.numSamples != null && (
        <p className="text-muted-foreground text-xs mt-1">
          {Number(d.numSamples).toLocaleString("nb-NO")} passeringer
          {lowCoverage && <span className="text-amber-500/80"> (av {numVariants})</span>}
        </p>
      )}
    </div>
  );
}

/** Går avgangen (ett klokkeslett, kan være flere turer) denne rutevarianten? */
function servesVariant(j: JourneyEntry, v: RouteVariant) {
  const pair = `${v.firstStopName}→${v.lastStopName}`;
  return j.endPairs
    ? j.endPairs.split("|").includes(pair)
    : `${j.firstStopName}→${j.lastStopName}` === pair;
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

  // Ukedagsfilter ('all' = ingen filtrering). Treffer bare de DuckDB-drevne
  // spørringene; stat-kortene faller tilbake fra stats_summary.json til
  // dagsserien når filteret er satt, siden artefakten ikke har dagtype.
  const [dayTypeParam, setDayTypeParam] = useUrlParam("dayType", "all");
  const dayType = parseDayTypeFilter(dayTypeParam);

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
  const routeCardRef = useRef<HTMLDivElement>(null);

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
  //
  // ⚠️ `?line=` MÅ fjernes fra URL-en samtidig. Uten det oppsto en uendelig
  // render-løkke som hvitet ut hele siden («Maximum update depth exceeded»):
  // denne effekten tømte fetchedLine, ?line= ble stående, ?direction/?stopProfileDir
  // endret `search`, effekten over («Pre-select line from ?line=») så at
  // lineParam fantes og fetchedLine var tom — og satte linja rett tilbake, som
  // trigget denne igjen. Reproduserbart ved å bytte operatør bort fra den
  // analyserte linjas operatør. Se STATUS.md 2026-08-24.
  useEffect(() => {
    if (!fetchedLine || allLines.length === 0) return;
    if (allLines.some((l) => l.lineRef === fetchedLine)) return;
    setFetchedLine("");
    setSelectedLine("");
    setSelectedJourney(null);
    setDirection("all");
    setStopProfileDir("");
    const params = new URLSearchParams(search);
    params.delete("line");
    const qs = params.toString();
    navigate(qs ? `/journey?${qs}` : "/journey", { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLines, fetchedLine]);

  // /summary koster ingen DuckDB-spørring (leser stats_summary.json), så
  // nøkkeltallene står med tall nesten umiddelbart. /distribution er ÉN
  // DuckDB-spørring som gir fordeling, varmekart og dagsserie — den erstattet
  // /daily og /hourly 2026-10-27, så linjeanalysen har én spørring mindre enn
  // før selv med tre nye grafer (hver spørring har et gulv på ~5 s).
  const lineQs = [wq, direction !== "all" ? `direction=${direction}` : "", dayType === "all" ? "" : `dayType=${dayType}`]
    .filter(Boolean).join("&");
  const lineBase = fetchedLine ? `/api/line/${encodeURIComponent(fetchedLine)}` : null;

  const { data: lineSummary } = useQuery<LineSummary | null>({
    queryKey: [lineBase ? `${lineBase}/summary?${lineQs}` : null],
    enabled: lineBase != null,
  });
  const { data: distRows, isLoading: distLoading } = useQuery<DistRow[]>({
    queryKey: [lineBase ? `${lineBase}/distribution?${lineQs}` : null],
    enabled: lineBase != null,
  });
  const dist = useMemo(() => (distRows ? parseDistribution(distRows) : null), [distRows]);
  const daily = dist?.daily ?? [];

  const { data: journeys = [] } = useJourneysForLine(fetchedLine, fromDate);

  const { data: worstStops = [] } = useWorstStopsForLine(fetchedLine, fromDate, WORST_STOPS_LIMIT, dayType);

  // Kartet lastes lat: Entur-kallet fyres først når brukeren trykker «Vis kart».
  const [showMap, setShowMap] = useState(false);
  const { data: lineGeometry, isLoading: mapLoading } = useLineGeometry(fetchedLine, showMap);

  // Forsinkelse per stopp til kartfargene. Gjenbruker worstStops (som allerede
  // hentes for «Verste stopp») — den grupperer per stop_ref over hele linjen,
  // så vi slipper en egen DuckDB-spørring bare for kartet.
  const stopDelays: StopDelayMap = useMemo(() => {
    // globalThis.Map: `Map` er her lucide-reacts kartikon (se import-linja),
    // som skygger for den innebygde Map-konstruktøren.
    const m: StopDelayMap = new globalThis.Map();
    for (const s of worstStops) {
      m.set(s.stopRef, { delay: s.avgDelayMin ?? null, n: s.numSamples ?? 0 });
    }
    return m;
  }, [worstStops]);

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
    fetchedLine, stopProfileDir, fromDate, selectedVariant, dayType,
  );

  const { data: journeyProfile = [], isLoading: journeyProfileLoading } = useJourneyProfile(
    fetchedLine,
    selectedJourney?.directionRef ?? "",
    selectedJourney?.firstStopTime ?? "",
    fromDate,
    dayType === "all" ? null : [dayType],
  );

  // Linja lastes så snart den velges. Før måtte man i tillegg trykke
  // «Analyser», og den knappen gjorde ingenting synlig når linja allerede
  // var valgt (knapp-sveipet 2026-10-26).
  const selectLine = (lineRef: string) => {
    setSelectedLine(lineRef);
    if (lineRef === fetchedLine) return;
    setFetchedLine(lineRef);
    setSelectedJourney(null);
    setDirection("all");
    setStopProfileDir("");
    setRouteZoom(null);
    // Lagre valget i URL-en, slik at det består om man navigerer bort (f.eks.
    // til kartet) og tilbake — se ?line=-lesingen i useEffect over.
    navigate(`/journey?line=${encodeURIComponent(lineRef)}`, { replace: true });
  };

  // ---- Nøkkeltall ----
  // Fordelingen (/distribution) er eksakt for akkurat de valgte filtrene og
  // vinner når den er klar. Til da står tallene fra stats_summary.json, som
  // kommer nesten umiddelbart men bare finnes uten retnings-/dagtypefilter
  // (se apiLineSummary). «I rute» er −1..+2 min, altså UTEN de som gikk for
  // tidlig — artefaktens pctOnTime (≤ 2 min) inkluderer dem, så de trekkes fra.
  const o = dist?.overall;
  const summaryNums: SummaryNumbers = {
    pctPunctual: o?.pctPunctual ?? (lineSummary?.pctOnTime != null ? lineSummary.pctOnTime - (lineSummary.pctEarly ?? 0) : null),
    pctEarly: o?.pctEarly ?? lineSummary?.pctEarly ?? null,
    pctLate10: o?.pctLate10 ?? lineSummary?.pctDelayed10plus ?? null,
    mean: o?.mean ?? lineSummary?.avgDelayMin ?? null,
    sd: o?.sd ?? lineSummary?.stddevDelayMin ?? null,
    p50: o?.p50 ?? null,
    p80: o?.p80 ?? null,
    p95: o?.p95 ?? null,
    deps: o?.deps ?? lineSummary?.totalDepartures ?? null,
  };

  // Sanntidsdekning per (linje, vindu) kommer bare fra artefakten — parquet
  // har kun sanntidsobserverte rader, så nevneren finnes ikke der. Uten
  // artefakt (egendefinert periode, filter) står den som «—».
  const coveragePct = lineSummary?.pctRealtimeCoverage != null ? Math.round(lineSummary.pctRealtimeCoverage) : null;
  const coverageWarning = coveragePct != null && coveragePct < 70
    ? `Sanntidsdekning ${coveragePct} % — over 30 % av avgangene mangler GPS-data. Forsinkelsesstatistikken kan være ufullstendig.`
    : null;

  // Noe — hva som helst — er klart å vise. Styrer om lasteanimasjonen skal vekk.
  const hasAnyLineData = lineSummary != null || dist != null;

  // Periodetekst med ev. dagtype, f.eks. «Siste måned · kun hverdager». Uten
  // dette ville en filtrert graf sett ut som om den dekket hele uka.
  const dtLabel = dayTypeFilterLabel(dayType);
  const periodLabel = dtLabel ? `${windowLabel(tw)} · ${dtLabel}` : windowLabel(tw);

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
  // Ett bryter for min/maks-båndene i ALLE graf-ene under (se band-toggle.tsx).
  const [showBands, setShowBands] = useState(true);
  // Aksene i timesgrafen og dagstrenden.
  const [trendYMax, setTrendYMax] = useState<number>(1);
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
        isDeparture: true,
        shortName: s.stopName
          ? s.stopName.length > 14 ? s.stopName.slice(0, 13) + "\u2026" : s.stopName
          : s.stopRef,
        // Outer band (capped at ±2σ): transparent base + visible range
        bandBase: outerBandBase,
        bandRange: outerBandRange,
        // Inner band (±σ): transparent base + 2σ-wide range
        innerBandBase,
        innerBandRange,
        // Absolute extremes (raw min/max across all weeks) — drawn as dashed lines
        extremeMin,
        extremeMax,
        // Derivative mode
        delayGain,
        // Samme oppdeling av endringen som for alle avganger.
        dwellDelay: s.avgDelayDepartureMin != null && s.avgDelayArrivalMin != null
          ? s.avgDelayDepartureMin - s.avgDelayArrivalMin
          : null,
        transitDelay: prev?.avgDelayDepartureMin != null && s.avgDelayArrivalMin != null
          ? s.avgDelayArrivalMin - prev.avgDelayDepartureMin
          : null,
        // Dwell mode (seconds, raw — shown with "sek" label)
        dwellTimeSec: s.avgDwellTimeSec ?? null,
      };
    });
  }, [journeyProfile]);

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
        // Båndet er P20–P80 (3 av 5 passeringer), ikke min–maks: én avgang
        // som sto i kø dro før aksen til +45 min og gjorde snittet flatt.
        bandBase: s.p20DelayMin ?? s.avgDelayMin ?? 0,
        bandRange: Math.max(0, (s.p80DelayMin ?? s.avgDelayMin ?? 0) - (s.p20DelayMin ?? s.avgDelayMin ?? 0)),
        delayGain,
        dwellDelay,
        transitDelay,
        dwellTimeSec: s.avgDwellTimeSec,
      };
    });
    return base;
  }, [lineStopProfile]);

  // ---- Nøkkeltallskortene, timesgrafen og dagstrenden ----
  // Samme /distribution-svar som grafene over (kind 1 og 3), så de koster
  // ingen egen spørring. «Høyst 2 min» er den gamle «Andel i rute» (≤ 2 min,
  // INKLUDERT de som gikk for tidlig) — samme definisjon som Oversikt.
  const pctWithin2 = o && o.pctEarly != null && o.pctPunctual != null
    ? o.pctEarly + o.pctPunctual
    : lineSummary?.pctOnTime ?? null;
  const trendData = daily.map((r) => ({
    date: r.date,
    label: formatDateShortNO(r.date),
    avgDelay: r.mean,
    maxDelay: r.max,
    minDelay: r.min,
    numDepartures: r.deps,
    bandBase: r.min ?? r.mean ?? 0,
    bandRange: (r.max ?? r.mean ?? 0) - (r.min ?? r.mean ?? 0),
  }));
  const worstDay = daily.length > 0
    ? daily.reduce((w, r) => ((r.mean ?? -Infinity) > (w.mean ?? -Infinity) ? r : w), daily[0])
    : null;
  const bestDay = daily.length > 0
    ? daily.reduce((b, r) => ((r.mean ?? Infinity) < (b.mean ?? Infinity) ? r : b), daily[0])
    : null;
  const hourlyData = (dist?.hourly ?? []).map((r) => {
    const avg = r.avg ?? 0;
    const max = r.max ?? avg;
    const min = r.min ?? avg;
    return {
      hour: `${String(r.hour).padStart(2, "0")}:00`,
      avgDelay: r.avg,
      maxAvgDelay: r.max,
      minAvgDelay: r.min,
      numSamples: r.n,
      // Stablet bånd: gjennomsiktig fra 0 til min, så fylt fra min til maks.
      bandBase: min,
      bandRange: Math.max(0, max - min),
    };
  });

  // Aksene følger dataene. Bånd-feltene tas bare med når båndene vises —
  // ellers strakk aksen seg etter et bånd som ikke tegnes.
  const trendDataMax = Math.ceil(Math.max(...trendData.map(d => Math.max(showBands ? (d.maxDelay ?? 0) : 0, d.avgDelay ?? 0)), 1));
  const hourlyDataMax = Math.ceil(Math.max(...hourlyData.map(d => Math.max(showBands ? (d.maxAvgDelay ?? 0) : 0, d.avgDelay ?? 0)), 1));
  useEffect(() => { setTrendYMax(trendDataMax); }, [trendDataMax]);
  useEffect(() => { setHourlyYMax(hourlyDataMax); }, [hourlyDataMax]);

  // ---- Ruteprofilen: alle avganger, eller én valgt avgang ----
  // Med en avgang valgt tegnes AVGANGENS egne stopp, ikke rutevariantens: en
  // avgang på en annen variant ville ellers mistet stopp stille.
  const hasDeparture = selectedJourney != null && profileData.length > 0;
  const routeData: RouteStop[] = useMemo(() => {
    if (!hasDeparture) return stopProfileData;
    const lineAvg = new globalThis.Map(stopProfileData.map((s) => [s.stopRef, s.avgDelayMin]));
    return profileData.map((s) => ({ ...s, lineAvgDelayMin: lineAvg.get(s.stopRef) ?? null }));
  }, [hasDeparture, profileData, stopProfileData]);

  // Avgangsvelgeren viser retningen og rutevarianten som er valgt. Slår
  // navnefilteret feil (uten treff), vises hele retningen framfor en tom liste.
  const currentVariant = routeVariants.find((v) => v.variantId === selectedVariant);
  const directionJourneys = useMemo(
    () => journeys.filter((j) => j.directionRef === stopProfileDir),
    [journeys, stopProfileDir],
  );
  const variantJourneys = useMemo(() => {
    if (!currentVariant) return directionJourneys;
    const hits = directionJourneys.filter((j) => servesVariant(j, currentVariant));
    return hits.length > 0 ? hits : directionJourneys;
  }, [directionJourneys, currentVariant]);

  const pickDeparture = (j: JourneyEntry) => {
    setSelectedJourney(j);
    if (currentVariant && !servesVariant(j, currentVariant)) {
      const v = routeVariants.find((r) => servesVariant(j, r));
      if (v) setSelectedVariant(v.variantId);
    }
  };

  // En avgang hører til én retning: bytt retning, og avgangen er ikke lenger valgt.
  useEffect(() => {
    if (selectedJourney && stopProfileDir && selectedJourney.directionRef !== stopProfileDir) {
      setSelectedJourney(null);
    }
  }, [selectedJourney, stopProfileDir]);

  // Zoom i ruteprofilen: indeksene Brush-en står på, delt av alle tre
  // visningene. null = hele ruta.
  const [routeZoom, setRouteZoom] = useState<{ start: number; end: number } | null>(null);
  const [showAllStops, setShowAllStops] = useState(false);
  // Brush-en leser startIndex/endIndex bare når grafen monteres. Endres zoomen
  // med en knapp (ikke ved å dra), monteres grafen på nytt via denne nøkkelen.
  const [routeChartKey, setRouteChartKey] = useState(0);
  const zoomTo = (z: { start: number; end: number } | null) => {
    setRouteZoom(z);
    setRouteChartKey((k) => k + 1);
  };
  // Indeksene gjelder én stoppliste, så zoomen nullstilles når lista byttes.
  useEffect(() => { setRouteZoom(null); }, [stopProfileDir, selectedVariant, selectedJourney?.firstStopTime, hasDeparture]);

  // Strekningen der forsinkelsen øker mest — står som en setning over grafen
  // og kan klikkes for å zoome inn dit.
  const biggestJump = useMemo(() => {
    let best = -1;
    for (let i = 1; i < routeData.length; i++) {
      if (best < 0 || routeData[i].delayGain > routeData[best].delayGain) best = i;
    }
    return best > 0 && routeData[best].delayGain > 0.1 ? best : null;
  }, [routeData]);

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

  // ---- Ruteprofilen: én graf, tre visninger, felles zoom ----
  const routeMax = routeData.length - 1;
  const zoomStart = routeZoom ? Math.max(0, Math.min(routeZoom.start, routeMax)) : 0;
  const zoomEnd = routeZoom ? Math.max(zoomStart, Math.min(routeZoom.end, routeMax)) : routeMax;
  const isZoomed = routeZoom != null && (zoomStart > 0 || zoomEnd < routeMax);
  const visibleStops = zoomEnd - zoomStart + 1;
  const routeDirLabel = directionLabels[stopProfileDir] ?? (stopProfileDir ? `Retning ${stopProfileDir}` : "");
  const openStop = (stopRef: string, stopName: string | null) =>
    navigate(`/stops?stop=${encodeURIComponent(stopRef)}&name=${encodeURIComponent(formatStopName(stopName, stopRef))}`);

  const lineLabel = fetchedLine
    ? `Linje ${lineNumber(fetchedLine)}${selectedLineName ? ` — ${selectedLineName}` : ""}${direction !== "all" ? ` · ${directionLabels[direction] ?? `retning ${direction}`}` : ""}`
    : "";

  return (
    <Layout>
      <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Linjeanalyse — {REGION_LABEL[region]}</h2>
            <p className="text-muted-foreground mt-1">Hvor presis er linja, når er den verst, og hvor på ruten oppstår forsinkelsen?</p>
          </div>
          <RegionSelector />
        </div>

        {/* ---- Linjevelger + filtre ---- */}
        <Card className="shadow-sm">
          <CardContent className="pt-5 space-y-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" id="line-picker-label">Linje</label>
              <Popover open={lineOpen} onOpenChange={setLineOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={lineOpen}
                    aria-labelledby="line-picker-label"
                    className="w-full min-w-0 justify-between font-normal"
                  >
                    <span className="truncate">
                      {selectedLine
                        ? (() => { const l = allLines.find(l => l.lineRef === selectedLine); return l ? `${lineNumber(l.lineRef)} — ${l.lineName ?? l.lineRef}` : selectedLine; })()
                        : "Søk etter linje …"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Søk etter linjenummer eller navn …" />
                    <CommandList>
                      <CommandEmpty>Ingen linjer funnet.</CommandEmpty>
                      <CommandGroup>
                        {sortedLines.map((line) => (
                          <CommandItem
                            key={line.lineRef}
                            value={`${lineNumber(line.lineRef)} ${line.lineName ?? ""} ${line.lineRef}`}
                            onSelect={() => {
                              selectLine(line.lineRef);
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

            {fetchedLine.length > 0 && (
              <div className="flex flex-col gap-2.5 pt-1">
                {/* Har linja bare ÉN retning, er et retningsvalg meningsløst: alle
                    knappene ville vist nøyaktig samme datasett. Verre for kilder
                    som ikke sender directionRef i det hele tatt (fylles med "0"),
                    der begge reiseveier ligger under samme retning — da ville
                    etiketten «A → B» direkte lyve om hva tallene dekker.
                    Målt uke 32–33: gjelder ALLE linjer hos AVI (94), VYG (22),
                    FLI (8) og NBU (3), samt 124 av 129 hos KOL. */}
                {directionOptions.length > 1 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">Retning:</span>
                    {directionOptions.map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={direction === d ? "default" : "outline"}
                        onClick={() => setDirection(d)}
                        className="h-7 px-3 text-xs max-w-full"
                      >
                        <span className="truncate">{d === "all" ? "Begge" : (directionLabels[d] ?? `Retning ${d}`)}</span>
                      </Button>
                    ))}
                  </div>
                )}
                <TimeWindowPicker value={tw} onChange={setTw} />
                <DayTypePicker value={dayType} onChange={setDayTypeParam} />
                <div className="flex items-center gap-3 flex-wrap">
                  <BandToggle show={showBands} onChange={setShowBands} />
                  <span className="text-[11px] text-muted-foreground">Reiseprofiler dekker inntil 13 uker med rådata.</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Loading / no data — bussen står bare så lenge INGEN av delene har
            landet. Så snart nøkkeltallene er inne, tar de over skjermen og
            resten fyller seg inn under. */}
        {fetchedLine.length > 0 && !hasAnyLineData && (
          distLoading ? (
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
            <p className="text-sm text-muted-foreground">Ingen data funnet for denne linjen i valgt periode.</p>
          )
        )}

        {/* ---- Svar, fordeling, tid, dag for dag ---- */}
        {hasAnyLineData && (
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

            <LineSummaryCard
              lineLabel={lineLabel}
              periodLabel={periodLabel}
              nums={summaryNums}
              coveragePct={coveragePct}
            />

            {/* Passasjertall (beta) — rendrer ingenting uten data for operatøren */}
            <LinePaxCard lineRef={fetchedLine} />

            {dist ? (
              <>
                <DelayHistogram dist={dist} periodLabel={periodLabel} />
                <WeekHourHeatmap dist={dist} periodLabel={periodLabel} />
                {dist.daily.length > 1 && <DailyChart daily={dist.daily} periodLabel={periodLabel} />}
              </>
            ) : distLoading ? (
              <ChartPlaceholder title="Slik fordeler forsinkelsene seg" label="Regner fordeling, varmekart og dagstall" />
            ) : null}

            {/* ---- Ruteprofil (alle stopp i rekkefølge) ---- */}
            <Card ref={routeCardRef} className="shadow-sm scroll-mt-20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Route className="h-5 w-5 text-primary" /> Hvor på ruten bygger forsinkelsen seg opp?</CardTitle>
                <CardDescription>
                  Forsinkelse ved hvert stopp, i rekkefølge langs ruten ({periodLabel}). Velg rutevariant, og én
                  avgang hvis du vil se den for seg. Dra i håndtakene under grafen for å zoome inn på en strekning.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Retningsvelger — skjules når linja bare har én retning (se directionOptions). */}
                {directionOptions.length > 1 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">Retning:</span>
                    {Object.keys(directionLabels).sort().map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={stopProfileDir === d ? "default" : "outline"}
                        onClick={() => setStopProfileDir(d)}
                        className="h-7 px-3 text-xs max-w-full"
                      >
                        <span className="truncate">{directionLabels[d] ?? `Retning ${d}`}</span>
                      </Button>
                    ))}
                  </div>
                )}
                {stopProfileDir !== "" && stopProfileDir !== "all" && (routeVariants.length > 1 || directionJourneys.length > 0) && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {routeVariants.length > 1 && (
                      <div className="grid gap-1.5 min-w-0 content-start">
                        <div className="flex items-center gap-1.5">
                          <label htmlFor="route-variant" className="text-sm font-medium">Rutevariant</label>
                          <InfoTip>
                            Linja har {routeVariants.length} ulike rutevarianter (ulike stopp eller endestopp). Den med flest
                            målinger (★) er valgt først.
                          </InfoTip>
                        </div>
                        <select
                          id="route-variant"
                          className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
                          value={selectedVariant ?? ""}
                          onChange={(e) => {
                            setSelectedVariant(e.target.value || undefined);
                            setSelectedJourney(null);
                          }}
                        >
                          {routeVariants.map((v, i) => (
                            <option key={v.variantId} value={v.variantId}>
                              {v.firstStopName ?? "?"} → {v.lastStopName ?? "?"} ({v.numStops} stopp, {v.totalSamples.toLocaleString("nb-NO")} målinger)
                              {i === 0 ? " ★" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {directionJourneys.length > 0 && (
                      <div className="grid gap-1.5 min-w-0 content-start">
                        <span id="departure-picker-label" className="text-sm font-medium">Avgang</span>
                        <Popover open={journeyOpen} onOpenChange={setJourneyOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              role="combobox"
                              aria-expanded={journeyOpen}
                              aria-labelledby="departure-picker-label"
                              className="h-9 w-full min-w-0 justify-between font-normal"
                            >
                              <span className="truncate">{selectedJourney ? journeyLabel(selectedJourney) : "Alle avganger"}</span>
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0" align="start">
                            <Command>
                              <CommandInput placeholder="Søk etter avgangstid …" />
                              <CommandList>
                                <CommandEmpty>Ingen avganger funnet.</CommandEmpty>
                                <CommandGroup>
                                  <CommandItem
                                    value="Alle avganger"
                                    onSelect={() => {
                                      setSelectedJourney(null);
                                      setJourneyOpen(false);
                                    }}
                                  >
                                    <Check className={cn("mr-2 h-4 w-4", selectedJourney == null ? "opacity-100" : "opacity-0")} />
                                    Alle avganger
                                  </CommandItem>
                                  {variantJourneys.map((j) => (
                                    <CommandItem
                                      key={`${j.directionRef}-${j.firstStopTime}`}
                                      value={journeyLabel(j)}
                                      onSelect={() => {
                                        pickDeparture(j);
                                        setJourneyOpen(false);
                                      }}
                                    >
                                      <Check
                                        className={cn(
                                          "mr-2 h-4 w-4 shrink-0",
                                          selectedJourney?.firstStopTime === j.firstStopTime ? "opacity-100" : "opacity-0",
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
                    )}
                  </div>
                )}

                {selectedJourney && (
                  <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Clock className="h-4 w-4 text-primary shrink-0" />
                    <span className="flex-1 min-w-[12rem]">
                      {journeyProfileLoading ? (
                        <>Henter avgangen kl. {selectedJourney.firstStopTime} …</>
                      ) : hasDeparture ? (() => {
                        const observed = Math.max(...profileData.map((r) => r.numSamples ?? 0), 0);
                        const total = selectedJourney.numVariants;
                        // Dagtypefilteret fjerner avganger med vilje; da er ikke færre observasjoner et datahull.
                        const partial = dayType === "all" && observed < total;
                        return (
                          <>
                            Avgangen kl. <strong>{selectedJourney.firstStopTime}</strong>
                            {" · "}{profileData.length} stopp
                            {" · "}{profileData[0]?.aimedTime} → {profileData[profileData.length - 1]?.aimedTime}
                            {" · snitt av "}
                            {partial ? (
                              <span className="text-amber-600" title={`${total - observed} avganger manglet sanntidsdata`}>
                                {observed} av {total} avganger ({Math.round(observed / total * 100)} % dekning)
                              </span>
                            ) : <>{observed} avganger</>}
                          </>
                        );
                      })() : (
                        <>Fant ingen målinger for avgangen kl. {selectedJourney.firstStopTime} med disse filtrene. Grafen viser alle avganger.</>
                      )}
                    </span>
                    <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setSelectedJourney(null)}>
                      Vis alle avganger
                    </Button>
                  </div>
                )}

                {routeData.length === 0 && stopProfileDir !== "" && (
                  lineStopProfileLoading ? (
                    <div className="flex justify-center py-4">
                      <BusLoading label="Laster stoppene langs ruten" scale={0.65} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Ingen stoppdata for {routeDirLabel || "denne retningen"} i valgt periode.
                    </p>
                  )
                )}

                {routeData.length > 0 && (
                  <>
                    {biggestJump != null && (
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <TrendingUp className="h-4 w-4 text-destructive shrink-0" />
                        <span className="flex-1 min-w-[12rem]">
                          Forsinkelsen øker mest fra{" "}
                          <strong>{formatStopName(routeData[biggestJump - 1].stopName, routeData[biggestJump - 1].stopRef)}</strong> til{" "}
                          <strong>{formatStopName(routeData[biggestJump].stopName, routeData[biggestJump].stopRef)}</strong>{" "}
                          (<span className="font-mono text-destructive">{fmtSignedMin(routeData[biggestJump].delayGain, 2)}</span> i snitt).
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs gap-1.5"
                          onClick={() => zoomTo({ start: Math.max(0, biggestJump - 4), end: Math.min(routeMax, biggestJump + 3) })}
                        >
                          <ZoomIn className="h-3.5 w-3.5" /> Zoom inn hit
                        </Button>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex gap-1 items-center">
                        {(["cumulative", "derivative", "dwell"] as const).map((mode) => (
                          <Button
                            key={mode}
                            size="sm"
                            variant={stopProfileMode === mode ? "default" : "outline"}
                            onClick={() => setStopProfileMode(mode)}
                            className="h-7 px-2.5 text-xs"
                          >
                            {mode === "cumulative" ? "Forsinkelse" : mode === "derivative" ? "Endring per stopp" : "Stopptid"}
                          </Button>
                        ))}
                        <InfoTip learnMoreHref="/metode#dwell-time">
                          <strong>Forsinkelse</strong>: snitt ved hvert stopp, med båndet for 3 av 5 passeringer (P20–P80) og stiplet P80. Med en avgang valgt vises avgangens snitt og spredning, med alle avganger som sammenlikning.<br />
                          <strong>Endring per stopp</strong>: hvor mye forsinkelse som bygges opp (rødt) eller tas igjen (grønt) siden forrige stopp.<br />
                          <strong>Stopptid</strong>: hvor lenge den står stille ved stoppet, i sekunder.
                        </InfoTip>
                      </div>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          onClick={() => zoomTo(null)}
                          disabled={!isZoomed}
                        >
                          Hele ruta
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs gap-1.5"
                          onClick={() => setShowAllStops(true)}
                        >
                          <ListOrdered className="h-3.5 w-3.5" /> Vis alle {routeData.length} stopp
                        </Button>
                      </div>
                    </div>

                    <div className="h-[380px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                          key={`${routeChartKey}-${stopProfileMode}-${showBands}-${hasDeparture ? selectedJourney?.firstStopTime : ""}-${routeData.length}`}
                          data={routeData}
                          margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis
                            dataKey="stopName"
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={10}
                            tickLine={false}
                            axisLine={false}
                            angle={-40}
                            textAnchor="end"
                            height={visibleStops <= 25 ? 100 : 70}
                            interval={visibleStops <= 25 ? 0 : "preserveStartEnd"}
                            tickFormatter={(v: string) => (v && v.length > 22 ? `${v.slice(0, 21)}…` : v ?? "")}
                          />
                          <YAxis
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            tickLine={false}
                            axisLine={false}
                            width={44}
                            tickFormatter={(v: number) => (stopProfileMode === "dwell" ? `${v} s` : `${v} m`)}
                            domain={stopProfileMode === "dwell" ? [0, "auto"] : ["auto", "auto"]}
                          />
                          <Tooltip content={<RouteTooltip mode={stopProfileMode} numVariants={selectedJourney?.numVariants} />} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                          {/* Hver Area MÅ være sin egen betingede node — recharts sin ComposedChart
                              mister stack-grupperingen hvis de pakkes i ett fragment (empirisk
                              verifisert: 0 <path> i DOM med fragment, 2 uten). */}
                          {stopProfileMode === "cumulative" && showBands && <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                          {stopProfileMode === "cumulative" && showBands && <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill={hasDeparture ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))"} fillOpacity={0.12} legendType="none" isAnimationActive={false} />}
                          {/* Valgt avgang: snitt ± σ innerst, og verste/beste dag som tynne stiplede linjer. */}
                          {stopProfileMode === "cumulative" && showBands && hasDeparture && <Area type="monotone" dataKey="innerBandBase" stackId="inner" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                          {stopProfileMode === "cumulative" && showBands && hasDeparture && <Area type="monotone" dataKey="innerBandRange" stackId="inner" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.28} legendType="none" isAnimationActive={false} />}
                          {stopProfileMode === "cumulative" && showBands && hasDeparture && <Line type="monotone" dataKey="extremeMax" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.55} dot={false} activeDot={false} legendType="none" isAnimationActive={false} connectNulls />}
                          {stopProfileMode === "cumulative" && showBands && hasDeparture && <Line type="monotone" dataKey="extremeMin" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.55} dot={false} activeDot={false} legendType="none" isAnimationActive={false} connectNulls />}
                          {stopProfileMode === "cumulative" && hasDeparture && <Line type="monotone" dataKey="lineAvgDelayMin" stroke="hsl(25 95% 53%)" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} connectNulls />}
                          {stopProfileMode === "cumulative" && !hasDeparture && <Line type="monotone" dataKey="p80DelayMin" stroke="hsl(25 95% 53%)" strokeWidth={1.5} strokeDasharray="5 3" dot={false} activeDot={false} isAnimationActive={false} connectNulls />}
                          {stopProfileMode === "cumulative" && <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={visibleStops <= 40 ? { r: 2.5, fill: "hsl(var(--primary))" } : false} activeDot={{ r: 5 }} isAnimationActive={false} />}
                          {stopProfileMode === "derivative" && (
                            <Bar dataKey="delayGain" isAnimationActive={false}>
                              {routeData.map((d, i) => (
                                <Cell key={i} fill={d.delayGain > 0.1 ? "hsl(var(--destructive))" : d.delayGain < -0.1 ? "hsl(160 84% 39%)" : "hsl(var(--muted-foreground))"} fillOpacity={0.8} />
                              ))}
                            </Bar>
                          )}
                          {stopProfileMode === "dwell" && <Line type="monotone" dataKey="dwellTimeSec" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={{ r: 2.5, fill: "hsl(var(--chart-4))" }} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls />}
                          {routeData.length > 8 && (
                            <Brush
                              dataKey="shortName"
                              height={26}
                              travellerWidth={10}
                              startIndex={zoomStart}
                              endIndex={zoomEnd}
                              onChange={(r: { startIndex?: number; endIndex?: number }) => {
                                if (r.startIndex == null || r.endIndex == null) return;
                                setRouteZoom({ start: r.startIndex, end: r.endIndex });
                              }}
                              stroke="hsl(var(--muted-foreground))"
                              fill="hsl(var(--muted))"
                              tickFormatter={() => ""}
                            />
                          )}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {isZoomed
                          ? <>Viser stopp {zoomStart + 1}–{zoomEnd + 1} av {routeData.length}</>
                          : <>{routeData.length} stopp</>}
                        {" · "}{Math.max(...routeData.map(r => r.numSamples ?? 0), 0).toLocaleString("nb-NO")} passeringer ved det mest målte stoppet
                      </span>
                      {stopProfileMode === "cumulative" && (
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-primary" />{hasDeparture ? "Denne avgangen" : "Snitt"}</span>
                          {hasDeparture
                            ? <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2" style={{ borderColor: "hsl(25 95% 53%)" }} />Alle avganger</span>
                            : <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: "hsl(25 95% 53%)" }} />P80</span>}
                          {showBands && !hasDeparture && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm bg-primary/15" />3 av 5 passeringer</span>}
                          {showBands && hasDeparture && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm" style={{ background: "hsl(var(--primary))", opacity: 0.28 }} />± 1σ</span>}
                          {showBands && hasDeparture && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm" style={{ background: "hsl(var(--muted-foreground))", opacity: 0.12 }} />± 2σ</span>}
                          {showBands && hasDeparture && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-muted-foreground/70" />Verste og beste dag</span>}
                          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setShowBands(!showBands)}>
                            {showBands ? "Skjul bånd" : "Vis bånd"}
                          </button>
                        </span>
                      )}
                    </div>
                    {stopProfileMode === "cumulative" && hasDeparture && showBands && (
                      <p className="text-xs text-muted-foreground leading-snug">
                        Båndene er snitt ± σ, det ytre kappet til ± 2σ. De er symmetriske i minutter, ikke prosentiler: forsinkelser
                        er gjerne høyreskeive, så det øvre båndet dekker typisk litt mer enn det nedre. For P50/P80/P95, bruk
                        reiseplanleggeren.
                      </p>
                    )}

                    <RouteStopsDialog
                      open={showAllStops}
                      onOpenChange={setShowAllStops}
                      title={`${lineLabel ? `${lineLabel} · ` : ""}${routeDirLabel}${hasDeparture ? ` · avgang ${selectedJourney?.firstStopTime}` : ""} · ${periodLabel}`}
                      stops={routeData}
                      onOpenStop={(s) => { setShowAllStops(false); openStop(s.stopRef, s.stopName); }}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            {/* ================= Flere detaljer =================
                Nøkkeltallskortene, beste/verste dag, timesgrafen og dagstrenden
                (alle fra /distribution), deretter kart, verste stopp og de
                verste og beste enkeltavgangene. */}
            <div className="pt-4 border-t space-y-1">
              <h3 className="text-xl font-semibold tracking-tight">Flere detaljer</h3>
              <p className="text-sm text-muted-foreground">
                Nøkkeltall, beste og verste dag, time for time og dag for dag med min/maks-bånd, kart, stopp og enkeltavganger.
              </p>
            </div>

            <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-3">
              <StatCard
                title="Snitt forsinkelse"
                icon={Clock}
                edge="border-l-primary"
                value={fmtSignedMin(summaryNums.mean)}
                valueClass={(summaryNums.mean ?? 0) > 5 ? "text-destructive" : undefined}
                hint={<>{periodLabel}{summaryNums.deps != null && <> · {summaryNums.deps.toLocaleString("nb-NO")} avganger</>}</>}
              />
              <StatCard
                title="Høyst 2 min forsinket"
                icon={CheckCircle}
                edge="border-l-emerald-500"
                value={fmtPct(pctWithin2, 1)}
                valueClass="text-emerald-600"
                hint="Inkludert de som gikk for tidlig"
                info={<>Samme grense som «Andel i rute» på Oversikt: høyst 2 min etter rutetid. «I rute» øverst på siden teller IKKE de som gikk mer enn 1 min for tidlig, og blir derfor lavere.</>}
              />
              <StatCard
                title="Kraftig forsinket"
                icon={AlertCircle}
                edge="border-l-destructive"
                value={fmtPct(summaryNums.pctLate10, 1)}
                valueClass="text-destructive"
                hint="Mer enn 10 min etter rutetid"
              />
              <StatCard
                title="Gikk for tidlig"
                icon={AlertTriangle}
                edge="border-l-amber-500"
                value={fmtPct(summaryNums.pctEarly, 1)}
                valueClass="text-amber-600"
                hint="Mer enn 1 min før rutetid"
              />
              <StatCard
                title="Pålitelighet (σ)"
                icon={BarChart2}
                edge="border-l-primary/50"
                value={summaryNums.sd != null ? `±${summaryNums.sd.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} min` : "—"}
                valueClass={(summaryNums.sd ?? 0) > 5 ? "text-destructive" : (summaryNums.sd ?? 0) > 3 ? "text-amber-600" : "text-emerald-600"}
                hint="Standardavvik · lavt = forutsigbar"
              />
              <StatCard
                title="Datadekning"
                icon={Signal}
                edge={coveragePct != null && coveragePct < 70 ? "border-l-amber-500" : "border-l-primary/50"}
                value={coveragePct != null ? `${coveragePct} %` : "—"}
                valueClass={coveragePct != null && coveragePct < 70 ? "text-amber-600" : coveragePct != null && coveragePct >= 90 ? "text-emerald-600" : undefined}
                hint={coveragePct != null ? "Avganger med sanntidsdata" : "Finnes bare for siste uke, måned og kvartal uten filter"}
              />
            </div>

            {worstDay && bestDay && worstDay.date !== bestDay.date && (
              <div className="grid gap-4 md:grid-cols-2">
                <StatCard
                  title="Verste dag"
                  icon={TrendingUp}
                  edge="border-l-destructive"
                  value={fmtSignedMin(worstDay.mean)}
                  valueClass="text-destructive"
                  hint={<>
                    <CalendarDays className="h-3 w-3 inline mr-1" />
                    {formatDateNO(worstDay.date)}
                    {worstDay.pctEarly != null && worstDay.pctPunctual != null && <> · {fmtPct(worstDay.pctEarly + worstDay.pctPunctual)} høyst 2 min</>}
                    {worstDay.deps != null && <> · {worstDay.deps.toLocaleString("nb-NO")} avganger</>}
                  </>}
                />
                <StatCard
                  title="Beste dag"
                  icon={TrendingDown}
                  edge="border-l-emerald-500"
                  value={fmtSignedMin(bestDay.mean)}
                  valueClass="text-emerald-600"
                  hint={<>
                    <CalendarDays className="h-3 w-3 inline mr-1" />
                    {formatDateNO(bestDay.date)}
                    {bestDay.pctEarly != null && bestDay.pctPunctual != null && <> · {fmtPct(bestDay.pctEarly + bestDay.pctPunctual)} høyst 2 min</>}
                    {bestDay.deps != null && <> · {bestDay.deps.toLocaleString("nb-NO")} avganger</>}
                  </>}
                />
              </div>
            )}

            {hourlyData.length === 0 && distLoading && (
              <ChartPlaceholder title="Forsinkelse etter time på dagen" label="Regner timesprofil" />
            )}

            {hourlyData.length > 0 && (
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5 text-primary" /> Forsinkelse etter time på dagen</CardTitle>
                  <CardDescription>
                    Snittforsinkelse per time ({periodLabel}).
                    {showBands && " Det skyggelagte båndet viser spennet mellom beste og verste enkeltdag i perioden."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DraggableYChart yMax={hourlyYMax} setYMax={setHourlyYMax} dataMax={hourlyDataMax} height={280}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={hourlyData} margin={{ left: 0, right: 12 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} width={52} tickFormatter={axisMin} domain={["auto", hourlyYMax]} allowDataOverflow />
                        <Tooltip content={<HourlyTooltip periodLabel={periodLabel} />} />
                        {showBands && <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                        {showBands && <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />}
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2, fill: "hsl(var(--primary))" }} activeDot={{ r: 4 }} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </DraggableYChart>
                </CardContent>
              </Card>
            )}

            {trendData.length === 0 && distLoading && (
              <ChartPlaceholder title="Daglig trend" label="Regner dagstrend" />
            )}

            {trendData.length > 0 && (
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-primary" /> Daglig trend</CardTitle>
                  <CardDescription>
                    Snittforsinkelse per dag ({periodLabel}).
                    {showBands && " Båndet viser laveste og høyeste enkeltmåling hver dag."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DraggableYChart yMax={trendYMax} setYMax={setTrendYMax} dataMax={trendDataMax} height={250}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={trendData} margin={{ left: 0, right: 12 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} width={52} tickFormatter={axisMin} domain={["auto", trendYMax]} allowDataOverflow />
                        <Tooltip content={<DailyTrendTooltip />} />
                        {showBands && <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                        {showBands && <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />}
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </DraggableYChart>
                </CardContent>
              </Card>
            )}

            {/* Rutekart — lastes lat, se showMap. */}
            <Card className="shadow-sm">
              <CardHeader>
                <div className="flex flex-row items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2"><MapIcon className="h-5 w-5 text-primary" /> Forsinkelseskart</CardTitle>
                    <CardDescription>
                      Ruten tegnet på kart, farget etter gjennomsnittlig forsinkelse per stopp ({periodLabel}).
                    </CardDescription>
                  </div>
                  <Button
                    size="sm"
                    variant={showMap ? "secondary" : "outline"}
                    onClick={() => setShowMap((v) => !v)}
                    className="flex-shrink-0"
                  >
                    {showMap ? "Skjul kart" : "Vis kart"}
                  </Button>
                </div>
              </CardHeader>
              {showMap && (
                <CardContent>
                  {mapLoading ? (
                    <div className="flex justify-center py-6">
                      <BusLoading label="Henter rutegeometri fra Entur" scale={0.55} />
                    </div>
                  ) : lineGeometry ? (
                    <LineRouteMap
                      variants={lineGeometry.variants}
                      stopDelays={stopDelays}
                      transportMode={lineGeometry.transportMode}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground py-2">
                      Fant ingen rutegeometri for denne linjen hos Entur.
                    </p>
                  )}
                </CardContent>
              )}
            </Card>

            {worstStops.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-destructive" /> Verste stopp på ruten</CardTitle>
                  <CardDescription>
                    De fem stoppene med høyest snittforsinkelse, begge retninger ({periodLabel}). Trykk for stoppanalysen.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {worstStops.slice(0, 5).map((stop, i) => (
                      <button
                        type="button"
                        key={stop.stopRef}
                        onClick={() => openStop(stop.stopRef, stop.stopName)}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 transition-colors text-left"
                        title="Se stoppstedsanalyse"
                      >
                        <span className="text-sm font-mono text-muted-foreground w-5 text-right flex-shrink-0">{i + 1}</span>
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="text-sm flex-1 truncate">{formatStopName(stop.stopName, stop.stopRef)}</span>
                        <span className={cn(
                          "text-sm font-mono font-semibold flex-shrink-0",
                          (stop.avgDelayMin ?? 0) > 5 ? "text-destructive" : "text-orange-500",
                        )}>
                          {fmtSignedMin(stop.avgDelayMin)}
                        </span>
                        <span className="text-xs text-muted-foreground flex-shrink-0 w-32 text-right hidden sm:inline whitespace-nowrap">
                          {stop.numSamples?.toLocaleString("nb-NO")} passeringer
                        </span>
                      </button>
                    ))}
                  </div>
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
                        {section.desc} for {selectedLineName ?? fetchedLine}, retning {stopProfileDir} · {periodLabel} (inntil 13 uker). Trykk på en avgang for å se den i ruteprofilen.
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
                                  // Oppslaget gir antall kjørte avganger, som dekningstallet trenger.
                                  pickDeparture(directionJourneys.find((x) => x.firstStopTime === j.departureTime) ?? {
                                    directionRef: stopProfileDir,
                                    firstStopTime: j.departureTime,
                                    numVariants: 1,
                                    firstStopName: j.firstStopName,
                                    lastStopName: j.lastStopName,
                                  });
                                  setTimeout(() => routeCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                                }}
                                title="Trykk for å se avgangen i ruteprofilen"
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
          </div>
        )}
      </div>
    </Layout>
  );
}
