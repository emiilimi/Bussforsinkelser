/**
 * Client-side DuckDB-WASM equivalents of the 11 storage.ts functions that
 * previously queried journey_stop_daily on the server.
 *
 * Architecture:
 *   1. useParquetQuery()  — runs SQL against Parquet files from Cloudflare R2
 *   2. Stop names are embedded directly in the Parquet files (stop_name column,
 *      populated via LEFT JOIN stop_coords in export_parquet.py).
 *      No separate server round-trip needed.
 *
 * Hver spørring kjører mot delays_by_line eller delays_by_stop (se
 * use-parquet-query.ts) — velges ut fra hvilken kolonne spørringen filtrerer
 * på FØRST/mest selektivt, siden Parquet radgruppe-pruning kun virker langs
 * kolonnen filen faktisk er sortert på. fromDate sendes med som options så
 * ukefiler utenfor vinduet ikke en gang registreres.
 *
 * SQL dialect: DuckDB (not SQLite). Key differences:
 *   - date arithmetic: current_date - INTERVAL N DAY  (not date('now', '-N days'))
 *   - CAST(x AS INTEGER) → CAST(x AS INTEGER) ✓ same
 *   - SUBSTR, COALESCE, AVG, COUNT, ROUND, SQRT, MAX, MIN → identical ✓
 *   - HAVING with alias: supported in DuckDB ✓
 *   - Correlated subqueries: supported ✓
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParquetQuery } from "./use-parquet-query";
import { IS_REISE } from "@/lib/app-mode";

/**
 * Oppslag mot /api/stops/lookup. I reise-bygget finnes ikke Express-serveren —
 * worker'en svarer 404 på ukjente /api/* — så der går oppslaget via
 * stats-adapteren (stoppested-metadata fra R2-artefakten) i stedet.
 * Dynamisk import: adapteren hører til duck/analyse-chunken, ikke hovedbundelen.
 */
async function lookupStops(
  refs: string,
  expand: boolean,
  nameHint?: string,
  lat?: number | null,
  lng?: number | null,
): Promise<Array<{ stopRef: string; stopName?: string | null; stopPlaceRef?: string | null }>> {
  const url = `/api/stops/lookup?refs=${encodeURIComponent(refs)}${expand ? "&expand=stopplace" : ""}${nameHint ? `&name=${encodeURIComponent(nameHint)}` : ""}${lat != null && lng != null ? `&lat=${lat}&lng=${lng}` : ""}`;
  if (IS_REISE) {
    const { statsAdapterFetch } = await import("@/lib/stats-adapter");
    const res = await statsAdapterFetch(url);
    return Array.isArray(res) ? res : [];
  }
  const res = await fetch(url);
  return res.ok ? await res.json() : [];
}

// ---------------------------------------------------------------------------
// Types (mirror the server return shapes exactly)
// ---------------------------------------------------------------------------

export interface JourneyEntry {
  directionRef: string;
  firstStopTime: string;
  numVariants: number;
  firstStopName: string | null;
  lastStopName: string | null;
}

export interface JourneyStopProfile {
  stopRef: string;
  stopSequence: number;
  aimedTime: string | null;
  avgDelayMin: number;
  maxDelayMin: number;
  minDelayMin: number;
  numSamples: number;
  numJourneys: number;
  stopName: string;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  stddevDelayMin: number | null;
}

export interface WorstStop {
  stopRef: string;
  stopName: string;
  avgDelayMin: number;
  numSamples: number;
}

export interface RouteVariant {
  variantId: string;
  firstStopName: string | null;
  lastStopName: string | null;
  numStops: number;
  totalSamples: number;
  exampleTime: string | null;
}

export interface LineStopProfileEntry {
  stopRef: string;
  stopSequence: number;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number;
  stopName: string | null;
}

export interface JourneyRanking {
  departureTime: string | null;
  firstStopName: string | null;
  lastStopName: string | null;
  avgDelayMin: number;
  observedDepartures: number;
  /** Siste observerte dato — eksakt dato for tallet når observedDepartures = 1. */
  lastDate: string | null;
}

export interface HourlyAtStop {
  lineRef: string;
  hour: number;
  avgDelayMin: number;
  numSamples: number;
}

export interface LineAtStop {
  lineRef: string;
  avgDelayMin: number;
  numSamples: number;
}

export interface CorridorStop {
  lineRef: string;
  stopRef: string;
  stopName: string | null;
  corridorIndex: number;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number;
}

