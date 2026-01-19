import Layout from "@/components/layout";
import { getWorstDays, getWorstStops } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CalendarDays, MapPinOff } from "lucide-react";
import { useRegion } from "@/lib/RegionContext";

export default function WorstLists() {
  const { region } = useRegion();
  const worstDays = getWorstDays();
  const worstStops = getWorstStops(region);

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-destructive flex items-center gap-2">
            <AlertTriangle className="h-8 w-8" /> Hall of Shame: {region.charAt(0).toUpperCase() + region.slice(1)}
          </h2>
          <p className="text-muted-foreground mt-1">The worst performing elements in this region.</p>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-muted-foreground" />
                Worst Days
              </CardTitle>
              <CardDescription>Historical worst dates for punctuality.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Delay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstDays.map((day, i) => (
                    <TableRow key={day.date} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell className="font-mono">{day.date}</TableCell>
                      <TableCell><Badge variant="outline">{day.reason}</Badge></TableCell>
                      <TableCell className="text-right text-destructive font-mono">{day.avgDelay}m</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPinOff className="h-5 w-5 text-muted-foreground" />
                Worst Stops
              </CardTitle>
              <CardDescription>Stops with highest accumulated delay.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stop Name</TableHead>
                    <TableHead className="text-right">Total Delay</TableHead>
                    <TableHead className="text-right">% Delayed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstStops.map((stop, i) => (
                    <TableRow key={`${region}-${stop.name}`} className={i === 0 ? "bg-orange-500/5 font-medium" : ""}>
                      <TableCell>{stop.name}</TableCell>
                      <TableCell className="text-right font-mono text-orange-600">{stop.totalDelayMinutes}m</TableCell>
                      <TableCell className="text-right font-mono">{stop.delayedDeparturesPct}%</TableCell>
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
