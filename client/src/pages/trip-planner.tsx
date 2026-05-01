import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useParquetQuery } from "@/hooks/use-parquet-query";
import Layout from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Navigation, Search, Clock, ArrowRight, AlertTriangle, CheckCircle,
  ArrowDown, ChevronDown, ChevronUp, Footprints, Bus, Train, Ship,
  Accessibility, ArrowDownUp, ArrowUpDown, Plane, Calendar,
  Info, Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StopSearchResult = {
  stopRef: string;
  stopPlaceRef: string | null;
  stopName: string;
  label?: string;       // full label from geocoder (e.g. "Bryggen, Bergen")
  layer?: string;       // "venue" | "address" | "street" etc.
  lat: number | null;
  lng: number | null;
  quayCount?: number;
};

type TripLeg = {
  mode: string;
  transportSubmode: string | null;
  fromPlace: { name: string; quay: { id: string; name: string } | null };
  toPlace: { name: string; quay: { id: string; name: string } | null };
  line: { id: string; publicCode: string; name: string } | null;
  expectedStartTime: string;
  expectedEndTime: string;
  duration: number;
  distance: number;
  intermediateQuays: Array<{ id: string; name: string }>;
  serviceJourney: { id: string } | null;
};

type TripPattern = {
  expectedStartTime: string;
  expectedEndTime: string;
  duration: number;
  legs: TripLeg[];
};

type TripStopStat = {
  stopRef: string;
  lineRef: string;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number | null;
};

