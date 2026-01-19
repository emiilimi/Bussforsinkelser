import Layout from "@/components/layout";
import { getMapData } from "@/lib/mockData";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { useRegion } from "@/lib/RegionContext";
import { MapContainer, TileLayer, CircleMarker, Popup, ZoomControl } from "react-leaflet";
import "leaflet/dist/leaflet.css";

export default function DelayMap() {
  const { region } = useRegion();
  const mapData = getMapData();

  // Region centers (mockup)
  const regionCenters: Record<string, [number, number]> = {
    vestland: [60.3913, 5.3221],
    viken: [59.9139, 10.7522],
    oslo: [59.9139, 10.7522],
    rogaland: [58.9700, 5.7331],
    trondelag: [63.4305, 10.3951],
  };

  const center = regionCenters[region] || regionCenters.vestland;

  const getColor = (delay: number) => {
    if (delay < 1) return "#10b981";
    if (delay < 3) return "#fbbf24";
    return "#ef4444";
  };

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight">Delay Map</h2>
          <p className="text-muted-foreground">Stop-level delay visualization for {region.charAt(0).toUpperCase() + region.slice(1)} via OpenStreetMap.</p>
        </div>

        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Data Validity Warning</AlertTitle>
          <AlertDescription>
            Approx. 12% of departures in this region currently lack real-time data. Reliability score: 88%.
          </AlertDescription>
        </Alert>

        <Card className="overflow-hidden border-2 h-[650px] relative">
          <MapContainer 
            center={center} 
            zoom={13} 
            className="w-full h-full z-0"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ZoomControl position="bottomright" />
            
            {mapData.map((stop) => (
              <CircleMarker
                key={stop.id}
                center={[stop.lat, stop.lng]}
                radius={12}
                pathOptions={{
                  fillColor: getColor(parseFloat(stop.avgDelay)),
                  fillOpacity: 0.8,
                  color: "white",
                  weight: 2,
                }}
              >
                <Popup className="custom-popup">
                  <div className="p-2 space-y-1">
                    <h3 className="font-bold border-b pb-1">{stop.name}</h3>
                    <div className="text-xs space-y-1 pt-1">
                      <p className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Avg Delay:</span>
                        <span className="font-mono font-bold" style={{ color: getColor(parseFloat(stop.avgDelay)) }}>
                          {stop.avgDelay}m
                        </span>
                      </p>
                      <p className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Data Quality:</span>
                        <span className="font-mono">{stop.dataQuality}%</span>
                      </p>
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>

          {/* Map Overlay Legend */}
          <div className="absolute top-4 right-4 bg-card/90 backdrop-blur p-4 rounded-lg border border-border shadow-2xl z-[1000] pointer-events-none">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3">Delay Scale</p>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#10b981]" />
                <span className="text-xs">&lt; 1 min</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#fbbf24]" />
                <span className="text-xs">1 - 3 min</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-[#ef4444]" />
                <span className="text-xs">&gt; 3 min</span>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </Layout>
  );
}
