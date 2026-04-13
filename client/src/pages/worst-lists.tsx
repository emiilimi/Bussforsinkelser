import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarDays, MapPin, MapPinOff, Trophy, Activity, Zap } from "lucide-react";
import { formatStopName } from "@/lib/utils";
import { formatDateNO, formatWeekdayShortNO, lineNumber } from "@/lib/date-utils";
import { useState } from "react";
import { useLocation } from "wouter";

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
};

export default function WorstLists() {
  const [, navigate] = useLocation();
  const [daySort, setDaySort] = useState<"delay" | "cancellations">("delay");
  const [stopSort, setStopSort] = useState<"delay" | "pct">("delay");

  const { data: worstDays = [] } = useQuery<DaySummary[]>({ queryKey: ["/api/worst-days?limit=10"] });
  const { data: bestDays = [] } = useQuery<DaySummary[]>({ queryKey: ["/api/best-days?limit=10"] });
  const { data: worstStops = [] } = useQuery<LeaderboardStop[]>({ queryKey: ["/api/leaderboard/stops?type=worst"] });
  const { data: bestStops = [] } = useQuery<LeaderboardStop[]>({ queryKey: ["/api/leaderboard/stops?type=best"] });
  const { data: reliableLines = [] } = useQuery<LeaderboardLine[]>({ queryKey: ["/api/leaderboard/lines?type=reliable"] });
  const { data: unreliableLines = [] } = useQuery<LeaderboardLine[]>({ queryKey: ["/api/leaderboard/lines?type=unreliable"] });

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

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Trophy className="h-8 w-8 text-primary" /> Topplister
          </h2>
          <p className="text-muted-foreground mt-1">Beste og dårligste dager og stoppesteder.</p>
        </div>

        {/* Day sort */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Sorter dager:</span>
          <Tabs value={daySort} onValueChange={(v) => setDaySort(v as any)} className="w-auto">
            <TabsList>
              <TabsTrigger value="delay" className="text-xs">Snitt forsinkelse</TabsTrigger>
              <TabsTrigger value="cancellations" className="text-xs">Kanselleringer</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Worst days */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-destructive" />
                Verste dager
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
                Beste dager
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

        {/* Stop sort */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Sorter stopp:</span>
          <Tabs value={stopSort} onValueChange={(v) => setStopSort(v as any)} className="w-auto">
            <TabsList>
              <TabsTrigger value="delay" className="text-xs">Snitt forsinkelse</TabsTrigger>
              <TabsTrigger value="pct" className="text-xs">Forsinket &gt;2m</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Worst stops */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPinOff className="h-5 w-5 text-destructive" />
                Verste stopp
              </CardTitle>
              <CardDescription>Siste 7 dager — min. 100 avganger/uke.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stoppested</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
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
                Beste stopp
              </CardTitle>
              <CardDescription>Siste 7 dager — min. 100 avganger/uke.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stoppested</TableHead>
                    <TableHead className="text-right">Snitt</TableHead>
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
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Most reliable */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-600" />
                Mest pålitelige linjer
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
                    <TableHead className="text-right hidden sm:table-cell">Avganger</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reliableLines.map((line, i) => (
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
                    <TableHead className="text-right hidden sm:table-cell">Avganger</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unreliableLines.map((line, i) => (
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
    </Layout>
  );
}
