import Layout from "@/components/layout";
import { getMapData } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Info, MapPin, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export default function DelayMap() {
  const [fylke, setFylke] = useState("vestland");
  const mapData = getMapData();

  const getColor = (delay: number) => {
    if (delay < 1) return "bg-emerald-500";
    if (delay < 3) return "bg-orange-400";
    return "bg-destructive";
  };

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Delay Map</h2>
            <p className="text-muted-foreground mt-1">Geographical overview of average bus delays via Entur.</p>
          </div>
          
          <Select value={fylke} onValueChange={setFylke}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Select County (Fylke)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vestland">Vestland</SelectItem>
              <SelectItem value="viken">Viken</SelectItem>
              <SelectItem value="oslo">Oslo</SelectItem>
              <SelectItem value="rogaland">Rogaland</SelectItem>
              <SelectItem value="trondelag">Trøndelag</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Data Quality Warning</AlertTitle>
          <AlertDescription>
            Approx. 12% of departures in {fylke.charAt(0).toUpperCase() + fylke.slice(1)} currently lack real-time GPS data. 
            Averages shown may be slightly lower than actual delays.
          </AlertDescription>
        </Alert>

        <Card className="overflow-hidden border-2">
          <CardContent className="p-0 relative bg-slate-100 min-h-[600px] flex items-center justify-center">
            {/* Mock Map Background */}
            <div className="absolute inset-0 opacity-20 grayscale bg-[url('https://www.google.com/maps/vt/pb=!1m4!1m3!1i12!2i2180!3i1245!2m3!1e0!2sm!3i634123456!3m8!2sen!3snw!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e0!5m1!1e0!23i4111425')] bg-cover" />
            
            <div className="relative w-full h-full p-12 grid grid-cols-2 md:grid-cols-4 gap-8">
              {mapData.map((stop) => (
                <div key={stop.id} className="flex flex-col items-center gap-2 group cursor-help">
                  <div className={cn(
                    "w-8 h-8 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-[10px] font-bold text-white transition-transform group-hover:scale-125",
                    getColor(parseFloat(stop.avgDelay))
                  )}>
                    {stop.avgDelay}m
                  </div>
                  <div className="bg-card/90 backdrop-blur px-2 py-1 rounded text-[10px] font-medium shadow-sm border border-border">
                    {stop.name}
                  </div>
                </div>
              ))}
            </div>

            {/* Map Legend */}
            <div className="absolute bottom-4 right-4 bg-card/90 backdrop-blur p-4 rounded-lg border border-border shadow-lg space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Avg Delay Scale</p>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-emerald-500" />
                <span className="text-xs">&lt; 1 min (On time)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-orange-400" />
                <span className="text-xs">1 - 3 min (Minor)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-destructive" />
                <span className="text-xs">&gt; 3 min (Significant)</span>
              </div>
              <div className="mt-4 pt-2 border-t border-border">
                <p className="text-[10px] leading-tight text-muted-foreground">
                  Data quality: <span className="text-emerald-500 font-bold">Good</span><br/>
                  Based on Entur Realtime Siri ET.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5 text-primary" />
                How to connect BigQuery?
              </CardTitle>
            </CardHeader>
            <CardContent className="prose prose-sm dark:prose-invert">
              <p>To connect this frontend to your actual BigQuery data, you would:</p>
              <ol className="text-xs space-y-2 text-muted-foreground">
                <li>Create a backend service (Node.js/Express).</li>
                <li>Install the <code>@google-cloud/bigquery</code> library.</li>
                <li>Set up a Service Account in GCP and download the JSON key.</li>
                <li>Write SQL queries to aggregate the 2.7B rows into small, cached JSON summaries for the frontend.</li>
              </ol>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-primary" />
                Data Reliability
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground leading-relaxed">
                We monitor the "Realtime Coverage" metric. If a bus stop has less than 70% real-time data coverage for a given period, 
                a warning icon is displayed. This ensures that averages aren't skewed by buses that "disappear" from the system 
                when they are most delayed.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
