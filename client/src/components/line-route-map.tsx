// ---------------------------------------------------------------------------
// Forsinkelseskart for én linje (linjeanalysen).
//
// Samme tegnekjerne som reiseplanleggerens rutekart (route-map-canvas.tsx),
// men geometrien kommer fra Enturs journeyPatterns for linja i stedet for fra
// et reiseforslag. Se functions/api/line-geometry.ts for hvorfor Entur eier
// variantlista og vi bare eier fargene.
//
// Flere varianter kan vises samtidig: en linje kjører ofte både full lengde og
// kortvarianter (RUT:Line:5 har f.eks. Sognsvann–Vestli, Nydalen–Vestli og
// Rødtvet–Vestli). Standard er den mest kjørte; resten kan slås på.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { decodePolyline } from "@/lib/decode-polyline";
import type { LineVariant } from "@/hooks/use-line-geometry";
import { Button } from "@/components/ui/button";
import {
  RouteMapCanvas, delayColor, modeColor, nearestIndex, makeBoundsAccumulator,
  MIN_OBS_FOR_COLOR, type Segment, type StopDot,
} from "@/components/route-map-canvas";

/** Forsinkelse per stopp, nøkkel = quay-ref (NSR:Quay:N). */
export type StopDelayMap = Map<string, { delay: number | null; n: number }>;

/** «Sognsvann → Vestli» — variantens endepunkter, til knappeteksten. */
function variantLabel(v: LineVariant): string {
  const first = v.quays[0]?.name ?? "?";
  const last = v.quays[v.quays.length - 1]?.name ?? "?";
  return `${first} → ${last}`;
}

export function LineRouteMap({
  variants,
  stopDelays,
  transportMode,
}: {
  variants: LineVariant[];
  stopDelays: StopDelayMap;
  transportMode: string | null;
}) {
  // Standard: bare den mest kjørte varianten. Å tegne alle med én gang ga et
  // rotete bilde der kortvarianter la seg oppå hovedruten i samme farge.
  const [shown, setShown] = useState<string[]>(() =>
    variants.length > 0 ? [variants[0].id] : [],
  );

  const toggle = (id: string) =>
    setShown((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const { segments, stops, bounds, anyDelayData } = useMemo(() => {
    const segments: Segment[] = [];
    const stops: StopDot[] = [];
    const box = makeBoundsAccumulator();
    // Et stopp kan ligge på flere varianter — tegn prikken bare én gang.
    const seenStops = new Set<string>();
    let anyDelayData = false;
    const neutral = modeColor(transportMode ?? "");

    for (const v of variants) {
      if (!shown.includes(v.id)) continue;
      const coords = decodePolyline(v.points);
      if (coords.length < 2) continue;
      for (const [lat, lng] of coords) box.grow(lat, lng);

      // Forankre hvert stopp til nærmeste punkt på polylinja, slik at
      // segmentene kan farges stoppvis. Sorteres på posisjon LANGS ruten —
      // quay-rekkefølgen fra Entur er allerede riktig, men forankringen kan
      // i sjeldne tilfeller gi ikke-monotone indekser (sløyfer, vendespor).
      const anchored = v.quays
        .map((q) => {
          const hit = stopDelays.get(q.id);
          const n = hit?.n ?? 0;
          const delay = hit && n >= MIN_OBS_FOR_COLOR ? hit.delay : null;
          return { ...q, delay, n, idx: nearestIndex(coords, q.lat, q.lng) };
        })
        .sort((a, b) => a.idx - b.idx);

      for (const a of anchored) {
        if (a.delay != null) anyDelayData = true;
        if (seenStops.has(a.id)) continue;
        seenStops.add(a.id);
        stops.push({
          pos: [a.lat, a.lng],
          color: a.delay != null ? delayColor(a.delay) : "#9ca3af",
          name: a.name ?? a.id,
          delay: a.delay,
          n: a.n,
        });
      }

      const label = variantLabel(v);
      const haveDelay = anchored.some((a) => a.delay != null);
      if (anchored.length >= 2 && haveDelay) {
        for (let j = 0; j < anchored.length - 1; j++) {
          const sub = coords.slice(anchored[j].idx, anchored[j + 1].idx + 1);
          if (sub.length < 2) continue;
          // Fargen for et segment = forsinkelsen når du NÅR neste stopp
          // (fallback til forrige stopp, ellers nøytral modusfarge).
          const d = anchored[j + 1].delay ?? anchored[j].delay;
          segments.push({ coords: sub, color: d != null ? delayColor(d) : neutral, dashed: false, label });
        }
      } else {
        segments.push({ coords, color: neutral, dashed: false, label });
      }
    }

    return { segments, stops, bounds: box.bounds(), anyDelayData };
  }, [variants, shown, stopDelays, transportMode]);

  if (variants.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/60 italic py-3 text-center">
        Entur har ingen rutegeometri for denne linjen.
      </p>
    );
  }

  return (
    <div>
      {variants.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-1">
          <span className="text-xs text-muted-foreground mr-1">Rutevarianter:</span>
          {variants.map((v) => (
            <Button
              key={v.id}
              size="sm"
              variant={shown.includes(v.id) ? "default" : "outline"}
              onClick={() => toggle(v.id)}
              className="h-6 px-2 text-[11px]"
              title={`${v.quays.length} stopp · ${v.runs} avganger i ruteplanen`}
            >
              {variantLabel(v)}
              <span className="opacity-70 ml-1">({v.runs})</span>
            </Button>
          ))}
        </div>
      )}
      <RouteMapCanvas
        segments={segments}
        stops={stops}
        bounds={bounds}
        footer={
          <p className="text-[9px] text-muted-foreground/60 italic px-2 py-1 leading-snug">
            Rutegeometri og stoppesteder fra Entur på OpenStreetMap. Tallet i
            parentes er antall avganger i ruteplanen som følger varianten.
            {anyDelayData
              ? " Ruten og stoppene er farget etter gjennomsnittlig historisk forsinkelse i valgt periode (grønn = i rute → mørk rød = svært forsinket), samme skala som forsinkelseskartet."
              : " Vi har ingen forsinkelsesdata for stoppene på denne ruten ennå, så ruten vises i én nøytral farge."}{" "}
            Grå stopp mangler data eller har for få observasjoner.
          </p>
        }
        emptyMessage="Velg minst én rutevariant for å se kartet."
      />
    </div>
  );
}
