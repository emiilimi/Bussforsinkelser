// ---------------------------------------------------------------------------
// Rutekart for ett reiseforslag (reiseplanlegger).
//
// Tegner leggenes faktiske geometri (fra Entur `pointsOnLink`) over
// OpenStreetMap-fliser med Leaflet — samme kartstack som forsinkelseskartet
// (`delay-map.tsx`). Gange vises stiplet grått. Kollektiv-legg fargelegges
// SEGMENTVIS etter median historisk forsinkelse (samme fargeskala som
// forsinkelseskartet), og hvert stopp langs ruten vises som en prikk i samme
// farge. Har vi ikke forsinkelsesdata for et legg, tegnes det i én nøytral
// modusfarge (som før).
//
// Ingen ekstra kartbibliotek eller API-nøkkel: geometrien og stoppkoordinatene
// kommer fra Entur, og react-leaflet/leaflet er allerede avhengigheter.
//
// Turn-by-turn-instruksjoner finnes IKKE i Entur-dataene — vi tegner ruten og
// lar «Gå X min til Y»-tekstene i kortet stå for beskrivelsen. Gå-legg kan
// vises alene (walk-directions) ved å sende et mønster med bare det ene legget.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { decodePolyline, type LatLng } from "@/lib/decode-polyline";
import { legStops, type TripPattern, type DuckDelayRow } from "@/lib/trip-shared";

const MODES_WITH_DELAY_DATA = new Set(["bus", "coach", "ferry"]);

// Nøytral farge per transportmodus (brukt når vi mangler forsinkelsesdata).
const MODE_COLORS: Record<string, string> = {
  bus: "#2563eb", coach: "#7c3aed", tram: "#059669",
  rail: "#dc2626", metro: "#ea580c", water: "#0891b2",
};
function modeColor(mode: string): string {
  return MODE_COLORS[mode] ?? "#6b7280";
}

// Forsinkelsesfargeskala — MÅ holdes lik `getColor` i delay-map.tsx.
function delayColor(delay: number): string {
  if (delay < 1) return "#10b981";
  if (delay < 3) return "#fbbf24";
  if (delay < 5) return "#f97316";
  if (delay < 10) return "#ef4444";
  return "#991b1b";
}

