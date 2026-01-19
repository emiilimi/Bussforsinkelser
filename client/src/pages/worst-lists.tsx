import Layout from "@/components/layout";
import { getWorstDays, getWorstStops } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CalendarDays, MapPinOff } from "lucide-react";

export default function WorstLists() {
  const worstDays = getWorstDays();
  const worstStops = getWorstStops();

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-destructive flex items-center gap-2">
            <AlertTriangle className="h-8 w-8" /> Hall of Shame
          </h2>
          <p className="text-muted-foreground mt-1">The absolute worst days and locations for commuters in Vestland.</p>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
          {/* Worst Days */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-muted-foreground" />
                Worst Days (Bergen)
              </CardTitle>
              <CardDescription>Ranked by average delay and cancellation volume.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Avg Delay</TableHead>
                    <TableHead className="text-right">Cancelled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstDays.map((day, i) => (
                    <TableRow key={day.date} className={i === 0 ? "bg-destructive/5 font-medium" : ""}>
                      <TableCell className="font-mono">{day.date}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-normal">{day.reason}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-destructive font-mono">{day.avgDelay}m</TableCell>
                      <TableCell className="text-right font-mono">{day.cancellations}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Worst Stops */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPinOff className="h-5 w-5 text-muted-foreground" />
                Worst Stops
              </CardTitle>
              <CardDescription>Stops with the highest accumulated delay minutes.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stop Name</TableHead>
                    <TableHead className="text-right">Accumulated Delay</TableHead>
                    <TableHead className="text-right">% Delayed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstStops.map((stop, i) => (
                    <TableRow key={stop.name} className={i === 0 ? "bg-orange-500/5 font-medium" : ""}>
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
