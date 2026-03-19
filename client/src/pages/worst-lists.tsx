import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CalendarDays, MapPin, MapPinOff, Trophy } from "lucide-react";
import { formatStopName } from "@/lib/utils";

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

export default function WorstLists() {
  const { data: worstDays = [] } = useQuery<DaySummary[]>({ queryKey: ["/api/worst-days?limit=10"] });
  const { data: bestDays = [] } = useQuery<DaySummary[]>({ queryKey: ["/api/best-days?limit=10"] });
  const { data: worstStops = [] } = useQuery<LeaderboardStop[]>({ queryKey: ["/api/leaderboard/stops?type=worst"] });
  const { data: bestStops = [] } = useQuery<LeaderboardStop[]>({ queryKey: ["/api/leaderboard/stops?type=best"] });

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Trophy className="h-8 w-8 text-primary" /> Topplister
          </h2>
          <p className="text-muted-foreground mt-1">Beste og dårligste dager og stoppesteder.</p>
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
                    <TableHead className="text-right">Snitt forsinkelse</TableHead>
                    <TableHead className="text-right">Kanselleringer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstDays.map((day, i) => (
                    <TableRow key={day.date} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell className="font-mono">{day.date}</TableCell>
                      <TableCell className="text-right text-destructive font-mono">
                        {day.avgDelayMin?.toFixed(1) ?? "—"}m
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
                    <TableHead className="text-right">Snitt forsinkelse</TableHead>
                    <TableHead className="text-right">I rute</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bestDays.map((day, i) => (
                    <TableRow key={day.date} className={i === 0 ? "bg-green-500/5 font-medium" : ""}>
                      <TableCell className="font-mono">{day.date}</TableCell>
                      <TableCell className="text-right text-green-600 font-mono">
                        {day.avgDelayMin?.toFixed(1) ?? "—"}m
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {day.pctOnTime?.toFixed(1) ?? "—"}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

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
                    <TableHead className="text-right">Snitt forsinkelse</TableHead>
                    <TableHead className="text-right">Forsinket &gt;2m</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstStops.map((stop, i) => (
                    <TableRow key={stop.stopRef} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell>{formatStopName(stop.stopName, stop.stopRef)}</TableCell>
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
                    <TableHead className="text-right">Snitt forsinkelse</TableHead>
                    <TableHead className="text-right">Forsinket &gt;2m</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bestStops.map((stop, i) => (
                    <TableRow key={stop.stopRef} className={i === 0 ? "bg-green-500/5 font-medium" : ""}>
                      <TableCell>{formatStopName(stop.stopName, stop.stopRef)}</TableCell>
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
      </div>
    </Layout>
  );
}
