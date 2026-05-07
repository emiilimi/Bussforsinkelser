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

/** Minutes between expected and aimed (positive = late). Null if no realtime. */
function realtimeDelayMin(d: Departure): number | null {
  if (!d.realtime || !d.expectedTime || !d.aimedTime) return null;
  return Math.round((new Date(d.expectedTime).getTime() - new Date(d.aimedTime).getTime()) / 60000);
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

  const { data: searchResults = [] } = useQuery<SearchResult[]>({
    queryKey: [`/api/stops/search?q=${encodeURIComponent(debouncedQuery)}`],
    enabled: debouncedQuery.length >= 2,
  });

  const stopRef = selectedStop?.ref ?? null;

  // Departures from Entur (1-minute server cache + 60s client refresh)
  const { data: depResp, isLoading: depLoading, isError: depError, error: depErr } =
    useQuery<DeparturesResponse>({
      queryKey: [`/api/departures/${encodeURIComponent(stopRef ?? "")}?minutes=${minutes}`],
      enabled: stopRef != null,
      refetchInterval: 60_000,
      placeholderData: keepPreviousData,
    });

  const departures = depResp?.departures ?? [];

  // Stop stat cards (last 30 days)
  const { data: stats } = useQuery<StopStatsResponse>({
    queryKey: [`/api/stop/${encodeURIComponent(stopRef ?? "")}?days=30${opStr ? `&${opStr}` : ""}`],
    enabled: stopRef != null,
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
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Vis neste:</span>
              <Tabs value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
                <TabsList>
                  <TabsTrigger value="30">30 min</TabsTrigger>
                  <TabsTrigger value="60">1 t</TabsTrigger>
                  <TabsTrigger value="90">1,5 t</TabsTrigger>
                  <TabsTrigger value="180">3 t</TabsTrigger>
                </TabsList>
              </Tabs>
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
              <CardDescription>
                Neste {minutes} minutter • Oppdateres hvert minutt
                {duckReady && delayMap && (
                  <span className="ml-2">• Forsinkelsesstatistikk fra DuckDB</span>
                )}
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
                  const rt = realtimeDelayMin(d);
                  const histKey = d.quayRef && d.lineRef ? `${d.quayRef}|${d.lineRef}` : null;
                  const hist = histKey ? delayMap?.get(histKey) : null;
                  const lineNum = d.lineNumber ?? (d.lineRef ? d.lineRef.split(":").pop() : "?");

                  return (
                    <button
                      key={`${d.serviceJourneyId ?? i}-${d.aimedTime}`}
                      onClick={() => {
                        if (d.lineRef) {
                          navigate(`/journey?line=${encodeURIComponent(d.lineRef)}${d.directionRef ? `&direction=${encodeURIComponent(d.directionRef)}` : ""}`);
                        }
                      }}
                      disabled={!d.lineRef}
                      className={cn(
                        "w-full grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 items-center py-3 px-1 text-left",
                        "hover:bg-muted/40 transition-colors disabled:cursor-default",
                        d.cancelled && "opacity-60 line-through",
                      )}
                    >
                      <div className="font-mono font-bold text-base w-12 tabular-nums">
                        {fmtHM(d.aimedTime)}
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
                        <Badge variant="outline" className="font-mono text-xs whitespace-nowrap">
                          P80 {hist.p80_dep > 0 ? "+" : ""}{hist.p80_dep.toFixed(1)}m
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground/60 italic">—</span>
                      )}
                    </button>
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