/** Indeks til nærmeste polylinje-vertex for en koordinat (kvadrert avstand). */
function nearestIndex(coords: LatLng[], lat: number, lng: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dlat = coords[i][0] - lat, dlng = coords[i][1] - lng;
    const d = dlat * dlat + dlng * dlng;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

type Segment = { coords: LatLng[]; color: string; dashed: boolean; label: string };
type StopDot = { pos: LatLng; color: string; name: string; delay: number | null };

export function TripRouteMap({
  pattern,
  stats,
}: {
  pattern: TripPattern;
  /** Per-stopp forsinkelse, nøkkel `${stopRef}|${lineRef}` (samme som
   *  useTripDelayDistribution). Utelates for rene gå-kart. */
  stats?: Map<string, DuckDelayRow>;
}) {
  const { segments, stops, bounds, origin, dest, anyDelayData } = useMemo(() => {
    const segments: Segment[] = [];
    const stops: StopDot[] = [];
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    const grow = (lat: number, lng: number) => {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    };
    let anyDelayData = false;
    let origin: LatLng | null = null;
    let dest: LatLng | null = null;

    for (const leg of pattern.legs) {
      const coords = leg.pointsOnLink ? decodePolyline(leg.pointsOnLink.points) : [];
      if (coords.length < 2) continue;
      for (const [lat, lng] of coords) grow(lat, lng);
      if (!origin) origin = coords[0];
      dest = coords[coords.length - 1];

      // Gå-legg: alltid stiplet grått.
      if (leg.mode === "foot") {
        segments.push({ coords, color: "#6b7280", dashed: true, label: "Gange" });
        continue;
      }

      const lineRef = leg.line?.id ?? "";
      const canColor = MODES_WITH_DELAY_DATA.has(leg.mode) && !!lineRef && !!stats;

      // Stopp langs legget med koordinat + median forsinkelse.
      const legStopList = legStops(leg);
      const anchored = legStopList
        .map((s, i) => {
          const row = canColor ? stats!.get(`${s.id}|${lineRef}`) : undefined;
          const isLast = i === legStopList.length - 1;
          const delay = (isLast ? row?.p50_arr : row?.p50_dep) ?? null;
          const idx = s.lat != null && s.lng != null ? nearestIndex(coords, s.lat, s.lng) : null;
          return { name: s.name, lat: s.lat, lng: s.lng, delay, idx };
        })
        .filter((a): a is typeof a & { idx: number; lat: number; lng: number } => a.idx != null)
        .sort((a, b) => a.idx - b.idx);

      // Stoppprikker (farget etter forsinkelse; grå hvis ukjent).
      for (const a of anchored) {
        if (a.delay != null) anyDelayData = true;
        stops.push({
          pos: [a.lat, a.lng],
          color: a.delay != null ? delayColor(a.delay) : "#9ca3af",
          name: a.name,
          delay: a.delay,
        });
      }

      const label = leg.line?.publicCode ? `Linje ${leg.line.publicCode}` : leg.mode;

      // Segmentvis fargelegging mellom stopp (gradient etter forsinkelse).
      // Krever minst to forankrede stopp MED forsinkelsesdata; ellers én
      // nøytral modusfarget linje.
      const haveDelay = anchored.some((a) => a.delay != null);
      if (canColor && anchored.length >= 2 && haveDelay) {
        for (let j = 0; j < anchored.length - 1; j++) {
          const sub = coords.slice(anchored[j].idx, anchored[j + 1].idx + 1);
          if (sub.length < 2) continue;
          // Fargen for et segment = forsinkelsen når du NÅR neste stopp
          // (fallback til forrige stopp, ellers modusfarge).
          const d = anchored[j + 1].delay ?? anchored[j].delay;
          segments.push({
            coords: sub,
            color: d != null ? delayColor(d) : modeColor(leg.mode),
            dashed: false,
            label,
          });
        }
      } else {
        segments.push({ coords, color: modeColor(leg.mode), dashed: false, label });
      }
    }

    const bounds: [[number, number], [number, number]] | null = Number.isFinite(minLat)
      ? [[minLat, minLng], [maxLat, maxLng]]
      : null;
    return { segments, stops, bounds, origin, dest, anyDelayData };
  }, [pattern, stats]);

  if (!bounds || segments.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/60 italic py-3 text-center">
        Ingen kartgeometri tilgjengelig for denne reisen.
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-border">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [24, 24] }}
        scrollWheelZoom={false}
        touchZoom={true}
        doubleClickZoom={true}
        style={{ height: 320, width: "100%" }}
        className="z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsytere'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {segments.map((s, i) => (
          <Polyline
            key={i}
            positions={s.coords}
            pathOptions={{
              color: s.color,
              weight: s.dashed ? 3 : 5,
              opacity: s.dashed ? 0.9 : 0.85,
              dashArray: s.dashed ? "1 7" : undefined,
              lineCap: "round",
            }}
          >
            <Tooltip sticky>{s.label}</Tooltip>
          </Polyline>
        ))}
        {stops.map((s, i) => (
          <CircleMarker
            key={`stop-${i}`}
            center={s.pos}
            radius={4}
            pathOptions={{ color: "white", weight: 1.5, fillColor: s.color, fillOpacity: 1 }}
          >
            <Tooltip>
              {s.name}
              {s.delay != null && <> · median {s.delay > 0 ? "+" : ""}{s.delay.toFixed(1)} min</>}
            </Tooltip>
          </CircleMarker>
        ))}
        {origin && (
          <CircleMarker center={origin} radius={6}
            pathOptions={{ color: "white", weight: 2, fillColor: "#16a34a", fillOpacity: 1 }}>
            <Tooltip>Start</Tooltip>
          </CircleMarker>
        )}
        {dest && (
          <CircleMarker center={dest} radius={6}
            pathOptions={{ color: "white", weight: 2, fillColor: "#dc2626", fillOpacity: 1 }}>
            <Tooltip>Mål</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
      <p className="text-[9px] text-muted-foreground/60 italic px-2 py-1 leading-snug">
        Rutegeometri fra Entur på OpenStreetMap. Stiplet grå = gange.
        {anyDelayData
          ? " Kollektiv-legg og stopp er farget etter median historisk forsinkelse (grønn = i rute → mørk rød = svært forsinket), samme skala som forsinkelseskartet."
          : " Kollektiv-legg er farget per transportmiddel (ingen forsinkelsesdata for denne ruten ennå)."}{" "}
        Zoom med to fingre eller +/−. Ikke sving-for-sving-veibeskrivelse.
      </p>
    </div>
  );
}
