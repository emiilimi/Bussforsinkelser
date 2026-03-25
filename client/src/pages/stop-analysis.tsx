import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { MapPin, Search, Route } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { ResponsiveContainer, ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Line, ReferenceLine, Legend } from "recharts";
import { cn, formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";

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

function DailyTrendTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as {
    date: string; avgDelay: number | null;
    maxDelay: number | null; minDelay: number | null; numDepartures: number | null;
  };
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg max-w-[200px]">
      <p className="font-medium">{d.date}</p>
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
  const { operator } = useRegion();
  const [query, setQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<{ ref: string; name: string; quays: Quay[] } | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null); // null = all platforms
  const [showResults, setShowResults] = useState(false);
  const [direction, setDirection] = useState<"all" | "0" | "1">("all");

  const { data: searchResults = [] } = useQuery<SearchResult[]>({
    queryKey: [`/api/stops/search?q=${encodeURIComponent(query)}`],
    enabled: query.length >= 2,
  });

  // Use specific quay ref when a platform is selected, otherwise use the stop place ref
  const activeRef = selectedPlatform ?? selectedStop?.ref ?? null;
  const stopStatsUrl = activeRef
    ? `/api/stop/${encodeURIComponent(activeRef)}?operator=${operator}${direction !== "all" ? `&direction=${direction}` : ""}`
    : null;

  const { data: stats, isLoading: statsLoading, isError: statsError } = useQuery<StopStatsResponse>({
    queryKey: [stopStatsUrl],
    enabled: stopStatsUrl != null,
    placeholderData: keepPreviousData, // keep old charts visible while switching platform
  });

  const { data: linesAtStop = [] } = useQuery<LineAtStop[]>({
    queryKey: [`/api/stop/${encodeURIComponent(activeRef ?? "")}/lines`],
    enabled: activeRef != null,
  });

  const { data: lineHourlyRaw = [] } = useQuery<LineHourlyAtStop[]>({
    queryKey: [`/api/stop/${encodeURIComponent(activeRef ?? "")}/lines/hourly`],
    enabled: activeRef != null,
  });

  const trendData = (stats?.daily ?? []).map((r) => ({
    date: r.date.slice(5),
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

  const avgPctDelayed =
    stats && stats.daily.length > 0
      ? stats.daily.reduce((s, r) => s + (r.pctDelayed2plus ?? 0), 0) / stats.daily.length
      : null;

  // Max delay for relative bar width in lines list
  const maxLineDelay = linesAtStop.reduce((m, l) => Math.max(m, l.avgDelayMin ?? 0), 0.01);

  // Pivot lineHourlyRaw into [{hour, "SKY:Line:6": 1.2, "SKY:Line:3": 0.8, ...}] for recharts
  const LINE_COLORS = ["hsl(var(--primary))", "hsl(var(--destructive))", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#06b6d4"];
  const uniqueLines = Array.from(new Set(lineHourlyRaw.map((r) => r.lineRef))).slice(0, 7);
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
        {selectedStop && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Retning:</span>
            {(["all", "0", "1"] as const).map((d) => (
              <Button
                key={d}
                size="sm"
                variant={direction === d ? "default" : "outline"}
                onClick={() => setDirection(d)}
                className="h-7 px-3 text-xs"
              >
                {d === "all" ? "Begge" : d === "0" ? "Retning 0 (utover)" : "Retning 1 (innover)"}
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
                    {direction === "0" ? "retning 0 (utover)" : "retning 1 (innover)"}. Prøv en annen retning.</>
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
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                      <Tooltip content={<DailyTrendTooltip />} />
                      {/* Min-max band */}
                      <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                      <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--destructive))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                      {/* Mean line */}
                      <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
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
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={hourlyData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                        <Tooltip content={<HourlyTooltip />} />
                        {/* Min-max band */}
                        <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                        <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--destructive))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                        {/* Average line */}
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 2, fill: "hsl(var(--destructive))" }} activeDot={{ r: 4 }} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
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
                        <Badge
                          variant="outline"
                          className="w-20 justify-center font-mono text-xs flex-shrink-0"
                        >
                          {lineDisplayName(line.lineRef)}
                        </Badge>
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
                          formatter={(v: number, name: string) => [`${v?.toFixed(2)}m`, lineDisplayName(name)]}
                        />
                        <Legend formatter={(v) => lineDisplayName(v)} />
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
