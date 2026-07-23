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
  arrActualMin: number | null; // faktisk målt ankomst, min siden midnatt
  depActualMin: number | null; // faktisk målt avgang, min siden midnatt
};

/**
 * Hvor godt observasjonene treffer BRUKERENS avgang:
 *  - "sj"    — samme faktiske avgang, matchet på stabil avgangs-id. Best.
 *  - "aimed" — samme faktiske avgang, matchet på eksakt rutetid + linje +
 *              stopp + retning (brukes når avgangs-id-en ikke gir nok dager,
 *              f.eks. rett etter en ruteendring).
 *  - "pool"  — IKKE brukerens avgang: sammenlignbare naboavganger innen
 *              ±60 min. Kun forsinkelsen deres er overførbar, så klokkeslett
 *              vises ikke.
 */
export type TransferGapSource = "sj" | "aimed" | "pool" | "none";

export type TransferGapTrack = {
  gaps: number[];
  observations: TransferGapObservation[]; // nyeste først
  days: number;
};

export type TransferGapResult = {
  // Den valgte kilden — det som driver badges og totalsannsynlighet.
  gaps: number[];
  observations: TransferGapObservation[];
  source: TransferGapSource;
  /**
   * Begge sporene beholdes alltid, slik at UI-et kan vise dem side om side.
   * `actual` = brukerens EGNE avganger (stabil id, ev. eksakt rutetid);
   * `pool` = ±60 min naboavganger. Backtest (STATUS.md 2026-07-23) viste at
   * poolen i praksis plukker brukerens egen avgang når den gikk, så sporene
   * er ofte like — forskjellen er hovedsakelig hvor mange dager de har.
   */
  actual: TransferGapTrack & { source: "sj" | "aimed" | "none" };
  pool: TransferGapTrack;
};

/** Er kilden faktiske observasjoner av brukerens egen avgang? */
export function isActualDepartureSource(s: TransferGapSource): boolean {
  return s === "sj" || s === "aimed";
}

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

export const SPECIFIC_MIN_DAYS = 5; // under dette: prøv neste matche-nivå

/**
 * Stabil avgangs-id fra en Entur ServiceJourney-id.
 *
 * Skyss' id-er har formen `SKY:ServiceJourney:{linje}-{datasettversjon}-{avgang}`,
 * og MIDTERSTE ledd (datasettversjonen) endres nesten daglig når ruteplanen
 * republiseres. Samme 10:00-avgang på linje 20 dukket opp under 23 ulike id-er
 * på 35 dager. Siste ledd er derimot stabilt (19135528 = hverdagsavgangen
 * 10:00) og bytter bare ved ekte ruteendring — som er ønsket, da en omlagt
 * avgang ikke skal slås sammen med sin gamle utgave.
 *
 * Id-er uten bindestrek (andre operatører) returneres uendret, så matchingen
 * blir da identisk med eksakt id-match.
 */
export function stableSjId(sjId: string): string {
  const lastDash = sjId.lastIndexOf("-");
  return lastDash >= 0 ? sjId.slice(lastDash + 1) : sjId;
}

/** Minutter-siden-midnatt-uttrykk for en "HH:MM:SS"-kolonne. */
function aimedMinExpr(col: string): string {
  return `(CAST(SUBSTR(${col}, 1, 2) AS INTEGER) * 60 + CAST(SUBSTR(${col}, 4, 2) AS INTEGER))`;
}

/**
 * Predikat som matcher alle datasettversjoner av samme avgang.
 *
 * ENDS_WITH (ikke REGEXP_EXTRACT): predikatet kjøres på hver rad som overlever
 * stop_ref-pruningen; målt lokalt over 7 ukefiler var regex ~15 % tregere
 * (235 ms mot 204 ms) med identisk resultat. Bindestreken er med i mønsteret
 * så '-19135528' ikke også treffer '...-119135528'. Or-grenen dekker
 * operatører uten bindestrek i id-en, der hele id-en ER den stabile id-en.
 *
 * MERK: predikatet kan uansett ikke brukes til radgruppe-pruning (i motsetning
 * til eksakt id-likhet). Pruningen kommer fra stop_ref, som er sorteringsnøkkel
 * i by-stop-familien — derfor MÅ disse spørringene kjøre mot den familien.
 */
