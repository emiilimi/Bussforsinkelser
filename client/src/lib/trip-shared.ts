// ---------------------------------------------------------------------------
// Delte typer og DuckDB-spørringer for reiseplanleggeren.
//
// Skilt ut fra pages/trip-planner.tsx slik at plan-graf-komponenten og
// reiseanalyse-dialogen kan gjenbruke dem uten sirkulære imports.
// ---------------------------------------------------------------------------

import type { QueryOptions } from "@/hooks/use-parquet-query";

// ---------------------------------------------------------------------------
// Entur trip-typer (speiler GraphQL-responsen fra /api/trip)
// ---------------------------------------------------------------------------

type Quay = { id: string; name: string; publicCode?: string | null };

export type TripLeg = {
  mode: string;
  transportSubmode: string | null;
  fromPlace: { name: string; quay: Quay | null };
  toPlace: { name: string; quay: Quay | null };
  line: { id: string; publicCode: string; name: string } | null;
  expectedStartTime: string;
  expectedEndTime: string;
  duration: number;
  distance: number;
  intermediateQuays: Array<Quay>;
  serviceJourney: {
    id: string;
    passingTimes: Array<{
      quay: { id: string } | null;
      departure: { time: string; dayOffset: number | null } | null;
      arrival: { time: string; dayOffset: number | null } | null;
    }>;
  } | null;
};

export type TripPattern = {
  expectedStartTime: string;
  expectedEndTime: string;
  duration: number;
  legs: TripLeg[];
};

export type DuckDelayRow = {
  stop_ref: string;
  line_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p95_dep: number | null;
  p50_arr: number | null;
  p80_arr: number | null;
  p95_arr: number | null;
  n: number;
};

export type StopEntry = { id: string; name: string; platform: string | null; aimedTime: string | null };

export type DuckQueryFn = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  options?: QueryOptions,
) => Promise<T[]>;

/** Alle stopp langs et transit-legg (første + mellomliggende + siste), med
 *  rutetid (ISO) fra serviceJourney.passingTimes der den finnes. */
export function legStops(leg: TripLeg): StopEntry[] {
  const passingTimeMap = new Map<string, string>();
  if (leg.serviceJourney?.passingTimes?.length) {
    const baseDate = leg.expectedStartTime.slice(0, 10); // YYYY-MM-DD
    for (const pt of leg.serviceJourney.passingTimes) {
      if (!pt.quay?.id) continue;
      const td = pt.departure ?? pt.arrival;
      if (!td?.time) continue;
      // time er "HH:MM:SS", dayOffset 0/1 for over midnatt
      const [hStr, mStr, sStr] = td.time.split(":");
      const dateObj = new Date(`${baseDate}T00:00:00`);
      dateObj.setDate(dateObj.getDate() + (td.dayOffset ?? 0));
      dateObj.setHours(parseInt(hStr, 10), parseInt(mStr, 10), parseInt(sStr ?? "0", 10));
      passingTimeMap.set(pt.quay.id, dateObj.toISOString());
    }
  }
  const entry = (q: Quay, aimedTime: string | null): StopEntry => ({
    id: q.id,
    name: q.name,
    platform: q.publicCode ?? null,
    aimedTime,
  });
  return [
    leg.fromPlace.quay
      ? entry(leg.fromPlace.quay, passingTimeMap.get(leg.fromPlace.quay.id) ?? leg.expectedStartTime)
      : null,
    ...leg.intermediateQuays.map((q) => entry(q, passingTimeMap.get(q.id) ?? null)),
    leg.toPlace.quay
      ? entry(leg.toPlace.quay, passingTimeMap.get(leg.toPlace.quay.id) ?? leg.expectedEndTime)
      : null,
  ].filter(Boolean) as StopEntry[];
}

