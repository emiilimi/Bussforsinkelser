import Layout from "@/components/layout";
import { getGeneralStats, getWeeklyDelayTrend, getWorstJourneyData } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line } from "recharts";
import { ArrowUpRight, ArrowDownRight, Clock, AlertTriangle, TrendingUp } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const [period, setPeriod] = useState("week");
  const stats = getGeneralStats(period);
  const trendData = getWeeklyDelayTrend();
  const worstJourneyPoints = getWorstJourneyData();

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Overview</h2>
            <p className="text-muted-foreground mt-1">Real-time pulse of Vestland public transit performance.</p>
          </div>
          
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select period" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Past Week</SelectItem>
              <SelectItem value="month">Past Month</SelectItem>
              <SelectItem value="year">Past Year</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Key Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Avg Delay</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{stats.avgDelay}m</div>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <span className="text-destructive flex items-center"><ArrowUpRight className="w-3 h-3" /> +12%</span> from last week
              </p>
            </CardContent>
          </Card>
          
          <Card className="border-l-4 border-l-destructive shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Delayed &gt;2m</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {Math.round((stats.delayedDepartures / stats.totalDepartures) * 100)}%
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.delayedDepartures} total departures
              </p>
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
                +{stats.worstLine.avgDelay}m avg delay
              </p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-emerald-500 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Most Reliable</CardTitle>
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.bestLine.name}</div>
              <p className="text-xs text-muted-foreground mt-1 text-emerald-600">
                Only {stats.bestLine.avgDelay}m avg delay
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Charts Section */}
        <div className="grid gap-4 md:grid-cols-7">
          {/* Main Trend Chart */}
          <Card className="col-span-4 shadow-sm">
            <CardHeader>
              <CardTitle>Delay Trend</CardTitle>
              <CardDescription>Average delay per day over the selected period.</CardDescription>
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
                    <XAxis 
                      dataKey="date" 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false}
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                      tickFormatter={(value) => `${value}m`}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="avgDelay" 
                      stroke="hsl(var(--destructive))" 
                      strokeWidth={2}
                      fillOpacity={1} 
                      fill="url(#colorDelay)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Worst Journey Chart */}
          <Card className="col-span-3 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Worst Journey</span>
                <span className="text-xs font-mono bg-destructive/10 text-destructive px-2 py-1 rounded">Line 6 • 16:15</span>
              </CardTitle>
              <CardDescription>Delay accumulation throughout the route.</CardDescription>
            </CardHeader>
            <CardContent>
               <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={worstJourneyPoints}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="stopName" 
                      hide
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                      tickFormatter={(value) => `${value/60}m`}
                    />
                    <Tooltip 
                      labelStyle={{ color: 'hsl(var(--foreground))' }}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                      formatter={(value: number) => [`${Math.round(value/60)}m`, 'Delay']}
                    />
                    <Line 
                      type="stepAfter" 
                      dataKey="delaySeconds" 
                      stroke="hsl(var(--destructive))" 
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 text-xs text-muted-foreground text-center font-mono">
                Start: Birkelundstoppen → End: Lyngbø
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
