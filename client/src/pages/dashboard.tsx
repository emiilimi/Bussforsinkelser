import Layout from "@/components/layout";
import { getGeneralStats, getWeeklyDelayTrend, getWorstJourneyData } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line } from "recharts";
import { ArrowUpRight, ArrowDownRight, Clock, AlertTriangle, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useRegion } from "@/lib/RegionContext";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const [period, setPeriod] = useState("week");
  const { region } = useRegion();
  const stats = getGeneralStats(period, region);
  const trendData = getWeeklyDelayTrend(region);
  const worstJourneyPoints = getWorstJourneyData();

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Overview: {region.charAt(0).toUpperCase() + region.slice(1)}</h2>
            <p className="text-muted-foreground mt-1">Regional performance analysis for the {period}.</p>
          </div>
          
          <Tabs value={period} onValueChange={setPeriod} className="w-[300px]">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="week">Week</TabsTrigger>
              <TabsTrigger value="month">Month</TabsTrigger>
              <TabsTrigger value="year">Year</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Avg Delay</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{stats.avgDelay}m</div>
              <p className="text-xs text-muted-foreground mt-1">Regional Average</p>
            </CardContent>
          </Card>
          
          <Card className="border-l-4 border-l-destructive shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Reliability</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {stats.dataValidityScore}%
              </div>
              <p className="text-xs text-muted-foreground mt-1">Real-time data coverage</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-orange-500 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Worst Line</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.worstLine.name}</div>
              <p className="text-xs text-muted-foreground mt-1 text-destructive">
                +{stats.worstLine.avgDelay.toFixed(1)}m avg delay
              </p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-emerald-500 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Status</CardTitle>
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">Stable</div>
              <p className="text-xs text-muted-foreground mt-1">System operational</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-7">
          <Card className="col-span-4 shadow-sm">
            <CardHeader>
              <CardTitle>Delay Trend</CardTitle>
              <CardDescription>Average delay progression over time.</CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData}>
                    <defs>
                      <linearGradient id="colorDelay" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.1}/>
                        <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${value.toFixed(1)}m`} />
                    <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }} />
                    <Area type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={2} fillOpacity={1} fill="url(#colorDelay)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="col-span-3 shadow-sm">
            <CardHeader>
              <CardTitle>Journey Progression</CardTitle>
              <CardDescription>Delay accumulation throughout a route.</CardDescription>
            </CardHeader>
            <CardContent>
               <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={worstJourneyPoints}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="stopName" hide />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `${Math.round(value/60)}m`} />
                    <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }} />
                    <Line type="stepAfter" dataKey="delaySeconds" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
