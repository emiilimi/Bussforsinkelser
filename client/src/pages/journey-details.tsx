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
import { CheckCircle, AlertCircle, ChevronsUpDown, Check, MapPin, ArrowRight, TrendingUp, ListOrdered, ZoomIn } from "lucide-react";
import { cn, formatStopName } from "@/lib/utils";
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Area, ComposedChart, Line, ReferenceLine, Brush, Bar, Cell } from "recharts";
import { parseDistribution, fmtSignedMin, type DistRow } from "@/lib/line-distribution";
import {
  LineSummaryCard, DelayHistogram, WeekHourHeatmap, DailyChart, RouteStopsDialog, type SummaryNumbers,
} from "@/components/line-analysis";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { InfoTip } from "@/components/info-tip";
import { ScrollableChart } from "@/components/scrollable-chart";
import { formatDateShortNO } from "@/lib/date-utils";
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

/**
 * Y-akse-maks for stopptid-grafene (sekunder), tilpasset de faktiske dataene.
 * 15 % luft over høyeste stopp, minimum 5 s. Se kommentaren ved
 * stopProfileDwellDataMax for hvorfor det gamle faste gulvet på 30 s var galt.
 */
function dwellAxisMax(values: Array<number | null | undefined>): number {
  const max = values.reduce<number>((m, v) => (v != null && v > m ? v : m), 0);
  return Math.max(5, Math.ceil(max * 1.15));
}

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
    <Card>
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

/** Tooltip for ruteprofilen: alle tallene for stoppet uansett hvilken visning
 *  som er valgt, med visningens eget tall øverst. */