function stableSjPredicate(stable: string): string {
  const esc = escSql(stable);
  return `(service_journey_id = '${esc}' OR ENDS_WITH(service_journey_id, '-${esc}'))`;
}

/** Overganger over midnatt gir stort negativt gap — legg til et døgn. */
function midnightSafeGap(expr: string): string {
  return `CASE WHEN (${expr}) < -720 THEN (${expr}) + 1440 ELSE (${expr}) END`;
}

/**
 * Samme retning som den planlagte avgangen. direction_ref-verdiene varierer
 * per operatør ('1'/'2', 'Outbound'/'Inbound', ...), så i stedet for å mappe
 * Enturs directionType slår vi opp retningen den PLANLAGTE avgangen selv er
 * registrert med. Ukjent SJ → COALESCE gjør vilkåret til no-op.
 */
function dirClause(sjId: string | null, quayRef: string | null): string {
  if (!sjId) return "";
  // stop_ref MÅ være med: uten den kan ikke denne korrelerte underspørringen
  // radgruppe-prunes, og den fullskanner hver eneste ukefil. Det er
  // sorteringsnøkkelen i by-stop-familien som gir pruningen. (Uten dette
  // hang overgangsspørringene i praksis — se STATUS.md 2026-07-23.)
  // Retningen er en egenskap ved avgangen, så det er trygt å slå den opp på
  // et vilkårlig stopp avgangen betjener.
  const quay = quayRef ? ` AND stop_ref = '${escSql(quayRef)}'` : "";
  return `AND direction_ref IS NOT DISTINCT FROM COALESCE(
    (SELECT ANY_VALUE(direction_ref) FROM delays_by_stop
     WHERE service_journey_id = '${escSql(sjId)}'${quay}),
    direction_ref)`;
}

/**
 * Nivå 1 — BRUKERENS EGEN AVGANG, matchet på stabil avgangs-id.
 * day_type filtreres slik at f.eks. en onsdagsreise ikke plukker opp
 * lørdagsobservasjoner. Returnerer faktisk målte tider (date, gap, arr_min, dep_min).
 */
export function sjGapSql(s: TransferSpec): string | null {
  if (!s.arrSjId || !s.arrQuayRef || !s.depSjId || !s.depQuayRef) return null;
  const arrStable = stableSjId(s.arrSjId);
  const depStable = stableSjId(s.depSjId);
  const gap = "dep.actual_dep_min - arr.actual_arr_min";
  return `
    WITH arr AS (
      SELECT date, ${aimedMinExpr("aimed_arrival")} + delay_arrival_min AS actual_arr_min
      FROM delays_by_stop
      WHERE ${stableSjPredicate(arrStable)}
        AND stop_ref = '${escSql(s.arrQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_arrival IS NOT NULL AND delay_arrival_min IS NOT NULL
    ),
    dep AS (
      SELECT date, ${aimedMinExpr("aimed_departure")} + delay_departure_min AS actual_dep_min
      FROM delays_by_stop
      WHERE ${stableSjPredicate(depStable)}
        AND stop_ref = '${escSql(s.depQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_departure IS NOT NULL AND delay_departure_min IS NOT NULL
    )
    SELECT arr.date AS date,
           ${midnightSafeGap(gap)} AS gap,
           arr.actual_arr_min AS arr_min,
           dep.actual_dep_min AS dep_min
    FROM arr INNER JOIN dep ON arr.date = dep.date
  `;
}

/**
 * Nivå 2 — BRUKERENS EGEN AVGANG, matchet på EKSAKT rutetid + linje + stopp +
 * retning. Brukes når avgangs-id-en ikke gir nok dager (typisk rett etter en
 * ruteendring, der id-en er ny). Fortsatt faktiske målte tider — dette er
 * "10:00-avgangen på linje 20", ikke en nabo innen ±60 min.
 */
