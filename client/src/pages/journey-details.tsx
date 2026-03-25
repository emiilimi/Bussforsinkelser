import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { Search, Clock, CheckCircle, AlertCircle, ChevronsUpDown, Check, MapPin, ArrowRight } from "lucide-react";
import { cn, formatStopName } from "@/lib/utils";
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Area, ComposedChart, Line, ReferenceLine } from "recharts";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";

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

function DailyTrendTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as {
    date: string;
    avgDelay: number | null;
    maxDelay: number | null;
    minDelay: number | null;
    numDepartures: number | null;
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JourneyDetails() {
  const { region, operator } = useRegion();
  const search = useSearch();

  // Direction filter for stats charts ('all' = both directions aggregated)
  const [direction, setDirection] = useState<"all" | "0" | "1">("all");

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

  const [stopProfileDir, setStopProfileDir] = useState<"0" | "1">("0");

  const { data: lineStopProfile = [] } = useQuery<LineStopProfile[]>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/stop-profile?direction=${stopProfileDir}`],
    enabled: fetchedLine.length > 0,
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
    setSelectedJourney(null); // reset journey when line changes
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
    date: r.date.slice(5),
    avgDelay: r.avgDelayMin,
    maxDelay: r.maxDelayMin,
    minDelay: r.minDelayMin,
    numDepartures: r.numDepartures,
    bandBase: r.minDelayMin ?? r.avgDelayMin ?? 0,
    bandRange: ((r.maxDelayMin ?? r.avgDelayMin ?? 0) - (r.minDelayMin ?? r.avgDelayMin ?? 0)),
  }));

  const selectedLineName = allLines.find((l) => l.lineRef === fetchedLine)?.lineName;

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
                        ? (allLines.find((l) => l.lineRef === selectedLine)?.lineName ?? selectedLine)
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
                          {allLines.map((line) => (
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
                              {line.lineName ?? line.lineRef}
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

        {/* ---- Stats + charts (existing) ---- */}
        {lineStats && (
          <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            {daily.length > 0 && (
              <DataQualityBanner
                date={daily[daily.length - 1].date}
                operator={operator}
                lineRef={fetchedLine}
              />
            )}

            {/* Direction toggle — applies to hourly + historical charts */}
            <div className="flex items-center gap-2">
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

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Snitt forsinkelse</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold font-mono ${(avgDelay ?? 0) > 5 ? "text-destructive" : ""}`}>
                    {avgDelay != null ? `${avgDelay.toFixed(1)}m` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Snitt siste 30 dager</p>
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
            </div>

            {hourlyData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Forsinkelse etter time på dagen</CardTitle>
                  <CardDescription>
                    Snittforsinkelse per time siste 30 dager. Det skyggelagte båndet viser spennet mellom beste og verste enkeltdag i perioden.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={hourlyData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="hour" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                        <Tooltip content={<HourlyTooltip />} />
                        {/* Min-max band: transparent base + shaded range */}
                        <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                        <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.12} legendType="none" isAnimationActive={false} />
                        {/* Average line */}
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2, fill: "hsl(var(--primary))" }} activeDot={{ r: 4 }} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
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
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={trendData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                        <Tooltip content={<DailyTrendTooltip />} />
                        {/* Min-max band */}
                        <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                        <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />
                        {/* Mean line */}
                        <Line type="monotone" dataKey="avgDelay" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- B: Worst stops on the line ---- */}
            {worstStops.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Verste stopp på ruten</CardTitle>
                  <CardDescription>
                    Stoppsteder med høyest gjennomsnittlig forsinkelse for {selectedLineName ?? fetchedLine} (siste 4 uker).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {worstStops.map((stop, i) => (
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
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- C: Line stop profile (all stops in route order) ---- */}
            {stopProfileData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Forsinkelsesprofil langs ruten</CardTitle>
                  <CardDescription>
                    Gjennomsnittlig forsinkelse per stopp langs hele ruten — viser hvor forsinkelsen bygger seg opp.
                    Båndet viser spennet mellom beste og verste enkeltavgang siste 4 uker.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Direction picker */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Retning:</span>
                    {(["0", "1"] as const).map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={stopProfileDir === d ? "default" : "outline"}
                        onClick={() => setStopProfileDir(d)}
                        className="h-7 px-3 text-xs"
                      >
                        Retning {d}
                      </Button>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {stopProfileData.length} stopp · {stopProfileData.reduce((s, r) => s + (r.numSamples ?? 0), 0).toLocaleString("nb-NO")} målinger totalt
                  </div>
                  <div className="overflow-x-auto">
                    <div style={{ width: stopProfileWidth, height: 320 }}>
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
                        />
                        <Tooltip content={<ProfileTooltip />} />
                        <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                        <Area type="monotone" dataKey="bandRange" stackId="band" stroke="none" fill="hsl(var(--primary))" fillOpacity={0.15} legendType="none" isAnimationActive={false} />
                        <Line type="monotone" dataKey="avgDelayMin" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3, fill: "hsl(var(--primary))" }} activeDot={{ r: 5 }} isAnimationActive={false} />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.6} />
                      </ComposedChart>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- A: Journey profile ---- */}
            {journeys.length > 0 && (
              <Card>
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
                      <div className="overflow-x-auto">
                        <div style={{ width: profileWidth, height: 320 }}>
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
                            {/* Min-max band: transparent base + colored range stacked on top */}
                            <Area
                              type="monotone"
                              dataKey="bandBase"
                              stackId="band"
                              stroke="none"
                              fill="transparent"
                              legendType="none"
                              isAnimationActive={false}
                            />
                            <Area
                              type="monotone"
                              dataKey="bandRange"
                              stackId="band"
                              stroke="none"
                              fill="hsl(var(--primary))"
                              fillOpacity={0.15}
                              legendType="none"
                              isAnimationActive={false}
                            />
                            {/* Mean line */}
                            <Line
                              type="monotone"
                              dataKey="avgDelayMin"
                              stroke="hsl(var(--primary))"
                              strokeWidth={2}
                              dot={{ r: 3, fill: "hsl(var(--primary))" }}
                              activeDot={{ r: 5 }}
                              isAnimationActive={false}
                            />
                            {/* Zero reference */}
                            <ReferenceLine
                              y={0}
                              stroke="hsl(var(--muted-foreground))"
                              strokeDasharray="4 2"
                              strokeOpacity={0.6}
                            />
                          </ComposedChart>
                        </div>
                      </div>
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