export function escSql(s: string) {
  return s.replace(/'/g, "''");
}

/** Minutter siden midnatt (kan være >1440 eller desimal) → "HH:MM". */
export function minutesToHM(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Empirisk overgangs-suksess: per-dag-paring (IKKE poolet per (stopp, linje)).
//
// For hver overgang vil vi ha én observasjon per historisk dag der BÅDE
// ankommende og avgående avgang faktisk gikk:
//
//     gap_min = (faktisk avgang ved depQuay) − (faktisk ankomst ved arrQuay)
//
// Deretter P(rekker) = #dager der gap_min ≥ gangtid + margin / #dager totalt.
//
// Primærvei matcher begge serviceJourney-IDene eksakt. Fallback når SJ-paret
// har for få observasjoner: pool per (linje, stopp, dagtype), fortsatt paret
// per dato — velg raden med rutetid nærmest planens rutetid.
// ---------------------------------------------------------------------------

export type TransferGapObservation = {
  date: string;              // YYYY-MM-DD
  gap: number;               // minutter
  arrActualMin: number | null; // faktisk ankomst, min siden midnatt (kun "specific")
  depActualMin: number | null; // faktisk avgang, min siden midnatt (kun "specific")
};

export type TransferGapResult = {
  gaps: number[];                        // gap (minutter) per historisk dag
  observations: TransferGapObservation[]; // samme dager, nyeste først
  source: "specific" | "fallback" | "none";
};

export type TransferSpec = {
  key: string;                   // unik id per overgang (cache-/map-nøkkel)
  arrSjId: string | null;        // serviceJourney.id for ankommende legg
  arrQuayRef: string | null;     // toPlace.quay.id for ankommende legg
  arrLineRef: string | null;     // line.id for ankommende legg (fallback)
  arrAimedMin: number | null;    // planlagt ankomst i min-siden-midnatt (fallback nærmest-match)
  depSjId: string | null;        // serviceJourney.id for avgående legg
  depQuayRef: string | null;     // fromPlace.quay.id for avgående legg
  depLineRef: string | null;     // line.id for avgående legg (fallback)
  depAimedMin: number | null;    // planlagt avgang i min-siden-midnatt
  dayType: string;               // 'weekday'|'saturday'|'sunday'|'holiday'|'may17'
};

export const SPECIFIC_MIN_DAYS = 5; // under dette: fall tilbake til time-pooling

/** SQL for primærveien (per-SJ). null hvis nødvendige ID-er mangler.
 *  day_type filtreres slik at f.eks. en onsdagsreise ikke plukker opp
 *  lørdagsobservasjoner. Returnerer (date, gap, arr_min, dep_min). */
export function specificGapSql(s: TransferSpec): string | null {
  if (!s.arrSjId || !s.arrQuayRef || !s.depSjId || !s.depQuayRef) return null;
  return `
    WITH arr AS (
      SELECT date,
        (CAST(SUBSTR(aimed_arrival, 1, 2) AS INTEGER) * 60 +
         CAST(SUBSTR(aimed_arrival, 4, 2) AS INTEGER)) + delay_arrival_min AS actual_arr_min
      FROM delays_by_stop
      WHERE service_journey_id = '${escSql(s.arrSjId)}'
        AND stop_ref = '${escSql(s.arrQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_arrival IS NOT NULL AND delay_arrival_min IS NOT NULL
    ),
    dep AS (
      SELECT date,
        (CAST(SUBSTR(aimed_departure, 1, 2) AS INTEGER) * 60 +
         CAST(SUBSTR(aimed_departure, 4, 2) AS INTEGER)) + delay_departure_min AS actual_dep_min
      FROM delays_by_stop
      WHERE service_journey_id = '${escSql(s.depSjId)}'
        AND stop_ref = '${escSql(s.depQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_departure IS NOT NULL AND delay_departure_min IS NOT NULL
    )
    SELECT arr.date AS date,
           (dep.actual_dep_min - arr.actual_arr_min) AS gap,
           arr.actual_arr_min AS arr_min,
           dep.actual_dep_min AS dep_min
    FROM arr INNER JOIN dep ON arr.date = dep.date
  `;
}

/** Fallback: pool per linje + stopp + dagtype. For hver dato velges den
 *  ankomsten/avgangen hvis rutetid ligger nærmest planens rutetid (±60 min),
 *  og forsinkelsene deres brukes som PROXY for planens avganger:
 *
 *      gap_dag = planlagt_gap + (avgangsforsinkelse − ankomstforsinkelse)
 *
 *  VIKTIG: vi sammenlikner IKKE absolutte klokkeslett på tvers av avganger.
 *  De valgte observasjonene er andre rutepassinger enn planens (nærmeste med
 *  data kan ligge en halvtime unna i ruteplanen), så klokkeslettene deres
 *  måler gapet til en annen avgang enn den brukeren skal rekke. Det eneste
 *  som er overførbart fra en naboavgang er forsinkelsen dens; delay-proxyen
 *  beholder planens gap og justerer kun med observerte forsinkelser.
 *  Returnerer (date, gap, arr_min=NULL, dep_min=NULL). */
export function fallbackGapSql(s: TransferSpec): string | null {
  if (!s.arrLineRef || !s.arrQuayRef || !s.depLineRef || !s.depQuayRef) return null;
  if (s.arrAimedMin == null || s.depAimedMin == null) return null;
  const HALF_WINDOW = 60; // minutter til hver side
  const arrLo = s.arrAimedMin - HALF_WINDOW;
  const arrHi = s.arrAimedMin + HALF_WINDOW;
  const depLo = s.depAimedMin - HALF_WINDOW;
  const depHi = s.depAimedMin + HALF_WINDOW;
  // Planlagt gap i minutter; overganger over midnatt gir negativ diff → +24t
  let plannedGap = s.depAimedMin - s.arrAimedMin;
  if (plannedGap < -720) plannedGap += 1440;
  // Samme retning: ~7 % av (linje, stopp)-kombinasjoner har trafikk i begge
  // retninger på samme plattform. direction_ref-verdiene varierer per operatør
  // ('1'/'2', 'Outbound'/'Inbound', ...), så i stedet for å mappe Enturs
  // directionType slår vi opp retningen den PLANLAGTE avgangen selv er
  // registrert med i dataene. Ukjent SJ → COALESCE gjør vilkåret til no-op.
  const dirClause = (sjId: string | null) =>
    sjId
      ? `AND direction_ref IS NOT DISTINCT FROM COALESCE(
           (SELECT ANY_VALUE(direction_ref) FROM delays_by_stop
            WHERE service_journey_id = '${escSql(sjId)}'),
           direction_ref)`
      : "";
  return `
    WITH arr_raw AS (
      SELECT date, delay_arrival_min AS arr_delay,
        (CAST(SUBSTR(aimed_arrival, 1, 2) AS INTEGER) * 60 +
         CAST(SUBSTR(aimed_arrival, 4, 2) AS INTEGER)) AS aimed_min
      FROM delays_by_stop
      WHERE line_ref = '${escSql(s.arrLineRef)}'
        AND stop_ref = '${escSql(s.arrQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_arrival IS NOT NULL AND delay_arrival_min IS NOT NULL
        ${dirClause(s.arrSjId)}
    ),
    arr AS (
      SELECT date, arr_delay FROM arr_raw
      WHERE aimed_min BETWEEN ${arrLo} AND ${arrHi}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY date ORDER BY ABS(aimed_min - ${s.arrAimedMin})) = 1
    ),
    dep_raw AS (
      SELECT date, delay_departure_min AS dep_delay,
        (CAST(SUBSTR(aimed_departure, 1, 2) AS INTEGER) * 60 +
         CAST(SUBSTR(aimed_departure, 4, 2) AS INTEGER)) AS aimed_min
      FROM delays_by_stop
      WHERE line_ref = '${escSql(s.depLineRef)}'
        AND stop_ref = '${escSql(s.depQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_departure IS NOT NULL AND delay_departure_min IS NOT NULL
        ${dirClause(s.depSjId)}
    ),
    dep AS (
      SELECT date, dep_delay FROM dep_raw
      WHERE aimed_min BETWEEN ${depLo} AND ${depHi}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY date ORDER BY ABS(aimed_min - ${s.depAimedMin})) = 1
    )
    SELECT arr.date AS date,
           (${plannedGap} + dep.dep_delay - arr.arr_delay) AS gap,
           NULL AS arr_min,
           NULL AS dep_min
    FROM arr INNER JOIN dep ON arr.date = dep.date
  `;
}

type CombinedGapRow = {
  src: "S" | "F";
  date: unknown;
  gap: number | null;
  arr_min: number | null;
  dep_min: number | null;
};

/** Parquet-datoer kan komme tilbake som streng, Date eller epoch-ms avhengig
 *  av Arrow-typen — normaliser til YYYY-MM-DD. */
function normalizeDate(d: unknown): string {
  if (typeof d === "string") return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "number") return new Date(d).toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Hent gap-fordelingen for én overgang i ÉN DuckDB-rundtur: primær (per-SJ)
 * og fallback UNION-es med en kildekolonne, og valget mellom dem tas
 * klientside. (Tidligere to sekvensielle spørringer per overgang.)
 */
export async function computeTransferGap(
  s: TransferSpec,
  duckQuery: DuckQueryFn,
): Promise<TransferGapResult> {
  const parts: string[] = [];
  const sSql = specificGapSql(s);
  const fSql = fallbackGapSql(s);
  if (sSql) parts.push(`SELECT 'S' AS src, date, gap, arr_min, dep_min FROM (${sSql})`);
  if (fSql) parts.push(`SELECT 'F' AS src, date, gap, arr_min, dep_min FROM (${fSql})`);
  if (parts.length === 0) return { gaps: [], observations: [], source: "none" };

  const rows = (await duckQuery(parts.join("\nUNION ALL\n"), undefined, {
    family: "by-stop",
  })) as CombinedGapRow[];

  const toObs = (r: CombinedGapRow): TransferGapObservation => ({
    date: normalizeDate(r.date),
    gap: Number(r.gap),
    arrActualMin: r.arr_min != null ? Number(r.arr_min) : null,
    depActualMin: r.dep_min != null ? Number(r.dep_min) : null,
  });
  const specific = rows.filter((r) => r.src === "S" && Number.isFinite(Number(r.gap))).map(toObs);
  const fallback = rows.filter((r) => r.src === "F" && Number.isFinite(Number(r.gap))).map(toObs);

  let observations: TransferGapObservation[];
  let source: TransferGapResult["source"];
  if (specific.length >= SPECIFIC_MIN_DAYS) {
    observations = specific;
    source = "specific";
  } else if (fallback.length > 0) {
    observations = fallback;
    source = "fallback";
  } else {
    // Samme semantikk som før: for få SJ-treff og tom fallback → "none",
    // men de få gap-ene vi har brukes fortsatt (med usikkerhetsvarsel i UI).
    observations = specific;
    source = "none";
  }
  observations = [...observations].sort((a, b) => (a.date < b.date ? 1 : -1));
  return { gaps: observations.map((o) => o.gap), observations, source };
}

/** Gap-fordelinger for alle overganger i et reiseforslag (sekvensielt —
 *  DuckDB-workeren er én tråd uansett). */
export async function computeTransferGaps(
  specs: TransferSpec[],
  duckQuery: DuckQueryFn,
): Promise<Map<string, TransferGapResult>> {
  const out = new Map<string, TransferGapResult>();
  for (const s of specs) {
    out.set(s.key, await computeTransferGap(s, duckQuery));
  }
  return out;
}

/** Empirisk overgangssannsynlighet: andel historiske dager der det faktiske
 *  gapet var minst nødvendig buffer (gange + margin). -1 = ukjent. */
export function probFromGaps(gaps: number[], requiredBuffer: number): number {
  if (gaps.length === 0) return -1;
  let made = 0;
  for (const g of gaps) {
    if (g >= requiredBuffer) made++;
  }
  return made / gaps.length;
}
