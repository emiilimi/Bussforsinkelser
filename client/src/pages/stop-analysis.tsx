import Layout from "@/components/layout";
import { STOPS, getStopStats, Stop } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Check, ChevronsUpDown, MapPin, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

export default function StopAnalysis() {
  const [open, setOpen] = useState(false);
  const [selectedStop, setSelectedStop] = useState<string>("olav_kyrres");
  const stats = getStopStats(selectedStop);

  const selectedStopName = STOPS.find((stop) => stop.id === selectedStop)?.name;

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-8 animate-in slide-in-from-bottom-4 duration-500">
        <div className="space-y-4">
          <h2 className="text-3xl font-bold tracking-tight">Stop Analysis</h2>
          <p className="text-muted-foreground">Detailed breakdown of delays at specific transit hubs.</p>
          
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-[300px] justify-between h-12 text-lg"
              >
                <MapPin className="mr-2 h-4 w-4 opacity-50" />
                {selectedStop ? selectedStopName : "Select stop..."}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0">
              <Command>
                <CommandInput placeholder="Search stop name..." />
                <CommandList>
                  <CommandEmpty>No stop found.</CommandEmpty>
                  <CommandGroup>
                    {STOPS.map((stop) => (
                      <CommandItem
                        key={stop.id}
                        value={stop.id}
                        onSelect={(currentValue) => {
                          setSelectedStop(currentValue === selectedStop ? "" : currentValue);
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedStop === stop.id ? "opacity-100" : "opacity-0"
                          )}
                        />
                        {stop.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {selectedStop && (
          <div className="grid gap-6">
            <div className="grid gap-4 md:grid-cols-3">
               <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Avg Delay</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold font-mono text-destructive">{stats.avgDelay}m</div>
                </CardContent>
               </Card>
               <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Daily Departures</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold font-mono">{stats.departures}</div>
                </CardContent>
               </Card>
               <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Delayed &gt;2m</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold font-mono text-orange-500">{Math.round((stats.delayed / stats.departures) * 100)}%</div>
                </CardContent>
               </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Line Comparison</CardTitle>
                <CardDescription>Average delay by line at {selectedStopName}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart layout="vertical" data={stats.lines} margin={{ left: 40, right: 40 }}>
                      <XAxis type="number" hide />
                      <YAxis 
                        dataKey="name" 
                        type="category" 
                        stroke="hsl(var(--foreground))"
                        fontSize={14}
                        width={150}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip 
                        cursor={{fill: 'hsl(var(--muted))'}}
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                      />
                      <Bar dataKey="avgDelayAtStop" radius={[0, 4, 4, 0]} barSize={30}>
                        {stats.lines.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.avgDelayAtStop > 4 ? "hsl(var(--destructive))" : entry.avgDelayAtStop > 2 ? "hsl(var(--chart-4))" : "hsl(var(--chart-2))"} />
                        ))}
                      </Bar>
                    </BarChart>
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
