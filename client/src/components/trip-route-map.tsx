// ---------------------------------------------------------------------------
// Rutekart for ett reiseforslag (reiseplanlegger).
//
// Tegner leggenes faktiske geometri (fra Entur `pointsOnLink`) over
// OpenStreetMap-fliser med Leaflet — samme kartstack som forsinkelseskartet
// (`delay-map.tsx`). Gange vises stiplet grått, kollektiv farget per modus.
// Ingen ekstra kartbibliotek eller API-nøkkel: geometrien hentes allerede fra
// Entur, og react-leaflet/leaflet er allerede avhengigheter.
//
// Turn-by-turn-instruksjoner finnes IKKE i Entur-dataene (og vises ikke inline
// på entur.no heller) — vi tegner ruten og lar de eksisterende
// "Gå X min til Y"-tekstene i kortet stå for beskrivelsen.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { decodePolyline, type LatLng } from "@/lib/decode-polyline";
import type { TripPattern } from "@/lib/trip-shared";

// Farge per transportmodus (gange håndteres separat som stiplet grå).
const MODE_COLORS: Record<string, string> = {
  bus: "#2563eb",     // blå
  coach: "#7c3aed",   // fiolett (flybuss)
  tram: "#059669",    // grønn
  rail: "#dc2626",    // rød
  metro: "#ea580c",   // oransje
  water: "#0891b2",   // cyan
};

function legColor(mode: string): string {
  return MODE_COLORS[mode] ?? "#6b7280";
}

type DecodedLeg = {
  mode: string;
  label: string | null;
  coords: LatLng[];
  isFoot: boolean;
};

export function TripRouteMap({ pattern }: { pattern: TripPattern }) {
  const legs = useMemo<DecodedLeg[]>(() => {
    return pattern.legs
      .map((leg) => ({
        mode: leg.mode,
        label: leg.line?.publicCode ?? null,
        coords: leg.pointsOnLink ? decodePolyline(leg.pointsOnLink.points) : [],
        isFoot: leg.mode === "foot",
      }))
      .filter((l) => l.coords.length >= 2);
  }, [pattern]);

  const bounds = useMemo<[[number, number], [number, number]] | null>(() => {
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    for (const l of legs) {
      for (const [lat, lng] of l.coords) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
    if (!Number.isFinite(minLat)) return null;
    return [[minLat, minLng], [maxLat, maxLng]];
  }, [legs]);

  // Start- og sluttpunkt for hele reisen (første/siste geometripunkt).
  const origin = legs[0]?.coords[0] ?? null;
  const dest = (() => {
    const last = legs[legs.length - 1];
    return last ? last.coords[last.coords.length - 1] : null;
  })();

  if (!bounds || legs.length === 0) {
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
        style={{ height: 320, width: "100%" }}
        className="z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsytere'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {legs.map((l, i) =>
          l.isFoot ? (
            <Polyline
              key={i}
              positions={l.coords}
              pathOptions={{ color: "#6b7280", weight: 3, dashArray: "1 7", lineCap: "round", opacity: 0.9 }}
            >
              <Tooltip sticky>Gange</Tooltip>
            </Polyline>
          ) : (
            <Polyline
              key={i}
              positions={l.coords}
              pathOptions={{ color: legColor(l.mode), weight: 5, opacity: 0.85 }}
            >
              <Tooltip sticky>{l.label ? `Linje ${l.label}` : l.mode}</Tooltip>
            </Polyline>
          ),
        )}
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
      <p className="text-[9px] text-muted-foreground/60 italic px-2 py-1">
        Rutegeometri fra Entur, tegnet på OpenStreetMap. Stiplet grå = gange,
        farget = kollektiv. Ikke sving-for-sving-veibeskrivelse.
      </p>
    </div>
  );
}
