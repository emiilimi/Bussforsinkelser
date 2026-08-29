// ---------------------------------------------------------------------------
// Delt tegnekjerne for rutekartene (reiseplanlegger + linjeanalyse).
//
// Trukket ut av trip-route-map.tsx da linjeanalysen fikk sitt eget kart:
// selve tegningen — fargeskala, stoppprikker, zoom-oppførsel, attribusjon —
// er identisk, mens KILDEN til geometrien er ulik (Entur-reiseforslag vs.
// Entur journeyPatterns for én linje). Kallerne bygger `Segment[]`/`StopDot[]`
// og lar denne filen stå for Leaflet-biten.
//
// Fargeskalaen MÅ holdes lik `getColor` i delay-map.tsx — de tre kartene skal
// lese likt.
// ---------------------------------------------------------------------------

import { useState, type ReactNode } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";
import type { LatLng } from "@/lib/decode-polyline";

export type Segment = { coords: LatLng[]; color: string; dashed: boolean; label: string };
export type StopDot = { pos: LatLng; color: string; name: string; delay: number | null; n: number };
export type MapBounds = [[number, number], [number, number]];

// Nøytral farge per transportmodus (brukt når vi mangler forsinkelsesdata).
const MODE_COLORS: Record<string, string> = {
  bus: "#2563eb", coach: "#7c3aed", tram: "#059669",
  rail: "#dc2626", metro: "#ea580c", water: "#0891b2",
};

export function modeColor(mode: string): string {
  return MODE_COLORS[mode] ?? "#6b7280";
}

/**
 * Minste antall observasjoner for (stopp, linje) før vi fargelegger stoppet.
 *
 * Uten en slik terskel kunne ÉN enkelt observasjon gi et selvsikkert rødt
 * punkt midt i en ellers grå rute — som så ut som en påstand om at nettopp
 * det stoppet er dårlig, når grunnlaget i praksis var tilfeldig støy.
 * (Rapportert av bruker: Bergen busstasjon lyste rødt på en NOR-WAY-avgang
 * der resten av ruten manglet data.)
 */
export const MIN_OBS_FOR_COLOR = 5;

/** Forsinkelsesfargeskala — MÅ holdes lik `getColor` i delay-map.tsx. */
export function delayColor(delay: number): string {
  if (delay < 1) return "#10b981";
  if (delay < 3) return "#fbbf24";
  if (delay < 5) return "#f97316";
  if (delay < 10) return "#ef4444";
  return "#991b1b";
}

/** Indeks til nærmeste polylinje-vertex for en koordinat (kvadrert avstand). */
export function nearestIndex(coords: LatLng[], lat: number, lng: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dlat = coords[i][0] - lat, dlng = coords[i][1] - lng;
    const d = dlat * dlat + dlng * dlng;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Voksende bounding box — kallerne samler utstrekningen mens de bygger segmenter. */
export function makeBoundsAccumulator() {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  return {
    grow(lat: number, lng: number) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    },
    bounds(): MapBounds | null {
      return Number.isFinite(minLat) ? [[minLat, minLng], [maxLat, maxLng]] : null;
    },
  };
}

/**
 * Rullehjul-zoom «klikk for å aktivere».
 *
 * Kartet ligger midt i en lang, scrollbar side. Er scrollWheelZoom alltid PÅ,
 * kaprer kartet sidescrollingen så snart musepekeren passerer over det — man
 * blir «fanget» og zoomer i stedet for å scrolle videre. Er den alltid AV,
 * kan man på desktop i praksis ikke zoome, bortsett fra de små +/−-knappene.
 *
 * Løsning: hjul-zoom slås PÅ når du klikker i kartet, og AV igjen når
 * musepekeren forlater det. Berøring (pinch) og +/− er upåvirket.
 */
function ScrollZoomActivator({ onChange }: { onChange: (active: boolean) => void }) {
  const map = useMap();
  useMapEvents({
    click() {
      if (!map.scrollWheelZoom.enabled()) {
        map.scrollWheelZoom.enable();
        onChange(true);
      }
    },
    mouseout() {
      if (map.scrollWheelZoom.enabled()) {
        map.scrollWheelZoom.disable();
        onChange(false);
      }
    },
  });
  return null;
}

export function RouteMapCanvas({
  segments,
  stops,
  bounds,
  origin,
  dest,
  height = 320,
  footer,
  emptyMessage = "Ingen kartgeometri tilgjengelig.",
}: {
  segments: Segment[];
  stops: StopDot[];
  bounds: MapBounds | null;
  /** Start-/målmarkør. Utelates når ruten ikke har et entydig start-/endepunkt. */
  origin?: LatLng | null;
  dest?: LatLng | null;
  height?: number;
  footer?: ReactNode;
  emptyMessage?: string;
}) {
  const [scrollZoomOn, setScrollZoomOn] = useState(false);

  if (!bounds || segments.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/60 italic py-3 text-center">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-border relative">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [24, 24] }}
        // Hjul-zoom starter av og skrus på ved klikk (se ScrollZoomActivator).
        scrollWheelZoom={false}
        touchZoom={true}
        doubleClickZoom={true}
        style={{ height, width: "100%" }}
        className="z-0"
      >
        <ScrollZoomActivator onChange={setScrollZoomOn} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsytere'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {/* Ingen tooltip på selve linjene: den ga et forstyrrende svart felt
            ved berøring/klikk uten å tilføre noe. Stoppene beholder sine. */}
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
          />
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
              {s.delay != null ? (
                <> · median {s.delay > 0 ? "+" : ""}{s.delay.toFixed(1)} min ({s.n} obs.)</>
              ) : (
                <> · {s.n > 0
                  ? `for få observasjoner (${s.n}) til å fargelegges`
                  : "ingen forsinkelsesdata"}</>
              )}
            </Tooltip>
          </CircleMarker>
        ))}
        {/* Start-/målmarkører er NØYTRALE (hvit fyll, mørk ring) — de sier
            ingenting om forsinkelse. Tidligere var de grønn/rød, altså nøyaktig
            de samme fargene som forsinkelsesskalaen (grønn = i rute, rød =
            forsinket). Det fikk endestoppet til å se «rødt/forsinket» ut og
            startstoppet «grønt/presist», selv når vi ikke hadde data for dem —
            rapportert av bruker 2026-07-27. */}
        {origin && (
          <CircleMarker center={origin} radius={7}
            pathOptions={{ color: "#1f2937", weight: 3, fillColor: "#ffffff", fillOpacity: 1 }}>
            <Tooltip>Start (ikke forsinkelsesfarge)</Tooltip>
          </CircleMarker>
        )}
        {dest && (
          <CircleMarker center={dest} radius={7}
            pathOptions={{ color: "#1f2937", weight: 3, fillColor: "#ffffff", fillOpacity: 1, dashArray: "3 2" }}>
            <Tooltip>Mål (ikke forsinkelsesfarge)</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
      {/* Hint om hjul-zoom. Vises til man har klikket i kartet; da er
          rullehjulet aktivt og hintet byttes ut med en bekreftelse. */}
      <div
        className={cn(
          "pointer-events-none absolute top-2 right-2 z-[400] rounded px-2 py-1 text-[10px] shadow-sm transition-opacity",
          scrollZoomOn
            ? "bg-primary/90 text-primary-foreground"
            : "bg-background/85 text-muted-foreground border border-border",
        )}
      >
        {scrollZoomOn ? "Rullehjul zoomer" : "Klikk i kartet for å zoome med rullehjul"}
      </div>
      {footer}
    </div>
  );
}
