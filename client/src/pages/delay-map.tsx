import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card } from "@/components/ui/card";
import { MapContainer, TileLayer, CircleMarker, Popup, ZoomControl, useMap } from "react-leaflet";
import { useEffect } from "react";
import "leaflet/dist/leaflet.css";
import { formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { REGION_MAP_CENTER } from "@/lib/regionCoords";

type MapStop = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number | null;
  pctDelayed2plus: number | null;
  numDepartures: number | null;
  lat: number | null;
  lng: number | null;
};

function ChangeView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => { map.setView(center, zoom); }, [center, zoom, map]);
  return null;
}

const getColor = (delay: number) => {
  if (delay < 1) return "#10b981";
  if (delay < 3) return "#fbbf24";
  return "#ef4444";
};

// Logarithmic radius: stops with few departures get small circles (~0.8),
// busy stops get large circles (up to 10). Based on 7-day departure sum.
const getRadius = (numDepartures: number | null): number => {
  if (!numDepartures || numDepartures <= 0) return 0.8;
  const MIN_R = 0.8;
  const MAX_R = 10;
  // log10(1)=0 → 0.8,  log10(100)=2 → ~5.8,  log10(1000)=3 → ~8.3, capped at 10
  return Math.min(MAX_R, MIN_R + Math.log10(numDepartures) * 3.1);
};

export default function DelayMap() {
  const { region, operator } = useRegion();
  const mapConfig = REGION_MAP_CENTER[region];
  const center: [number, number] = [mapConfig.lat, mapConfig.lng];

  const { data: stops = [], isLoading } = useQuery<MapStop[]>({
    queryKey: [`/api/stops/map?operator=${operator}`],
  });

  const mappableStops = stops.filter((s) => s.lat != null && s.lng != null);

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight">Forsinkelseskart</h2>
          <p className="text-muted-foreground">
            Ukesgjennomsnitt per stopp (siste 7 dager). Sirkelstørrelse viser antall avganger.
            {!isLoading && mappableStops.length > 0 && ` ${mappableStops.length} stopp vist.`}
          </p>
        </div>

        <Card className="overflow-hidden border-2 h-[650px] relative">
          <MapContainer
            center={center}
            zoom={mapConfig.zoom}
            className="w-full h-full z-0"
            zoomControl={false}
          >
            <ChangeView center={center} zoom={mapConfig.zoom} />
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ZoomControl position="bottomright" />
            {mappableStops.map((stop) => (
              <CircleMarker
                key={stop.stopRef}
                center={[stop.lat!, stop.lng!]}
                radius={getRadius(stop.numDepartures)}
                pathOptions={{
                  fillColor: getColor(stop.avgDelayMin ?? 0),
                  fillOpacity: 0.8,
                  color: "white",
                  weight: 1.5,
                }}
              >
                <Popup>
                  <div className="p-1 space-y-1">
                    <h3 className="font-bold border-b pb-1 text-sm">{formatStopName(stop.stopName, stop.stopRef)}</h3>
                    <div className="text-[10px] space-y-1 pt-1">
                      <p className="flex justify-between gap-4">
                        <span>Snitt forsinkelse:</span>
                        <span className="font-bold" style={{ color: getColor(stop.avgDelayMin ?? 0) }}>
                          {stop.avgDelayMin?.toFixed(1) ?? "—"}m
                        </span>
                      </p>
                      {stop.pctDelayed2plus != null && (
                        <p className="flex justify-between gap-4">
                          <span>Forsinket &gt;2m:</span>
                          <span>{stop.pctDelayed2plus.toFixed(0)}%</span>
                        </p>
                      )}
                      {stop.numDepartures != null && (
                        <p className="flex justify-between gap-4">
                          <span>Avganger (7 dager):</span>
                          <span>{stop.numDepartures}</span>
                        </p>
                      )}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>

          <div className="absolute top-4 right-4 bg-card/90 backdrop-blur p-4 rounded-lg border border-border shadow-2xl z-[1000] pointer-events-none">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3">Forsinkelse</p>
            <div className="space-y-2 mb-3">
              <div className="flex items-center gap-3"><div className="w-3 h-3 rounded-full bg-[#10b981]" /><span className="text-xs">&lt; 1 min</span></div>
              <div className="flex items-center gap-3"><div className="w-3 h-3 rounded-full bg-[#fbbf24]" /><span className="text-xs">1 – 3 min</span></div>
              <div className="flex items-center gap-3"><div className="w-3 h-3 rounded-full bg-[#ef4444]" /><span className="text-xs">&gt; 3 min</span></div>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Avganger / uke</p>
            <div className="space-y-2">
              <div className="flex items-center gap-3"><div className="w-2 h-2 rounded-full bg-muted-foreground opacity-60" /><span className="text-xs">&lt; 10</span></div>
              <div className="flex items-center gap-3"><div className="w-3 h-3 rounded-full bg-muted-foreground opacity-60" /><span className="text-xs">~100</span></div>
              <div className="flex items-center gap-3"><div className="w-5 h-5 rounded-full bg-muted-foreground opacity-60" /><span className="text-xs">&gt; 1 000</span></div>
            </div>
          </div>
        </Card>
      </div>
    </Layout>
  );
}