type StatsTimeWindow = {
  type: "all" | "days" | "weekday" | "weekend" | "custom";
  value?: number;
  dateFrom?: string;
  dateTo?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<string, string> = {
  bus: "Buss",
  tram: "Trikk",
  rail: "Tog",
  metro: "T-bane",
  water: "Bat",
  coach: "Flybuss",
  foot: "Gange",
  bicycle: "Sykkel",
  scooter_rental: "Elsparkesykkel",
};

const MODE_ICONS: Record<string, typeof Bus> = {
  bus: Bus,
  tram: Train,
  rail: Train,
  metro: Train,
  water: Ship,
  coach: Plane,
  foot: Footprints,
};

// Modes for which the pipeline currently produces delay statistics.
// 'coach' (flybuss) and 'ferry' share the Skyss SIRI ET feed with regular buses.
// ('ferry' is the vehicleMode value Skyss uses — NOT 'water'.)
const MODES_WITH_DELAY_DATA = new Set(["bus", "coach", "ferry"]);

// ---------------------------------------------------------------------------
// DuckDB helpers
// ---------------------------------------------------------------------------

function esc(s: string) { return s.replace(/'/g, "''"); }

type DuckDelayRow = {
  stop_ref: string;
  line_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p95_dep: number | null;
  p50_arr: number | null;
  p80_arr: number | null;
  p95_arr: number | null;
  n: number;
};

/** Empirical transfer probability from DuckDB percentiles */
function transferProbabilityFromDist(
  p50: number | null, p80: number | null, p95: number | null,
  bufferMinutes: number,
): number {
  if (p50 == null || p80 == null || p95 == null) return -1;
  if (bufferMinutes > p95) return 0.97;
  if (bufferMinutes > p80) return 0.80 + 0.17 * (bufferMinutes - p80) / (p95 - p80);
  if (bufferMinutes > p50) return 0.50 + 0.30 * (bufferMinutes - p50) / (p80 - p50);
  if (p50 > 0) return Math.max(0.05, 0.50 * bufferMinutes / p50);
  return 0.10;
}

/** Hook: fetch delay distributions from DuckDB for trip (stop, line) pairs */
function useTripDelayDistribution(
  pairs: Array<{ stopRef: string; lineRef: string }>,
  duckReady: boolean,
  duckQuery: (sql: string) => Promise<any[]>,
) {
  return useQuery<Map<string, DuckDelayRow>>({
    queryKey: ["duck-trip-delays", ...pairs.map(p => `${p.stopRef}|${p.lineRef}`)],
    queryFn: async () => {
      if (pairs.length === 0) return new Map();

      const conditions = pairs
        .map(p => `(stop_ref = '${esc(p.stopRef)}' AND line_ref = '${esc(p.lineRef)}')`)
        .join(" OR ");

      const sql = `
        SELECT
          stop_ref,
          line_ref,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95_dep,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min) AS p50_arr,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min) AS p80_arr,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_arrival_min) AS p95_arr,
          COUNT(*) AS n
        FROM delays
        WHERE (${conditions})
          AND delay_departure_min IS NOT NULL
        GROUP BY stop_ref, line_ref
      `;

      const rows = await duckQuery(sql) as DuckDelayRow[];
      const map = new Map<string, DuckDelayRow>();
      for (const row of rows) {
        map.set(`${row.stop_ref}|${row.line_ref}`, row);
      }
      return map;
    },
    enabled: duckReady && pairs.length > 0,
    staleTime: Infinity,
  });
}

const TRANSPORT_MODE_OPTIONS = [
  { value: "bus", label: "Buss" },
  { value: "tram", label: "Trikk" },
  { value: "rail", label: "Tog" },
  { value: "metro", label: "T-bane" },
  { value: "water", label: "Bat/ferje" },
  { value: "coach", label: "Flybuss" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}t ${m % 60}min`;
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

function ModeIcon({ mode, className }: { mode: string; className?: string }) {
  const Icon = MODE_ICONS[mode] ?? Bus;
  return <Icon className={className} />;
}

function delayBadge(delay: number | null, hasData: boolean) {
  if (!hasData) return <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">ingen data</Badge>;
  if (delay == null) return null;
  if (Math.abs(delay) < 1) return <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">i rute</Badge>;
  if (delay < 3) return <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">+{delay.toFixed(1)}m</Badge>;
  return <Badge variant="destructive" className="text-[10px]">+{delay.toFixed(1)}m</Badge>;
}

function transferProbability(arrivalDelay: number | null, bufferMinutes: number): number {
  if (arrivalDelay == null) return -1; // unknown
  const margin = bufferMinutes - arrivalDelay;
  if (margin > 5) return 0.99;
  if (margin > 3) return 0.90;
  if (margin > 1) return 0.70;
  if (margin > 0) return 0.40;
  return 0.10;
}

function transferChance(arrivalDelay: number | null, bufferMinutes: number): string | null {
  if (arrivalDelay == null) return null;
  const margin = bufferMinutes - arrivalDelay;
  if (margin > 3) return "Trygg overgang";
  if (margin > 1) return "Sannsynlig";
  if (margin > 0) return "Usikker";
  return "Risikabel";
}

function transferColor(arrivalDelay: number | null, bufferMinutes: number): string {
  if (arrivalDelay == null) return "text-muted-foreground";
  const margin = bufferMinutes - arrivalDelay;
  if (margin > 3) return "text-green-600";
  if (margin > 1) return "text-amber-600";
  return "text-destructive";
}

function probabilityBadge(prob: number) {
  const pct = Math.round(prob * 100);
  if (prob > 0.90) {
    return <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">{pct}%</Badge>;
  }
  if (prob > 0.60) {
    return <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">{pct}%</Badge>;
  }
  return <Badge variant="destructive" className="text-[10px]">{pct}%</Badge>;
}

function addMinutesToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d.toISOString();
}

function estimateP80(avgDelay: number | null, realP80?: number | null): string | null {
  // Use real DuckDB P80 if available
  if (realP80 != null) {
    if (Math.abs(realP80) < 1) return "i rute";
    return `+${realP80.toFixed(1)}m`;
  }
  if (avgDelay == null) return null;
  if (avgDelay < 1) return "i rute";
  const p80est = avgDelay * 1.5;
  return `~+${p80est.toFixed(1)}m`;
}

/** Round to nearest 5 minutes for time input */
function roundedNow(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Geocoder result type
// ---------------------------------------------------------------------------

type GeocoderResult = {
  id: string;
  name: string;
  label: string;
  layer: string;
  lat: number;
  lng: number;
};

// ---------------------------------------------------------------------------
// Stop / address search with debounce — uses Entur Geocoder API
// ---------------------------------------------------------------------------

function StopSearch({
  label,
  value,
  onSelect,
  externalQuery,
}: {
  label: string;
  value: StopSearchResult | null;
  onSelect: (stop: StopSearchResult) => void;
  externalQuery?: string;
}) {
  const [query, setQuery] = useState(value?.stopName ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync query when value changes externally (e.g. swap direction)
  useEffect(() => {
    if (externalQuery !== undefined) {
      setQuery(externalQuery);
    }
  }, [externalQuery]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [] } = useQuery<GeocoderResult[]>({
    queryKey: [`/api/geocoder/autocomplete?text=${encodeURIComponent(debouncedQuery)}&size=8`],
    enabled: debouncedQuery.length >= 2 && open,
  });

  function toStopSearchResult(r: GeocoderResult): StopSearchResult {
    // "venue" layer = NSR stop (StopPlace or Quay)
    const isStop = r.layer === "venue" && r.id.startsWith("NSR:");
    return {
      stopRef: isStop ? r.id : `coords:${r.lat},${r.lng}`,
      stopPlaceRef: isStop ? r.id : null,
      stopName: r.name,
      label: r.label,
      layer: r.layer,
      lat: r.lat,
      lng: r.lng,
    };
  }

  const layerIcon = (layer: string) => {
    if (layer === "venue") return "\u{1F68F}"; // bus stop emoji
    return "\u{1F4CD}"; // pin emoji
  };

  return (
    <div className="relative">
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          placeholder="Stoppested eller adresse..."
          className="pl-9"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-start gap-2"
              onMouseDown={(e) => {
                e.preventDefault();
                const stop = toStopSearchResult(r);
                setQuery(r.name);
                setOpen(false);
                onSelect(stop);
              }}
            >
              <span className="text-xs mt-0.5 flex-shrink-0">{layerIcon(r.layer)}</span>
              <span>
                <span className="block">{r.name}</span>
                {r.label !== r.name && (
                  <span className="block text-xs text-muted-foreground">{r.label}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trip result card
// ---------------------------------------------------------------------------

function TripCard({
  pattern,
  index,
  stats,
  duckStats,
  transferMarginMin,
  walkSpeedKmh,
  sprintSpeedKmh,
}: {
  pattern: TripPattern;
  index: number;
  stats: Map<string, TripStopStat>;
  duckStats?: Map<string, DuckDelayRow>;
  transferMarginMin: number;
  walkSpeedKmh: number;
  sprintSpeedKmh: number;
}) {
  const [expanded, setExpanded] = useState(index === 0);

  // ---------- Compute transfer probabilities + overall probability ----------
  // For each transit→transit transfer (with optional foot leg(s) in between) we
  // compute three probabilities of catching the connection:
  //   - default (gangtid + 2 min margin)   → headline shown in the collapsed card
  //   - userMargin (gangtid + N min)       → uses the "Overgangsmargin"-filter
  //   - sprint (raskere gangtid + 30 sek)  → uses the "Spurt-tempo"-filter
  // The "effective buffer" for each scenario = totalGap − walkTime − margin, fed
  // into transferProbabilityFromDist() against the arrival-delay distribution
  // of the inbound transit leg at the transfer stop.
  const transferAnalysis = useMemo(() => {
    type Probs = { default: number; user: number; sprint: number };
    const transfers: Array<{
      buffer: number;       // minutes — total gap between TransitA end and TransitB start
      walkTime: number;     // minutes — sum of foot-leg durations between them
      sprintWalkTime: number; // minutes — walkTime scaled by walkSpeed/sprintSpeed
      probs: Probs;         // 3 probabilities; -1 = unknown
      fromLine: string | null;
      toLine: string | null;
    }> = [];

    // Indexes of transit (non-foot) legs and a lookup from "leg index" → transfer index
    // (i.e. for an inbound transit leg legA, what position is its outgoing transfer in
    // the transfers[] array). Lets the renderer attach badges without re-counting.
    const transitIdxs: number[] = [];
    const transferIdxByLeg: Map<number, number> = new Map();
    for (let i = 0; i < pattern.legs.length; i++) {
      if (pattern.legs[i].mode !== "foot") transitIdxs.push(i);
    }
    for (let t = 0; t < transitIdxs.length - 1; t++) {
      transferIdxByLeg.set(transitIdxs[t], t);
    }

    for (let t = 0; t < transitIdxs.length - 1; t++) {
      const aIdx = transitIdxs[t];
      const bIdx = transitIdxs[t + 1];
      const legA = pattern.legs[aIdx];
      const legB = pattern.legs[bIdx];

      // Sum walking time between A and B (any foot legs in between).
      let walkSec = 0;
      for (let k = aIdx + 1; k < bIdx; k++) {
        if (pattern.legs[k].mode === "foot") walkSec += pattern.legs[k].duration ?? 0;
      }
      const walkTime = walkSec / 60;
      const sprintRatio = sprintSpeedKmh > 0 ? walkSpeedKmh / sprintSpeedKmh : 1;
      const sprintWalkTime = walkTime * sprintRatio;

      const totalGap = (new Date(legB.expectedStartTime).getTime() - new Date(legA.expectedEndTime).getTime()) / 60000;
      if (totalGap <= 0) continue;

      const lineRef = legA.line?.id ?? "";
      const hasDelayData = MODES_WITH_DELAY_DATA.has(legA.mode) && !!lineRef;

      const arrQuay = legA.toPlace.quay?.id ?? "";
      const statKey = `${arrQuay}|${lineRef}`;
      const arrStat = stats.get(statKey);
      const duckStat = duckStats?.get(statKey);
      const arrDelay = hasDelayData ? (arrStat?.avgDelayArrivalMin ?? null) : null;

      const probFor = (effective: number): number => {
        if (!hasDelayData) return -1;
        if (duckStat && duckStat.p50_arr != null) {
          return transferProbabilityFromDist(duckStat.p50_arr, duckStat.p80_arr, duckStat.p95_arr, effective);
        }
        return transferProbability(arrDelay, effective);
      };

      const probs: Probs = {
        default: probFor(totalGap - walkTime - 2),
        user: probFor(totalGap - walkTime - transferMarginMin),
        sprint: probFor(totalGap - sprintWalkTime - 0.5),
      };

      transfers.push({
        buffer: totalGap,
        walkTime,
        sprintWalkTime,
        probs,
        fromLine: legA.line?.publicCode ?? null,
        toLine: legB.line?.publicCode ?? null,
      });
    }

    // Headline overall probability uses the default (gangtid + 2 min) scenario.
    const knownProbs = transfers.filter((t) => t.probs.default >= 0).map((t) => t.probs.default);
    const overallProb = knownProbs.length > 0
      ? knownProbs.reduce((a, b) => a * b, 1)
      : -1;

    const hasTransfers = transfers.length > 0;

    return { transfers, overallProb, hasTransfers, transferIdxByLeg };
  }, [pattern, stats, duckStats, transferMarginMin, walkSpeedKmh, sprintSpeedKmh]);

  // ---------- Compute estimated departure/arrival from delays ----------
  const estimatedTimes = useMemo(() => {
    // Find first bus leg's first stop delay
    let estDeparture: string | null = null;
    let estArrival: string | null = null;
    let firstBusDelayDep: number | null = null;
    let lastBusDelayArr: number | null = null;

    for (const leg of pattern.legs) {
      if (leg.mode === "foot" || !leg.line?.id) continue;
      if (!MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      const fromQuay = leg.fromPlace.quay?.id;
      if (!fromQuay) continue;
      const statKey = `${fromQuay}|${leg.line.id}`;
      const duckStat = duckStats?.get(statKey);
      const stat = stats.get(statKey);
      // Prefer DuckDB P50, fall back to server avg
      if (duckStat?.p50_dep != null) {
        firstBusDelayDep = duckStat.p50_dep;
      } else if (stat?.avgDelayDepartureMin != null) {
        firstBusDelayDep = stat.avgDelayDepartureMin;
      } else if (stat?.avgDelayMin != null) {
        firstBusDelayDep = stat.avgDelayMin;
      }
      break;
    }

    for (let i = pattern.legs.length - 1; i >= 0; i--) {
      const leg = pattern.legs[i];
      if (leg.mode === "foot" || !leg.line?.id) continue;
      if (!MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      const toQuay = leg.toPlace.quay?.id;
      if (!toQuay) continue;
      const statKey = `${toQuay}|${leg.line.id}`;
      const duckStat = duckStats?.get(statKey);
      const stat = stats.get(statKey);
      // Prefer DuckDB P50, fall back to server avg
      if (duckStat?.p50_arr != null) {
        lastBusDelayArr = duckStat.p50_arr;
      } else if (stat?.avgDelayArrivalMin != null) {
        lastBusDelayArr = stat.avgDelayArrivalMin;
      } else if (stat?.avgDelayMin != null) {
        lastBusDelayArr = stat.avgDelayMin;
      }
      break;
    }

    if (firstBusDelayDep != null) {
      estDeparture = formatTime(addMinutesToIso(pattern.expectedStartTime, firstBusDelayDep));
    }
    if (lastBusDelayArr != null) {
      estArrival = formatTime(addMinutesToIso(pattern.expectedEndTime, lastBusDelayArr));
    }

    // P80 estimate from the worst delay across all legs (prefer real DuckDB P80)
    let worstAvgDelay: number | null = null;
    let worstRealP80: number | null = null;
    for (const leg of pattern.legs) {
      if (leg.mode === "foot" || !leg.line?.id) continue;
      if (!MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      const toQuay = leg.toPlace.quay?.id;
      if (!toQuay) continue;
      const statKey = `${toQuay}|${leg.line.id}`;
      const duckStat = duckStats?.get(statKey);
      const stat = stats.get(statKey);
      if (duckStat?.p80_arr != null) {
        if (worstRealP80 == null || duckStat.p80_arr > worstRealP80) {
          worstRealP80 = duckStat.p80_arr;
        }
      }
      const d = stat?.avgDelayMin ?? null;
      if (d != null && (worstAvgDelay == null || d > worstAvgDelay)) {
        worstAvgDelay = d;
      }
    }
    const p80 = estimateP80(worstAvgDelay, worstRealP80);

    return { estDeparture, estArrival, p80, firstBusDelayDep, lastBusDelayArr };
  }, [pattern, stats, duckStats]);

  return (
    <Card className={cn("transition-all", index === 0 && "border-primary/50")}>
      <div
        className="cursor-pointer p-4 pb-3"
        onClick={() => setExpanded(!expanded)}
      >
        {/* --- Collapsed summary row --- */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-start">
              <span className="text-lg font-bold font-mono">
                {formatTime(pattern.expectedStartTime)}
              </span>
              {estimatedTimes.estDeparture && (
                <span className="text-xs font-mono text-amber-500">
                  ~{estimatedTimes.estDeparture}
                </span>
              )}
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col items-start">
              <span className="text-lg font-bold font-mono">
                {formatTime(pattern.expectedEndTime)}
              </span>
              {estimatedTimes.estArrival && (
                <span className="text-xs font-mono text-amber-500">
                  ~{estimatedTimes.estArrival}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <Badge variant="secondary" className="text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {formatDuration(pattern.duration)}
            </Badge>
            {/* Transfer success probability or "Direkte" */}
            {transferAnalysis.hasTransfers ? (
              transferAnalysis.overallProb >= 0 ? (
                probabilityBadge(transferAnalysis.overallProb)
              ) : (
                <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">overgang</Badge>
              )
            ) : (
              <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">Direkte</Badge>
            )}
            {/* P80 estimate */}
            {estimatedTimes.p80 && (
              <Badge variant="outline" className="text-[9px] text-muted-foreground border-dashed">
                P80 est. {estimatedTimes.p80}
              </Badge>
            )}
            {expanded
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />
            }
          </div>
        </div>
        {/* Compact line summary with mode icons */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {pattern.legs.map((leg, i) => (
            <Badge key={i} variant="outline" className="text-xs gap-1">
              <ModeIcon mode={leg.mode} className="h-3 w-3" />
              {leg.line?.publicCode
                ? `${leg.line.publicCode}`
                : modeLabel(leg.mode)
              }
            </Badge>
          ))}
        </div>
      </div>

      {expanded && (
        <CardContent className="pt-0 space-y-3">
          {pattern.legs.map((leg, legIdx) => {
            const lineRef = leg.line?.id ?? "";
            const hasDelayData = MODES_WITH_DELAY_DATA.has(leg.mode) && !!lineRef;

            // All quay stops in this leg
            const allStops = [
              leg.fromPlace.quay,
              ...leg.intermediateQuays.map((q) => ({ id: q.id, name: q.name })),
              leg.toPlace.quay,
            ].filter(Boolean) as Array<{ id: string; name: string }>;

            // Attach transferInfo on the inbound transit leg (= legA of a transit→transit pair).
            const transferIdx = transferAnalysis.transferIdxByLeg.get(legIdx);
            const transferInfo = transferIdx != null
              ? transferAnalysis.transfers[transferIdx] ?? null
              : null;

            // Walking leg — compact display
            if (leg.mode === "foot") {
              const distM = Math.round(leg.distance || 0);
              return (
                <div key={legIdx} className="flex items-center gap-2 py-1.5 px-3 text-xs text-muted-foreground">
                  <Footprints className="h-3 w-3" />
                  <span>
                    Ga {distM > 0 ? `${distM}m` : ""} til {leg.toPlace.name}
                    {leg.duration > 0 && ` (${Math.round(leg.duration / 60)} min)`}
                  </span>
                </div>
              );
            }

            return (
              <div key={legIdx}>
                <div className="border rounded-lg p-3 bg-muted/20">
                  {/* Leg header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <ModeIcon mode={leg.mode} className="h-4 w-4 text-primary" />
                      {leg.line?.publicCode ? (
                        <Badge className="text-xs font-mono">{leg.line.publicCode}</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">{modeLabel(leg.mode)}</Badge>
                      )}
                      {leg.line?.name && (
                        <span className="text-xs text-muted-foreground truncate max-w-48">{leg.line.name}</span>
                      )}
                      {!hasDelayData && (
                        <span className="text-[9px] text-muted-foreground/60 italic">ingen forsinkelsesdata</span>
                      )}
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatTime(leg.expectedStartTime)} - {formatTime(leg.expectedEndTime)}
                    </span>
                  </div>

                  {/* Stops along leg */}
                  <div className="space-y-1 ml-2">
                    {allStops.map((stop, stopIdx) => {
                      const statKey = `${stop.id}|${lineRef}`;
                      const stat = stats.get(statKey);
                      const isFirst = stopIdx === 0;
                      const isLast = stopIdx === allStops.length - 1;

                      return (
                        <div key={stop.id + stopIdx} className="flex items-center gap-2 text-xs">
                          <div className={cn(
                            "w-2 h-2 rounded-full flex-shrink-0",
                            isFirst || isLast ? "bg-primary" : "bg-muted-foreground/40"
                          )} />
                          <span className={cn(
                            "flex-1",
                            (isFirst || isLast) ? "font-medium" : "text-muted-foreground"
                          )}>
                            {stop.name}
                          </span>
                          {(isFirst || isLast) && hasDelayData && delayBadge(stat?.avgDelayMin ?? null, true)}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Transfer indicator with three probabilities */}
                {transferInfo && (
                  <div className="py-2 px-3 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <ArrowDown className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        Overgang: {transferInfo.buffer.toFixed(0)} min total
                      </span>
                      {transferInfo.walkTime > 0 && (
                        <span className="text-xs text-muted-foreground">
                          ({transferInfo.walkTime.toFixed(1)} min gange)
                        </span>
                      )}
                      {transferInfo.fromLine && transferInfo.toLine && (
                        <span className="text-xs text-muted-foreground">
                          Linje {transferInfo.fromLine} &rarr; Linje {transferInfo.toLine}
                        </span>
                      )}
                    </div>
                    {transferInfo.probs.default >= 0 ? (
                      <div className="flex flex-col gap-0.5 ml-5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-44">
                            Med 2 min margin:
                          </span>
                          {probabilityBadge(transferInfo.probs.default)}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-44">
                            Med {transferMarginMin} min margin:
                          </span>
                          {transferInfo.probs.user >= 0
                            ? probabilityBadge(transferInfo.probs.user)
                            : <span className="text-[10px] text-muted-foreground/60 italic">ukjent</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-44">
                            Spurt ({sprintSpeedKmh.toFixed(1)} km/t + 30 sek):
                          </span>
                          {transferInfo.probs.sprint >= 0
                            ? probabilityBadge(transferInfo.probs.sprint)
                            : <span className="text-[10px] text-muted-foreground/60 italic">ukjent</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="ml-5 text-[10px] text-muted-foreground/60 italic">
                        mangler forsinkelsesdata for vurdering
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TripPlanner() {
  const [fromStop, setFromStop] = useState<StopSearchResult | null>(null);
  const [toStop, setToStop] = useState<StopSearchResult | null>(null);
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [tripPatterns, setTripPatterns] = useState<TripPattern[]>([]);
  const [delayStats, setDelayStats] = useState<Map<string, TripStopStat>>(new Map());
  const [showFilters, setShowFilters] = useState(false);

  // Filter state
  const [departDate, setDepartDate] = useState(todayISO());
  const [departTime, setDepartTime] = useState(roundedNow());
  const [arriveBy, setArriveBy] = useState(false);
  const [walkSpeedKmh, setWalkSpeedKmh] = useState(4.8);
  // Probability-only filters (don't affect Entur routing):
  // - transferMarginMin: extra buffer the user wants on top of pure walk time (e.g. 5 min)
  // - sprintSpeedKmh: pace used when running the "spurt" scenario; defaults to walk speed
  //   so that a sprint = walking at the chosen pace + 30 sec margin, until user overrides.
  const [transferMarginMin, setTransferMarginMin] = useState(5);
  const [sprintSpeedKmh, setSprintSpeedKmh] = useState<number | null>(null);
  const [maxTransfers, setMaxTransfers] = useState("any");
  const [transferSlack, setTransferSlack] = useState("default");
  const [selectedModes, setSelectedModes] = useState<string[]>(["bus", "tram", "rail", "metro", "water", "coach"]);
  const [wheelchairAccessible, setWheelchairAccessible] = useState(false);

  // Statistics time window filter
  const [statsTimeWindow, setStatsTimeWindow] = useState<StatsTimeWindow>({ type: "all" });

  // DuckDB-WASM for empirical percentiles
  const { ready: duckReady, query: duckQuery, loading: duckLoading } = useParquetQuery();

  // Derive (stopRef, lineRef) pairs for DuckDB query from current trip results
  const duckPairs = useMemo(() => {
    const pairs: Array<{ stopRef: string; lineRef: string }> = [];
    const seen = new Set<string>();
    for (const p of tripPatterns) {
      for (const leg of p.legs) {
        const lineRef = leg.line?.id ?? "";
        if (!lineRef || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
        const quays = [
          leg.fromPlace.quay?.id,
          ...leg.intermediateQuays.map((q) => q.id),
          leg.toPlace.quay?.id,
        ].filter(Boolean) as string[];
        for (const q of quays) {
          const key = `${q}|${lineRef}`;
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ stopRef: q, lineRef });
          }
        }
      }
    }
    return pairs;
  }, [tripPatterns]);

  const { data: duckData } = useTripDelayDistribution(duckPairs, duckReady, duckQuery);

  // Count total DuckDB observations for transparency display
  const duckObservationCount = useMemo(() => {
    if (!duckData) return 0;
    let total = 0;
    for (const row of Array.from(duckData.values())) {
      total += row.n ?? 0;
    }
    return total;
  }, [duckData]);

  function toggleMode(mode: string) {
    setSelectedModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode],
    );
  }

  // Swap direction handler
  function swapDirection() {
    const oldFrom = fromStop;
    const oldTo = toStop;
    setFromStop(oldTo);
    setToStop(oldFrom);
    setFromQuery(oldTo?.stopName ?? "");
    setToQuery(oldFrom?.stopName ?? "");
  }

  const tripMutation = useMutation({
    mutationFn: async () => {
      if (!fromStop || !toStop) throw new Error("Velg fra og til");

      // Build dateTime ISO string from date + time, with local timezone offset
      const localDate = new Date(`${departDate}T${departTime}:00`);
      const dateTime = localDate.toISOString();

      // 1. Build location refs — NSR:StopPlace for stops, coordinates for addresses
      function locationRef(stop: StopSearchResult) {
        if (stop.stopPlaceRef) return { place: stop.stopPlaceRef };
        if (stop.lat != null && stop.lng != null) return { coordinates: { latitude: stop.lat, longitude: stop.lng }, name: stop.stopName };
        return { place: stop.stopRef };
      }

      // Convert walk speed from km/h to m/s
      const walkSpeedMs = walkSpeedKmh / 3.6;

      // 2. Fetch trip from Entur
      const tripRes = await apiRequest("POST", "/api/trip", {
        from: locationRef(fromStop),
        to: locationRef(toStop),
        when: dateTime,
        arriveBy: arriveBy || undefined,
        transportModes: selectedModes.length > 0 ? selectedModes : undefined,
        walkSpeed: walkSpeedMs,
        maximumTransfers: maxTransfers !== "any" ? parseInt(maxTransfers) : undefined,
        transferSlack: transferSlack !== "default" ? parseInt(transferSlack) : undefined,
        wheelchairAccessible: wheelchairAccessible || undefined,
        numTripPatterns: 12, // hoytt tall -> Entur beregner dynamisk searchWindow riktig
      });
      const tripData = await tripRes.json();

      // Surface errors from Entur (e.g. invalid parameters, no routes)
      if (tripData?.errors?.length) {
        const msg = tripData.errors.map((e: { message: string }) => e.message).join("; ");
        console.warn("[trip] Entur GraphQL errors:", tripData.errors);
        throw new Error(`Entur: ${msg}`);
      }
      if (tripData?.error) {
        throw new Error(tripData.error + (tripData.detail ? ` — ${tripData.detail}` : ""));
      }

      const patterns: TripPattern[] = tripData?.data?.trip?.tripPatterns ?? [];

      if (patterns.length === 0) {
        return { patterns: [], stats: new Map<string, TripStopStat>() };
      }

      // 2. Collect (stopRef, lineRef) pairs — only for modes where we have data
      const stopLinePairs = new Set<string>();
      for (const p of patterns) {
        for (const leg of p.legs) {
          const lineRef = leg.line?.id ?? "";
          if (!lineRef || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
          const quays = [
            leg.fromPlace.quay?.id,
            ...leg.intermediateQuays.map((q) => q.id),
            leg.toPlace.quay?.id,
          ].filter(Boolean) as string[];
          for (const q of quays) {
            stopLinePairs.add(`${q}|${lineRef}`);
          }
        }
      }

      // 3. Fetch delay stats
      const stops = Array.from(stopLinePairs).map((key) => {
        const [stopRef, lineRef] = key.split("|");
        return { stopRef, lineRef };
      });

      let statsMap = new Map<string, TripStopStat>();
      if (stops.length > 0) {
        const statsRes = await apiRequest("POST", "/api/trip/stats", { stops });
        const statsData: TripStopStat[] = await statsRes.json();
        statsMap = new Map(statsData.map((s) => [`${s.stopRef}|${s.lineRef}`, s]));
      }

      return { patterns, stats: statsMap };
    },
    onSuccess: (data) => {
      setTripPatterns(data.patterns);
      setDelayStats(data.stats);
    },
  });

  const canSearch = fromStop != null && toStop != null && selectedModes.length > 0;

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Navigation className="h-8 w-8 text-primary" /> Reisesjekk
          </h2>
          <p className="text-muted-foreground mt-1">
            Planlegg reisen din og se historiske forsinkelsesdata for hvert stopp.
          </p>
        </div>

        {/* Search form */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* From / Swap / To / Button */}
            <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr_auto] items-end">
              <StopSearch label="Fra" value={fromStop} onSelect={(s) => { setFromStop(s); setFromQuery(s.stopName); }} externalQuery={fromQuery} />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 self-end"
                onClick={swapDirection}
                title="Bytt retning"
              >
                <ArrowUpDown className="h-4 w-4" />
              </Button>
              <StopSearch label="Til" value={toStop} onSelect={(s) => { setToStop(s); setToQuery(s.stopName); }} externalQuery={toQuery} />
              <div className="flex items-end">
                <Button
                  onClick={() => tripMutation.mutate()}
                  disabled={!canSearch || tripMutation.isPending}
                  className="w-full md:w-auto"
                >
                  {tripMutation.isPending ? "Leter..." : "Finn reise"}
                </Button>
              </div>
            </div>

            {/* Date / Time / Direction */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <div>
                <Label className="text-xs text-muted-foreground">Dato</Label>
                <Input
                  type="date"
                  value={departDate}
                  onChange={(e) => setDepartDate(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Tid</Label>
                <Input
                  type="time"
                  value={departTime}
                  onChange={(e) => setDepartTime(e.target.value)}
                  className="h-9 text-sm"
                  step="300"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Retning</Label>
                <Select value={arriveBy ? "arrive" : "depart"} onValueChange={(v) => setArriveBy(v === "arrive")}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="depart">Avgang</SelectItem>
                    <SelectItem value="arrive">Ankomst</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <ArrowDownUp className="h-3 w-3" />
                  {showFilters ? "Skjul filtre" : "Flere filtre"}
                </Button>
              </div>
            </div>

            {/* Advanced filters — collapsible */}
            {showFilters && (
              <div className="border-t pt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                {/* Transport modes */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Transportmidler</Label>
                  <div className="flex flex-wrap gap-2">
                    {TRANSPORT_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => toggleMode(opt.value)}
                        className={cn(
                          "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                          selectedModes.includes(opt.value)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                  {/* Walking speed slider */}
                  <div className="col-span-2 md:col-span-1">
                    <Label className="text-xs text-muted-foreground">
                      Ganghastighet: {walkSpeedKmh.toFixed(1)} km/t
                    </Label>
                    <div className="pt-2 px-1">
                      <Slider
                        value={[walkSpeedKmh]}
                        onValueChange={(v) => setWalkSpeedKmh(v[0])}
                        min={0}
                        max={20}
                        step={0.1}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
                      <span>0</span>
                      <span>10</span>
                      <span>20 km/t</span>
                    </div>
                  </div>

                  {/* Sprint speed slider — affects only "spurt"-overgangssannsynlighet */}
                  <div className="col-span-2 md:col-span-1">
                    <Label className="text-xs text-muted-foreground">
                      Spurt-tempo: {(sprintSpeedKmh ?? walkSpeedKmh).toFixed(1)} km/t
                    </Label>
                    <div className="pt-2 px-1">
                      <Slider
                        value={[sprintSpeedKmh ?? walkSpeedKmh]}
                        onValueChange={(v) => setSprintSpeedKmh(v[0])}
                        min={walkSpeedKmh}
                        max={20}
                        step={0.1}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
                      <span>{walkSpeedKmh.toFixed(0)}</span>
                      <span>{((walkSpeedKmh + 20) / 2).toFixed(0)}</span>
                      <span>20 km/t</span>
                    </div>
                  </div>

                  {/* User transfer margin — only affects probability shown, not Entur routing */}
                  <div className="col-span-2 md:col-span-1">
                    <Label className="text-xs text-muted-foreground">
                      Overgangsmargin: {transferMarginMin} min
                    </Label>
                    <div className="pt-2 px-1">
                      <Slider
                        value={[transferMarginMin]}
                        onValueChange={(v) => setTransferMarginMin(v[0])}
                        min={0}
                        max={15}
                        step={1}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
                      <span>0</span>
                      <span>5</span>
                      <span>15 min</span>
                    </div>
                  </div>

                  {/* Max transfers */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Maks overganger</Label>
                    <Select value={maxTransfers} onValueChange={setMaxTransfers}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Ubegrenset</SelectItem>
                        <SelectItem value="0">Direkte</SelectItem>
                        <SelectItem value="1">1 overgang</SelectItem>
                        <SelectItem value="2">2 overganger</SelectItem>
                        <SelectItem value="3">3 overganger</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Transfer slack */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Overgangstid</Label>
                    <Select value={transferSlack} onValueChange={setTransferSlack}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Standard (2 min)</SelectItem>
                        <SelectItem value="-60">-1 min (sprinter)</SelectItem>
                        <SelectItem value="0">0 sek</SelectItem>
                        <SelectItem value="30">30 sek</SelectItem>
                        <SelectItem value="60">1 min</SelectItem>
                        <SelectItem value="180">3 min</SelectItem>
                        <SelectItem value="300">5 min (trygt)</SelectItem>
                        <SelectItem value="600">10 min (ekstra trygt)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Wheelchair */}
                  <div className="flex items-end">
                    <button
                      onClick={() => setWheelchairAccessible(!wheelchairAccessible)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-md text-xs border transition-colors w-full h-9",
                        wheelchairAccessible
                          ? "bg-primary/10 text-primary border-primary/30"
                          : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                      )}
                    >
                      <Accessibility className="h-4 w-4" />
                      Universell utforming
                    </button>
                  </div>
                </div>

                {/* Statistics time window filter */}
                <div className="border-t pt-4">
                  <Label className="text-xs text-muted-foreground mb-2 block flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Statistikkperiode (pavirker kun forsinkelsesdata, ikke reiseforslag)
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { type: "all" as const, label: "Alle data" },
                      { type: "days" as const, value: 7, label: "Siste 7 dager" },
                      { type: "days" as const, value: 30, label: "Siste 30 dager" },
                      { type: "days" as const, value: 90, label: "Siste 90 dager" },
                      { type: "weekday" as const, label: "Ukedager" },
                      { type: "weekend" as const, label: "Helg" },
                      { type: "custom" as const, label: "Egne datoer" },
                    ] as const).map((opt) => {
                      const isActive = statsTimeWindow.type === opt.type &&
                        (opt.type !== "days" || statsTimeWindow.value === opt.value);
                      return (
                        <button
                          key={`${opt.type}-${opt.type === "days" ? opt.value : ""}`}
                          onClick={() => {
                            if (opt.type === "days") {
                              setStatsTimeWindow({ type: "days", value: opt.value });
                            } else {
                              setStatsTimeWindow({ type: opt.type });
                            }
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                            isActive
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  {statsTimeWindow.type === "custom" && (
                    <div className="flex gap-3 mt-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">Fra dato</Label>
                        <Input
                          type="date"
                          value={statsTimeWindow.dateFrom ?? ""}
                          onChange={(e) => setStatsTimeWindow((prev) => ({ ...prev, dateFrom: e.target.value }))}
                          className="h-9 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Til dato</Label>
                        <Input
                          type="date"
                          value={statsTimeWindow.dateTo ?? ""}
                          onChange={(e) => setStatsTimeWindow((prev) => ({ ...prev, dateTo: e.target.value }))}
                          className="h-9 text-sm"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tripMutation.isError && (
              <p className="text-destructive text-sm flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                {(tripMutation.error as Error).message}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        {tripPatterns.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">
              {tripPatterns.length} reiseforslag
              {delayStats.size > 0 && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  med forsinkelsesdata fra siste 13 uker
                </span>
              )}
            </h3>
            {tripPatterns.map((pattern, i) => (
              <TripCard
                key={i}
                pattern={pattern}
                index={i}
                stats={delayStats}
                duckStats={duckData}
                transferMarginMin={transferMarginMin}
                walkSpeedKmh={walkSpeedKmh}
                sprintSpeedKmh={sprintSpeedKmh ?? walkSpeedKmh}
              />
            ))}
          </div>
        )}

        {tripPatterns.length === 0 && !tripMutation.isPending && tripMutation.isSuccess && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <p>Ingen reiseforslag funnet. Prov andre stoppesteder eller juster filtre.</p>
            </CardContent>
          </Card>
        )}

        {/* Methodology info box */}
        <Card className="bg-muted/20 border-muted">
          <CardContent className="pt-5 pb-4 text-xs text-muted-foreground space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Info className="h-4 w-4 text-primary" />
                Slik beregner vi tallene
              </h3>
              <div className="flex items-center gap-2">
                <span className={cn(
                  "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border",
                  duckReady
                    ? "text-green-600 border-green-300 bg-green-50 dark:bg-green-950/20"
                    : duckLoading
                    ? "text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20"
                    : "text-muted-foreground border-border"
                )}>
                  <Database className="h-3 w-3" />
                  {duckReady ? "DuckDB klar" : duckLoading ? "Laster DuckDB..." : "DuckDB utilgjengelig"}
                </span>
                {duckObservationCount > 0 && (
                  <span className="text-[10px] text-muted-foreground/70">
                    {duckObservationCount.toLocaleString("nb-NO")} obs.
                  </span>
                )}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {/* Reiseforslag */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80">Reiseforslag</p>
                <p>Hentet fra Entur Journey Planner API v3 (NLOD 2.0). Tidene er planlagte rutetider fra Entur.</p>
              </div>

              {/* Estimert tid */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80 flex items-center gap-1">
                  <span className="text-amber-500 font-mono">~HH:MM</span> Estimert tid
                </p>
                <p>Rutetid + median forsinkelse (P50) for den aktuelle linjen ved det aktuelle stoppet. Basert pa ekte sanntidsdata fra de siste ukene. Beregnet med DuckDB-WASM direkte i nettleseren fra ukentlige Parquet-filer.</p>
              </div>

              {/* Sannsynlighet for overgang */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80 flex items-center gap-1">
                  <span className="text-green-600 font-mono">X%</span> Sannsynlighet for a rekke bytte
                </p>
                <p>Beregnet empirisk fra historiske forsinkelsesdata. Vi ser pa alle registrerte ankomster av linje A ved byttestoppet, og regner ut hvor stor andel som ville rukket avgangen til linje B gitt buffertiden og din valgte ganghastighet/margin. Nar DuckDB-data er tilgjengelig brukes persentiler (P50/P80/P95) for interpolering; ellers brukes gjennomsnittsforsinkelse som fallback.</p>
              </div>

              {/* P80 punktlighet */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80 flex items-center gap-1">
                  <span className="text-muted-foreground font-mono">P80</span> Punktlighet
                </p>
                <p>80. persentil av forsinkelsen. Betyr at 80% av avgangene er innenfor denne forsinkelsen. Beregnet via DuckDB-WASM fra ra observasjoner.</p>
              </div>
            </div>

            <div className="border-t pt-3 space-y-2">
              <div className="flex items-start gap-2">
                <CheckCircle className="h-3 w-3 text-green-500 mt-0.5 flex-shrink-0" />
                <p><strong>Datakilde:</strong> Sanntidsdata fra SIRI ET (Entur). Forsinkelse = faktisk tid - planlagt tid. Kun buss (Skyss/Vestland) har forsinkelsesdata per na. Andre transportmidler vises uten statistikk.</p>
              </div>
              <div className="flex items-start gap-2">
                <Calendar className="h-3 w-3 text-primary mt-0.5 flex-shrink-0" />
                <p><strong>Tidsvindu-filter:</strong> Pavirker kun forsinkelsesstatistikken, ikke reiseforslagene fra Entur.</p>
              </div>
              <div className="flex items-start gap-2">
                <Database className="h-3 w-3 text-primary mt-0.5 flex-shrink-0" />
                <p><strong>Teknisk:</strong> Forsinkelsesdata lagres i SQLite, eksporteres til Parquet (ZSTD), og analyseres med DuckDB-WASM (~6 MB) direkte i nettleseren. Ingen data sendes tilbake til serveren.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
