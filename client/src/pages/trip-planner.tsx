import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import Layout from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Navigation, Search, Clock, ArrowRight, AlertTriangle, CheckCircle,
  ArrowDown, ChevronDown, ChevronUp, Footprints, Bus, Train, Ship,
  Accessibility, ArrowDownUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StopSearchResult = {
  stopRef: string;
  stopPlaceRef: string | null;
  stopName: string;
  label?: string;       // full label from geocoder (e.g. "Bryggen, Bergen")
  layer?: string;       // "venue" | "address" | "street" etc.
  lat: number | null;
  lng: number | null;
  quayCount?: number;
};

type TripLeg = {
  mode: string;
  transportSubmode: string | null;
  fromPlace: { name: string; quay: { id: string; name: string } | null };
  toPlace: { name: string; quay: { id: string; name: string } | null };
  line: { id: string; publicCode: string; name: string } | null;
  expectedStartTime: string;
  expectedEndTime: string;
  duration: number;
  distance: number;
  intermediateQuays: Array<{ id: string; name: string }>;
  serviceJourney: { id: string } | null;
};

type TripPattern = {
  expectedStartTime: string;
  expectedEndTime: string;
  duration: number;
  legs: TripLeg[];
};

type TripStopStat = {
  stopRef: string;
  lineRef: string;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<string, string> = {
  bus: "Buss",
  tram: "Trikk",
  rail: "Tog",
  metro: "T-bane",
  water: "Båt",
  coach: "Ekspressbuss",
  foot: "Gange",
  bicycle: "Sykkel",
  scooter_rental: "Elsparkesykkel",
};

const MODE_ICONS: Record<string, typeof Bus> = {
  bus: Bus,
  tram: Train,
  rail: Train,
  metro: Train,
  water: Ship,
  coach: Bus,
  foot: Footprints,
};

// We only have delay data for bus (Skyss). Other modes show "ingen data".
const MODES_WITH_DELAY_DATA = new Set(["bus"]);

const TRANSPORT_MODE_OPTIONS = [
  { value: "bus", label: "Buss" },
  { value: "tram", label: "Trikk" },
  { value: "rail", label: "Tog" },
  { value: "metro", label: "T-bane" },
  { value: "water", label: "Båt/ferje" },
  { value: "coach", label: "Ekspressbuss" },
];

const WALK_SPEED_OPTIONS = [
  { value: "0.8", label: "Rolig (3 km/t)" },
  { value: "1.33", label: "Normal (4.8 km/t)" },
  { value: "1.8", label: "Rask (6.5 km/t)" },
  { value: "2.5", label: "Jogger (9 km/t)" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}t ${m % 60}min`;
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

function ModeIcon({ mode, className }: { mode: string; className?: string }) {
  const Icon = MODE_ICONS[mode] ?? Bus;
  return <Icon className={className} />;
}

function delayBadge(delay: number | null, hasData: boolean) {
  if (!hasData) return <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">ingen data</Badge>;
  if (delay == null) return null;
  if (Math.abs(delay) < 1) return <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">i rute</Badge>;
  if (delay < 3) return <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">+{delay.toFixed(1)}m</Badge>;
  return <Badge variant="destructive" className="text-[10px]">+{delay.toFixed(1)}m</Badge>;
}

function transferChance(arrivalDelay: number | null, bufferMinutes: number): string | null {
  if (arrivalDelay == null) return null;
  const margin = bufferMinutes - arrivalDelay;
  if (margin > 3) return "Trygg overgang";
  if (margin > 1) return "Sannsynlig";
  if (margin > 0) return "Usikker";
  return "Risikabel";
}

function transferColor(arrivalDelay: number | null, bufferMinutes: number): string {
  if (arrivalDelay == null) return "text-muted-foreground";
  const margin = bufferMinutes - arrivalDelay;
  if (margin > 3) return "text-green-600";
  if (margin > 1) return "text-amber-600";
  return "text-destructive";
}

/** Round to nearest 5 minutes for time input */
function roundedNow(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Geocoder result type
// ---------------------------------------------------------------------------

type GeocoderResult = {
  id: string;
  name: string;
  label: string;
  layer: string;
  lat: number;
  lng: number;
};

// ---------------------------------------------------------------------------
// Stop / address search with debounce — uses Entur Geocoder API
// ---------------------------------------------------------------------------

function StopSearch({
  label,
  value,
  onSelect,
}: {
  label: string;
  value: StopSearchResult | null;
  onSelect: (stop: StopSearchResult) => void;
}) {
  const [query, setQuery] = useState(value?.stopName ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [] } = useQuery<GeocoderResult[]>({
    queryKey: [`/api/geocoder/autocomplete?text=${encodeURIComponent(debouncedQuery)}&size=8`],
    enabled: debouncedQuery.length >= 2 && open,
  });

  function toStopSearchResult(r: GeocoderResult): StopSearchResult {
    // "venue" layer = NSR stop (StopPlace or Quay)
    const isStop = r.layer === "venue" && r.id.startsWith("NSR:");
    return {
      stopRef: isStop ? r.id : `coords:${r.lat},${r.lng}`,
      stopPlaceRef: isStop ? r.id : null,
      stopName: r.name,
      label: r.label,
      layer: r.layer,
      lat: r.lat,
      lng: r.lng,
    };
  }

  const layerIcon = (layer: string) => {
    if (layer === "venue") return "\u{1F68F}"; // bus stop emoji
    return "\u{1F4CD}"; // pin emoji
  };

  return (
    <div className="relative">
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          placeholder="Stoppested eller adresse..."
          className="pl-9"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-start gap-2"
              onMouseDown={(e) => {
                e.preventDefault();
                const stop = toStopSearchResult(r);
                setQuery(r.name);
                setOpen(false);
                onSelect(stop);
              }}
            >
              <span className="text-xs mt-0.5 flex-shrink-0">{layerIcon(r.layer)}</span>
              <span>
                <span className="block">{r.name}</span>
                {r.label !== r.name && (
                  <span className="block text-xs text-muted-foreground">{r.label}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trip result card
// ---------------------------------------------------------------------------

function TripCard({
  pattern,
  index,
  stats,
}: {
  pattern: TripPattern;
  index: number;
  stats: Map<string, TripStopStat>;
}) {
  const [expanded, setExpanded] = useState(index === 0);

  return (
    <Card className={cn("transition-all", index === 0 && "border-primary/50")}>
      <div
        className="cursor-pointer p-4 pb-3"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold font-mono">
              {formatTime(pattern.expectedStartTime)}
            </span>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <span className="text-lg font-bold font-mono">
              {formatTime(pattern.expectedEndTime)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {formatDuration(pattern.duration)}
            </Badge>
            {expanded
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />
            }
          </div>
        </div>
        {/* Compact line summary with mode icons */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {pattern.legs.map((leg, i) => (
            <Badge key={i} variant="outline" className="text-xs gap-1">
              <ModeIcon mode={leg.mode} className="h-3 w-3" />
              {leg.line?.publicCode
                ? `${leg.line.publicCode}`
                : modeLabel(leg.mode)
              }
            </Badge>
          ))}
        </div>
      </div>

      {expanded && (
        <CardContent className="pt-0 space-y-3">
          {pattern.legs.map((leg, legIdx) => {
            const lineRef = leg.line?.id ?? "";
            const hasDelayData = MODES_WITH_DELAY_DATA.has(leg.mode) && !!lineRef;

            // All quay stops in this leg
            const allStops = [
              leg.fromPlace.quay,
              ...leg.intermediateQuays.map((q) => ({ id: q.id, name: q.name })),
              leg.toPlace.quay,
            ].filter(Boolean) as Array<{ id: string; name: string }>;

            // Transfer analysis between this leg and next
            const nextLeg = pattern.legs[legIdx + 1];
            let transferInfo: { buffer: number; chance: string | null; color: string } | null = null;
            if (nextLeg && nextLeg.mode !== "foot") {
              // Only show transfer analysis for transit→transit (not transit→walking)
              const arrivalTime = new Date(leg.expectedEndTime).getTime();
              const departureTime = new Date(nextLeg.expectedStartTime).getTime();
              const bufferMin = (departureTime - arrivalTime) / 60000;
              if (bufferMin > 0) {
                const arrQuay = leg.toPlace.quay?.id ?? "";
                const statKey = `${arrQuay}|${lineRef}`;
                const arrStat = stats.get(statKey);
                const chance = hasDelayData
                  ? transferChance(arrStat?.avgDelayArrivalMin ?? null, bufferMin)
                  : null;
                const color = hasDelayData
                  ? transferColor(arrStat?.avgDelayArrivalMin ?? null, bufferMin)
                  : "text-muted-foreground";
                transferInfo = { buffer: bufferMin, chance, color };
              }
            }

            // Walking leg — compact display
            if (leg.mode === "foot") {
              const distM = Math.round(leg.distance || 0);
              return (
                <div key={legIdx} className="flex items-center gap-2 py-1.5 px-3 text-xs text-muted-foreground">
                  <Footprints className="h-3 w-3" />
                  <span>
                    Gå {distM > 0 ? `${distM}m` : ""} til {leg.toPlace.name}
                    {leg.duration > 0 && ` (${Math.round(leg.duration / 60)} min)`}
                  </span>
                </div>
              );
            }

            return (
              <div key={legIdx}>
                <div className="border rounded-lg p-3 bg-muted/20">
                  {/* Leg header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <ModeIcon mode={leg.mode} className="h-4 w-4 text-primary" />
                      {leg.line?.publicCode ? (
                        <Badge className="text-xs font-mono">{leg.line.publicCode}</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">{modeLabel(leg.mode)}</Badge>
                      )}
                      {leg.line?.name && (
                        <span className="text-xs text-muted-foreground truncate max-w-48">{leg.line.name}</span>
                      )}
                      {!hasDelayData && (
                        <span className="text-[9px] text-muted-foreground/60 italic">ingen forsinkelsesdata</span>
                      )}
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatTime(leg.expectedStartTime)} – {formatTime(leg.expectedEndTime)}
                    </span>
                  </div>

                  {/* Stops along leg */}
                  <div className="space-y-1 ml-2">
                    {allStops.map((stop, stopIdx) => {
                      const statKey = `${stop.id}|${lineRef}`;
                      const stat = stats.get(statKey);
                      const isFirst = stopIdx === 0;
                      const isLast = stopIdx === allStops.length - 1;

                      return (
                        <div key={stop.id + stopIdx} className="flex items-center gap-2 text-xs">
                          <div className={cn(
                            "w-2 h-2 rounded-full flex-shrink-0",
                            isFirst || isLast ? "bg-primary" : "bg-muted-foreground/40"
                          )} />
                          <span className={cn(
                            "flex-1",
                            (isFirst || isLast) ? "font-medium" : "text-muted-foreground"
                          )}>
                            {stop.name}
                          </span>
                          {(isFirst || isLast) && hasDelayData && delayBadge(stat?.avgDelayMin ?? null, true)}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Transfer indicator */}
                {transferInfo && (
                  <div className="flex items-center gap-2 py-2 px-3">
                    <ArrowDown className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      Overgang: {transferInfo.buffer.toFixed(0)} min buffer
                    </span>
                    {transferInfo.chance && (
                      <span className={cn("text-xs font-medium", transferInfo.color)}>
                        {transferInfo.chance}
                      </span>
                    )}
                    {!transferInfo.chance && (
                      <span className="text-[9px] text-muted-foreground/60 italic">
                        mangler data for vurdering
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TripPlanner() {
  const [fromStop, setFromStop] = useState<StopSearchResult | null>(null);
  const [toStop, setToStop] = useState<StopSearchResult | null>(null);
  const [tripPatterns, setTripPatterns] = useState<TripPattern[]>([]);
  const [delayStats, setDelayStats] = useState<Map<string, TripStopStat>>(new Map());
  const [showFilters, setShowFilters] = useState(false);

  // Filter state
  const [departDate, setDepartDate] = useState(todayISO());
  const [departTime, setDepartTime] = useState(roundedNow());
  const [arriveBy, setArriveBy] = useState(false);
  const [walkSpeed, setWalkSpeed] = useState("1.33");
  const [maxTransfers, setMaxTransfers] = useState("any");
  const [transferSlack, setTransferSlack] = useState("default");
  const [selectedModes, setSelectedModes] = useState<string[]>(["bus", "tram", "rail", "metro", "water"]);
  const [wheelchairAccessible, setWheelchairAccessible] = useState(false);

  function toggleMode(mode: string) {
    setSelectedModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode],
    );
  }

  const tripMutation = useMutation({
    mutationFn: async () => {
      if (!fromStop || !toStop) throw new Error("Velg fra og til");

      // Build dateTime ISO string from date + time, with local timezone offset
      const localDate = new Date(`${departDate}T${departTime}:00`);
      const dateTime = localDate.toISOString();

      // 1. Build location refs — NSR:StopPlace for stops, coordinates for addresses
      function locationRef(stop: StopSearchResult) {
        if (stop.stopPlaceRef) return { place: stop.stopPlaceRef };
        if (stop.lat != null && stop.lng != null) return { coordinates: { latitude: stop.lat, longitude: stop.lng }, name: stop.stopName };
        return { place: stop.stopRef };
      }

      // 2. Fetch trip from Entur
      const tripRes = await apiRequest("POST", "/api/trip", {
        from: locationRef(fromStop),
        to: locationRef(toStop),
        when: dateTime,
        arriveBy: arriveBy || undefined,
        transportModes: selectedModes.length > 0 ? selectedModes : undefined,
        walkSpeed: parseFloat(walkSpeed),
        maximumTransfers: maxTransfers !== "any" ? parseInt(maxTransfers) : undefined,
        transferSlack: transferSlack !== "default" ? parseInt(transferSlack) : undefined,
        wheelchairAccessible: wheelchairAccessible || undefined,
        numTripPatterns: 12, // høyt tall → Entur beregner dynamisk searchWindow riktig
      });
      const tripData = await tripRes.json();

      // Surface errors from Entur (e.g. invalid parameters, no routes)
      if (tripData?.errors?.length) {
        const msg = tripData.errors.map((e: any) => e.message).join("; ");
        console.warn("[trip] Entur GraphQL errors:", tripData.errors);
        throw new Error(`Entur: ${msg}`);
      }
      if (tripData?.error) {
        throw new Error(tripData.error + (tripData.detail ? ` — ${tripData.detail}` : ""));
      }

      const patterns: TripPattern[] = tripData?.data?.trip?.tripPatterns ?? [];

      if (patterns.length === 0) {
        return { patterns: [], stats: new Map<string, TripStopStat>() };
      }

      // 2. Collect (stopRef, lineRef) pairs — only for modes where we have data
      const stopLinePairs = new Set<string>();
      for (const p of patterns) {
        for (const leg of p.legs) {
          const lineRef = leg.line?.id ?? "";
          if (!lineRef || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
          const quays = [
            leg.fromPlace.quay?.id,
            ...leg.intermediateQuays.map((q) => q.id),
            leg.toPlace.quay?.id,
          ].filter(Boolean) as string[];
          for (const q of quays) {
            stopLinePairs.add(`${q}|${lineRef}`);
          }
        }
      }

      // 3. Fetch delay stats
      const stops = Array.from(stopLinePairs).map((key) => {
        const [stopRef, lineRef] = key.split("|");
        return { stopRef, lineRef };
      });

      let statsMap = new Map<string, TripStopStat>();
      if (stops.length > 0) {
        const statsRes = await apiRequest("POST", "/api/trip/stats", { stops });
        const statsData: TripStopStat[] = await statsRes.json();
        statsMap = new Map(statsData.map((s) => [`${s.stopRef}|${s.lineRef}`, s]));
      }

      return { patterns, stats: statsMap };
    },
    onSuccess: (data) => {
      setTripPatterns(data.patterns);
      setDelayStats(data.stats);
    },
  });

  const canSearch = fromStop != null && toStop != null && selectedModes.length > 0;

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Navigation className="h-8 w-8 text-primary" /> Reisesjekk
          </h2>
          <p className="text-muted-foreground mt-1">
            Planlegg reisen din og se historiske forsinkelsesdata for hvert stopp.
          </p>
        </div>

        {/* Search form */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* From / To / Button */}
            <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
              <StopSearch label="Fra" value={fromStop} onSelect={setFromStop} />
              <StopSearch label="Til" value={toStop} onSelect={setToStop} />
              <div className="flex items-end">
                <Button
                  onClick={() => tripMutation.mutate()}
                  disabled={!canSearch || tripMutation.isPending}
                  className="w-full md:w-auto"
                >
                  {tripMutation.isPending ? "Leter..." : "Finn reise"}
                </Button>
              </div>
            </div>

            {/* Date / Time / Direction */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <div>
                <Label className="text-xs text-muted-foreground">Dato</Label>
                <Input
                  type="date"
                  value={departDate}
                  onChange={(e) => setDepartDate(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Tid</Label>
                <Input
                  type="time"
                  value={departTime}
                  onChange={(e) => setDepartTime(e.target.value)}
                  className="h-9 text-sm"
                  step="300"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Retning</Label>
                <Select value={arriveBy ? "arrive" : "depart"} onValueChange={(v) => setArriveBy(v === "arrive")}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="depart">Avgang</SelectItem>
                    <SelectItem value="arrive">Ankomst</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <ArrowDownUp className="h-3 w-3" />
                  {showFilters ? "Skjul filtre" : "Flere filtre"}
                </Button>
              </div>
            </div>

            {/* Advanced filters — collapsible */}
            {showFilters && (
              <div className="border-t pt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                {/* Transport modes */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Transportmidler</Label>
                  <div className="flex flex-wrap gap-2">
                    {TRANSPORT_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => toggleMode(opt.value)}
                        className={cn(
                          "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                          selectedModes.includes(opt.value)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                  {/* Walking speed */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Ganghastighet</Label>
                    <Select value={walkSpeed} onValueChange={setWalkSpeed}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WALK_SPEED_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Max transfers */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Maks overganger</Label>
                    <Select value={maxTransfers} onValueChange={setMaxTransfers}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Ubegrenset</SelectItem>
                        <SelectItem value="0">Direkte</SelectItem>
                        <SelectItem value="1">1 overgang</SelectItem>
                        <SelectItem value="2">2 overganger</SelectItem>
                        <SelectItem value="3">3 overganger</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Transfer slack */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Overgangstid</Label>
                    <Select value={transferSlack} onValueChange={setTransferSlack}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Standard (2 min)</SelectItem>
                        <SelectItem value="-60">−1 min (sprinter)</SelectItem>
                        <SelectItem value="0">0 sek (håper på det beste)</SelectItem>
                        <SelectItem value="30">30 sek</SelectItem>
                        <SelectItem value="60">1 min</SelectItem>
                        <SelectItem value="180">3 min</SelectItem>
                        <SelectItem value="300">5 min (trygt)</SelectItem>
                        <SelectItem value="600">10 min (ekstra trygt)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Wheelchair */}
                  <div className="flex items-end">
                    <button
                      onClick={() => setWheelchairAccessible(!wheelchairAccessible)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-md text-xs border transition-colors w-full h-9",
                        wheelchairAccessible
                          ? "bg-primary/10 text-primary border-primary/30"
                          : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                      )}
                    >
                      <Accessibility className="h-4 w-4" />
                      Universell utforming
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tripMutation.isError && (
              <p className="text-destructive text-sm flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                {(tripMutation.error as Error).message}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        {tripPatterns.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">
              {tripPatterns.length} reiseforslag
              {delayStats.size > 0 && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  med forsinkelsesdata fra siste 13 uker
                </span>
              )}
            </h3>
            {tripPatterns.map((pattern, i) => (
              <TripCard key={i} pattern={pattern} index={i} stats={delayStats} />
            ))}
          </div>
        )}

        {tripPatterns.length === 0 && !tripMutation.isPending && tripMutation.isSuccess && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <p>Ingen reiseforslag funnet. Prøv andre stoppesteder eller juster filtre.</p>
            </CardContent>
          </Card>
        )}

        {/* Info */}
        <Card className="bg-muted/30">
          <CardContent className="pt-4 text-xs text-muted-foreground space-y-1">
            <p><strong>Hvordan fungerer dette?</strong></p>
            <p>Reiseforslagene kommer fra Entur sin reiseplanlegger (Journey Planner API v3). Vi legger til forsinkelsesdata fra vår egen database, basert på 13 ukers historikk.</p>
            <p className="flex items-center gap-1"><CheckCircle className="h-3 w-3 text-green-500" /> <strong>i rute</strong> = under 1 min forsinket i snitt</p>
            <p className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-500" /> <strong>+Xm</strong> = snitt forsinkelse ved dette stoppet for denne linjen</p>
            <p>Forsinkelsesdata er foreløpig kun tilgjengelig for buss (Skyss). Trikk, T-bane, tog og båt vises uten forsinkelsesstatistikk.</p>
            <p>Overgangsvurdering basert på gjennomsnittlig ankomstforsinkelse vs. tid til neste avgang. Fremtidig versjon: persentiler og empirisk beregning.</p>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
