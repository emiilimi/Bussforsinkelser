import { useQuery } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapContainer, TileLayer, CircleMarker, Popup, ZoomControl, useMap, useMapEvents } from "react-leaflet";
import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { Link } from "wouter";
import "leaflet/dist/leaflet.css";
import type { LatLngBounds } from "leaflet";
import { formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { REGION_MAP_CENTER } from "@/lib/regionCoords";
import { TimeWindowPicker, type TimeWindow, windowToQuery } from "@/components/time-window-picker";
import { IS_REISE } from "@/lib/app-mode";

type MapStop = {
  stopRef: string;
  stopName: string | null;
  avgDelayMin: number | null;
  pctDelayed2plus: number | null;
  numDepartures: number | null;
  lat: number | null;
  lng: number | null;
};

/** Only recenters when the region actually changes */
function RegionRecenter({ region }: { region: string }) {
  const map = useMap();
  const prevRegion = useRef(region);
  useEffect(() => {
    if (region !== prevRegion.current) {
      const cfg = REGION_MAP_CENTER[region as keyof typeof REGION_MAP_CENTER];
      if (cfg) map.setView([cfg.lat, cfg.lng], cfg.zoom);
      prevRegion.current = region;
    }
  }, [region, map]);
  return null;
}

/** Tracks map bounds for viewport-based filtering */
function BoundsTracker({ onBoundsChange }: { onBoundsChange: (b: LatLngBounds) => void }) {
  const map = useMap();

  // Set initial bounds
  useEffect(() => {
    onBoundsChange(map.getBounds());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useMapEvents({
    moveend: () => onBoundsChange(map.getBounds()),
    zoomend: () => onBoundsChange(map.getBounds()),
  });
  return null;
}

const getColor = (delay: number) => {
  if (delay < 1)  return "#10b981";
  if (delay < 3)  return "#fbbf24";
  if (delay < 5)  return "#f97316";
  if (delay < 10) return "#ef4444";
  return "#991b1b";
};

const getRadius = (numDepartures: number | null): number => {
  if (!numDepartures || numDepartures <= 0) return 0.8;
  const MIN_R = 0.8;
  const MAX_R = 10;
  return Math.min(MAX_R, MIN_R + Math.log10(numDepartures) * 3.1);
};

type TimePreset = { label: string; hourMin?: number; hourMax?: number };
const TIME_PRESETS: TimePreset[] = [
  { label: "Hele dagen" },
  { label: "Morgenrush (7–9)", hourMin: 7, hourMax: 9 },
  { label: "Formiddag (9–15)", hourMin: 9, hourMax: 15 },
  { label: "Ettermiddagsrush (15–17)", hourMin: 15, hourMax: 17 },
  { label: "Ettermiddag (17–19)", hourMin: 17, hourMax: 19 },
  { label: "Kveld (19–23)", hourMin: 19, hourMax: 23 },
  { label: "Natt (23–4)", hourMin: 23, hourMax: 4 },
  { label: "Tidlig morgen (4–7)", hourMin: 4, hourMax: 7 },
];

type DayFilter = "all" | "weekday" | "weekend";
const DAY_LABELS: Record<DayFilter, string> = { all: "Alle dager", weekday: "Ukedager", weekend: "Helg" };


export default function DelayMap() {
  const { region, operators } = useRegion();
  const mapConfig = REGION_MAP_CENTER[region];
  const center: [number, number] = [mapConfig.lat, mapConfig.lng];

  const [dayType, setDayType] = useState<DayFilter>("all");
  const [timePreset, setTimePreset] = useState<TimePreset>(TIME_PRESETS[0]);
  const [window, setWindow] = useState<TimeWindow>({ kind: "preset", days: 7, label: "Siste uke" });
  const [showFilters, setShowFilters] = useState(false);
  const [bounds, setBounds] = useState<LatLngBounds | null>(null);

  const wq = windowToQuery(window);
  const queryParams = new URLSearchParams(
    operators.length ? { operator: operators.join(",") } : {},
  );
  if (dayType !== "all") queryParams.set("dayType", dayType);
  if (timePreset.hourMin != null) queryParams.set("hourMin", String(timePreset.hourMin));
  if (timePreset.hourMax != null) queryParams.set("hourMax", String(timePreset.hourMax));
  // Pass time-window to /api/stops/map. That endpoint uses "windowDays" not "days".
  wq.split("&").filter(Boolean).forEach((kv) => {
    const [k, v] = kv.split("=");
    if (!k || !v) return;
    // Map endpoint uses windowDays; from/to not yet supported server-side, fallback to days
    if (k === "days") queryParams.set("windowDays", v);
    else if (k === "from" || k === "to") { /* custom range not supported by map backend yet */ }
    else queryParams.set(k, v);
  });

  const { data: stops = [], isLoading, isError, error } = useQuery<MapStop[]>({
    queryKey: [`/api/stops/map?${queryParams.toString()}`],
  });

  const mappableStops = useMemo(
    () => stops.filter((s) => s.lat != null && s.lng != null),
    [stops],
  );

  // Ved lav zoom kan viewporten inneholde titusenvis av stopp — hver markør
  // er en React-komponent med event handlers, og det knekker mobiler. Cap:
  // vis de N travleste (flest avganger); zoom inn for å se resten.
  const MAX_MARKERS = 1500;

  // Filter to only stops in the current viewport (with a small padding)
  const { visibleStops, capped } = useMemo(() => {
    let inView = mappableStops;
    if (bounds) {
      const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.1;
      const padLng = (bounds.getEast() - bounds.getWest()) * 0.1;
      const south = bounds.getSouth() - padLat;
      const north = bounds.getNorth() + padLat;
      const west = bounds.getWest() - padLng;
      const east = bounds.getEast() + padLng;
      inView = mappableStops.filter(
        (s) => s.lat! >= south && s.lat! <= north && s.lng! >= west && s.lng! <= east,
      );
    }
    if (inView.length <= MAX_MARKERS) {
      return { visibleStops: inView, capped: false };
    }
    const top = [...inView]
      .sort((a, b) => (b.numDepartures ?? 0) - (a.numDepartures ?? 0))
      .slice(0, MAX_MARKERS);
    return { visibleStops: top, capped: true };
  }, [mappableStops, bounds]);

  const handleBoundsChange = useCallback((b: LatLngBounds) => setBounds(b), []);

  const hasActiveFilters = dayType !== "all" || timePreset.hourMin != null || window.kind !== "preset" || (window.kind === "preset" && window.days !== 7);
  const windowLabel = window.kind === "preset" ? window.label.toLowerCase() : `${window.from} – ${window.to}`;

  return (
    <Layout>
      <div className="space-y-4 animate-in fade-in duration-500">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight">Forsinkelseskart</h2>
          <p className="text-muted-foreground text-sm">
            Gjennomsnitt per stopp ({windowLabel}).
            {hasActiveFilters && (
              <span className="text-primary font-medium">
                {" "}Filtrert: {DAY_LABELS[dayType]}, {timePreset.label}.
              </span>
            )}
            {!isLoading && mappableStops.length > 0 && (
              <> {visibleStops.length.toLocaleString("nb-NO")} av {mappableStops.length.toLocaleString("nb-NO")} stopp synlige.
                {capped && <span className="text-amber-600"> Viser de {visibleStops.length.toLocaleString("nb-NO")} travleste — zoom inn for å se alle.</span>}
              </>
            )}
          </p>
        </div>

        {/* Filter toggle */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className="h-8 text-xs"
        >
          {showFilters ? "Skjul filter" : "Vis filter"}
          {hasActiveFilters && " ●"}
        </Button>

        {showFilters && (
          <div className="grid gap-3 md:grid-cols-3 p-4 bg-muted/50 rounded-lg border">
            {/* Day type */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Dag</p>
              <div className="flex flex-wrap gap-1.5">
                {(["all", "weekday", "weekend"] as DayFilter[]).map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={dayType === d ? "default" : "outline"}
                    onClick={() => setDayType(d)}
                    className="h-7 px-3 text-xs"
                  >
                    {DAY_LABELS[d]}
                  </Button>
                ))}
              </div>
            </div>

            {/* Time of day */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Tid på dagen</p>
              <div className="flex flex-wrap gap-1.5">
                {TIME_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    variant={timePreset.label === preset.label ? "default" : "outline"}
                    onClick={() => setTimePreset(preset)}
                    className="h-7 px-2.5 text-xs"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Time window */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Tidsperiode</p>
              {/* Kart-endepunktet støtter kun hele dagsvinduer (windowDays) —
                  egendefinert datointervall ville stille blitt ignorert.
                  Reise-artefakten har dessuten bare 7/30/90-vinduer. */}
              <TimeWindowPicker
                value={window}
                onChange={setWindow}
                allowCustom={false}
                presetDays={IS_REISE ? [7, 30, 90] : undefined}
              />
            </div>
          </div>
        )}

        <Card className="overflow-hidden border-2 h-[600px] relative">
          <MapContainer
            center={center}
            zoom={mapConfig.zoom}
            className="w-full h-full z-0"
            zoomControl={false}
            // Canvas-renderer: CircleMarkers tegnes på ett canvas i stedet
            // for tusenvis av individuelle SVG-DOM-noder — stor mobilgevinst.
            preferCanvas
          >
            <RegionRecenter region={region} />
            <BoundsTracker onBoundsChange={handleBoundsChange} />
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ZoomControl position="bottomright" />
            {visibleStops.map((stop) => (
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
                          <span>Avganger:</span>
                          <span>{stop.numDepartures.toLocaleString("nb-NO")}</span>
                        </p>
                      )}
                    </div>
                    <Link
                      href={`/stops?stop=${encodeURIComponent(stop.stopRef)}&name=${encodeURIComponent(formatStopName(stop.stopName, stop.stopRef))}`}
                      className="block text-center text-[10px] text-primary hover:underline mt-2 pt-1 border-t border-border"
                    >
                      Se stoppstedsanalyse →
                    </Link>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>

          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 bg-background/50 backdrop-blur-sm flex items-center justify-center z-[500]">
              <div className="text-sm text-muted-foreground animate-pulse">Laster stopp...</div>
            </div>
          )}

          {/* Error overlay */}
          {isError && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1100] bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-4 py-2 rounded-md shadow-lg max-w-md">
              <p className="text-sm text-red-700 dark:text-red-300">
                Kunne ikke laste stopp-data. {error instanceof Error ? error.message : ""}
              </p>
            </div>
          )}

          <div className="absolute top-4 right-4 bg-card/90 backdrop-blur p-3 rounded-lg border border-border shadow-2xl z-[1000] pointer-events-none">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Forsinkelse</p>
            <div className="space-y-1.5 mb-2">
              <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-[#10b981]" /><span className="text-[10px]">&lt; 1 min</span></div>
              <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-[#fbbf24]" /><span className="text-[10px]">1 – 3 min</span></div>
              <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-[#f97316]" /><span className="text-[10px]">3 – 5 min</span></div>
              <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-[#ef4444]" /><span className="text-[10px]">5 – 10 min</span></div>
              <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-[#991b1b]" /><span className="text-[10px]">&gt; 10 min</span></div>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Størrelse</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-muted-foreground opacity-60" /><span className="text-[10px]">&lt; 10 avg</span></div>
              <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-muted-foreground opacity-60" /><span className="text-[10px]">~100 avg</span></div>
              <div className="flex items-center gap-2"><div className="w-4 h-4 rounded-full bg-muted-foreground opacity-60" /><span className="text-[10px]">&gt; 1 000 avg</span></div>
            </div>
          </div>
        </Card>
      </div>
    </Layout>
  );
}