function RouteTooltip({ active, payload, mode }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const gainTone = d.delayGain > 0.1 ? "text-destructive" : d.delayGain < -0.1 ? "text-emerald-600" : "text-muted-foreground";
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[260px]">
      <p className="font-medium leading-tight">{d.stopName ?? d.stopRef}</p>
      <div className="font-mono mt-1.5 space-y-0.5 text-xs">
        {mode === "dwell" && <p>Stopptid {d.dwellTimeSec != null ? `${Math.round(d.dwellTimeSec)} s` : "—"}</p>}
        <p>Snitt <span className="font-semibold">{fmtSignedMin(d.avgDelayMin)}</span></p>
        {d.p50DelayMin != null && <p className="text-muted-foreground">Median {fmtSignedMin(d.p50DelayMin)}</p>}
        {d.p80DelayMin != null && <p className="text-orange-600 dark:text-orange-400">P80 {fmtSignedMin(d.p80DelayMin)}</p>}
        <p className={gainTone}>Endring fra forrige {fmtSignedMin(d.delayGain, 2)}</p>
        {d.dwellDelay != null && <p className="text-muted-foreground">· på stoppet {fmtSignedMin(d.dwellDelay, 2)}</p>}
        {d.transitDelay != null && <p className="text-muted-foreground">· på veien hit {fmtSignedMin(d.transitDelay, 2)}</p>}
        {mode !== "dwell" && d.dwellTimeSec != null && <p className="text-muted-foreground">Stopptid {Math.round(d.dwellTimeSec)} s</p>}
      </div>
      {d.numSamples != null && <p className="text-muted-foreground text-xs mt-1">{Number(d.numSamples).toLocaleString("nb-NO")} passeringer</p>}
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

  const { data: journeyProfile = [] } = useJourneyProfile(
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
  const [profileMode, setProfileMode] = useState<"cumulative" | "derivative" | "dwell">("cumulative");
  const [profileYMax, setProfileYMax] = useState<number>(1);
  const [profileYMin, setProfileYMin] = useState<number>(0);
  const [profileDerYMax, setProfileDerYMax] = useState<number>(1);
  const [profileDerYMin, setProfileDerYMin] = useState<number>(0);
  const [profileDwellYMax, setProfileDwellYMax] = useState<number>(30);

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
  useEffect(() => { setRouteZoom(null); }, [stopProfileDir, selectedVariant]);

  // Strekningen der forsinkelsen øker mest — står som en setning over grafen
  // og kan klikkes for å zoome inn dit.
  const biggestJump = useMemo(() => {
    let best = -1;
    for (let i = 1; i < stopProfileData.length; i++) {
      if (best < 0 || stopProfileData[i].delayGain > stopProfileData[best].delayGain) best = i;
    }
    return best > 0 && stopProfileData[best].delayGain > 0.1 ? best : null;
  }, [stopProfileData]);

  // Compute Y-axis maxes after data is available and sync to state.
  // Bånd-feltene (maxDelay, bandBase+bandRange, extremeMax, o.l.) tas KUN med
  // når showBands er på — ellers ble aksen stående og strekke seg etter et
  // bånd som ikke lenger tegnes, og snittlinjen klistret seg flat til bunnen.
  const profileDataMax = Math.ceil(Math.max(...profileData.map(d => Math.max(showBands ? d.bandBase + d.bandRange : 0, showBands ? (d.avgPlusSigma ?? 0) : 0, d.avgDelayMin ?? 0, showBands ? (d.extremeMax ?? 0) : 0)), 1));
  // Min also accounts for avg-σ inner band lower edge AND raw extreme min (can be negative when avg is small)
  const profileDataMin = Math.floor(Math.min(...profileData.map(d => Math.min(showBands ? d.bandBase : 0, showBands ? d.innerBandBase : 0, showBands ? (d.extremeMin ?? 0) : 0, d.avgDelayMin ?? 0)), 0));
  const profileDerDataMax = Math.ceil(Math.max(...profileData.map(d => Math.abs(d.delayGain ?? 0)), 1));
  const profileDerDataMin = Math.floor(Math.min(...profileData.map(d => d.delayGain ?? 0), 0));
  const profileDwellDataMax = dwellAxisMax(profileData.map(d => d.dwellTimeSec));
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

  // ---- Ruteprofilen: én graf, tre visninger, felles zoom ----
  const routeMax = stopProfileData.length - 1;
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
        <Card>
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
            <Card>
              <CardHeader>
                <CardTitle>Hvor på ruten bygger forsinkelsen seg opp?</CardTitle>
                <CardDescription>
                  Forsinkelse ved hvert stopp, i rekkefølge langs ruten ({periodLabel}). Dra i håndtakene under
                  grafen for å zoome inn på en strekning, eller åpne lista med alle stoppene.
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
                {routeVariants.length > 1 && stopProfileDir !== "" && stopProfileDir !== "all" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">Rutevariant:</span>
                    <select
                      className="text-xs border rounded px-2 py-1 bg-background max-w-full"
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
                    <InfoTip>
                      Linja har {routeVariants.length} ulike rutevarianter (ulike stopp eller endestopp). Den med flest
                      målinger (★) er valgt.
                    </InfoTip>
                  </div>
                )}

                {stopProfileData.length === 0 && stopProfileDir !== "" && (
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

                {stopProfileData.length > 0 && (
                  <>
                    {biggestJump != null && (
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <TrendingUp className="h-4 w-4 text-destructive shrink-0" />
                        <span className="flex-1 min-w-[12rem]">
                          Forsinkelsen øker mest fra{" "}
                          <strong>{formatStopName(stopProfileData[biggestJump - 1].stopName, stopProfileData[biggestJump - 1].stopRef)}</strong> til{" "}
                          <strong>{formatStopName(stopProfileData[biggestJump].stopName, stopProfileData[biggestJump].stopRef)}</strong>{" "}
                          (<span className="font-mono text-destructive">{fmtSignedMin(stopProfileData[biggestJump].delayGain, 2)}</span> i snitt).
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
                          <strong>Forsinkelse</strong>: snitt ved hvert stopp, med båndet for 3 av 5 passeringer (P20–P80) og stiplet P80.<br />
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
                          <ListOrdered className="h-3.5 w-3.5" /> Vis alle {stopProfileData.length} stopp
                        </Button>
                      </div>
                    </div>

                    <div className="h-[380px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                          key={`${routeChartKey}-${stopProfileMode}-${showBands}`}
                          data={stopProfileData}
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
                          <Tooltip content={<RouteTooltip mode={stopProfileMode} />} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                          {/* Hver Area MÅ være sin egen betingede node — recharts mister
                              stack-grupperingen hvis de pakkes i et fragment (se Avgangsanalyse). */}
                          {stopProfileMode === "cumulative" && showBands && <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                          {stopProfileMode === "cumulative" && showBands && <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />}
                          {stopProfileMode === "cumulative" && <Line type="monotone" dataKey="p80DelayMin" stroke="hsl(25 95% 53%)" strokeWidth={1.5} strokeDasharray="5 3" dot={false} activeDot={false} isAnimationActive={false} connectNulls />}
                          {stopProfileMode === "cumulative" && <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={visibleStops <= 40 ? { r: 2.5, fill: "hsl(var(--primary))" } : false} activeDot={{ r: 5 }} isAnimationActive={false} />}
                          {stopProfileMode === "derivative" && (
                            <Bar dataKey="delayGain" isAnimationActive={false}>
                              {stopProfileData.map((d, i) => (
                                <Cell key={i} fill={d.delayGain > 0.1 ? "hsl(var(--destructive))" : d.delayGain < -0.1 ? "hsl(160 84% 39%)" : "hsl(var(--muted-foreground))"} fillOpacity={0.8} />
                              ))}
                            </Bar>
                          )}
                          {stopProfileMode === "dwell" && <Line type="monotone" dataKey="dwellTimeSec" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={{ r: 2.5, fill: "hsl(var(--chart-4))" }} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls />}
                          {stopProfileData.length > 8 && (
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
                          ? <>Viser stopp {zoomStart + 1}–{zoomEnd + 1} av {stopProfileData.length}</>
                          : <>{stopProfileData.length} stopp</>}
                        {" · "}{Math.max(...stopProfileData.map(r => r.numSamples ?? 0), 0).toLocaleString("nb-NO")} passeringer ved det mest målte stoppet
                      </span>
                      {stopProfileMode === "cumulative" && (
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-primary" />Snitt</span>
                          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: "hsl(25 95% 53%)" }} />P80</span>
                          {showBands && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm bg-primary/15" />3 av 5 passeringer</span>}
                          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setShowBands(!showBands)}>
                            {showBands ? "Skjul bånd" : "Vis bånd"}
                          </button>
                        </span>
                      )}
                    </div>

                    <RouteStopsDialog
                      open={showAllStops}
                      onOpenChange={setShowAllStops}
                      title={`${lineLabel ? `${lineLabel} · ` : ""}${routeDirLabel} · ${periodLabel}`}
                      stops={stopProfileData}
                      onOpenStop={(s) => { setShowAllStops(false); openStop(s.stopRef, s.stopName); }}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            {/* Rutekart — lastes lat, se showMap. */}
            <Card>
              <CardHeader>
                <div className="flex flex-row items-start justify-between gap-3">
                  <div>
                    <CardTitle>Forsinkelseskart</CardTitle>
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
                  <CardTitle>Verste stopp på ruten</CardTitle>
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
                        {section.desc} for {selectedLineName ?? fetchedLine}, retning {stopProfileDir} · {periodLabel} (inntil 13 uker).
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
                            {/* Outer band: capped at avg±2σ (≈95% of weeks, filters outlier weeks).
                                NB: hver av disse MÅ være sin egen betingede JSX-node — recharts sin
                                ComposedChart mister stack-grupperingen til Area-barna hvis de i stedet
                                pakkes i ett <>...</>-fragment (empirisk verifisert: 0 <path> i DOM med
                                fragment, 2 uten, selv om ComposedChart sin egen toArray() sier den skal
                                flate ut fragmenter — noe annet i stack/domene-beregningen gjør ikke det). */}
                            {showBands && <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                            {showBands && <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--muted-foreground))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />}
                            {/* Inner band: avg±σ symmetric (≈68% of weeks) */}
                            {showBands && <Area type="monotone" dataKey="innerBandBase" stackId="inner" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />}
                            {showBands && <Area type="monotone" dataKey="innerBandRange" stackId="inner" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.28} legendType="none" isAnimationActive={false} />}
                            {/* Absolute extremes (raw min/max across all weeks) — faint dashed lines */}
                            {showBands && <Line type="monotone" dataKey="extremeMax" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.55} dot={false} activeDot={false} legendType="none" isAnimationActive={false} connectNulls />}
                            {showBands && <Line type="monotone" dataKey="extremeMin" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.55} dot={false} activeDot={false} legendType="none" isAnimationActive={false} connectNulls />}
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
                          {showBands && (
                            <>
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
                            </>
                          )}
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
                          unit="s"
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
