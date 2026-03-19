import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell } from "recharts";
import { Clock, TrendingUp, Bus, CheckCircle } from "lucide-react";
import { useState } from "react";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";

type DailySummary = {
  date: string;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  totalJourneys: number | null;
  totalCancellations: number | null;
};

type LeaderboardLine = {
  lineRef: string;
  lineName: string | null;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  totalDepartures: number | null;
};

const PERIOD_DAYS: Record<string, number> = { week: 7, month: 30, year: 365 };

export default function Dashboard() {
  const [period, setPeriod] = useState("week");
  const { region, operator } = useRegion();
  const days = PERIOD_DAYS[period];

  const { data: summary } = useQuery<DailySummary>({ queryKey: ["/api/summary"] });
  const { data: trend = [] } = useQuery<DailySummary[]>({
    queryKey: [`/api/summary/trend?days=${days}`],
  });
  const { data: worstLines = [] } = useQuery<LeaderboardLine[]>({
    queryKey: [`/api/leaderboard/lines?type=worst&period=${period}&operator=${operator}`],
  });

  const trendData = trend.map((r) => ({
    date: r.date.slice(5),
    avgDelay: r.avgDelayMin ?? 0,
  }));

  const topWorst = worstLines.slice(0, 5);

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Oversikt — {REGION_LABEL[region]}</h2>
            <p className="text-muted-foreground mt-1">
              Forsinkelsesstatistikk for siste {days} dager
            </p>
          </div>

          <Tabs value={period} onValueChange={setPeriod} className="w-[300px]">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="week">Uke</TabsTrigger>
              <TabsTrigger value="month">Måned</TabsTrigger>
              <TabsTrigger value="year">År</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Snitt forsinkelse</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {summary?.avgDelayMin != null ? `${summary.avgDelayMin.toFixed(1)}m` : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Siste tilgjengelige dag</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-emerald-500 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Andel i rute</CardTitle>
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {summary?.pctOnTime != null ? `${summary.pctOnTime.toFixed(1)}%` : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Avganger &lt; 2 min forsinkelse</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-orange-500 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Dårligste linje</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {worstLines[0]?.lineName ?? "—"}
              </div>
              <p className="text-xs text-destructive mt-1">
                {worstLines[0]?.avgDelayMin != null
                  ? `+${worstLines[0].avgDelayMin.toFixed(1)}m snitt`
                  : ""}
              </p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-primary/50 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Totale avganger</CardTitle>
              <Bus className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {summary?.totalJourneys != null
                  ? summary.totalJourneys.toLocaleString("nb-NO")
                  : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Siste tilgjengelige dag</p>
            </CardContent>
          </Card>
        </div>

        {summary?.date && (
          <DataQualityBanner date={summary.date} operator={operator} />
        )}

        <div className="grid gap-4 md:grid-cols-7">
          <Card className="col-span-4 shadow-sm">
            <CardHeader>
              <CardTitle>Forsinkelse over tid</CardTitle>
              <CardDescription>Gjennomsnittlig forsinkelse per dag.</CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData}>
                    <defs>
                      <linearGradient id="colorDelay" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                      formatter={(v: number) => [`${v.toFixed(2)}m`, "Snitt forsinkelse"]}
                    />
                    <Area type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={2} fillOpacity={1} fill="url(#colorDelay)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="col-span-3 shadow-sm">
            <CardHeader>
              <CardTitle>Dårligste linjer — {REGION_LABEL[region]}</CardTitle>
              <CardDescription>Linjer med høyest gjennomsnittlig forsinkelse.</CardDescription>
            </CardHeader>
            <CardContent>
              {topWorst.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">Ingen data for valgt region</p>
              ) : (
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart layout="vertical" data={topWorst} margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                      <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                      <YAxis dataKey="lineName" type="category" stroke="hsl(var(--muted-foreground))" fontSize={11} width={130} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: number) => [`${v.toFixed(2)}m`, "Snitt forsinkelse"]}
                      />
                      <Bar dataKey="avgDelayMin" radius={[0, 4, 4, 0]} barSize={24}>
                        {topWorst.map((entry, index) => (
                          <Cell
                            key={index}
                            fill={
                              (entry.avgDelayMin ?? 0) > 5
                                ? "hsl(var(--destructive))"
                                : (entry.avgDelayMin ?? 0) > 2
                                ? "hsl(var(--chart-4))"
                                : "hsl(var(--chart-2))"
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
