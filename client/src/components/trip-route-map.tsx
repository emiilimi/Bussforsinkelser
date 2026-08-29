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
import { decodePolyline, type LatLng } from "@/lib/decode-polyline";
import { legStops, type TripPattern, type DuckDelayRow } from "@/lib/trip-shared";
import { MODES_WITH_DELAY_DATA } from "@/components/mode-icon";
import {
  RouteMapCanvas, delayColor, modeColor, nearestIndex, makeBoundsAccumulator,
  MIN_OBS_FOR_COLOR, type Segment, type StopDot,
} from "@/components/route-map-canvas";

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
    const box = makeBoundsAccumulator();
    const grow = (lat: number, lng: number) => box.grow(lat, lng);
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

    return { segments, stops, bounds: box.bounds(), origin, dest, anyDelayData };
  }, [pattern, stats]);

  const footer = (
    <p className="text-[9px] text-muted-foreground/60 italic px-2 py-1 leading-snug">
      Rutegeometri fra Entur på OpenStreetMap. Stiplet grå = gange.
      {anyDelayData
        ? " Kollektiv-legg og stopp er farget etter median historisk forsinkelse (grønn = i rute → mørk rød = svært forsinket), samme skala som forsinkelseskartet."
        : " Kollektiv-legg er farget per transportmiddel (ingen forsinkelsesdata for denne ruten ennå)."}{" "}
      Zoom: to fingre, +/−, dobbeltklikk, eller klikk i kartet og bruk
      rullehjulet. Ikke sving-for-sving-veibeskrivelse.
    </p>
  );

  return (
    <RouteMapCanvas
      segments={segments}
      stops={stops}
      bounds={bounds}
      origin={origin}
      dest={dest}
      footer={footer}
      emptyMessage="Ingen kartgeometri tilgjengelig for denne reisen."
    />
  );
}
