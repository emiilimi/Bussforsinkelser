import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useLocation } from "wouter";
import { MapPin, Search, Route } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Line, ReferenceLine } from "recharts";
import { cn, formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearchResult = { stopRef: string; stopName: string | null };

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
    numSamples: number | null;
  }>;
};

type LineAtStop = {
  lineRef: string;
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

export default function StopAnalysis() {
  const [, navigate] = useLocation();
  const { operator } = useRegion();
  const [query, setQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<{ ref: string; name: string } | null>(null);
  const [showResults, setShowResults] = useState(false);

  const { data: searchResults = [] } = useQuery<SearchResult[]>({
    queryKey: [`/api/stops/search?q=${encodeURIComponent(query)}`],
    enabled: query.length >= 2,
  });

  const { data: stats } = useQuery<StopStatsResponse>({
    queryKey: [`/api/stop/${encodeURIComponent(selectedStop?.ref ?? "")}`],
    enabled: selectedStop != null,
  });

  const { data: linesAtStop = [] } = useQuery<LineAtStop[]>({
    queryKey: [`/api/stop/${encodeURIComponent(selectedStop?.ref ?? "")}/lines`],
    enabled: selectedStop != null,
  });

  const trendData = (stats?.daily ?? []).map((r) => ({
    date: r.date.slice(5),
    avgDelay: r.avgDelayMin,
    bandBase: r.minDelayMin ?? r.avgDelayMin ?? 0,
    bandRange: ((r.maxDelayMin ?? r.avgDelayMin ?? 0) - (r.minDelayMin ?? r.avgDelayMin ?? 0)),
  }));

  const hourlyData = (stats?.hourly ?? []).map((r) => ({
    hour: `${r.hour}:00`,
    avgDelay: r.avgDelayMin,
  }));

  const avgPctDelayed =
    stats && stats.daily.length > 0
      ? stats.daily.reduce((s, r) => s + (r.pctDelayed2plus ?? 0), 0) / stats.daily.length
      : null;

  // Max delay for relative bar width in lines list
  const maxLineDelay = linesAtStop.reduce((m, l) => Math.max(m, l.avgDelayMin ?? 0), 0.01);

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
                {searchResults.map((r) => (
                  <button
                    key={r.stopRef}
                    className="w-full text-left px-3 py-2 hover:bg-muted text-sm flex items-center gap-2"
                    onMouseDown={() => {
                      setSelectedStop({ ref: r.stopRef, name: formatStopName(r.stopName, r.stopRef) });
                      setQuery(formatStopName(r.stopName, r.stopRef));
                      setShowResults(false);
                    }}
                  >
                    <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    {formatStopName(r.stopName, r.stopRef)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {stats && (
          <div className="grid gap-6 animate-in slide-in-from-bottom-4 duration-300">
            {stats.daily.length > 0 && (
              <DataQualityBanner
                date={stats.daily[stats.daily.length - 1].date}
                operator={operator}
                stopRef={selectedStop?.ref}
              />
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
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: number, name: string) => {
                          if (name === "bandBase" || name === "bandRange") return null;
                          return [`${v.toFixed(2)}m`, "Snitt forsinkelse"];
                        }}
                      />
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
                  <CardDescription>Gjennomsnittlig forsinkelse per avgangstid ved {formatStopName(stats.stopName, stats.stopRef)} (siste 30 dager).</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={hourlyData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                        <Tooltip
                          contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                          formatter={(v: number) => [`${v.toFixed(2)}m`, "Snitt forsinkelse"]}
                        />
                        <Bar dataKey="avgDelay" radius={[4, 4, 0, 0]} barSize={20}>
                          {hourlyData.map((entry, i) => (
                            <Cell key={i} fill={delayColor(entry.avgDelay)} />
                          ))}
                        </Bar>
                      </BarChart>
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
          </div>
        )}
      </div>
    </Layout>
  );
}
