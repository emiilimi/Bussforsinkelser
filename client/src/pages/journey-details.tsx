import Layout from "@/components/layout";
import { LINES, getJourneyStats } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Clock, Search, Timer, AlertCircle } from "lucide-react";
import { useRegion } from "@/lib/RegionContext";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";

export default function JourneyDetails() {
  const { region } = useRegion();
  const [selectedLine, setSelectedLine] = useState("6");
  const [time, setTime] = useState("16:15");
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<any>(null);

  const handleSearch = () => {
    setStats(getJourneyStats(selectedLine, time));
    setShowStats(true);
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Journey Check: {region.charAt(0).toUpperCase() + region.slice(1)}</h2>
          <p className="text-muted-foreground mt-1">Investigate specific regional scheduled departures.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Lookup Journey</CardTitle>
            <CardDescription>Select a line and departure time to see historical performance in {region}.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-4 items-end">
              <div className="grid gap-2 flex-1">
                <label className="text-sm font-medium">Line</label>
                <Select value={selectedLine} onValueChange={setSelectedLine}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select line" />
                  </SelectTrigger>
                  <SelectContent>
                    {LINES.map(line => (
                      <SelectItem key={line.id} value={line.id}>{line.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2 flex-1">
                <label className="text-sm font-medium">Departure Time</label>
                <Input 
                  type="time" 
                  value={time} 
                  onChange={(e) => setTime(e.target.value)}
                  className="block"
                />
              </div>
              <Button onClick={handleSearch} className="w-full md:w-auto">
                <Search className="mr-2 h-4 w-4" /> Analyze
              </Button>
            </div>
          </CardContent>
        </Card>

        {showStats && stats && (
          <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Historical Avg Delay</CardTitle>
                  <Timer className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold font-mono ${parseFloat(stats.avgDelay) > 5 ? "text-destructive" : "text-foreground"}`}>
                    {stats.avgDelay}m
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Punctuality Score</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-emerald-600">{stats.punctuality}%</div>
                </CardContent>
              </Card>
               <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Risk Level</CardTitle>
                  <AlertCircle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono">
                    {parseFloat(stats.avgDelay) > 7 ? "HIGH" : parseFloat(stats.avgDelay) > 3 ? "MEDIUM" : "LOW"}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Typical Delay Progression</CardTitle>
                <CardDescription>How delay typically accumulates on this specific journey in {region}.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stats.trend}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="stopName" hide />
                      <YAxis 
                        tickFormatter={(val) => `${Math.round(val/60)}m`} 
                        stroke="hsl(var(--muted-foreground))"
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip 
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                        formatter={(val: number) => [`${Math.round(val/60)}m`, "Delay"]}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="delaySeconds" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
