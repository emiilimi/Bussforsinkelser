import { useQuery, keepPreviousData } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { RegionSelector } from "@/components/region-selector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarDays, MapPin, MapPinOff, Trophy, Activity, Zap } from "lucide-react";
import { formatStopName } from "@/lib/utils";
import { formatDateNO, formatWeekdayShortNO, lineNumber } from "@/lib/date-utils";
import { useState } from "react";
import { useLocation } from "wouter";
import { useRegion } from "@/lib/RegionContext";
import {
  TimeWindowPicker,
  type TimeWindow,
  windowToQuery,
  serializeWindow,
  parseWindow,
} from "@/components/time-window-picker";
import { InfoTip } from "@/components/info-tip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BusLoading } from "@/components/bus-loading";
import { useUrlParam } from "@/hooks/use-url-state";

type DaySummary = {
  date: string;
  avgDelayMin: number | null;
  totalJourneys: number | null;
  totalCancellations: number | null;
  pctOnTime: number | null;
};

type LeaderboardStop = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number | null;
  stddevDelayMin: number | null;
  pctDelayed2plus: number | null;
  totalDepartures: number | null;
};

type LeaderboardLine = {
  lineRef: string;
  lineName: string | null;
  avgDelayMin: number | null;
  stddevDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  totalDepartures: number | null;
  totalCancellations: number | null;
};