export interface TripStopStat {
  stopRef: string;
  lineRef: string;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number | null;
}

// ---------------------------------------------------------------------------
// Helper: 91 days ago as ISO date string (mirrors date('now', '-91 days'))
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. useJourneysForLine
// ---------------------------------------------------------------------------

export function useJourneysForLine(lineRef: string, fromDate: string) {
  const { query, ready } = useParquetQuery();
  return useQuery<JourneyEntry[]>({
    queryKey: ["journeys-for-line", lineRef, fromDate],
    enabled: ready && !!lineRef,
    queryFn: () =>
      query<JourneyEntry>(`
        SELECT
          direction_ref AS directionRef,
          first_stop_time AS firstStopTime,
          COUNT(*) AS numVariants,
          MAX(first_stop_name) AS firstStopName,
          MAX(last_stop_name)  AS lastStopName
        FROM (
          SELECT
            d.service_journey_id,
            d.direction_ref,
            MIN(COALESCE(d.aimed_departure, d.aimed_arrival)) AS first_stop_time,
            (SELECT COALESCE(d2.stop_name, d2.stop_ref)
             FROM delays_by_line d2
             WHERE d2.service_journey_id = d.service_journey_id
             ORDER BY d2.stop_sequence ASC LIMIT 1) AS first_stop_name,
            (SELECT COALESCE(d2.stop_name, d2.stop_ref)
             FROM delays_by_line d2
             WHERE d2.service_journey_id = d.service_journey_id
             ORDER BY d2.stop_sequence DESC LIMIT 1) AS last_stop_name
          FROM delays_by_line d
          WHERE d.line_ref = ? AND d.date >= ?
          GROUP BY d.service_journey_id, d.direction_ref
        )
        GROUP BY direction_ref, first_stop_time
        ORDER BY direction_ref, first_stop_time`,
        [lineRef, fromDate],
        { family: "by-line", fromDate }),
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// 2. useJourneyProfile
// ---------------------------------------------------------------------------

export function useJourneyProfile(
  lineRef: string,
  directionRef: string,
  firstStopTime: string,
  fromDate?: string,
  dayTypes?: string[] | null,
) {
  const { query, ready } = useParquetQuery();
  const effectiveFrom = fromDate ?? daysAgo(91);

  // Step 1: find matching service_journey_ids
  const sjQuery = useQuery<Array<{ service_journey_id: string }>>({
    queryKey: ["journey-sj-ids", lineRef, directionRef, firstStopTime, effectiveFrom],
    enabled: ready && !!lineRef && !!directionRef && !!firstStopTime,
    queryFn: () =>
      query<{ service_journey_id: string }>(`
        SELECT DISTINCT service_journey_id
        FROM delays_by_line
        WHERE line_ref = ? AND direction_ref = ? AND date >= ?
        GROUP BY service_journey_id
        HAVING MIN(COALESCE(aimed_departure, aimed_arrival)) = ?`,
        [lineRef, directionRef, effectiveFrom, firstStopTime],
        { family: "by-line", fromDate: effectiveFrom }),
    staleTime: Infinity,
  });

  const sjIds = sjQuery.data?.map((r) => r.service_journey_id) ?? [];
  const dtFilter =
    dayTypes && dayTypes.length
      ? `AND day_type IN (${dayTypes.map((dt) => `'${dt.replace(/'/g, "''")}'`).join(",")})`
      : "";

  // Step 2: aggregate profile — filtrert på en liste med service_journey_id
  // (ikke line_ref/stop_ref direkte), men disse tilhører alle linjen fra
  // steg 1, så by-line + samme fromDate-vindu gir fortsatt god pruning.
  const profileQuery = useQuery<JourneyStopProfile[]>({
    queryKey: ["journey-profile", sjIds.join(","), dtFilter],
    enabled: sjIds.length > 0,
    queryFn: () => {
      const ph = sjIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      return query<JourneyStopProfile>(`
        SELECT
          stop_ref                                                              AS stopRef,
          MIN(stop_sequence)                                                    AS stopSequence,
          MIN(COALESCE(aimed_departure, aimed_arrival))                         AS aimedTime,
          ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2)       AS avgDelayMin,
          ROUND(MAX(COALESCE(delay_departure_min, delay_arrival_min)), 2)       AS maxDelayMin,
          ROUND(MIN(COALESCE(delay_departure_min, delay_arrival_min)), 2)       AS minDelayMin,
          COUNT(*)                                                              AS numSamples,
          COUNT(DISTINCT date)                                                  AS numJourneys,
          COALESCE(MAX(stop_name), stop_ref)                                    AS stopName,
          ROUND(AVG(delay_arrival_min), 2)                                      AS avgDelayArrivalMin,
          ROUND(AVG(delay_departure_min), 2)                                    AS avgDelayDepartureMin,
          ROUND(AVG(dwell_time_sec), 1)                                         AS avgDwellTimeSec,
          ROUND(SQRT(GREATEST(0,
            AVG(COALESCE(delay_departure_min, delay_arrival_min)
                * COALESCE(delay_departure_min, delay_arrival_min))
            - AVG(COALESCE(delay_departure_min, delay_arrival_min))
            * AVG(COALESCE(delay_departure_min, delay_arrival_min))
          )), 2)                                                                AS stddevDelayMin
        FROM delays_by_line
        WHERE service_journey_id IN (${ph}) ${dtFilter}
        GROUP BY stop_ref
        ORDER BY MIN(COALESCE(aimed_departure, aimed_arrival)) ASC,
                 MIN(stop_sequence) ASC`,
        undefined,
        { family: "by-line", fromDate: effectiveFrom });
    },
    staleTime: Infinity,
  });

  return {
    ...profileQuery,
    isLoading: sjQuery.isLoading || profileQuery.isLoading,
    data: profileQuery.data,
  };
}

// ---------------------------------------------------------------------------
// 3. useWorstStopsForLine
// ---------------------------------------------------------------------------

export function useWorstStopsForLine(lineRef: string, fromDate: string, limit = 15) {
  const { query, ready } = useParquetQuery();
  const stats = useQuery<WorstStop[]>({
    queryKey: ["worst-stops-line", lineRef, fromDate, limit],
    enabled: ready && !!lineRef,
    queryFn: () =>
      query<WorstStop>(`
        SELECT stop_ref AS stopRef,
          COALESCE(MAX(stop_name), stop_ref) AS stopName,
          ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
          COUNT(*) AS numSamples
        FROM delays_by_line
        WHERE line_ref = ? AND date >= ?
        GROUP BY stop_ref
        HAVING COUNT(*) >= 20
        ORDER BY avgDelayMin DESC
        LIMIT ?`,
        [lineRef, fromDate, limit],
        { family: "by-line", fromDate }),
    staleTime: Infinity,
  });
  return stats;
}

// ---------------------------------------------------------------------------
// 4. useRouteVariants
// ---------------------------------------------------------------------------

export function useRouteVariants(lineRef: string, directionRef: string, fromDate: string) {
  const { query, ready } = useParquetQuery();
  return useQuery<RouteVariant[]>({
    queryKey: ["route-variants", lineRef, directionRef, fromDate],
    enabled: ready && !!lineRef,
    queryFn: () =>
      // arg_min/arg_max i stedet for korrelerte subspørringer: de fire
      // subspørringene her (første/siste stopp-ref og -navn) hadde INGEN
      // line_ref/dato-filter, så hver av dem skannet HELE datasettet på nytt
      // — én gang per service_journey_id i gruppa, altså hundrevis av
      // fullskann per sidelast. arg_min(x, y) plukker x fra raden med lavest
      // y innenfor gruppa som allerede er lest. Samme mønster som
      // useJourneyRankings under, og semantisk likt: stop_sequence er aldri
      // NULL. Bonus: nå respekteres datovinduet også for endestoppene.
      //
      // CAST(... AS BIGINT): SUM(<heltall>) gir ellers HUGEINT, som Arrow
      // sender som Decimal128 → Uint32Array i JS, ikke et tall. Det ga
      // "99 090,0,0" i nedtrekket. runQueryOnConn konverterer nå slike
      // verdier, men CAST-en holder typen riktig allerede i SQL-en (samme
      // grep som stats-adapter.ts bruker).
      query<RouteVariant>(`
        SELECT
          first_stop_ref || '->' || last_stop_ref || ':' || num_stops AS variantId,
          MAX(COALESCE(first_stop_name, first_stop_ref)) AS firstStopName,
          MAX(COALESCE(last_stop_name, last_stop_ref))   AS lastStopName,
          num_stops           AS numStops,
          CAST(SUM(total_samples) AS BIGINT) AS totalSamples,
          MIN(first_time)     AS exampleTime
        FROM (
          SELECT
            d.service_journey_id,
            COUNT(DISTINCT d.stop_ref) AS num_stops,
            MIN(COALESCE(d.aimed_departure, d.aimed_arrival)) AS first_time,
            COUNT(*) AS total_samples,
            arg_min(d.stop_ref,  d.stop_sequence) AS first_stop_ref,
            arg_max(d.stop_ref,  d.stop_sequence) AS last_stop_ref,
            arg_min(d.stop_name, d.stop_sequence) AS first_stop_name,
            arg_max(d.stop_name, d.stop_sequence) AS last_stop_name
          FROM delays_by_line d
          WHERE d.line_ref = ? AND d.direction_ref = ? AND d.date >= ?
          GROUP BY d.service_journey_id
        )
        GROUP BY first_stop_ref, last_stop_ref, num_stops
        HAVING SUM(total_samples) >= 20
        ORDER BY totalSamples DESC
        LIMIT 20`,
        [lineRef, directionRef, fromDate],
        { family: "by-line", fromDate }),
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// 5. useLineStopProfile
// ---------------------------------------------------------------------------

export function useLineStopProfile(
  lineRef: string,
  directionRef: string,
  fromDate: string,
  variantId?: string,
) {
  const { query, ready } = useParquetQuery();

  // Step 1: find dominant service_journey_id
  const dominantQuery = useQuery<Array<{ service_journey_id: string }>>({
    queryKey: ["line-stop-profile-dominant", lineRef, directionRef, fromDate, variantId ?? ""],
    enabled: ready && !!lineRef,
    queryFn: async () => {
      if (variantId) {
        const m = variantId.match(/^(.+)->(.+):(\d+)$/);
        if (m) {
          const [, firstStop, lastStop, numStops] = m;
          // arg_min/arg_max, ikke korrelerte subspørringer — se
          // useRouteVariants over for hvorfor (subspørringene manglet
          // line_ref/dato-filter og fullskannet datasettet per gruppe).
          return query<{ service_journey_id: string }>(`
            SELECT d.service_journey_id
            FROM delays_by_line d
            WHERE d.line_ref = ? AND d.direction_ref = ? AND d.date >= ?
            GROUP BY d.service_journey_id
            HAVING COUNT(DISTINCT d.stop_ref) = ?
              AND arg_min(d.stop_ref, d.stop_sequence) = ?
              AND arg_max(d.stop_ref, d.stop_sequence) = ?
            ORDER BY COUNT(*) DESC, d.service_journey_id
            LIMIT 1`,
            [lineRef, directionRef, fromDate, parseInt(numStops), firstStop, lastStop],
            { family: "by-line", fromDate });
        }
      }
      // service_journey_id som tiebreak: målt på ekte data kan 38 avganger
      // dele samme COUNT(*), og uten et stabilt kriterium plukker LIMIT 1
      // vilkårlig — profilen kunne da «bytte avgang» mellom to sidelastninger.
      // (De uavgjorte har samme stopprekkefølge, så valget påvirker ikke
      // tallene, kun stabiliteten.)
      return query<{ service_journey_id: string }>(`
        SELECT service_journey_id FROM delays_by_line
        WHERE line_ref = ? AND direction_ref = ? AND date >= ?
        GROUP BY service_journey_id
        ORDER BY COUNT(*) DESC, service_journey_id LIMIT 1`,
        [lineRef, directionRef, fromDate],
        { family: "by-line", fromDate });
    },
    staleTime: Infinity,
  });

  const dominantId = dominantQuery.data?.[0]?.service_journey_id;

  // Step 2: stoppene (og rekkefølgen) for den dominerende avgangen.
  //
  // fromDate er med nå. Kommentaren her sa tidligere at «datovinduet er ukjent
  // her», men det er det ikke — det er en parameter til hooken. Uten den
  // droppet prepareView ingen ukefiler, og et view over ALLE registrerte uker
  // (opptil 14) ble bygget for det som bare er et lite oppslag på ÉN avgang.
  //
  // Henter samtidig stop_sequence, slik at steg 3 slipper to korrelerte
  // subspørringer for å finne rekkefølgen (se der).
  const canonicalQuery = useQuery<Array<{ stop_ref: string; stop_sequence: number }>>({
    queryKey: ["line-stop-profile-canonical", dominantId ?? "", fromDate],
    enabled: !!dominantId,
    queryFn: () =>
      query<{ stop_ref: string; stop_sequence: number }>(`
        SELECT stop_ref, MIN(stop_sequence) AS stop_sequence
        FROM delays_by_line WHERE service_journey_id = ?
        GROUP BY stop_ref
        ORDER BY stop_sequence`,
        [dominantId!],
        { family: "by-line", fromDate }),
    staleTime: Infinity,
  });

  const canonicalStops = canonicalQuery.data?.map((r) => r.stop_ref) ?? [];

  // Step 3: aggregate all matching journeys at those stops.
  //
  // stopSequence hentes IKKE lenger med korrelert subspørring (den lå både i
  // SELECT og i ORDER BY, altså to fullskann av delays_by_line per utrad).
  // Steg 2 har allerede rekkefølgen for den dominerende avgangen, så vi
  // kobler den på klientsiden og sorterer der.
  const profileQuery = useQuery<Array<Omit<LineStopProfileEntry, "stopSequence">>>({
    queryKey: ["line-stop-profile-data", lineRef, directionRef, fromDate, dominantId ?? "", canonicalStops.join(",")],
    enabled: !!dominantId && canonicalStops.length > 0,
    queryFn: () => {
      const ph = canonicalStops.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
      return query<Omit<LineStopProfileEntry, "stopSequence">>(`
        SELECT
          d.stop_ref AS stopRef,
          ROUND(AVG(COALESCE(d.delay_departure_min, d.delay_arrival_min)), 2) AS avgDelayMin,
          ROUND(MAX(COALESCE(d.delay_departure_min, d.delay_arrival_min)), 2) AS maxDelayMin,
          ROUND(MIN(COALESCE(d.delay_departure_min, d.delay_arrival_min)), 2) AS minDelayMin,
          ROUND(AVG(d.delay_arrival_min), 2)   AS avgDelayArrivalMin,
          ROUND(AVG(d.delay_departure_min), 2)  AS avgDelayDepartureMin,
          ROUND(AVG(d.dwell_time_sec), 1)       AS avgDwellTimeSec,
          COUNT(*)                              AS numSamples,
          COALESCE(MAX(d.stop_name), d.stop_ref) AS stopName
        FROM delays_by_line d
        WHERE d.line_ref = ? AND d.direction_ref = ? AND d.date >= ?
          AND d.stop_ref IN (${ph})
        GROUP BY d.stop_ref
        HAVING COUNT(*) >= 3`,
        [lineRef, directionRef, fromDate],
        { family: "by-line", fromDate });
    },
    staleTime: Infinity,
  });

  // Rekkefølge fra steg 2 påkoblet, og sortert her i stedet for i SQL-en.
  const sequenceByStop = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of canonicalQuery.data ?? []) m.set(r.stop_ref, Number(r.stop_sequence));
    return m;
  }, [canonicalQuery.data]);

  const orderedProfile = useMemo(() => {
    if (!profileQuery.data) return undefined;
    return profileQuery.data
      .map((r) => ({ ...r, stopSequence: sequenceByStop.get(r.stopRef) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.stopSequence - b.stopSequence) as LineStopProfileEntry[];
  }, [profileQuery.data, sequenceByStop]);

  return {
    isLoading: dominantQuery.isLoading || canonicalQuery.isLoading || profileQuery.isLoading,
    error: dominantQuery.error ?? canonicalQuery.error ?? profileQuery.error,
    data: orderedProfile,
  };
}

// ---------------------------------------------------------------------------
// 6 & 7. useWorstJourneysForLine / useBestJourneysForLine
// ---------------------------------------------------------------------------

/**
 * Rangerer avganger på LINJENS RUTETID, ikke service_journey_id.
 *
 * Skyss (SKY) sitt NeTEx-datagrunnlag utsteder tilsynelatende en ny
 * service_journey_id per driftsdøgn for samme rutetabell-slot, i stedet for
 * én stabil ID som gjenbrukes hver dag (bekreftet ved direkte inspeksjon:
 * linje 22s 06:46-avgang hadde 18 ulike service_journey_id-er over 20
 * observerte dager). Å gruppere på service_journey_id (som tidligere) gir
 * derfor nesten utelukkende singleton-grupper (1 observasjon) selv for
 * avganger som i praksis går hver eneste dag — misvisende som "verste
 * enkeltavganger".
 *
 * Grupperer i stedet på (rutetid, første stopp, siste stopp) — den faktiske
 * rutetabell-sloten, uavhengig av hvilken SJ-id den enkelte dagen fikk.
 * Både rutetid OG endestoppene er med i grupperingsnøkkelen fordi samme
 * klokkeslett i sjeldne tilfeller dekker flere ulike rutevarianter.
 */
function useJourneyRankings(
  lineRef: string,
  directionRef: string,
  fromDate: string,
  order: "DESC" | "ASC",
  limit = 15,
  minObservedDays = 1,
) {
  const { query, ready } = useParquetQuery();
  const stats = useQuery<Array<Omit<JourneyRanking, "firstStopName" | "lastStopName"> & { firstStopRef: string; lastStopRef: string }>>({
    queryKey: ["journey-rankings-v2", lineRef, directionRef, fromDate, order, limit, minObservedDays],
    enabled: ready && !!lineRef,
    queryFn: () =>
      query(`
        WITH sj_dep AS (
          SELECT
            service_journey_id,
            arg_min(COALESCE(aimed_departure, aimed_arrival), stop_sequence) AS depTime,
            arg_min(COALESCE(stop_name, stop_ref), stop_sequence) AS firstStopRef,
            arg_max(COALESCE(stop_name, stop_ref), stop_sequence) AS lastStopRef,
            COUNT(DISTINCT stop_ref) AS numStops
          FROM delays_by_line
          WHERE line_ref = ? AND direction_ref = ? AND date >= ?
          GROUP BY service_journey_id
          HAVING COUNT(DISTINCT stop_ref) >= 3
        )
        SELECT
          sd.depTime      AS departureTime,
          sd.firstStopRef AS firstStopRef,
          sd.lastStopRef  AS lastStopRef,
          ROUND(AVG(COALESCE(d.delay_departure_min, d.delay_arrival_min)), 2) AS avgDelayMin,
          COUNT(DISTINCT d.date) AS observedDepartures,
          MAX(d.date)            AS lastDate
        FROM sj_dep sd
        JOIN delays_by_line d ON d.service_journey_id = sd.service_journey_id
        GROUP BY sd.depTime, sd.firstStopRef, sd.lastStopRef
        HAVING observedDepartures >= ?
        ORDER BY avgDelayMin ${order}
        LIMIT ?`,
        [lineRef, directionRef, fromDate, minObservedDays, limit],
        { family: "by-line", fromDate }),
    staleTime: Infinity,
  });

  return {
    ...stats,
    data: stats.data?.map((r) => ({
      departureTime: r.departureTime,
      firstStopName: (r.firstStopRef as string) ?? null,
      lastStopName: (r.lastStopRef as string) ?? null,
      avgDelayMin: r.avgDelayMin,
      observedDepartures: r.observedDepartures,
      lastDate: (r as any).lastDate as string | null,
    })) as JourneyRanking[] | undefined,
  };
}

export function useWorstJourneysForLine(
  lineRef: string,
  directionRef: string,
  fromDate: string,
  limit = 15,
  minObservedDays = 1,
) {
  return useJourneyRankings(lineRef, directionRef, fromDate, "DESC", limit, minObservedDays);
}

export function useBestJourneysForLine(
  lineRef: string,
  directionRef: string,
  fromDate: string,
  limit = 15,
  minObservedDays = 1,
) {
  return useJourneyRankings(lineRef, directionRef, fromDate, "ASC", limit, minObservedDays);
}

// ---------------------------------------------------------------------------
// 8. useLineHourlyAtStop
// ---------------------------------------------------------------------------

export function useLineHourlyAtStop(
  stopRef: string, fromDate: string, stopName?: string,
  lat?: number | null, lng?: number | null,
) {
  const { query, ready } = useParquetQuery();

  // NSR:StopPlace → expand to all quays via /api/stops/lookup (raw fetch, not hook)
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");

  return useQuery<HourlyAtStop[]>({
    queryKey: ["line-hourly-at-stop", stopRef, fromDate, stopName ?? "", lat ?? "", lng ?? ""],
    enabled: ready && !!stopRef,
    queryFn: async () => {
      if (isStopPlace) {
        // Utvid StopPlace → alle barne-quays, så filtrer parquet på dem
        const allQuays = await lookupStops(stopRef, true, stopName, lat, lng);
        const quayList = allQuays.map((q) => `'${q.stopRef.replace(/'/g, "''")}'`).join(",");
        if (!quayList) return [];

        return query<HourlyAtStop>(`
          SELECT line_ref AS lineRef,
            CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) AS hour,
            ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
            COUNT(*) AS numSamples
          FROM delays_by_stop
          WHERE stop_ref IN (${quayList}) AND date >= ?
            AND COALESCE(aimed_departure, aimed_arrival) IS NOT NULL
          GROUP BY line_ref, CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER)
          ORDER BY line_ref, hour`,
          [fromDate],
          { family: "by-stop", fromDate });
      }

      return query<HourlyAtStop>(`
        SELECT line_ref AS lineRef,
          CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) AS hour,
          ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
          COUNT(*) AS numSamples
        FROM delays_by_stop
        WHERE stop_ref = ? AND date >= ?
          AND COALESCE(aimed_departure, aimed_arrival) IS NOT NULL
        GROUP BY line_ref, CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER)
        ORDER BY line_ref, hour`,
        [stopRef, fromDate],
        { family: "by-stop", fromDate });
    },
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// 9. useLinesAtStop
// ---------------------------------------------------------------------------

export function useLinesAtStop(
  stopRef: string, fromDate: string, stopName?: string,
  lat?: number | null, lng?: number | null,
) {
  const { query, ready } = useParquetQuery();
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");

  return useQuery<LineAtStop[]>({
    queryKey: ["lines-at-stop", stopRef, fromDate, stopName ?? "", lat ?? "", lng ?? ""],
    enabled: ready && !!stopRef,
    queryFn: async () => {
      if (isStopPlace) {
        const allQuays = await lookupStops(stopRef, true, stopName, lat, lng);
        const quayList = allQuays.map((q) => `'${q.stopRef.replace(/'/g, "''")}'`).join(",");
        if (!quayList) return [];

        return query<LineAtStop>(`
          SELECT line_ref AS lineRef,
            ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
            COUNT(*) AS numSamples
          FROM delays_by_stop
          WHERE stop_ref IN (${quayList}) AND date >= ?
          GROUP BY line_ref
          ORDER BY avgDelayMin DESC`,
          [fromDate],
          { family: "by-stop", fromDate });
      }

      return query<LineAtStop>(`
        SELECT line_ref AS lineRef,
          ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
          COUNT(*) AS numSamples
        FROM delays_by_stop
        WHERE stop_ref = ? AND date >= ?
        GROUP BY line_ref
        ORDER BY avgDelayMin DESC`,
        [stopRef, fromDate],
        { family: "by-stop", fromDate });
    },
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// 9b. useLineDeparturesAtStop — enkeltobservasjonene bak en linjes snitt
// ---------------------------------------------------------------------------

export interface LineDepartureAtStop {
  date: string;
  dayType: string | null;
  serviceJourneyId: string | null;
  aimedTime: string | null;
  delayArrivalMin: number | null;
  delayDepartureMin: number | null;
}

/** De rå observasjonene bak «N avg.» for én linje ved ett stopp — én rad per
 *  (avgang, dag). Samme populasjon som useLinesAtStop teller, så antallet
 *  matcher. Kjøres kun når brukeren utvider raden (enabled). */
export function useLineDeparturesAtStop(
  lineRef: string,
  stopRef: string,
  fromDate: string,
  enabled: boolean,
  stopName?: string,
  lat?: number | null,
  lng?: number | null,
) {
  const { query, ready } = useParquetQuery();
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");

  return useQuery<LineDepartureAtStop[]>({
    queryKey: ["line-departures-at-stop", lineRef, stopRef, fromDate, stopName ?? "", lat ?? "", lng ?? ""],
    enabled: ready && enabled && !!lineRef && !!stopRef,
    queryFn: async () => {
      let stopCond: string;
      if (isStopPlace) {
        const allQuays = await lookupStops(stopRef, true, stopName, lat, lng);
        const quayList = allQuays
          .map((q) => `'${q.stopRef.replace(/'/g, "''")}'`)
          .join(",");
        if (!quayList) return [];
        stopCond = `stop_ref IN (${quayList})`;
      } else {
        stopCond = `stop_ref = '${stopRef.replace(/'/g, "''")}'`;
      }
      // Kalt fra en stopp-sentrert side (stoppanalyse) — stop_ref er
      // eksakt/enkelt, så by-stop gir best pruning selv om line_ref også
      // er et likhetsfilter.
      return query<LineDepartureAtStop>(`
        SELECT date,
          day_type AS dayType,
          service_journey_id AS serviceJourneyId,
          SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 5) AS aimedTime,
          delay_arrival_min   AS delayArrivalMin,
          delay_departure_min AS delayDepartureMin
        FROM delays_by_stop
        WHERE line_ref = ? AND ${stopCond} AND date >= ?
        ORDER BY date DESC, aimedTime DESC
        LIMIT 100`,
        [lineRef, fromDate],
        { family: "by-stop", fromDate });
    },
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// 10. useCorridorComparison
// ---------------------------------------------------------------------------

export function useCorridorComparison(
  corridor: Array<{ lineRef: string; stopRefs: string[] }>,
  fromDate: string,
) {
  const { query, ready } = useParquetQuery();

  return useQuery<CorridorStop[]>({
    queryKey: ["corridor-comparison", JSON.stringify(corridor), fromDate],
    enabled: ready && corridor.length > 0,
    queryFn: async () => {
      const results: CorridorStop[] = [];

      for (const entry of corridor) {
        if (entry.stopRefs.length === 0) continue;
        const ph = entry.stopRefs.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
        const lineRef = entry.lineRef.replace(/'/g, "''");

        // line_ref er én eksakt verdi (svært selektiv under by-line-sortering),
        // stop_ref-listen er sekundær — by-line vinner her.
        const rows = await query<Omit<CorridorStop, "corridorIndex" | "lineRef"> & { stopRef: string }>(`
          SELECT
            stop_ref AS stopRef,
            COALESCE(MAX(stop_name), stop_ref) AS stopName,
            ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
            ROUND(AVG(delay_arrival_min), 2)   AS avgDelayArrivalMin,
            ROUND(AVG(delay_departure_min), 2)  AS avgDelayDepartureMin,
            ROUND(AVG(dwell_time_sec), 1)       AS avgDwellTimeSec,
            COUNT(*) AS numSamples
          FROM delays_by_line
          WHERE line_ref = '${lineRef}' AND date >= ? AND stop_ref IN (${ph})
          GROUP BY stop_ref`,
          [fromDate],
          { family: "by-line", fromDate });

        const stopMap = new Map(rows.map((r) => [r.stopRef, r]));
        entry.stopRefs.forEach((stopRef, idx) => {
          const data = stopMap.get(stopRef);
          results.push({
            lineRef: entry.lineRef,
            stopRef,
            stopName: data?.stopName ?? null,
            corridorIndex: idx,
            avgDelayMin: data?.avgDelayMin ?? null,
            avgDelayArrivalMin: data?.avgDelayArrivalMin ?? null,
            avgDelayDepartureMin: data?.avgDelayDepartureMin ?? null,
            avgDwellTimeSec: data?.avgDwellTimeSec ?? null,
            numSamples: data?.numSamples ?? 0,
          });
        });
      }

      return results;
    },
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// 11. useTripStopStats
// ---------------------------------------------------------------------------

export function useTripStopStats(stops: Array<{ stopRef: string; lineRef: string }>) {
  const { query, ready } = useParquetQuery();

  return useQuery<TripStopStat[]>({
    queryKey: ["trip-stop-stats", stops.map((s) => `${s.lineRef}@${s.stopRef}`).join(",")],
    enabled: ready && stops.length > 0,
    queryFn: () => {
      const conditions = stops
        .map((s) => `(stop_ref = '${s.stopRef.replace(/'/g, "''")}' AND line_ref = '${s.lineRef.replace(/'/g, "''")}')`)
        .join(" OR ");
      const cutoff = daysAgo(91);
      // Blandet sett med (stopp, linje)-par fra en hel reise — verken
      // sortering vinner konsekvent, by-stop som default er like godt.
      return query<TripStopStat>(`
        SELECT
          stop_ref AS stopRef,
          line_ref AS lineRef,
          ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
          ROUND(AVG(delay_arrival_min), 2)   AS avgDelayArrivalMin,
          ROUND(AVG(delay_departure_min), 2)  AS avgDelayDepartureMin,
          ROUND(AVG(dwell_time_sec), 1)       AS avgDwellTimeSec,
          COUNT(*) AS numSamples
        FROM delays_by_stop
        WHERE date >= '${cutoff}' AND (${conditions})
        GROUP BY stop_ref, line_ref`,
        undefined,
        { family: "by-stop", fromDate: cutoff });
    },
    staleTime: Infinity,
  });
}
