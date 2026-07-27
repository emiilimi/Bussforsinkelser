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

import { useMemo, useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";
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

// Minste antall observasjoner for (stopp, linje) før vi fargelegger stoppet.
// Samme terskel som SPECIFIC_MIN_DAYS i overgangsstatistikken.
const MIN_OBS_FOR_COLOR = 5;

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
type StopDot = { pos: LatLng; color: string; name: string; delay: number | null; n: number };

/**
 * Rullehjul-zoom «klikk for å aktivere».
 *
 * Kartet ligger midt i en lang, scrollbar liste med reiseforslag. Er
 * scrollWheelZoom alltid PÅ, kaprer kartet sidescrollingen så snart musepekeren
 * passerer over det — man blir «fanget» og zoomer i stedet for å scrolle
 * videre. Er den alltid AV (som før), kan man på desktop i praksis ikke zoome
 * i det hele tatt, bortsett fra de små +/−-knappene.
 *
 * Løsning: hjul-zoom slås PÅ når du klikker i kartet, og AV igjen når
 * musepekeren forlater det. Da scroller siden normalt forbi kartet, men et
 * klikk gir full zoom-kontroll. Berøring (pinch) og +/− er upåvirket.
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

export function TripRouteMap({
  pattern,
  stats,
}: {
  pattern: TripPattern;
  /** Per-stopp forsinkelse, nøkkel `${stopRef}|${lineRef}` (samme som
   *  useTripDelayDistribution). Utelates for rene gå-kart. */
  stats?: Map<string, DuckDelayRow>;
}) {
  const [scrollZoomOn, setScrollZoomOn] = useState(false);
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
      //
      // MIN_OBS: et stopp fargelegges bare når vi har nok observasjoner for
      // akkurat (stopp, linje). Uten en slik terskel kunne ÉN enkelt
      // observasjon gi et selvsikkert rødt punkt midt i en ellers grå rute —
      // som så ut som en påstand om at nettopp det stoppet er dårlig, når
      // grunnlaget i praksis var tilfeldig støy. (Rapportert av bruker:
      // Bergen busstasjon lyste rødt på en NOR-WAY-avgang der resten av ruten
      // manglet data.) Under terskelen behandles stoppet som «ingen data».
      const legStopList = legStops(leg);
      const anchored = legStopList
        .map((s, i) => {
          const row = canColor ? stats!.get(`${s.id}|${lineRef}`) : undefined;
          const isLast = i === legStopList.length - 1;
          const n = row?.n ?? 0;
          const raw = (isLast ? row?.p50_arr : row?.p50_dep) ?? null;
          const delay = n >= MIN_OBS_FOR_COLOR ? raw : null;
          const idx = s.lat != null && s.lng != null ? nearestIndex(coords, s.lat, s.lng) : null;
          return { name: s.name, lat: s.lat, lng: s.lng, delay, n, idx };
        })
        .filter((a): a is typeof a & { idx: number; lat: number; lng: number } => a.idx != null)
        .sort((a, b) => a.idx - b.idx);

      // Stoppprikker (farget etter forsinkelse; grå hvis for lite/ingen data).
      for (const a of anchored) {
        if (a.delay != null) anyDelayData = true;
        stops.push({
          pos: [a.lat, a.lng],
          color: a.delay != null ? delayColor(a.delay) : "#9ca3af",
          name: a.name,
          delay: a.delay,
          n: a.n,
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
    <div className="mt-2 rounded-lg overflow-hidden border border-border relative">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [24, 24] }}
        // Hjul-zoom starter av og skrus på ved klikk (se ScrollZoomActivator).
        scrollWheelZoom={false}
        touchZoom={true}
        doubleClickZoom={true}
        style={{ height: 320, width: "100%" }}
        className="z-0"
      >
        <ScrollZoomActivator onChange={setScrollZoomOn} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsytere'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {/* Ingen tooltip på selve linjene: den ga et forstyrrende svart felt
            ved berøring/klikk uten å tilføre noe (linjen er allerede beskrevet
            i legg-lista over). Stoppene beholder sine tooltips. */}
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
            startstoppet «grønt/presis», selv når vi ikke hadde data for dem —
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
      <p className="text-[9px] text-muted-foreground/60 italic px-2 py-1 leading-snug">
        Rutegeometri fra Entur på OpenStreetMap. Stiplet grå = gange.
        {anyDelayData
          ? " Kollektiv-legg og stopp er farget etter median historisk forsinkelse (grønn = i rute → mørk rød = svært forsinket), samme skala som forsinkelseskartet."
          : " Kollektiv-legg er farget per transportmiddel (ingen forsinkelsesdata for denne ruten ennå)."}{" "}
        Zoom: to fingre, +/−, dobbeltklikk, eller klikk i kartet og bruk
        rullehjulet. Ikke sving-for-sving-veibeskrivelse.
      </p>
    </div>
  );
}
