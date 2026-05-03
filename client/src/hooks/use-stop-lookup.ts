import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface StopInfo {
  stopRef: string;
  stopName: string | null;
  stopPlaceRef: string | null;
  stopPlaceName: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Batch-lookup: gitt en liste stop_refs, returner stoppnavn + StopPlace-info
 * fra server (stop_coords-tabellen).
 *
 * Brukes av DuckDB-WASM-hooks for å berike resultater med stoppnavn etter
 * at Parquet-queries kun returnerer stop_refs (stop_coords er ikke i Parquet).
 *
 * React Query cacher per unike sett av refs → samme stopp slås bare opp én gang.
 */
export function useStopLookup(refs: string[]): {
  data: StopInfo[] | undefined;
  isLoading: boolean;
} {
  const key = [...refs].sort().join(",");
  return useQuery<StopInfo[]>({
    queryKey: ["stops-lookup", key],
    enabled: refs.length > 0,
    queryFn: () =>
      apiRequest("GET", `/api/stops/lookup?refs=${refs.join(",")}`).then((r) => r.json()) as Promise<StopInfo[]>,
    staleTime: Infinity,
    retry: false,
  });
}

/** Convenience: slå opp ett enkelt stopp */
export function useStopInfo(stopRef: string | null | undefined): StopInfo | undefined {
  const { data } = useStopLookup(stopRef ? [stopRef] : []);
  return data?.[0];
}