export function aimedGapSql(s: TransferSpec): string | null {
  if (!s.arrLineRef || !s.arrQuayRef || !s.depLineRef || !s.depQuayRef) return null;
  if (s.arrAimedMin == null || s.depAimedMin == null) return null;
  const gap = "dep.actual_dep_min - arr.actual_arr_min";
  return `
    WITH arr AS (
      SELECT date, ${aimedMinExpr("aimed_arrival")} + delay_arrival_min AS actual_arr_min
      FROM delays_by_stop
      WHERE line_ref = '${escSql(s.arrLineRef)}'
        AND stop_ref = '${escSql(s.arrQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_arrival IS NOT NULL AND delay_arrival_min IS NOT NULL
        AND ${aimedMinExpr("aimed_arrival")} = ${s.arrAimedMin}
        ${dirClause(s.arrSjId, s.arrQuayRef)}
    ),
    dep AS (
      SELECT date, ${aimedMinExpr("aimed_departure")} + delay_departure_min AS actual_dep_min
      FROM delays_by_stop
      WHERE line_ref = '${escSql(s.depLineRef)}'
        AND stop_ref = '${escSql(s.depQuayRef)}'
        AND day_type = '${escSql(s.dayType)}'
        AND aimed_departure IS NOT NULL AND delay_departure_min IS NOT NULL
        AND ${aimedMinExpr("aimed_departure")} = ${s.depAimedMin}
        ${dirClause(s.depSjId, s.depQuayRef)}
    )
    SELECT arr.date AS date,
           ${midnightSafeGap(gap)} AS gap,
           arr.actual_arr_min AS arr_min,
           dep.actual_dep_min AS dep_min
    FROM arr INNER JOIN dep ON arr.date = dep.date
  `;
}

/** Nivå 3 — POOL: IKKE brukerens avgang. Per linje + stopp + dagtype velges
 *  for hver dato den ankomsten/avgangen hvis rutetid ligger nærmest planens
 *  (±60 min), og forsinkelsene deres brukes som PROXY:
 *
 *      gap_dag = planlagt_gap + (avgangsforsinkelse − ankomstforsinkelse)
 *
 *  VIKTIG: vi sammenlikner IKKE absolutte klokkeslett på tvers av avganger.
 *  De valgte observasjonene er andre rutepassinger enn planens (nærmeste med
 *  data kan ligge en halvtime unna i ruteplanen), så klokkeslettene deres
 *  måler gapet til en annen avgang enn den brukeren skal rekke. Det eneste
 *  som er overførbart fra en naboavgang er forsinkelsen dens; delay-proxyen
 *  beholder planens gap og justerer kun med observerte forsinkelser.
 *  Derfor returneres arr_min/dep_min som NULL — UI-et skal aldri vise
 *  klokkeslett for denne kilden. */
