import { useQuery, keepPreviousData } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { Search, Clock, AlertCircle, Loader2 } from "lucide-react";
import { ModeIcon } from "@/components/mode-icon";
import { cn, formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { useParquetQuery } from "@/hooks/use-parquet-query";
import { warmupDuckDB } from "@/hooks/use-duckdb";
import { InfoTip } from "@/components/info-tip";
import { IS_REISE } from "@/lib/app-mode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Quay = { stopRef: string; platformCode: string };
type SearchResult = {
  stopRef: string;
  stopName: string | null;
  platformCodes: string | null;
  quays: Quay[];
};

type Departure = {
  aimedTime: string;
  expectedTime: string | null;
  aimedArrivalTime: string | null;
  expectedArrivalTime: string | null;
  realtime: boolean;
  cancelled: boolean;
  destination: string | null;
  quayRef: string | null;
  quayName: string | null;
  platform: string | null;
  lineRef: string | null;
  lineNumber: string | null;
  lineName: string | null;
  transportMode: string | null;
  serviceJourneyId: string | null;
  directionRef: string | null;
};

type DeparturesResponse = {
  stopRef: string | null;
  stopName: string | null;
  departures: Departure[];
};

type SjCall = {
  quayRef: string | null;
  quayName: string | null;
  platform: string | null;
  aimedArrival: string | null;
  expectedArrival: string | null;
  aimedDeparture: string | null;
  expectedDeparture: string | null;
  realtime: boolean;
  cancelled: boolean;
  destination: string | null;
};

type SjResponse = {
  serviceJourneyId: string;
  line: { lineRef: string; publicCode: string | null; name: string | null; transportMode: string | null } | null;
  date: string;
  calls: SjCall[];
};

type StopStatsResponse = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number;
  totalDepartures: number;
  daily: Array<{
    date: string;
    avgDelayMin: number | null;
    pctDelayed2plus: number | null;
    stddevDelayMin: number | null;
    numDepartures: number | null;
  }>;
};

