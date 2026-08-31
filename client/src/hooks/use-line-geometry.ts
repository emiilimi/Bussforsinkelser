// Rutevarianter med geometri for én linje — datagrunnlaget for kartet på
// linjeanalysen. Se functions/api/line-geometry.ts for hvorfor dette kommer
// fra Entur og ikke fra våre egne parquet-data.

import { useQuery } from "@tanstack/react-query";

export type LineVariantQuay = {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
};

export type LineVariant = {
  id: string;
  /** "inbound" | "outbound" | null — Enturs retningsbegrep, ikke vår direction_ref. */
  directionType: string | null;
  /** Google-kodet polylinje (presisjon 5), dekodes med decodePolyline(). */
  points: string;
  /** Antall avganger i ruteplanen som følger denne varianten. */
  runs: number;
  quays: LineVariantQuay[];
};

export type LineGeometry = {
  lineRef: string;
  publicCode: string | null;
  name: string | null;
  transportMode: string | null;
  /** Hvor mange varianter linja har totalt (før vi kuttet til `max`). */
  totalPatterns: number;
  variants: LineVariant[];
};

/**
 * `enabled` styrer lat lasting: kartet hentes først når brukeren ber om det,
 * slik at et Entur-kall ikke fyres av på hver eneste linjeanalyse-visning.
 */
export function useLineGeometry(lineRef: string, enabled: boolean, max = 3) {
  return useQuery<LineGeometry>({
    queryKey: [`/api/line-geometry?line=${encodeURIComponent(lineRef)}&max=${max}`],
    enabled: enabled && !!lineRef,
    staleTime: Infinity,
  });
}