export function poolGapSql(s: TransferSpec): string | null {
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
        ${dirClause(s.arrSjId, s.arrQuayRef)}
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
        ${dirClause(s.depSjId, s.depQuayRef)}
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
  src: "S" | "A" | "P";
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
 * Hent gap-fordelingen for én overgang i ÉN DuckDB-rundtur.
 *
 * Tre matche-nivåer UNION-es med en kildekolonne, og valget tas klientside:
 *   'S' stabil avgangs-id   → brukerens egen avgang (best)
 *   'A' eksakt rutetid      → brukerens egen avgang (når id-en er for fersk)
 *   'P' ±60 min-pool        → NABOavganger, kun forsinkelsen er overførbar
 *
 * Nivå 1 og 2 velges først når de har minst SPECIFIC_MIN_DAYS dager. Poolen
 * brukes bare som siste utvei, og merkes i UI.
 */
export async function computeTransferGap(
  s: TransferSpec,
  duckQuery: DuckQueryFn,
): Promise<TransferGapResult> {
  const parts: string[] = [];
  const sSql = sjGapSql(s);
  const aSql = aimedGapSql(s);
  const pSql = poolGapSql(s);
  if (sSql) parts.push(`SELECT 'S' AS src, date, gap, arr_min, dep_min FROM (${sSql})`);
  if (aSql) parts.push(`SELECT 'A' AS src, date, gap, arr_min, dep_min FROM (${aSql})`);
  if (pSql) parts.push(`SELECT 'P' AS src, date, gap, arr_min, dep_min FROM (${pSql})`);
  const emptyTrack: TransferGapTrack = { gaps: [], observations: [], days: 0 };
  if (parts.length === 0) {
    return {
      gaps: [], observations: [], source: "none",
      actual: { ...emptyTrack, source: "none" }, pool: emptyTrack,
    };
  }

  const rows = (await duckQuery(parts.join("\nUNION ALL\n"), undefined, {
    family: "by-stop",
  })) as CombinedGapRow[];

  const toObs = (r: CombinedGapRow): TransferGapObservation => ({
    date: normalizeDate(r.date),
    gap: Number(r.gap),
    arrActualMin: r.arr_min != null ? Number(r.arr_min) : null,
    depActualMin: r.dep_min != null ? Number(r.dep_min) : null,
  });
  // Dedupliser til én observasjon per dato i JS i stedet for med QUALIFY i
  // SQL-en. Nivå 1/2 kan i sjeldne tilfeller gi to rader på samme dato (samme
  // stabile id kjørt to ganger). QUALIFY direkte på `FROM delays_by_stop` fikk
  // DuckDB-WASM-spørringen til å aldri fullføre — den løser seg aldri, og
  // uten feil å fange ble kortene stående på "beregner…". Poolen beholder sin
  // QUALIFY: den ligger på en allerede materialisert CTE og har alltid virket.
  const pick = (tag: CombinedGapRow["src"]) => {
    const seen = new Set<string>();
    const out: TransferGapObservation[] = [];
    for (const r of rows) {
      if (r.src !== tag || !Number.isFinite(Number(r.gap))) continue;
      const o = toObs(r);
      if (seen.has(o.date)) continue;
      seen.add(o.date);
      out.push(o);
    }
    return out;
  };
  const bySj = pick("S");
  const byAimed = pick("A");
  const byPool = pick("P");

  const newest = (o: TransferGapObservation[]) =>
    [...o].sort((a, b) => (a.date < b.date ? 1 : -1));
  const track = (o: TransferGapObservation[]): TransferGapTrack => {
    const s = newest(o);
    return { gaps: s.map((x) => x.gap), observations: s, days: s.length };
  };
  // Brukerens egne avganger: stabil id foretrekkes, ellers eksakt rutetid.
  const actualObs = bySj.length >= byAimed.length ? bySj : byAimed;
  const actualSource: "sj" | "aimed" | "none" =
    actualObs.length === 0 ? "none" : actualObs === bySj ? "sj" : "aimed";
  const actual = { ...track(actualObs), source: actualSource };
  const pool = track(byPool);

  let observations: TransferGapObservation[];
  let source: TransferGapSource;
  if (bySj.length >= SPECIFIC_MIN_DAYS) {
    observations = bySj;
    source = "sj";
  } else if (byAimed.length >= SPECIFIC_MIN_DAYS) {
    observations = byAimed;
    source = "aimed";
  } else if (byPool.length > 0) {
    observations = byPool;
    source = "pool";
  } else {
    // Ingen av nivåene ga nok — bruk det beste vi har av faktiske
    // observasjoner (kan være 0). UI viser usikkerhetsvarsel ved få dager.
    const best = bySj.length >= byAimed.length ? bySj : byAimed;
    observations = best;
    source = best.length > 0 ? (best === bySj ? "sj" : "aimed") : "none";
  }
  observations = [...observations].sort((a, b) => (a.date < b.date ? 1 : -1));
  return {
    gaps: observations.map((o) => o.gap),
    observations,
    source,
    actual,
    pool,
  };
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