type DuckDelayRow = {
  stop_ref: string;
  line_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p95_dep: number | null;
  n: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string) { return s.replace(/'/g, "''"); }

function fmtHM(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Minutes between expected and aimed (positive = late). Null if no realtime.
 *  I ankomstmodus brukes ankomsttidene (fallback til avgang for første stopp). */
function realtimeDelayMin(d: Departure, mode: "departure" | "arrival"): number | null {
  const aimed = mode === "arrival" ? (d.aimedArrivalTime ?? d.aimedTime) : d.aimedTime;
  const expected = mode === "arrival" ? (d.expectedArrivalTime ?? d.expectedTime) : d.expectedTime;
  if (!d.realtime || !expected || !aimed) return null;
  return Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 60000);
}

/** Tidspunktet som vises/sorteres på, avhengig av avgang/ankomst-modus. */
function displayTime(d: Departure, mode: "departure" | "arrival"): string {
  return mode === "arrival" ? (d.aimedArrivalTime ?? d.aimedTime) : d.aimedTime;
}

function delayBadgeClass(delayMin: number | null): string {
  if (delayMin == null) return "";
  if (delayMin <= 1) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (delayMin <= 4) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
}

/** Turn "+0" into "i rute", "-2" into "-2m", "+3" into "+3m" */
function fmtDeltaMin(m: number): string {
  if (m === 0) return "i rute";
  return m > 0 ? `+${m}m` : `${m}m`;
}

function addMinToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Utvidet visning: hele reisen for én avgang (klikk på en rad)
// ---------------------------------------------------------------------------

type SjStopStat = {
  stop_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p50_arr: number | null;
  p80_arr: number | null;
  n: number;
  source: "sj" | "line";
};

function JourneyDetail({
  sjId,
  dateIso,
  lineRef,
  highlightQuay,
  duckReady,
  duckQuery,
}: {
  sjId: string;
  dateIso: string; // aimedTime for den klikkede avgangen
  lineRef: string | null;
  highlightQuay: string | null;
  duckReady: boolean;
  duckQuery: (sql: string) => Promise<any[]>;
}) {
  const date = dateIso.slice(0, 10);
  const { data: sj, isLoading, isError } = useQuery<SjResponse>({
    queryKey: [`/api/servicejourney/${encodeURIComponent(sjId)}?date=${date}`],
    refetchInterval: 60_000,
  });

  // Per-stopp P50/P80 fra DuckDB: helst for akkurat denne avgangen
  // (service_journey_id), ellers for linjen ved stoppet.
  const { data: statMap } = useQuery<Map<string, SjStopStat>>({
    queryKey: ["duck-sj-stops", sjId, lineRef ?? ""],
    enabled: duckReady,
    staleTime: Infinity,
    queryFn: async () => {
      const map = new Map<string, SjStopStat>();
      const cols = `
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
        PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p50_arr,
        PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p80_arr,
        COUNT(*) AS n`;
      // Linjenivå først (bredest), deretter overskriv med SJ-nivå der vi har
      // nok observasjoner på akkurat denne avgangen.
      if (lineRef) {
        const lineRows = await duckQuery(`
          SELECT stop_ref, ${cols} FROM delays
          WHERE line_ref = '${esc(lineRef)}'
          GROUP BY stop_ref`) as Array<Omit<SjStopStat, "source">>;
        for (const r of lineRows) map.set(r.stop_ref, { ...r, source: "line" });
      }
      const sjRows = await duckQuery(`
        SELECT stop_ref, ${cols} FROM delays
        WHERE service_journey_id = '${esc(sjId)}'
        GROUP BY stop_ref`) as Array<Omit<SjStopStat, "source">>;
      for (const r of sjRows) {
        if (r.n >= 3) map.set(r.stop_ref, { ...r, source: "sj" });
      }
      return map;
    },
  });

  if (isLoading) {
    return <div className="py-3 pl-14 text-xs text-muted-foreground">Henter hele reisen…</div>;
  }
  if (isError || !sj || sj.calls.length === 0) {
    return <div className="py-3 pl-14 text-xs text-muted-foreground">Fant ikke stopplisten for denne avgangen.</div>;
  }

  const anySj = Array.from(statMap?.values() ?? []).some((s) => s.source === "sj");

  return (
    <div className="py-2 pl-8 pr-2 bg-muted/20 rounded-md mb-2">
      <div className="text-[10px] text-muted-foreground mb-1.5 flex items-center gap-2 flex-wrap">
        <span className="font-medium">
          Linje {sj.line?.publicCode ?? "?"} · hele reisen ({sj.calls.length} stopp)
        </span>
        <span>Rutetid</span>
        <span className="text-emerald-600">sanntid</span>
        <span className="text-amber-500">~P50</span>
        <span className="text-red-500/80">P80</span>
        {statMap && statMap.size > 0 && (
          <span className="italic">
            {anySj ? "statistikk for akkurat denne avgangen" : "statistikk for linjen ved hvert stopp"}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {sj.calls.map((c, i) => {
          const isLast = i === sj.calls.length - 1;
          const aimed = isLast ? (c.aimedArrival ?? c.aimedDeparture) : (c.aimedDeparture ?? c.aimedArrival);
          const expected = isLast ? (c.expectedArrival ?? c.expectedDeparture) : (c.expectedDeparture ?? c.expectedArrival);
          const rtDelta = c.realtime && aimed && expected
            ? Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 60000)
            : null;
          const stat = c.quayRef ? statMap?.get(c.quayRef) : null;
          const p50 = isLast ? stat?.p50_arr : stat?.p50_dep;
          const p80 = isLast ? stat?.p80_arr : stat?.p80_dep;
          const isHighlight = c.quayRef != null && c.quayRef === highlightQuay;
          return (
            <div
              key={`${c.quayRef ?? "q"}-${i}`}
              className={cn(
                "flex items-center gap-2 text-xs py-0.5 px-1 rounded",
                isHighlight && "bg-primary/10 font-medium",
                c.cancelled && "opacity-60 line-through",
              )}
            >
              <div className={cn(
                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                i === 0 || isLast ? "bg-primary" : "bg-muted-foreground/40",
              )} />
              <span className="flex-1 truncate">
                {c.quayName ?? "—"}
                {c.platform && <span className="text-[10px] text-muted-foreground ml-1">Plt. {c.platform}</span>}
              </span>
              <span className="font-mono text-[11px] tabular-nums">{fmtHM(aimed)}</span>
              {rtDelta != null ? (
                <Badge variant="outline" className={cn("font-mono text-[9px] px-1 py-0", delayBadgeClass(rtDelta))}>
                  {fmtDeltaMin(rtDelta)}
                </Badge>
              ) : (
                <span className="w-8 text-center text-[9px] text-muted-foreground/40">—</span>
              )}
              <span className="font-mono text-[10px] tabular-nums text-amber-500 w-12 text-right">
                {aimed && p50 != null ? `~${fmtHM(addMinToIso(aimed, p50))}` : ""}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-red-500/80 w-11 text-right">
                {aimed && p80 != null ? fmtHM(addMinToIso(aimed, p80)) : ""}
              </span>
            </div>
          );
        })}
      </div>
      {(!statMap || statMap.size === 0) && (
        <p className="text-[10px] text-muted-foreground/60 italic mt-1.5">
          Ingen historiske observasjoner for denne linjen ennå — kun rutetider og sanntid vises.
        </p>
      )}
      {!IS_REISE && lineRef && (
        <a
          href={`/journey?line=${encodeURIComponent(lineRef)}`}
          className="text-[10px] text-primary hover:underline inline-block mt-1.5"
        >
          Full linjeanalyse →
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Departures() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { operators } = useRegion();
  const opStr = operators.length ? `operator=${operators.join(",")}` : "";

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<{ ref: string; name: string } | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [minutes, setMinutes] = useState(90);
  // Avgang (når bussen forlater stoppet) vs ankomst (når den kommer inn)
  const [mode, setMode] = useState<"departure" | "arrival">("departure");
  // Valgt tidspunkt. Tomt = "nå" (live-visning med auto-refresh hvert minutt).
  // Satt = fast vindu fra valgt tid — Entur støtter også tidspunkt bakover i
  // tid (startTime), men sanntidsdata for passerte avganger finnes bare i en
  // kort periode; lenger tilbake vises kun rutetider.
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("");
  // Utvidet avgang (viser hele reisen). Nøkkel = sjId + aimedTime.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const startIso = useMemo(() => {
    if (!customDate || !customTime) return null;
    const d = new Date(`${customDate}T${customTime}:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [customDate, customTime]);

  const nowDate = () => new Date().toISOString().slice(0, 10);
  const nowTime = () => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
  };

  // Auto-select stop from URL params (?stop=NSR:StopPlace:X&name=…)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const stopRef = params.get("stop");
    const stopName = params.get("name");
    if (stopRef && !selectedStop) {
      setSelectedStop({ ref: stopRef, name: stopName ?? stopRef });
      setQuery(stopName ?? stopRef);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Reise-bygget har ingen SQLite-backend → bruk Entur Geocoder (samme som
  // reiseplanleggeren). Det fulle nettstedet bruker DB-søket som før.
  const searchUrl = IS_REISE
    ? `/api/geocoder/autocomplete?text=${encodeURIComponent(debouncedQuery)}&size=8`
    : `/api/stops/search?q=${encodeURIComponent(debouncedQuery)}`;

  const { data: rawSearch = [] } = useQuery<any[]>({
    queryKey: [searchUrl],
    enabled: debouncedQuery.length >= 2,
  });

  // Normaliser begge kildene til SearchResult[]. Geocoder returnerer både
  // stoppesteder (layer "venue", NSR-id) og adresser — bare stoppesteder kan
  // gi avganger, så adresser filtreres bort.
  const searchResults: SearchResult[] = useMemo(() => {
    if (!IS_REISE) return rawSearch as SearchResult[];
    return (rawSearch as Array<{ id: string; name: string; layer: string }>)
      .filter((r) => r.layer === "venue" && typeof r.id === "string" && r.id.startsWith("NSR:"))
      .map((r) => ({ stopRef: r.id, stopName: r.name, platformCodes: null, quays: [] }));
  }, [rawSearch]);

  const stopRef = selectedStop?.ref ?? null;

  // Lat DuckDB-init: start WASM-nedlastingen først når et stopp er valgt —
  // det er da P80-kolonnen og reisedetaljene faktisk trenger den.
  useEffect(() => {
    if (stopRef) warmupDuckDB();
  }, [stopRef]);

  // Departures from Entur (1-minute server cache + 60s client refresh).
  // Ved valgt tidspunkt (startIso) er vinduet fast — ingen auto-refresh.
  // view=arrivals gir også avganger som KUN ankommer stoppet (endeholdeplass) —
  // uten den er «Ankomster» bare avgangslisten med ankomsttider.
  const { data: depResp, isLoading: depLoading, isError: depError, error: depErr } =
    useQuery<DeparturesResponse>({
      queryKey: [
        `/api/departures/${encodeURIComponent(stopRef ?? "")}?minutes=${minutes}${startIso ? `&startTime=${encodeURIComponent(startIso)}` : ""}${mode === "arrival" ? "&view=arrivals" : ""}`,
      ],
      enabled: stopRef != null,
      refetchInterval: startIso ? false : 60_000,
      placeholderData: keepPreviousData,
    });

  // Sorter på visningstiden (avgang eller ankomst)
  const departures = useMemo(() => {
    const list = [...(depResp?.departures ?? [])];
    list.sort(
      (a, b) => new Date(displayTime(a, mode)).getTime() - new Date(displayTime(b, mode)).getTime(),
    );
    return list;
  }, [depResp, mode]);

  // Stop stat cards (last 30 days) — SQLite-backend. Skrus av i reise-bygget
  // (ingen DB). Fase 5 erstatter disse med en Parquet-basert oppsummering.
  const { data: stats } = useQuery<StopStatsResponse>({
    queryKey: [`/api/stop/${encodeURIComponent(stopRef ?? "")}?days=30${opStr ? `&${opStr}` : ""}`],
    enabled: stopRef != null && !IS_REISE,
    placeholderData: keepPreviousData,
  });

  // Compute summary stats from `daily` (mirrors stop-analysis.tsx)
  const avgDelayMin = stats?.avgDelayMin ?? null;
  const totalDepartures = stats?.totalDepartures ?? null;
  const avgPctDelayed = useMemo(() => {
    if (!stats || stats.daily.length === 0) return null;
    return stats.daily.reduce((s, r) => s + (r.pctDelayed2plus ?? 0), 0) / stats.daily.length;
  }, [stats]);
  const avgStddev = useMemo(() => {
    if (!stats || stats.daily.length === 0) return null;
    let num = 0, den = 0;
    for (const r of stats.daily) {
      if (r.stddevDelayMin != null && r.numDepartures != null) {
        num += r.stddevDelayMin * r.numDepartures;
        den += r.numDepartures;
      }
    }
    return den > 0 ? num / den : null;
  }, [stats]);

  // DuckDB-WASM percentiles per (quay, line) pair seen in the departure list
  const { ready: duckReady, query: duckQuery } = useParquetQuery();
  const duckPairs = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ stopRef: string; lineRef: string }> = [];
    for (const d of departures) {
      if (!d.quayRef || !d.lineRef) continue;
      const k = `${d.quayRef}|${d.lineRef}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ stopRef: d.quayRef, lineRef: d.lineRef });
    }
    return out;
  }, [departures]);

  const { data: delayMap } = useQuery<Map<string, DuckDelayRow>>({
    queryKey: ["duck-departure-delays", ...duckPairs.map(p => `${p.stopRef}|${p.lineRef}`)],
    queryFn: async () => {
      if (duckPairs.length === 0) return new Map();
      const conditions = duckPairs
        .map(p => `(stop_ref = '${esc(p.stopRef)}' AND line_ref = '${esc(p.lineRef)}')`)
        .join(" OR ");
      const sql = `
        SELECT
          stop_ref,
          line_ref,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95_dep,
          COUNT(*) AS n
        FROM delays
        WHERE (${conditions}) AND delay_departure_min IS NOT NULL
        GROUP BY stop_ref, line_ref`;
      const rows = await duckQuery(sql) as DuckDelayRow[];
      const map = new Map<string, DuckDelayRow>();
      for (const r of rows) map.set(`${r.stop_ref}|${r.line_ref}`, r);
      return map;
    },
    enabled: duckReady && duckPairs.length > 0,
    staleTime: Infinity,
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Clock className="w-7 h-7 text-primary" /> Avganger
          </h2>
          <p className="text-muted-foreground mt-1">
            Kommende avganger fra et stoppested, med historisk forsinkelsesstatistikk per linje.
          </p>
        </div>

        {/* Stop search */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Søk etter stoppested (f.eks. Bergen busstasjon)…"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setShowResults(true)}
                onBlur={() => setTimeout(() => setShowResults(false), 150)}
              />
              {showResults && searchResults.length > 0 && (
                <div className="absolute top-full mt-1 w-full bg-card border border-border rounded-md shadow-lg z-50 max-h-64 overflow-y-auto">
                  {searchResults.map((r) => {
                    const name = formatStopName(r.stopName, r.stopRef);
                    return (
                      <button
                        key={r.stopRef}
                        className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                        onMouseDown={() => {
                          setSelectedStop({ ref: r.stopRef, name });
                          setQuery(name);
                          setShowResults(false);
                          // Update URL so refresh + share works
                          navigate(`/avganger?stop=${encodeURIComponent(r.stopRef)}&name=${encodeURIComponent(name)}`);
                        }}
                      >
                        <div className="font-medium">{name}</div>
                        {r.platformCodes && (
                          <div className="text-xs text-muted-foreground">Plattformer: {r.platformCodes}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Time window picker */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-muted-foreground">Vis neste:</span>
              <Tabs value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
                <TabsList>
                  <TabsTrigger value="30">30 min</TabsTrigger>
                  <TabsTrigger value="60">1 t</TabsTrigger>
                  <TabsTrigger value="90">1,5 t</TabsTrigger>
                  <TabsTrigger value="180">3 t</TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs value={mode} onValueChange={(v) => setMode(v as "departure" | "arrival")}>
                <TabsList>
                  <TabsTrigger value="departure">Avganger</TabsTrigger>
                  <TabsTrigger value="arrival">Ankomster</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Tidspunkt-velger: tomt = nå (live). Kan settes frem eller tilbake i tid. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Fra tidspunkt:</span>
              <Input
                type="date"
                className="h-9 w-auto text-sm"
                value={customDate}
                onChange={(e) => {
                  setCustomDate(e.target.value);
                  if (e.target.value && !customTime) setCustomTime(nowTime());
                }}
              />
              <Input
                type="time"
                className="h-9 w-auto text-sm"
                value={customTime}
                onChange={(e) => {
                  setCustomTime(e.target.value);
                  if (e.target.value && !customDate) setCustomDate(nowDate());
                }}
              />
              <Button
                variant={startIso ? "outline" : "secondary"}
                size="sm"
                className="h-9"
                disabled={!startIso}
                onClick={() => {
                  setCustomDate("");
                  setCustomTime("");
                }}
              >
                Nå
              </Button>
              {startIso && new Date(startIso).getTime() < Date.now() - 5 * 60_000 && (
                <span className="text-xs text-muted-foreground italic">
                  Tilbake i tid: sanntid finnes bare kort tid etter avgang — eldre visninger er rutetider.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Stop stat cards (mirrors stop-analysis.tsx) */}
        {stopRef && stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Snitt forsinkelse</CardDescription>
                <CardTitle className="text-2xl font-mono">
                  {avgDelayMin != null ? `${avgDelayMin.toFixed(2)}m` : "—"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">Siste 30 dager</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Pålitelighet (σ)</CardDescription>
                <CardTitle className="text-2xl font-mono">
                  {avgStddev != null ? `${avgStddev.toFixed(2)}m` : "—"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">Lavere = mer forutsigbar</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Forsinket &gt; 2 min</CardDescription>
                <CardTitle className="text-2xl font-mono">
                  {avgPctDelayed != null ? `${avgPctDelayed.toFixed(1)}%` : "—"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">Andel av avganger</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Avganger</CardDescription>
                <CardTitle className="text-2xl font-mono">
                  {totalDepartures != null ? totalDepartures.toLocaleString("nb-NO") : "—"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">Totalt siste 30 dager</CardContent>
            </Card>
          </div>
        )}

        {/* Departure list */}
        {stopRef && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{depResp?.stopName ?? selectedStop?.name ?? "Avganger"}</span>
                {depLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              </CardTitle>
              <CardDescription className="flex items-center gap-1.5">
                <span>
                  {mode === "arrival" ? "Ankomster" : "Avganger"}{" "}
                  {startIso
                    ? `${minutes} min fra ${fmtHM(startIso)} (${customDate})`
                    : `neste ${minutes} minutter • Oppdateres hvert minutt`}
                  {duckReady && delayMap && (
                    <span className="ml-2">• Forsinkelsesstatistikk fra DuckDB</span>
                  )}
                </span>
                <InfoTip learnMoreHref="/metode#persentiler">
                  Tallene til høyre: <strong>Sanntid</strong> (faktisk forsinkelse nå) og
                  <strong> P80</strong> (historisk — 4 av 5 ganger har avgangen vært bedre enn dette).
                </InfoTip>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {depError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 py-4">
                  <AlertCircle className="w-4 h-4" />
                  Kunne ikke laste avganger. {depErr instanceof Error ? depErr.message : ""}
                </div>
              )}

              {!depError && departures.length === 0 && !depLoading && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  Ingen avganger funnet i tidsvinduet.
                </p>
              )}

              <div className="divide-y divide-border">
                {departures.map((d, i) => {
                  const rt = realtimeDelayMin(d, mode);
                  const histKey = d.quayRef && d.lineRef ? `${d.quayRef}|${d.lineRef}` : null;
                  const hist = histKey ? delayMap?.get(histKey) : null;
                  const lineNum = d.lineNumber ?? (d.lineRef ? d.lineRef.split(":").pop() : "?");
                  const rowKey = `${d.serviceJourneyId ?? i}-${d.aimedTime}`;
                  const isExpanded = expandedKey === rowKey;

                  return (
                    <div key={rowKey}>
                    <button
                      onClick={() => {
                        if (d.serviceJourneyId) {
                          setExpandedKey(isExpanded ? null : rowKey);
                        }
                      }}
                      disabled={!d.serviceJourneyId}
                      title="Vis hele reisen med rutetider, sanntid og historiske estimater"
                      className={cn(
                        "w-full grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 items-center py-3 px-1 text-left",
                        "hover:bg-muted/40 transition-colors disabled:cursor-default",
                        isExpanded && "bg-muted/30",
                        d.cancelled && "opacity-60 line-through",
                      )}
                    >
                      <div className="font-mono font-bold text-base w-12 tabular-nums">
                        {fmtHM(displayTime(d, mode))}
                      </div>

                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <ModeIcon mode={d.transportMode} size={14} />
                        <span className="font-mono text-sm">{lineNum}</span>
                      </div>

                      <div className="text-sm truncate">
                        <span className="text-foreground">{d.destination ?? d.lineName ?? "—"}</span>
                        {d.platform && (
                          <span className="text-xs text-muted-foreground ml-2">Plt. {d.platform}</span>
                        )}
                      </div>

                      {/* Realtime badge */}
                      {rt != null ? (
                        <Badge variant="outline" className={cn("font-mono text-xs", delayBadgeClass(rt))}>
                          {fmtDeltaMin(rt)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">ingen sanntid</span>
                      )}

                      {/* Historical P80 badge */}
                      {hist && hist.p80_dep != null ? (
                        <Badge variant="outline" className="font-mono text-xs whitespace-nowrap" title="Historisk 80-persentil — 4 av 5 avganger er bedre enn dette">
                          P80 {hist.p80_dep > 0 ? "+" : ""}{hist.p80_dep.toFixed(1)}m
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground/60 italic">—</span>
                      )}
                    </button>
                    {isExpanded && d.serviceJourneyId && (
                      <JourneyDetail
                        sjId={d.serviceJourneyId}
                        dateIso={d.aimedTime}
                        lineRef={d.lineRef}
                        highlightQuay={d.quayRef}
                        duckReady={duckReady}
                        duckQuery={duckQuery}
                      />
                    )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {!stopRef && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              Søk etter et stoppested for å se kommende avganger.
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