export default function WorstLists() {
  const [, navigate] = useLocation();
  const { operators } = useRegion();
  const [daySort, setDaySort] = useUrlParam("daySort", "delay");
  const [stopSort, setStopSort] = useUrlParam("stopSort", "delay");
  const [lineSort, setLineSort] = useUrlParam("lineSort", "stddev");
  const [vehicleMode, setVehicleMode] = useUrlParam("vehicleMode", "all");
  const DEFAULT_WINDOW: TimeWindow = { kind: "preset", days: 7, label: "Siste uke" };
  const [windowParam, setWindowParam] = useUrlParam("window", serializeWindow(DEFAULT_WINDOW));
  const window = parseWindow(windowParam, DEFAULT_WINDOW);
  const setWindow = (w: TimeWindow) => setWindowParam(serializeWindow(w));
  const wq = windowToQuery(window);

  // opStr/modeStr: raw query params (no leading separator). Each callsite chooses ? or & explicitly.
  const opStr = operators.length ? `operator=${operators.join(",")}` : "";
  const modeStr = vehicleMode !== "all" ? `mode=${vehicleMode}` : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join("&");

  const { data: worstDays = [], isFetching: worstDaysFetching } = useQuery<DaySummary[]>({ queryKey: [`/api/worst-days?${join(`limit=10`, opStr, wq)}`], placeholderData: keepPreviousData });
  const { data: bestDays = [], isFetching: bestDaysFetching } = useQuery<DaySummary[]>({ queryKey: [`/api/best-days?${join(`limit=10`, opStr, wq)}`], placeholderData: keepPreviousData });
  const { data: worstStops = [], isFetching: worstStopsFetching } = useQuery<LeaderboardStop[]>({ queryKey: [`/api/leaderboard/stops?${join(`type=worst`, opStr, wq, modeStr)}`], placeholderData: keepPreviousData });
  const { data: bestStops = [], isFetching: bestStopsFetching } = useQuery<LeaderboardStop[]>({ queryKey: [`/api/leaderboard/stops?${join(`type=best`, opStr, wq, modeStr)}`], placeholderData: keepPreviousData });
  const { data: reliableLines = [], isFetching: reliableLinesFetching } = useQuery<LeaderboardLine[]>({ queryKey: [`/api/leaderboard/lines?${join(`type=reliable`, opStr, modeStr)}`], placeholderData: keepPreviousData });
  const { data: unreliableLines = [], isFetching: unreliableLinesFetching } = useQuery<LeaderboardLine[]>({ queryKey: [`/api/leaderboard/lines?${join(`type=unreliable`, opStr, modeStr)}`], placeholderData: keepPreviousData });

  const isRefreshing = worstDaysFetching || bestDaysFetching || worstStopsFetching || bestStopsFetching || reliableLinesFetching || unreliableLinesFetching;

  // Sort days
  const sortedWorstDays = [...worstDays].sort((a, b) =>
    daySort === "cancellations"
      ? (b.totalCancellations ?? 0) - (a.totalCancellations ?? 0)
      : (b.avgDelayMin ?? 0) - (a.avgDelayMin ?? 0)
  );
  const sortedBestDays = [...bestDays].sort((a, b) =>
    daySort === "cancellations"
      ? (a.totalCancellations ?? 0) - (b.totalCancellations ?? 0)
      : (a.avgDelayMin ?? 0) - (b.avgDelayMin ?? 0)
  );

  // Sort stops
  const sortedWorstStops = [...worstStops].sort((a, b) =>
    stopSort === "pct"
      ? (b.pctDelayed2plus ?? 0) - (a.pctDelayed2plus ?? 0)
      : (b.avgDelayMin ?? 0) - (a.avgDelayMin ?? 0)
  );
  const sortedBestStops = [...bestStops].sort((a, b) =>
    stopSort === "pct"
      ? (a.pctDelayed2plus ?? 0) - (b.pctDelayed2plus ?? 0)
      : (a.avgDelayMin ?? 0) - (b.avgDelayMin ?? 0)
  );

  // Sort reliability lists by chosen criterion. `reliable` = best (low first), `unreliable` = worst (high first).
  const sortedReliableLines = [...reliableLines].sort((a, b) => {
    if (lineSort === "pctOnTime") return (b.pctOnTime ?? 0) - (a.pctOnTime ?? 0);
    if (lineSort === "cancellations") return (a.totalCancellations ?? 0) - (b.totalCancellations ?? 0);
    return (a.stddevDelayMin ?? 0) - (b.stddevDelayMin ?? 0);
  });
  const sortedUnreliableLines = [...unreliableLines].sort((a, b) => {
    if (lineSort === "pctOnTime") return (a.pctOnTime ?? 0) - (b.pctOnTime ?? 0);
    if (lineSort === "cancellations") return (b.totalCancellations ?? 0) - (a.totalCancellations ?? 0);
    return (b.stddevDelayMin ?? 0) - (a.stddevDelayMin ?? 0);
  });

  return (
    <Layout>
      <TooltipProvider>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <Trophy className="h-8 w-8 text-primary" /> Topplister
            </h2>
            <p className="text-muted-foreground mt-1">Beste og dårligste dager og stoppesteder.</p>
          </div>
          <RegionSelector />
        </div>

        <TimeWindowPicker value={window} onChange={setWindow} />

        {isRefreshing && (
          <div className="flex items-center">
            <BusLoading label="Laster nye data" scale={0.4} />
          </div>
        )}

        {/* Day sort */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Sorter dager:</span>
          <Tabs value={daySort} onValueChange={(v) => setDaySort(v as any)} className="w-auto">
            <TabsList>
              <TabsTrigger value="delay" className="text-xs">Snitt forsinkelse</TabsTrigger>
              <TabsTrigger value="cancellations" className="text-xs">Kanselleringer</TabsTrigger>
            </TabsList>
          </Tabs>
          <InfoTip learnMoreHref="/metode#hva-vises">Snitt = vektet gjennomsnittlig forsinkelse over dagens avganger. Kanselleringer = totalt antall avlyste avganger den dagen.</InfoTip>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Worst days */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-destructive" />
                Mest forsinkede dager
                <InfoTip>Dager rangert etter høyeste vektet snittforsinkelse i valgt tidsvindu. "Snitt" er minutter forsinkelse, "I rute" er andel ankomster ≤2 min over rutetid. Dager med åpenbart ufullstendige data (langt færre registrerte avganger enn normalt, f.eks. dagen som fortsatt lastes inn) er utelatt fra rangeringen.</InfoTip>
              </CardTitle>
              <CardDescription>Dager med høyest gjennomsnittlig forsinkelse.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dato</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
                    <TableHead className="text-right">I rute</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Avganger</TableHead>
                    <TableHead className="text-right">Kans.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedWorstDays.map((day, i) => (
                    <TableRow key={day.date} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell className="text-sm">
                        <span className="text-muted-foreground text-xs mr-1">{formatWeekdayShortNO(day.date)}</span>
                        {formatDateNO(day.date)}
                      </TableCell>
                      <TableCell className="text-right text-destructive font-mono">
                        {day.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {day.pctOnTime?.toFixed(1) ?? "—"}%
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {day.totalJourneys?.toLocaleString("nb-NO") ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {day.totalCancellations ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Best days */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-green-500" />
                Mest punktlige dager
                <InfoTip>Dager med lavest vektet snittforsinkelse i valgt tidsvindu. Dager med åpenbart ufullstendige data (langt færre registrerte avganger enn normalt, f.eks. dagen som fortsatt lastes inn) er utelatt — ellers ville en halvferdig dag med bare noen få avganger feilaktig framstå som den mest punktlige.</InfoTip>
              </CardTitle>
              <CardDescription>Dager med lavest gjennomsnittlig forsinkelse.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dato</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
                    <TableHead className="text-right">I rute</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Avganger</TableHead>
                    <TableHead className="text-right">Kans.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedBestDays.map((day, i) => (
                    <TableRow key={day.date} className={i === 0 ? "bg-green-500/5 font-medium" : ""}>
                      <TableCell className="text-sm">
                        <span className="text-muted-foreground text-xs mr-1">{formatWeekdayShortNO(day.date)}</span>
                        {formatDateNO(day.date)}
                      </TableCell>
                      <TableCell className="text-right text-green-600 font-mono">
                        {day.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {day.pctOnTime?.toFixed(1) ?? "—"}%
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {day.totalJourneys?.toLocaleString("nb-NO") ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {day.totalCancellations ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        {/* Stop sort + mode filter */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">Sorter stopp:</span>
          <Tabs value={stopSort} onValueChange={(v) => setStopSort(v as any)} className="w-auto">
            <TabsList>
              <TabsTrigger value="delay" className="text-xs">Snitt forsinkelse</TabsTrigger>
              <TabsTrigger value="pct" className="text-xs">Forsinket &gt;2m</TabsTrigger>
            </TabsList>
          </Tabs>
          <InfoTip>"Snitt" sorterer etter vektet snittforsinkelse. "Forsinket &gt;2m" sorterer etter andel stopp-passeringer som var mer enn 2 min forsinket.</InfoTip>
          <span className="text-sm text-muted-foreground ml-2">Modus:</span>
          <Tabs value={vehicleMode} onValueChange={setVehicleMode} className="w-auto">
            <TabsList>
              <TabsTrigger value="all" className="text-xs">Alle</TabsTrigger>
              <TabsTrigger value="bus" className="text-xs">Buss</TabsTrigger>
              <TabsTrigger value="tram" className="text-xs">Trikk</TabsTrigger>
              <TabsTrigger value="metro" className="text-xs">T-bane</TabsTrigger>
              <TabsTrigger value="water" className="text-xs">Båt</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Worst stops */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPinOff className="h-5 w-5 text-destructive" />
                Mest forsinkede stopp
                <InfoTip>Stopp rangert etter vektet snittforsinkelse i valgt tidsvindu. Min. 100 avganger totalt for å være med.</InfoTip>
              </CardTitle>
              <CardDescription>I valgt tidsvindu — min. 100 avganger totalt.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stoppested</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">σ</TableHead>
                    <TableHead className="text-right">&gt;2m</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedWorstStops.map((stop, i) => (
                    <TableRow key={stop.stopRef} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell className="text-sm">
                        <button
                          onClick={() => navigate(`/stops?stop=${encodeURIComponent(stop.stopRef)}&name=${encodeURIComponent(formatStopName(stop.stopName, stop.stopRef))}`)}
                          className="hover:underline text-left"
                          title="Se stoppstedsanalyse"
                        >
                          {formatStopName(stop.stopName, stop.stopRef)}
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-destructive font-mono">
                        {stop.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {stop.stddevDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {stop.pctDelayed2plus?.toFixed(1) ?? "—"}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Best stops */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-green-500" />
                Mest punktlige stopp
                <InfoTip>Stopp med lavest vektet snittforsinkelse i valgt tidsvindu. Min. 100 avganger totalt.</InfoTip>
              </CardTitle>
              <CardDescription>I valgt tidsvindu — min. 100 avganger totalt.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stoppested</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">σ</TableHead>
                    <TableHead className="text-right">&gt;2m</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedBestStops.map((stop, i) => (
                    <TableRow key={stop.stopRef} className={i === 0 ? "bg-green-500/5 font-medium" : ""}>
                      <TableCell className="text-sm">
                        <button
                          onClick={() => navigate(`/stops?stop=${encodeURIComponent(stop.stopRef)}&name=${encodeURIComponent(formatStopName(stop.stopName, stop.stopRef))}`)}
                          className="hover:underline text-left"
                          title="Se stoppstedsanalyse"
                        >
                          {formatStopName(stop.stopName, stop.stopRef)}
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-green-600 font-mono">
                        {stop.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {stop.stddevDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {stop.pctDelayed2plus?.toFixed(1) ?? "—"}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        {/* ---- Reliability (stddev-based) ---- */}
        <div className="space-y-2">
          <h3 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" /> Pålitelighet
          </h3>
          <p className="text-sm text-muted-foreground">
            Standardavvik (σ) for forsinkelse — lavt = forutsigbar, høyt = uforutsigbar. Min. 500 avganger totalt.
          </p>
          <div className="flex items-center gap-3 pt-2">
            <span className="text-sm text-muted-foreground">Sorter linjer:</span>
            <Tabs value={lineSort} onValueChange={(v) => setLineSort(v as any)} className="w-auto">
              <TabsList>
                <TabsTrigger value="stddev" className="text-xs">Standardavvik (σ)</TabsTrigger>
                <TabsTrigger value="pctOnTime" className="text-xs">% i rute</TabsTrigger>
                <TabsTrigger value="cancellations" className="text-xs">Kanselleringer</TabsTrigger>
              </TabsList>
            </Tabs>
            <InfoTip learnMoreHref="/metode#punktlighet">"σ" sorterer etter spredning i forsinkelse. "% i rute" sorterer etter andel avganger ≤2 min over rutetid. Kanselleringer kommer når pipeline-endring er deployed.</InfoTip>
          </div>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Most reliable */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-600" />
                Mest pålitelige linjer
                <InfoTip>Linjer med lavest standardavvik (σ) — minst variasjon mellom avgangene. Lavt σ ≈ forutsigbar forsinkelse.</InfoTip>
              </CardTitle>
              <CardDescription>Lavest standardavvik — mest forutsigbar forsinkelse.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Linje</TableHead>
                    <TableHead className="text-right">σ</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Kans.</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Avganger</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedReliableLines.map((line, i) => (
                    <TableRow key={line.lineRef} className={i === 0 ? "bg-emerald-500/5 font-medium" : ""}>
                      <TableCell className="text-sm">
                        <button
                          onClick={() => navigate(`/journey?line=${encodeURIComponent(line.lineRef)}`)}
                          className="hover:underline text-left"
                          title="Se linjeanalyse"
                        >
                          <span className="font-semibold">{lineNumber(line.lineRef)}</span>
                          {line.lineName && <span className="text-muted-foreground"> · {line.lineName}</span>}
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-emerald-600 font-mono">
                        ±{line.stddevDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {line.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {line.totalCancellations?.toLocaleString("nb-NO") ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {line.totalDepartures?.toLocaleString("nb-NO") ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Least reliable */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-destructive" />
                Mest uforutsigbare linjer
                <InfoTip>Linjer med høyest standardavvik (σ) — store hopp mellom avgangene. Vanskelig å planlegge med.</InfoTip>
              </CardTitle>
              <CardDescription>Høyest standardavvik — størst sprik mellom avgangene.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Linje</TableHead>
                    <TableHead className="text-right">σ</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Kans.</TableHead>
                    <TableHead className="text-right hidden sm:table-cell">Avganger</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedUnreliableLines.map((line, i) => (
                    <TableRow key={line.lineRef} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell className="text-sm">
                        <button
                          onClick={() => navigate(`/journey?line=${encodeURIComponent(line.lineRef)}`)}
                          className="hover:underline text-left"
                          title="Se linjeanalyse"
                        >
                          <span className="font-semibold">{lineNumber(line.lineRef)}</span>
                          {line.lineName && <span className="text-muted-foreground"> · {line.lineName}</span>}
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-destructive font-mono">
                        ±{line.stddevDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {line.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {line.totalCancellations?.toLocaleString("nb-NO") ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                        {line.totalDepartures?.toLocaleString("nb-NO") ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
      </TooltipProvider>
    </Layout>
  );
}
