import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { MapPin, Search, Route } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { ResponsiveContainer, ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Line, ReferenceLine, Legend } from "recharts";
import { cn, formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { useYAxisDrag } from "@/components/scrollable-chart";
import { formatDateShortNO, formatWeekdayDateNO } from "@/lib/date-utils";

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

type LineAtStop = {
  lineRef: string;
  avgDelayMin: number | null;
  numSamples: number | null;
};

type LineHourlyAtStop = {
  lineRef: string;
  hour: number;
  avgDelayMin: number | null;
  numSamples: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineDisplayName(lineRef: string): string {
  const parts = lineRef.split(":");
  return parts.length >= 3 ? `Linje ${parts[parts.length - 1]}` : lineRef;
}

function delayColor(delay: number | null) {
  const d = delay ?? 0;
  if (d > 5) return "hsl(var(--destructive))";
  if (d > 2) return "hsl(var(--chart-4))";
  return "hsl(var(--primary))";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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
    date: string; label: string; avgDelay: number | null;
    maxDelay: number | null; minDelay: number | null; numDepartures: number | null;
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

// Custom hourly tooltip with max/min explanation
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

export default function StopAnalysis() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { operator } = useRegion();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<{ ref: string; name: string; quays: Quay[] } | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null); // null = all platforms
  const [showResults, setShowResults] = useState(false);
  const [direction, setDirection] = useState<string>("all");
  const [periodDays, setPeriodDays] = useState<number>(30);

  // Auto-select stop from URL params (e.g. navigated from topplister or map)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const stopRef = params.get("stop");
    const stopName = params.get("name");
    if (stopRef && !selectedStop) {
      setSelectedStop({ ref: stopRef, name: stopName ?? stopRef, quays: [] });
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

  // Use specific quay ref when a platform is selected, otherwise use the stop place ref
  const activeRef = selectedPlatform ?? selectedStop?.ref ?? null;

  const { data: availableDirections = [] } = useQuery<string[]>({
    queryKey: [`/api/stop/${encodeURIComponent(activeRef ?? "")}/directions?operator=${operator}`],
    enabled: activeRef != null,
  });
  const stopStatsUrl = activeRef
    ? `/api/stop/${encodeURIComponent(activeRef)}?operator=${operator}&days=${periodDays}${direction !== "all" ? `&direction=${direction}` : ""}`
    : null;

  const { data: stats, isLoading: statsLoading, isError: statsError } = useQuery<StopStatsResponse>({
    queryKey: [stopStatsUrl],
    enabled: stopStatsUrl != null,
    placeholderData: keepPreviousData, // keep old charts visible while switching platform
  });

  const { data: allLines = [] } = useQuery<Array<{ lineRef: string; lineName: string | null }>>({
    queryKey: [`/api/lines/all?operator=${operator}`],
    enabled: activeRef != null,
  });

  const lineNameMap = Object.fromEntries(allLines.map(l => [l.lineRef, l.lineName]));
  function lineNumber(ref: string) { return ref.split(":").pop() ?? ref; }

  const { data: linesAtStop = [] } = useQuery<LineAtStop[]>({
    queryKey: [`/api/stop/${encodeURIComponent(activeRef ?? "")}/lines`],
    enabled: activeRef != null,
  });

  const { data: lineHourlyRaw = [] } = useQuery<LineHourlyAtStop[]>({
    queryKey: [`/api/stop/${encodeURIComponent(activeRef ?? "")}/lines/hourly`],
    enabled: activeRef != null,
  });

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

  // Max delay for relative bar width in lines list
  const maxLineDelay = linesAtStop.reduce((m, l) => Math.max(m, l.avgDelayMin ?? 0), 0.01);

  // Pivot lineHourlyRaw into [{hour, "SKY:Line:6": 1.2, "SKY:Line:3": 0.8, ...}] for recharts
  const LINE_COLORS = ["hsl(var(--primary))", "hsl(var(--destructive))", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#06b6d4"];
  // Sort lines by total departures (descending) — show most frequent lines first
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
    <Layout>
      <div className="max-w-4xl mx-auto space-y-8 animate-in slide-in-from-bottom-4 duration-500">
        <div className="space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Stoppstedsanalyse</h2>
          <p className="text-muted-foreground">Detaljert forsinkelsesstatistikk for individuelle stopp.</p>

          {/* Search box */}
          <div className="relative w-[340px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Søk etter stoppested..."
              className="pl-9 h-12 text-base"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
              onFocus={() => setShowResults(true)}
              onBlur={() => setTimeout(() => setShowResults(false), 150)}
            />
            {showResults && searchResults.length > 0 && (
              <div className="absolute top-full mt-1 w-full bg-card border border-border rounded-md shadow-lg z-50 max-h-64 overflow-y-auto">
                {searchResults.map((r) => {
                  const name = formatStopName(r.stopName, r.stopRef);
                  const platforms = r.platformCodes
                    ? r.platformCodes.split(",").filter(Boolean).join(", ")
                    : null;
                  return (
                    <button
                      key={r.stopRef}
                      className="w-full text-left px-3 py-2 hover:bg-muted text-sm flex items-center gap-2"
                      onMouseDown={() => {
                        setSelectedStop({ ref: r.stopRef, name, quays: r.quays });
                        setSelectedPlatform(null);
                        setDirection("all");
                        setQuery(name);
                        setShowResults(false);
                      }}
                    >
                      <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 min-w-0">
                        {name}
                        {platforms && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            plattform {platforms}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Direction toggle — outside stats block so it stays visible even when no data */}
        {selectedStop && availableDirections.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Retning:</span>
            {["all", ...availableDirections].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={direction === d ? "default" : "outline"}
                onClick={() => setDirection(d as any)}
                className="h-7 px-3 text-xs"
              >
                {d === "all" ? "Begge" : `Retning ${d}`}
              </Button>
            ))}
          </div>
        )}

        {/* Platform picker — outside stats block so it stays visible while loading */}
        {selectedStop && selectedStop.quays.length > 1 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Plattform:</span>
            <Button
              size="sm"
              variant={selectedPlatform === null ? "default" : "outline"}
              onClick={() => setSelectedPlatform(null)}
              className="h-7 px-3 text-xs"
            >
              Alle
            </Button>
            {selectedStop.quays.map((q) => (
              <Button
                key={q.stopRef}
                size="sm"
                variant={selectedPlatform === q.stopRef ? "default" : "outline"}
                onClick={() => setSelectedPlatform(q.stopRef)}
                className="h-7 px-3 text-xs"
              >
                {q.platformCode}
              </Button>
            ))}
          </div>
        )}

        {/* Period selector */}
        {selectedStop && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Periode:</span>
            <Tabs value={String(periodDays)} onValueChange={(v) => setPeriodDays(Number(v))}>
              <TabsList>
                <TabsTrigger value="7">Uke</TabsTrigger>
                <TabsTrigger value="30">Måned</TabsTrigger>
                <TabsTrigger value="90">3 mnd</TabsTrigger>
                <TabsTrigger value="365">År</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        {/* Loading state */}
        {statsLoading && !stats && (
          <div className="flex items-center gap-3 text-muted-foreground py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Laster data...</span>
          </div>
        )}

        {/* No data / error state */}
        {!statsLoading && selectedStop && (statsError || (!stats && stopStatsUrl != null)) && (
          <div className="flex flex-col items-start gap-3 py-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              <span className="font-medium">
                {selectedPlatform
                  ? "Ingen data for denne plattformen"
                  : "Ingen data funnet for dette stoppestedet"}
              </span>
            </div>
            <p className="text-sm text-muted-foreground max-w-md">
              {selectedPlatform
                ? <>Det finnes ingen forsinkelsesdata for plattform{" "}
                    <span className="font-medium">
                      {selectedStop.quays.find(q => q.stopRef === selectedPlatform)?.platformCode ?? ""}
                    </span> ved <span className="font-medium">{selectedStop.name}</span>.</>
                : direction !== "all"
                ? <>Det finnes ingen forsinkelsesdata for{" "}
                    <span className="font-medium">{selectedStop.name}</span> i{" "}
                    retning {direction}. Prøv en annen retning.</>
                : <>Det finnes ingen forsinkelsesdata for{" "}
                    <span className="font-medium">{selectedStop.name}</span> i den valgte perioden.
                    Stoppestedet kan være et ferjekai, trikk eller ha for lite trafikk til å vises.</>
              }
            </p>
            <div className="flex gap-2 flex-wrap">
              {direction !== "all" && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setDirection("all")}
                >
                  Tilbake til alle retninger
                </Button>
              )}
              {selectedPlatform && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setSelectedPlatform(null)}
                >
                  Tilbake til alle plattformer
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedStop(null);
                  setSelectedPlatform(null);
                  setDirection("all");
                  setQuery("");
                }}
              >
                Tilbakestill søk
              </Button>
            </div>
          </div>
        )}

        {stats && selectedStop && (
          <div className="grid gap-6 animate-in slide-in-from-bottom-4 duration-300">
            {stats.daily.length > 0 && (
              <DataQualityBanner
                date={stats.daily[stats.daily.length - 1].date}
                operator={operator}
                stopRef={selectedStop?.ref}
              />
            )}

            {/* Loading indicator overlay when switching platforms */}
            {statsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Oppdaterer...
              </div>
            )}

            {/* ---- Stat cards ---- */}
            <div className="grid gap-4 md:grid-cols-3">
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

            {/* ---- C: Lines serving this stop ---- */}
            {linesAtStop.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Linjer ved dette stoppestedet</CardTitle>
                  <CardDescription>
                    Gjennomsnittlig forsinkelse per linje ved {formatStopName(stats.stopName, stats.stopRef)} (siste 4 uker).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {linesAtStop.map((line) => (
                      <div key={line.lineRef} className="flex items-center gap-3">
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
                        {/* Relative delay bar */}
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
                          onClick={() => navigate(`/journey?line=${encodeURIComponent(line.lineRef)}`)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                          title="Åpne reisesjekk for denne linjen"
                        >
                          <Route className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Reisesjekk</span>
                        </button>
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
                    Gjennomsnittlig forsinkelse per time for hver linje ved {formatStopName(stats.stopName, stats.stopRef)} (siste 4 uker, fra reisedata).
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
    </Layout>
  );
}
