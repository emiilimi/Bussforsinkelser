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
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, Area, ComposedChart, Line, ReferenceLine } from "recharts";
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
  hour: number;
  avgDelayMin: number | null;
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

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function delayColor(delay: number | null) {
  const d = delay ?? 0;
  if (d > 5) return "hsl(var(--destructive))";
  if (d > 2) return "hsl(var(--chart-4))";
  return "hsl(var(--primary))";
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JourneyDetails() {
  const { region, operator } = useRegion();
  const search = useSearch();

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

  const { data: lineStats } = useQuery<LineStatsResponse>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}`],
    enabled: fetchedLine.length > 0,
  });

  const { data: journeys = [] } = useQuery<JourneyEntry[]>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/journeys`],
    enabled: fetchedLine.length > 0,
  });

  const { data: worstStops = [] } = useQuery<WorstStop[]>({
    queryKey: [`/api/line/${encodeURIComponent(fetchedLine)}/stops`],
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

  const hourlyData = (lineStats?.hourly ?? []).map((r) => ({
    hour: `${r.hour}:00`,
    avgDelay: r.avgDelayMin,
  }));

  const trendData = daily.map((r) => ({
    date: r.date.slice(5),
    avgDelay: r.avgDelayMin,
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
                  <CardDescription>Gjennomsnittlig forsinkelse per avgangstid (siste 30 dager).</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px]">
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
                        <Tooltip
                          contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                          formatter={(v: number, name: string) => {
                            if (name === "bandBase" || name === "bandRange") return null;
                            return [`${v.toFixed(2)}m`, "Snitt forsinkelse"];
                          }}
                        />
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
