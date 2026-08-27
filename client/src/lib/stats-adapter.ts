// ---------------------------------------------------------------------------
// Full offload: server analysesidenes /api/*-endepunkter fra statiske
// artefakter på R2 (stats_summary.json, stats_stops_map.json) + DuckDB-WASM,
// i stedet for Express/SQLite. Brukes KUN i reise-bygget (IS_REISE):
// queryClient prøver statsAdapterFetch(url) først; `undefined` = ikke et
// endepunkt vi håndterer → vanlig fetch.
//
// Responsformene speiler det gamle Express-API-et slik at sidene
// (dashboard.tsx, worst-lists.tsx, delay-map.tsx, journey-details.tsx)
// er uendret. Prosenter er 0–100. Felter som ikke finnes i datagrunnlaget
// (totalCancellations, per-linje sanntidsdekning) er null.
// ---------------------------------------------------------------------------

import {
  PARQUET_BASE, standaloneDuckQuery, ensureParquetFilesRegistered, latestAvailableDate,
  type DelayFamily,
} from "@/hooks/use-parquet-query";
import { computeDayType, dayTypePredicate } from "@/lib/day-type";
import { fetchStopDetail, snapToWindow, offsetToDate } from "@/lib/stop-detail";

// ---------------------------------------------------------------------------
// «For tidlig»-terskel
//
// Mer enn ETT minutt før rutetid. Under det er tallet stort sett
// avrundingsstøy: målt over 12,2 mill. observasjoner er 7,7 % negative i det
// hele tatt, men bare 2,8 % ligger under -1 min.
//
// Hvorfor det er verdt en egen måling: en avgang som går for tidlig kan man
// ikke rekke, uansett hvor presis man selv er. Den teller likevel som «i rute»
// i dagens definisjon (forsinkelse <= 2 min), så uten dette tallet er den
// usynlig. Andelen varierer voldsomt mellom transportmidler — målt uke 33-34:
// fly 61,6 %, ferje 9,4 %, buss 2,7 %, tog 1,2 %, bybane 0,1 %.
// ---------------------------------------------------------------------------
export const EARLY_MIN = -1;

// ---------------------------------------------------------------------------
// Artefakt-typer
// ---------------------------------------------------------------------------

type DailyRow = {
  date: string;
  operator: string;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  totalJourneys: number;
  n: number;
  pctRealtimeCoverage: number | null;
  pctEarly: number | null;
  // Avlyste avganger (unike per dag/operatør) — null for dager før målingen startet
  totalCancellations?: number | null;
  // Avganger i feeden helt uten sanntid (ikke avlyst) — null før målingen startet
  journeysMissingRealtime?: number | null;
};

type LineRow = {
  lineRef: string;
  mode: string;
  window: number;
  avgDelayMin: number | null;
  stddevDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  pctEarly: number | null;
  totalDepartures: number;
};

type Summary = {
  generatedAt: string;
  windows: number[];
  dates: { min: string; max: string };
  daily: DailyRow[];
  lines: LineRow[];
  /** Sanntidsdekning i prosent per linje, én verdi per vindu i `windows`.
   *  Mangler i artefakter laget før feltet fantes — behandles som tomt. */
  coverage?: Record<string, Array<number | null>>;
};

// Kompakt radformat: [stopRef, operator, stopName, lat, lng, w7, w30, w90,
//                     spRef, platformCode, spName]
// der wN = [avgDelayMin, pctDelayed2plus, stddevDelayMin, totalDepartures] | null.
// De tre siste (etter vinduene) er stoppested-metadata for stoppanalyse-søket:
// spRef er kompaktet til bare tallet i NSR:StopPlace:N, spName er null når det
// er likt stopName. Eldre artefakter mangler dem — behandles som null.
type StopWindowStats = [number | null, number | null, number | null, number] | null;
type StopRow = [
  string, string, string | null, number | null, number | null,
  ...Array<StopWindowStats | number | string | null>,
];

type StopsDoc = {
  generatedAt: string;
  windows: number[];
  stops: StopRow[];
};

// {line_ref: navn} — SKY fra NeTEx, resten DB-derivert (dominerende
// endeholdeplass-par). Se pipeline/aggregate_stats.py::build_line_names.
type LineNamesDoc = Record<string, string>;

// ---------------------------------------------------------------------------
// Artefakt-henting (én gang per sesjon). cache: "no-cache" = alltid
// revalider mot serveren (ETag), men GJENBRUK cachet innhold ved 304 —
// i motsetning til "no-store" som lastet hele 2-7 MB på nytt ved hver
// eneste sidelast. Ferskhet bevares (ny ETag når artefakten endres
// nattlig); gjentatte besøk koster bare et lite revalideringskall.
// ---------------------------------------------------------------------------

let summaryPromise: Promise<Summary> | null = null;
let stopsPromise: Promise<StopsDoc> | null = null;
let lineNamesPromise: Promise<LineNamesDoc> | null = null;

function fetchSummary(): Promise<Summary> {
  if (!summaryPromise) {
    summaryPromise = fetch(`${PARQUET_BASE}/stats_summary.json`, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`stats_summary.json: ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        summaryPromise = null; // tillat retry ved neste kall
        throw err;
      });
  }
  return summaryPromise;
}

function fetchStops(): Promise<StopsDoc> {
  if (!stopsPromise) {
    stopsPromise = fetch(`${PARQUET_BASE}/stats_stops_map.json`, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`stats_stops_map.json: ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        stopsPromise = null;
        throw err;
      });
  }
  return stopsPromise;
}

function fetchLineNames(): Promise<LineNamesDoc> {
  if (!lineNamesPromise) {
    lineNamesPromise = fetch(`${PARQUET_BASE}/stats_line_names.json`, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`stats_line_names.json: ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        lineNamesPromise = null;
        // Linjenavn er kosmetikk (sidene faller tilbake til "Linje N") —
        // ikke la en feilet artefakt-henting kaste hele resten av svaret.
        console.warn("[stats-adapter] Kunne ikke hente linjenavn:", err);
        return {};
      });
  }
  return lineNamesPromise;
}

// ---------------------------------------------------------------------------
// Hjelpere
// ---------------------------------------------------------------------------

function parseOperators(params: URLSearchParams): string[] {
  const raw = params.get("operator");
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Snapp et ønsket antall dager til nærmeste tilgjengelige vindu (7/30/90). */
function snapWindow(days: number, windows: number[]): number {
  let best = windows[windows.length - 1];
  let bestDiff = Infinity;
  for (const w of windows) {
    const diff = Math.abs(w - days);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = w;
    }
  }
  return best;
}

/** Vektet sammenslåing av daily-rader (på tvers av operatører) til én rad. */
function combineDaily(rows: DailyRow[]): {
  date: string;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  pctEarly: number | null;
  totalJourneys: number;
  totalCancellations: number | null;
  pctRealtimeCoverage: number | null;
  journeysMissingRealtime: number | null;
} {
  const n = rows.reduce((a, r) => a + r.n, 0);
  const w = (pick: (r: DailyRow) => number | null): number | null => {
    let sum = 0;
    let wsum = 0;
    for (const r of rows) {
      const v = pick(r);
      if (v != null) {
        sum += v * r.n;
        wsum += r.n;
      }
    }
    return wsum > 0 ? +(sum / wsum).toFixed(2) : null;
  };
  // Tellinger summeres der de er målt; null hvis ingen rader har måling
  const sumMeasured = (pick: (r: DailyRow) => number | null | undefined): number | null => {
    let sum = 0;
    let seen = false;
    for (const r of rows) {
      const v = pick(r);
      if (v != null) {
        sum += v;
        seen = true;
      }
    }
    return seen ? sum : null;
  };
  return {
    date: rows[0]?.date ?? "",
    avgDelayMin: w((r) => r.avgDelayMin),
    pctOnTime: w((r) => r.pctOnTime),
    pctDelayed10plus: w((r) => r.pctDelayed10plus),
    pctEarly: w((r) => r.pctEarly),
    totalJourneys: rows.reduce((a, r) => a + r.totalJourneys, 0),
    totalCancellations: sumMeasured((r) => r.totalCancellations),
    pctRealtimeCoverage: n > 0 ? w((r) => r.pctRealtimeCoverage) : null,
    journeysMissingRealtime: sumMeasured((r) => r.journeysMissingRealtime),
  };
}

/** daily-rader filtrert på operatører, gruppert per dato (stigende). */
function dailyByDate(summary: Summary, operators: string[]): Map<string, DailyRow[]> {
  const map = new Map<string, DailyRow[]>();
  for (const row of summary.daily) {
    if (operators.length > 0 && !operators.includes(row.operator)) continue;
    const list = map.get(row.date);
    if (list) list.push(row);
    else map.set(row.date, [row]);
  }
  return new Map(Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])));
}

function lineOperator(lineRef: string): string {
  return lineRef.split(":")[0] ?? "";
}

/** Numerisk-vennlig sortering av linjenumre ("3" < "20" < "50E"). */
function lineSortKey(lineRef: string): [number, string] {
  const code = lineRef.split(":").pop() ?? "";
  const num = parseInt(code, 10);
  return [Number.isFinite(num) ? num : 99999, code];
}

const esc = (s: string) => s.replace(/'/g, "''");

/** WHERE-fragment for ukedagsfilteret, eller null. Hvitelista og selve
 *  predikatet ligger i lib/day-type.ts — delt med use-journey-queries. */
function dayTypeClause(params: URLSearchParams): string | null {
  return dayTypePredicate(params.get("dayType"));
}

/** "N dager tilbake fra ferskeste tilgjengelige data" — erstatter det
 *  tidligere MAX(date)-underspørringsmønsteret mot den nå fjernede
 *  generiske "delays"-viewen. Krever at ensureParquetFilesRegistered() er
 *  kalt først (gjøres i statsAdapterFetch). */
function daysAgoFromLatest(days: number, family: DelayFamily): string {
  const latest = latestAvailableDate(family) ?? new Date().toISOString().slice(0, 10);
  const d = new Date(`${latest}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.max(days - 1, 0));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Endepunkt-adaptere
// ---------------------------------------------------------------------------

async function apiSummary(params: URLSearchParams) {
  const summary = await fetchSummary();
  const byDate = dailyByDate(summary, parseOperators(params));
  const dates = Array.from(byDate.keys());
  if (dates.length === 0) return null;
  return combineDaily(byDate.get(dates[dates.length - 1])!);
}

async function apiSummaryTrend(params: URLSearchParams) {
  const summary = await fetchSummary();
  const days = parseInt(params.get("days") ?? "7", 10) || 7;
  const byDate = dailyByDate(summary, parseOperators(params));
  return Array.from(byDate.values()).slice(-days).map(combineDaily);
}

type CombinedDay = ReturnType<typeof combineDaily>;

/**
 * Terskel for "åpenbart ufullstendig dag": halvparten av medianen for
 * gjeldende operatørfilter — men beregnet over ALLE tilgjengelige dager,
 * IKKE bare det brukervalgte tidsvinduet. Et kort vindu (f.eks. «Siste uke»)
 * kan ha FLERTALLET av dagene ufullstendige (skjedde faktisk 2026-08-07: 5 av
 * 7 dager i «Siste uke» var ufullstendige pga. ingest trigget for tidlig på
 * døgnet) — da drar de ufullstendige dagene medianen selv ned til et nivå som
 * ikke lenger fanger opp NOEN av dem. Referansen må derfor være bredere enn
 * vinduet som faktisk filtreres/vises.
 */
/**
 * Terskler PER DAGTYPE, ikke én felles.
 *
 * En felles terskel sammenlikner søndag med ukedag, og søndagsrutene er
 * legitimt mye tynnere enn hverdagsrutene. Målt for Skyss: median over alle
 * dager 321 984 → terskel 160 992, mens ALLE sju søndagene lå på 128 816–
 * 159 246. Resultatet var at hver eneste søndag ble kastet ut av
 * rangeringene, med beskjed til brukeren om «åpenbart ufullstendig
 * innhenting» — altså en påstand om datafeil der dataene var komplette.
 *
 * Nå måles hver dag mot medianen for SIN egen dagtype. Helligdager og 17. mai
 * kjører søndagsruter, så de faller tilbake på søndagsmedianen når de har for
 * få egne observasjoner til en egen median.
 */
type Thresholds = { byDayType: Map<string, number>; fallback: number | null };

const DAY_TYPE_FALLBACK: Record<string, string> = { holiday: "sunday", may17: "sunday" };
const MIN_DAYS_FOR_MEDIAN = 3;

function medianOf(counts: number[]): number | null {
  if (counts.length === 0) return null;
  const sorted = [...counts].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function completenessThreshold(summary: Summary, operators: string[]): Thresholds {
  const allRows = Array.from(dailyByDate(summary, operators).values()).map(combineDaily);
  const groups = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of allRows) {
    if (r.totalJourneys <= 0) continue;
    all.push(r.totalJourneys);
    const dt = computeDayType(r.date);
    const list = groups.get(dt);
    if (list) list.push(r.totalJourneys);
    else groups.set(dt, [r.totalJourneys]);
  }
  const globalMedian = all.length >= MIN_DAYS_FOR_MEDIAN ? medianOf(all) : null;

  const byDayType = new Map<string, number>();
  for (const [dayType, counts] of Array.from(groups.entries())) {
    let basis = counts.length >= MIN_DAYS_FOR_MEDIAN ? counts : null;
    if (!basis) {
      // For få egne dager (typisk helligdag) — lån fra en dagtype med samme
      // ruteomfang før vi eventuelt faller tilbake på alle dager.
      const fb = DAY_TYPE_FALLBACK[dayType];
      const fbCounts = fb ? groups.get(fb) : undefined;
      if (fbCounts && fbCounts.length >= MIN_DAYS_FOR_MEDIAN) basis = fbCounts;
    }
    const median = basis ? medianOf(basis) : null;
    if (median != null && median > 0) byDayType.set(dayType, 0.5 * median);
  }
  return { byDayType, fallback: globalMedian != null && globalMedian > 0 ? 0.5 * globalMedian : null };
}

/**
 * Skiller dager med åpenbart UFULLSTENDIGE data fra resten, gitt en terskel
 * fra completenessThreshold(). En dag som fortsatt ingesteres (eller der
 * ingest ble avbrutt) har langt færre registrerte avganger enn normalt; de få
 * som finnes er ikke et representativt utvalg, og gir typisk et misvisende
 * «beste dag»-resultat (f.eks. 0,1 min snitt / 97 % i rute fordi bare en
 * håndfull avganger rakk å bli lastet). En ekte dårlig dag (snø/kaos)
 * beholder normalt avgangsvolum og havner derfor IKKE i `excluded` — vi
 * filtrerer på datamengde, ikke på forsinkelse.
 *
 * Delt mellom apiWorstBestDays og apiExcludedDays slik at UI-et kan VISE
 * nøyaktig hvilke dager som ble utelatt (i stedet for å skjule det stille —
 * se prinsippet i components/data-quality-flag.tsx).
 */
function partitionByCompleteness(rows: CombinedDay[], thresholds: Thresholds): { complete: CombinedDay[]; excluded: CombinedDay[] } {
  const complete: CombinedDay[] = [];
  const excluded: CombinedDay[] = [];
  for (const r of rows) {
    const limit = thresholds.byDayType.get(computeDayType(r.date)) ?? thresholds.fallback;
    // Ingen brukbar referanse (for lite historikk) → behold dagen. Å utelate
    // den ville vært å påstå datafeil vi ikke har grunnlag for.
    (limit == null || r.totalJourneys >= limit ? complete : excluded).push(r);
  }
  return { complete, excluded };
}

function windowedDailyRows(summary: Summary, params: URLSearchParams): CombinedDay[] {
  const from = params.get("from");
  const to = params.get("to");
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : null;

  let rows = Array.from(dailyByDate(summary, parseOperators(params)).values()).map(combineDaily);
  if (from) rows = rows.filter((r) => r.date >= from);
  if (to) rows = rows.filter((r) => r.date <= to);
  if (days && !from && !to) rows = rows.slice(-days);
  return rows;
}

async function apiWorstBestDays(params: URLSearchParams, order: "worst" | "best") {
  const summary = await fetchSummary();
  const limit = parseInt(params.get("limit") ?? "10", 10) || 10;
  const threshold = completenessThreshold(summary, parseOperators(params));

  const { complete } = partitionByCompleteness(windowedDailyRows(summary, params), threshold);
  complete.sort((a, b) =>
    order === "worst"
      ? (b.avgDelayMin ?? -Infinity) - (a.avgDelayMin ?? -Infinity)
      : (a.avgDelayMin ?? Infinity) - (b.avgDelayMin ?? Infinity),
  );
  return complete.slice(0, limit);
}

/** Dagene apiWorstBestDays nettopp utelot pga. åpenbart ufullstendig ingest,
 *  nyeste først — til /api/worst-days/excluded (se partitionByCompleteness). */
async function apiExcludedDays(params: URLSearchParams) {
  const summary = await fetchSummary();
  const threshold = completenessThreshold(summary, parseOperators(params));
  const { excluded } = partitionByCompleteness(windowedDailyRows(summary, params), threshold);
  return excluded.sort((a, b) => b.date.localeCompare(a.date));
}

const PERIOD_TO_DAYS: Record<string, number> = { week: 7, month: 30, year: 90 };

async function apiLeaderboardLines(params: URLSearchParams) {
  const [summary, lineNames] = await Promise.all([fetchSummary(), fetchLineNames()]);
  const type = params.get("type") ?? "worst";
  const mode = params.get("mode") ?? "all";
  const operators = parseOperators(params);
  const period = params.get("period");
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : null;
  const win = snapWindow(
    days ?? (period ? PERIOD_TO_DAYS[period] ?? 90 : 90),
    summary.windows,
  );

  let rows = summary.lines.filter(
    (l) =>
      l.window === win &&
      l.mode === mode &&
      (operators.length === 0 || operators.includes(lineOperator(l.lineRef))),
  );

  const sorters: Record<string, (a: LineRow, b: LineRow) => number> = {
    worst: (a, b) => (b.avgDelayMin ?? -Infinity) - (a.avgDelayMin ?? -Infinity),
    best: (a, b) => (a.avgDelayMin ?? Infinity) - (b.avgDelayMin ?? Infinity),
    reliable: (a, b) => (a.stddevDelayMin ?? Infinity) - (b.stddevDelayMin ?? Infinity),
    unreliable: (a, b) => (b.stddevDelayMin ?? -Infinity) - (a.stddevDelayMin ?? -Infinity),
  };
  rows = [...rows].sort(sorters[type] ?? sorters.worst);

  return rows.slice(0, 20).map((l) => ({
    lineRef: l.lineRef,
    lineName: lineNames[l.lineRef] ?? null,
    avgDelayMin: l.avgDelayMin,
    stddevDelayMin: l.stddevDelayMin,
    pctOnTime: l.pctOnTime,
    pctDelayed10plus: l.pctDelayed10plus,
    totalDepartures: l.totalDepartures,
    totalCancellations: null,
  }));
}

async function apiLinesAll(params: URLSearchParams) {
  const [summary, lineNames] = await Promise.all([fetchSummary(), fetchLineNames()]);
  const operators = parseOperators(params);
  const maxWin = Math.max(...summary.windows);
  const seen = new Set<string>();
  const out: Array<{ lineRef: string; lineName: string | null }> = [];
  for (const l of summary.lines) {
    if (l.window !== maxWin || l.mode !== "all") continue;
    if (operators.length > 0 && !operators.includes(lineOperator(l.lineRef))) continue;
    if (seen.has(l.lineRef)) continue;
    seen.add(l.lineRef);
    out.push({ lineRef: l.lineRef, lineName: lineNames[l.lineRef] ?? null });
  }
  out.sort((a, b) => {
    const [na, ca] = lineSortKey(a.lineRef);
    const [nb, cb] = lineSortKey(b.lineRef);
    return na - nb || ca.localeCompare(cb);
  });
  return out;
}

/** Slå opp vindus-statistikk i en kompakt stopprad. */
function stopWindow(doc: StopsDoc, row: StopRow, win: number): StopWindowStats {
  const idx = 5 + doc.windows.indexOf(win);
  return (row[idx] as StopWindowStats) ?? null;
}

// ---------------------------------------------------------------------------
// Stoppested-metadata (stoppanalyse): quay → stoppested + plattform.
// Feltene ligger ETTER vinduene i raden; eldre artefakter mangler dem → null.
// ---------------------------------------------------------------------------

type QuayMeta = {
  stopRef: string;
  stopName: string | null;
  stopPlaceRef: string | null;
  stopPlaceName: string | null;
  platformCode: string | null;
  lat: number | null;
  lng: number | null;
};

let quayMetaCache: Map<string, QuayMeta> | null = null;

/** Unike quays på tvers av operatør-rader (cachet per sesjon). */
function quayMetaMap(doc: StopsDoc): Map<string, QuayMeta> {
  if (quayMetaCache) return quayMetaCache;
  const base = 5 + doc.windows.length;
  const map = new Map<string, QuayMeta>();
  for (const row of doc.stops) {
    if (map.has(row[0])) continue;
    const rawSp = row[base] as number | string | null | undefined;
    map.set(row[0], {
      stopRef: row[0],
      stopName: row[2],
      lat: row[3],
      lng: row[4],
      stopPlaceRef:
        typeof rawSp === "number"
          ? `NSR:StopPlace:${rawSp}`
          : (rawSp ?? null) || null,
      platformCode: (row[base + 1] as string | null | undefined) ?? null,
      stopPlaceName: (row[base + 2] as string | null | undefined) ?? null,
    });
  }
  quayMetaCache = map;
  return map;
}

let stopPlaceIndexCache: Map<string, QuayMeta[]> | null = null;

/** stopPlaceRef → medlems-quays, indeksert ÉN gang. resolveStopQuays og
 *  apiStopsLookup slår opp per StopPlace flere ganger per sidelast
 *  (linjer/timesprofil/dagstrend/retninger kaller alle sin egen
 *  StopPlace→quays-utvidelse) — uten denne indeksen var hvert kall et
 *  lineært søk gjennom hele metas-kartet (~60 000 rader i produksjon). */
function stopPlaceIndex(metas: Map<string, QuayMeta>): Map<string, QuayMeta[]> {
  if (stopPlaceIndexCache) return stopPlaceIndexCache;
  const idx = new Map<string, QuayMeta[]>();
  for (const m of Array.from(metas.values())) {
    if (!m.stopPlaceRef) continue;
    const arr = idx.get(m.stopPlaceRef);
    if (arr) arr.push(m);
    else idx.set(m.stopPlaceRef, [m]);
  }
  stopPlaceIndexCache = idx;
  return idx;
}

function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** ?lat=&lng= → koordinat-hint for quaysByName, eller null hvis fraværende/ugyldig. */
function parseCoordHint(params: URLSearchParams): { lat: number; lng: number } | null {
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Haversine-avstand i meter mellom to koordinater. */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Norge har flere fysisk urelaterte stoppesteder med identisk navn (f.eks.
 *  "Kringsjå" finnes i Oslo, Bergen og Fredrikstad — bekreftet via Enturs
 *  geocoder 2026-08-14). Radius rundt et koordinat-hint (fra søketreffet som
 *  utløste oppslaget) holder navnematchen til ÉN by. 1,5 km er rikelig slakk
 *  for at en quay kan ha flyttet noen meter, men trygt under avstanden
 *  mellom to steder med samme navn i praksis (typisk hundrevis av km) — se
 *  STATUS.md 2026-08-14 for utledningen. Filtreres KUN når treffene faktisk
 *  spenner over mer enn ett stoppested — ellers ingen grunn til å risikere å
 *  luke ut et treff pga. et unøyaktig/manglende koordinat-hint. */
const NAME_MATCH_RADIUS_M = 1500;

/** Alle quays der stopPlaceName/stopName matcher det gitte navnet nøyaktig
 *  (normalisert). Brukt som fallback når en NSR:StopPlace-ref ikke finnes i
 *  artefakten — se resolveStopQuays. `hint` er søketreffets koordinat, brukt
 *  til å luke ut navnelikheter i andre byer (se NAME_MATCH_RADIUS_M). */
function quaysByName(
  metas: Map<string, QuayMeta>,
  name: string,
  hint?: { lat: number; lng: number } | null,
): { quays: string[]; nameHint: string | null } {
  const target = normName(name);
  const matches: QuayMeta[] = [];
  let found: string | null = null;
  for (const m of Array.from(metas.values())) {
    const candidate = m.stopPlaceName ?? m.stopName;
    if (candidate && normName(candidate) === target) {
      matches.push(m);
      found = candidate;
    }
  }

  const distinctStopPlaces = new Set(matches.map((m) => m.stopPlaceRef ?? m.stopRef));
  if (hint && distinctStopPlaces.size > 1) {
    const nearby = matches.filter(
      (m) => m.lat != null && m.lng != null &&
        distanceMeters(hint.lat, hint.lng, m.lat, m.lng) <= NAME_MATCH_RADIUS_M,
    );
    // Bare stol på radius-filteret når det faktisk fant noe — et tomt
    // resultat betyr mest sannsynlig et upresist hint, ikke at ALLE treffene
    // er feil sted. Da er uten radius-filter tryggere enn "ingen data".
    if (nearby.length > 0) return { quays: nearby.map((m) => m.stopRef), nameHint: found };
  }
  return { quays: matches.map((m) => m.stopRef), nameHint: found };
}

/** NSR:StopPlace:X → medlems-quays (med data); quay-refs slippes gjennom.
 *  nameHint: stoppestedets visningsnavn (fra Entur-geocoderet, som brukes
 *  til stoppsøket i reise-bygget).
 *
 *  NSR-IDer slås periodisk sammen/erstattes (se NOTES.md) — geocoderet gir
 *  gjerne en NYERE ID enn den `stats_stops_map.json` ble bygget med, og et
 *  eksakt ref-oppslag gir da null quays selv om stoppet åpenbart finnes.
 *  Faller derfor tilbake til navnematch når ref-oppslaget er tomt OG en
 *  nameHint er oppgitt — samme fysiske sted, bare under den gamle IDen. */
async function resolveStopQuays(
  ref: string,
  nameHint?: string | null,
  coordHint?: { lat: number; lng: number } | null,
): Promise<{ quays: string[]; nameHint: string | null }> {
  const doc = await fetchStops();
  const metas = quayMetaMap(doc);
  if (ref.startsWith("NSR:StopPlace:")) {
    const members = stopPlaceIndex(metas).get(ref) ?? [];
    if (members.length > 0) {
      const quays = members.map((m) => m.stopRef);
      let name: string | null = null;
      for (const m of members) name = m.stopPlaceName ?? m.stopName ?? name;
      return { quays, nameHint: name };
    }
    if (nameHint) return quaysByName(metas, nameHint, coordHint);
    return { quays: [], nameHint: null };
  }
  return { quays: [ref], nameHint: metas.get(ref)?.stopName ?? null };
}

/** Quay-refs med sitt stoppested — shardnøkkelen stoppdetalj-artefakten
 *  bruker (se lib/stop-detail.ts). Samme oppslag som resolveStopQuays, men
 *  beholder stopPlaceRef i stedet for å kaste den. */
async function resolveQuaysWithPlace(
  ref: string,
  nameHint?: string | null,
  coordHint?: { lat: number; lng: number } | null,
): Promise<Array<{ stopRef: string; stopPlaceRef: string | null }>> {
  const doc = await fetchStops();
  const metas = quayMetaMap(doc);
  const { quays } = await resolveStopQuays(ref, nameHint, coordHint);
  return quays.map((q) => ({ stopRef: q, stopPlaceRef: metas.get(q)?.stopPlaceRef ?? null }));
}

/**
 * GET /api/stops/search?q=... — typeahead-søk for stoppanalysen.
 * Grupperer per stoppested-NAVN (som serverens searchStops): store knutepunkt
 * med flere StopPlace-IDer med identisk navn kollapses til ett treff, og
 * MIN(ref) velges som representativ. Plattform-quays uten platformCode
 * utelates fra quays-listen (plattformvelgeren), men teller i grunnlaget.
 */
async function apiStopsSearch(params: URLSearchParams) {
  const q = (params.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return [];
  const doc = await fetchStops();

  const groups = new Map<string, { refs: string[]; quays: QuayMeta[] }>();
  for (const meta of Array.from(quayMetaMap(doc).values())) {
    const name = meta.stopPlaceName ?? meta.stopName;
    if (!name) continue;
    const matches =
      name.toLowerCase().includes(q) ||
      (meta.stopName != null && meta.stopName.toLowerCase().includes(q));
    if (!matches) continue;
    const g = groups.get(name) ?? { refs: [], quays: [] };
    g.refs.push(meta.stopPlaceRef ?? meta.stopRef);
    g.quays.push(meta);
    groups.set(name, g);
  }

  const results = Array.from(groups.entries()).map(([name, g]) => {
    const platforms = Array.from(
      new Set(
        g.quays.map((x) => x.platformCode).filter((p): p is string => !!p),
      ),
    ).sort();
    return {
      stopRef: g.refs.slice().sort()[0],
      stopName: name,
      platformCodes: platforms.length > 0 ? platforms.join(",") : null,
      quays: g.quays
        .filter((x): x is QuayMeta & { platformCode: string } => !!x.platformCode)
        .map((x) => ({ stopRef: x.stopRef, platformCode: x.platformCode }))
        .sort((a, b) => a.platformCode.localeCompare(b.platformCode, "nb")),
    };
  });
  results.sort((a, b) => a.stopName.localeCompare(b.stopName, "nb"));
  return results.slice(0, 20);
}

/**
 * GET /api/stops/lookup?refs=...&expand=stopplace&name=... — batch-oppslag
 * brukt av DuckDB-hookene (useLinesAtStop m.fl.) for å utvide StopPlace →
 * quays. `name` er en valgfri fallback — se resolveStopQuays over for
 * hvorfor (NSR-ID-drift mellom geocoderet og artefakten).
 */
async function apiStopsLookup(params: URLSearchParams) {
  const refs = (params.get("refs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (refs.length === 0) return [];
  const doc = await fetchStops();
  const metas = quayMetaMap(doc);
  const expand = params.get("expand") === "stopplace";
  const nameHint = params.get("name");
  const coordHint = parseCoordHint(params);

  const out: Array<{ stopRef: string; stopName: string | null; stopPlaceRef: string | null }> = [];
  for (const ref of refs) {
    if (expand && ref.startsWith("NSR:StopPlace:")) {
      const members = stopPlaceIndex(metas).get(ref) ?? [];
      for (const m of members) {
        out.push({ stopRef: m.stopRef, stopName: m.stopName, stopPlaceRef: m.stopPlaceRef });
      }
      if (members.length === 0 && nameHint) {
        const { quays } = quaysByName(metas, nameHint, coordHint);
        for (const q of quays) {
          const m = metas.get(q);
          if (m) out.push({ stopRef: m.stopRef, stopName: m.stopName, stopPlaceRef: m.stopPlaceRef });
        }
      }
    } else {
      const m = metas.get(ref);
      if (m) out.push({ stopRef: m.stopRef, stopName: m.stopName, stopPlaceRef: m.stopPlaceRef });
      else if (expand) out.push({ stopRef: ref, stopName: null, stopPlaceRef: null });
    }
  }
  return out;
}

/**
 * GET /api/stop/:ref — dagstrend + timesprofil for ett stoppested/quay.
 * Speiler Express-svaret fra getStopStats + getStopHourlyProfile.
 */
/**
 * Dagstrend + timesprofil fra stoppdetalj-artefakten. null = ikke dekket
 * (mangler shard/stopp, eller vinduet finnes ikke) → kalleren faller
 * tilbake til DuckDB.
 *
 * Flere quays slås sammen her, vektet på antall observasjoner — samme
 * resultat som `stop_ref IN (...)` i SQL-en, siden begge er et snitt over de
 * samme radene.
 */
async function stopStatsFromArtifact(
  ref: string,
  params: URLSearchParams,
  quays: string[],
  nameHint: string | null,
  days: number,
) {
  const withPlace = await resolveQuaysWithPlace(ref, params.get("name"), parseCoordHint(params));
  const { stops, maxDate, windows } = await fetchStopDetail(withPlace);
  if (stops.size === 0 || !maxDate) return null;
  const win = snapToWindow(days, windows);
  if (win == null || Math.abs(win - days) > 0) return null; // kun eksakte vinduer

  // --- dagstrend: slå sammen quays per dato ---
  const byDate = new Map<number, { sum: number; n: number; mx: number | null; mn: number | null;
                                   p2s: number; p2n: number; deps: number }>();
  for (const e of Array.from(stops.values())) {
    for (const [off, avg, mx, mn, pct2, , , deps] of e.d) {
      const cur = byDate.get(off) ?? { sum: 0, n: 0, mx: null, mn: null, p2s: 0, p2n: 0, deps: 0 };
      if (avg != null && deps) { cur.sum += avg * deps; cur.n += deps; }
      if (mx != null) cur.mx = cur.mx == null ? mx : Math.max(cur.mx, mx);
      if (mn != null) cur.mn = cur.mn == null ? mn : Math.min(cur.mn, mn);
      if (pct2 != null && deps) { cur.p2s += pct2 * deps; cur.p2n += deps; }
      cur.deps += deps;
      byDate.set(off, cur);
    }
  }
  const cutoff = days - 1;
  const daily = Array.from(byDate.entries())
    .filter(([off]) => off <= cutoff)
    .sort((a, b) => b[0] - a[0])                       // eldst → nyest
    .map(([off, v]) => ({
      date: offsetToDate(maxDate, off),
      avgDelayMin: v.n ? Math.round((v.sum / v.n) * 100) / 100 : null,
      maxDelayMin: v.mx,
      minDelayMin: v.mn,
      pctDelayed2plus: v.p2n ? Math.round((v.p2s / v.p2n) * 10) / 10 : null,
      stddevDelayMin: null,   // ikke meningsfullt å slå sammen på tvers av quays
      numDepartures: v.deps,
    }));
  if (daily.length === 0) return null;

  // --- timesprofil: vektet snitt per time på tvers av quays ---
  const byHour = new Map<number, { sum: number; n: number; mx: number | null; mn: number | null; samples: number }>();
  for (const e of Array.from(stops.values())) {
    for (const [hour, avg, mxa, mna, n] of e.h[String(win)] ?? []) {
      const cur = byHour.get(hour) ?? { sum: 0, n: 0, mx: null, mn: null, samples: 0 };
      if (avg != null && n) { cur.sum += avg * n; cur.n += n; }
      if (mxa != null) cur.mx = cur.mx == null ? mxa : Math.max(cur.mx, mxa);
      if (mna != null) cur.mn = cur.mn == null ? mna : Math.min(cur.mn, mna);
      cur.samples += n;
      byHour.set(hour, cur);
    }
  }
  const hourly = Array.from(byHour.entries()).sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({
    hour,
    avgDelayMin: v.n ? Math.round((v.sum / v.n) * 100) / 100 : null,
    maxAvgDelayMin: v.mx,
    minAvgDelayMin: v.mn,
    numSamples: v.samples,
  }));

  const totalDepartures = daily.reduce((s, r) => s + (r.numDepartures ?? 0), 0);
  const wsum = daily.reduce((s, r) => s + (r.avgDelayMin ?? 0) * (r.numDepartures ?? 0), 0);
  return {
    stopRef: ref,
    stopName: nameHint,
    avgDelayMin: totalDepartures ? Math.round((wsum / totalDepartures) * 100) / 100 : 0,
    totalDepartures,
    daily,
    hourly,
  };
}

async function apiStopStats(ref: string, params: URLSearchParams) {
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 30;
  const from = params.get("from");
  const to = params.get("to");
  const direction = params.get("direction");
  const operators = parseOperators(params);

  const { quays, nameHint } = await resolveStopQuays(ref, params.get("name"), parseCoordHint(params));
  if (quays.length === 0) throw new Error("Stoppested ikke funnet");

  // Ferdigaggregert artefakt først — ETT lite filoppslag i stedet for to
  // DuckDB-spørringer over parquet (målt ~40 s kaldt, se lib/stop-detail.ts).
  // Dekker standardvisningen; retnings-/operatørfilter og egendefinerte
  // datointervall faller gjennom til DuckDB under.
  if (!direction && operators.length === 0 && !from && !to) {
    const fromArtifact = await stopStatsFromArtifact(ref, params, quays, nameHint, days);
    if (fromArtifact) return fromArtifact;
  }

  await ensureParquetFilesRegistered();
  const effectiveFrom = from ?? daysAgoFromLatest(days, "by-stop");

  const D = "COALESCE(delay_departure_min, delay_arrival_min)";
  const conds: string[] = [
    `stop_ref IN (${quays.map((s) => `'${esc(s)}'`).join(", ")})`,
    `${D} IS NOT NULL`,
    `date >= '${esc(effectiveFrom)}'`,
  ];
  if (to) conds.push(`date <= '${esc(to)}'`);
  if (direction) conds.push(`direction_ref = '${esc(direction)}'`);
  if (operators.length > 0) {
    conds.push(`split_part(line_ref, ':', 1) IN (${operators.map((o) => `'${esc(o)}'`).join(", ")})`);
  }
  const stopDayType = dayTypeClause(params);
  if (stopDayType) conds.push(stopDayType);
  const where = conds.join(" AND ");
  const duckOptions = { family: "by-stop" as const, fromDate: effectiveFrom, toDate: to ?? undefined };

  const [daily, hourly] = await Promise.all([
    standaloneDuckQuery<{
      date: string; stopNameRow: string | null;
      avgDelayMin: number | null; maxDelayMin: number | null; minDelayMin: number | null;
      pctDelayed2plus: number | null; pctEarly: number | null;
      stddevDelayMin: number | null; numDepartures: number | null;
    }>(`
      SELECT
        date,
        MAX(stop_name)       AS stopNameRow,
        ROUND(AVG(${D}), 2)  AS avgDelayMin,
        ROUND(MAX(${D}), 1)  AS maxDelayMin,
        ROUND(MIN(${D}), 1)  AS minDelayMin,
        ROUND(100.0 * AVG(CASE WHEN ${D} > 2 THEN 1 ELSE 0 END), 1) AS pctDelayed2plus,
        ROUND(100.0 * AVG(CASE WHEN ${D} < ${EARLY_MIN} THEN 1 ELSE 0 END), 1) AS pctEarly,
        ROUND(STDDEV_SAMP(${D}), 2) AS stddevDelayMin,
        COUNT(DISTINCT service_journey_id) AS numDepartures
      FROM delays_by_stop
      WHERE ${where}
      GROUP BY date
      ORDER BY date
    `, undefined, duckOptions),
    standaloneDuckQuery<Record<string, unknown>>(`
      WITH per_date_hour AS (
        SELECT date,
          CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) AS hour,
          AVG(${D}) AS avg_delay,
          COUNT(*) AS n
        FROM delays_by_stop
        WHERE ${where} AND COALESCE(aimed_departure, aimed_arrival) IS NOT NULL
        GROUP BY 1, 2
      )
      SELECT hour,
        ROUND(AVG(avg_delay), 2) AS avgDelayMin,
        ROUND(MAX(avg_delay), 2) AS maxAvgDelayMin,
        ROUND(MIN(avg_delay), 2) AS minAvgDelayMin,
        CAST(SUM(n) AS INTEGER)  AS numSamples
      FROM per_date_hour
      GROUP BY hour
      ORDER BY hour
    `, undefined, duckOptions),
  ]);

  if (daily.length === 0) throw new Error("404: Stoppested ikke funnet");

  const avgDelay =
    daily.reduce((sum, r) => sum + (r.avgDelayMin ?? 0), 0) / daily.length;
  const totalDepartures = daily.reduce((sum, r) => sum + (r.numDepartures ?? 0), 0);

  return {
    stopRef: ref,
    stopName: nameHint ?? daily[0].stopNameRow,
    avgDelayMin: Math.round(avgDelay * 100) / 100,
    totalDepartures,
    daily: daily.map(({ stopNameRow: _n, ...row }) => row),
    hourly,
  };
}

// Retning (direction_ref) er en stabil egenskap ved en linje ved et stopp —
// den svinger ikke med tidsvinduet brukeren har valgt i periodevelgeren.
// Derfor et FAST, lite vindu i stedet for hele historikken: uten dette bygde
// prepareView et view over ALLE registrerte uker (ubegrenset fromDate/toDate
// → filesForFamily dropper ingen filer), dvs. opptil 14 uker på reise-bygget,
// PÅ HVER stoppsidelast — den enkeltdyreste av de fem spørringene
// stoppanalysen fyrer av. Se STATUS.md.
const DIRECTIONS_LOOKBACK_DAYS = 30;

/** GET /api/stop/:ref/directions — direction_ref-verdier ved stoppet. */
async function apiStopDirections(ref: string, params: URLSearchParams) {
  const operators = parseOperators(params);
  const { quays } = await resolveStopQuays(ref, params.get("name"), parseCoordHint(params));
  if (quays.length === 0) return [];

  // Artefakten har retningene ferdig — samme shard som resten av
  // stoppdetaljene, altså gratis når den allerede er hentet.
  if (operators.length === 0) {
    const withPlace = await resolveQuaysWithPlace(ref, params.get("name"), parseCoordHint(params));
    const { stops } = await fetchStopDetail(withPlace);
    if (stops.size > 0) {
      const set = new Set<string>();
      for (const e of Array.from(stops.values())) for (const d of e.dir) set.add(d);
      if (set.size > 0) return Array.from(set).sort();
    }
  }
  const conds: string[] = [
    `stop_ref IN (${quays.map((s) => `'${esc(s)}'`).join(", ")})`,
    "direction_ref IS NOT NULL",
  ];
  if (operators.length > 0) {
    conds.push(`split_part(line_ref, ':', 1) IN (${operators.map((o) => `'${esc(o)}'`).join(", ")})`);
  }
  await ensureParquetFilesRegistered();
  const fromDate = daysAgoFromLatest(DIRECTIONS_LOOKBACK_DAYS, "by-stop");
  conds.push(`date >= '${esc(fromDate)}'`);
  const rows = await standaloneDuckQuery<{ direction_ref: string }>(`
    SELECT DISTINCT direction_ref FROM delays_by_stop
    WHERE ${conds.join(" AND ")}
    ORDER BY direction_ref
  `, undefined, { family: "by-stop", fromDate });
  return rows.map((r) => String(r.direction_ref));
}

async function apiLeaderboardStops(params: URLSearchParams) {
  const doc = await fetchStops();
  const type = params.get("type") ?? "worst";
  const operators = parseOperators(params);
  const mode = params.get("mode");
  const from = params.get("from");
  const to = params.get("to");
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 7;

  // Artefakten har verken transportmiddel-dimensjon eller vilkårlige
  // datointervall — de tilfellene krever eksakt DuckDB-spørring over parquet.
  // (Uten disse filtrene svarer artefakten øyeblikkelig.)
  if ((mode && mode !== "all") || (from && to)) {
    return apiLeaderboardStopsFiltered(doc, type, operators, mode, from, to, days);
  }

  const win = snapWindow(days, doc.windows);

  const rows: Array<{
    stopRef: string;
    stopName: string | null;
    avgDelayMin: number | null;
    stddevDelayMin: number | null;
    pctDelayed2plus: number | null;
    totalDepartures: number;
  }> = [];
  for (const row of doc.stops) {
    if (operators.length > 0 && !operators.includes(row[1])) continue;
    const w = stopWindow(doc, row, win);
    if (!w) continue;
    rows.push({
      stopRef: row[0],
      stopName: row[2],
      avgDelayMin: w[0],
      pctDelayed2plus: w[1],
      stddevDelayMin: w[2],
      totalDepartures: w[3],
    });
  }
  rows.sort((a, b) =>
    type === "best"
      ? (a.avgDelayMin ?? Infinity) - (b.avgDelayMin ?? Infinity)
      : (b.avgDelayMin ?? -Infinity) - (a.avgDelayMin ?? -Infinity),
  );
  return rows.slice(0, 50);
}

async function apiLeaderboardStopsFiltered(
  doc: StopsDoc,
  type: string,
  operators: string[],
  mode: string | null,
  from: string | null,
  to: string | null,
  days: number,
) {
  await ensureParquetFilesRegistered();
  const useExplicitRange = !!(from && to);
  const effectiveFrom = useExplicitRange ? from! : daysAgoFromLatest(days, "by-stop");
  const effectiveTo = useExplicitRange ? to! : undefined;

  const D = "COALESCE(delay_departure_min, delay_arrival_min)";
  const conds: string[] = [`${D} IS NOT NULL`, `date >= '${esc(effectiveFrom)}'`];
  if (effectiveTo) conds.push(`date <= '${esc(effectiveTo)}'`);
  if (mode && mode !== "all") conds.push(`vehicle_mode = '${esc(mode)}'`);
  if (operators.length > 0) {
    conds.push(`split_part(line_ref, ':', 1) IN (${operators.map((o) => `'${esc(o)}'`).join(", ")})`);
  }

  const rows = await standaloneDuckQuery<{
    stop_ref: string; avg_delay: number | null; sd: number | null;
    pct2: number | null; n: number;
  }>(`
    SELECT stop_ref,
      ROUND(AVG(${D}), 2)          AS avg_delay,
      ROUND(STDDEV_SAMP(${D}), 2)  AS sd,
      ROUND(100.0 * AVG(CASE WHEN ${D} > 2 THEN 1 ELSE 0 END), 1) AS pct2,
      COUNT(DISTINCT service_journey_id || date) AS n
    FROM delays_by_stop
    WHERE ${conds.join(" AND ")}
    GROUP BY stop_ref
    HAVING COUNT(DISTINCT service_journey_id || date) >= 5
    ORDER BY avg_delay ${type === "best" ? "ASC" : "DESC"}
    LIMIT 50
  `, undefined, { family: "by-stop", fromDate: effectiveFrom, toDate: effectiveTo });

  const names = new Map<string, string | null>();
  for (const row of doc.stops) {
    if (!names.has(row[0])) names.set(row[0], row[2]);
  }
  return rows.map((r) => ({
    stopRef: r.stop_ref,
    stopName: names.get(r.stop_ref) ?? null,
    avgDelayMin: r.avg_delay,
    stddevDelayMin: r.sd,
    pctDelayed2plus: r.pct2,
    totalDepartures: r.n,
  }));
}

async function apiStopsMap(params: URLSearchParams) {
  const doc = await fetchStops();
  const operators = parseOperators(params);
  const windowDays = parseInt(params.get("windowDays") ?? "7", 10) || 7;
  const dayType = params.get("dayType");
  const hourMin = params.get("hourMin");
  const hourMax = params.get("hourMax");

  // Filtrert visning (dagtype/time): eksakt DuckDB-spørring over parquet.
  // Koordinater/navn joines fra artefakten (finnes ikke i parquet).
  if (dayType || hourMin != null || hourMax != null) {
    return apiStopsMapFiltered(doc, operators, windowDays, dayType, hourMin, hourMax);
  }

  // Standardvisning: rett fra artefakten (øyeblikkelig).
  const win = snapWindow(windowDays, doc.windows);
  // Uten operatørfilter kan samme stopp ha rader for flere operatører —
  // slå sammen vektet med antall avganger.
  const byStop = new Map<string, {
    stopName: string | null; lat: number | null; lng: number | null;
    sumDelay: number; sumPct: number; wsum: number; departures: number;
  }>();
  for (const row of doc.stops) {
    if (operators.length > 0 && !operators.includes(row[1])) continue;
    const w = stopWindow(doc, row, win);
    if (!w) continue;
    const e = byStop.get(row[0]) ?? {
      stopName: row[2], lat: row[3], lng: row[4],
      sumDelay: 0, sumPct: 0, wsum: 0, departures: 0,
    };
    if (w[0] != null) { e.sumDelay += w[0] * w[3]; e.wsum += w[3]; }
    if (w[1] != null) e.sumPct += w[1] * w[3];
    e.departures += w[3];
    byStop.set(row[0], e);
  }
  return Array.from(byStop.entries()).map(([stopRef, e]) => ({
    stopRef,
    stopName: e.stopName,
    avgDelayMin: e.wsum > 0 ? +(e.sumDelay / e.wsum).toFixed(2) : null,
    pctDelayed2plus: e.wsum > 0 ? +(e.sumPct / e.wsum).toFixed(1) : null,
    numDepartures: e.departures,
    lat: e.lat,
    lng: e.lng,
  }));
}

async function apiStopsMapFiltered(
  doc: StopsDoc,
  operators: string[],
  windowDays: number,
  dayType: string | null,
  hourMin: string | null,
  hourMax: string | null,
) {
  await ensureParquetFilesRegistered();
  const effectiveFrom = daysAgoFromLatest(windowDays, "by-stop");

  const conds: string[] = [
    "COALESCE(delay_departure_min, delay_arrival_min) IS NOT NULL",
    `date >= '${esc(effectiveFrom)}'`,
  ];
  if (dayType === "weekday") conds.push("day_type IN ('weekday')");
  if (dayType === "weekend") conds.push("day_type IN ('saturday', 'sunday')");
  if (operators.length > 0) {
    conds.push(`split_part(line_ref, ':', 1) IN (${operators.map((o) => `'${esc(o)}'`).join(", ")})`);
  }
  const hourExpr = "CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER)";
  if (hourMin != null) conds.push(`${hourExpr} >= ${parseInt(hourMin, 10) || 0}`);
  if (hourMax != null) conds.push(`${hourExpr} <= ${parseInt(hourMax, 10) || 23}`);

  const rows = await standaloneDuckQuery<{
    stop_ref: string; avg_delay: number | null; pct2: number | null; n: number;
  }>(`
    SELECT stop_ref,
      ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avg_delay,
      ROUND(100.0 * AVG(CASE WHEN COALESCE(delay_departure_min, delay_arrival_min) > 2 THEN 1 ELSE 0 END), 1) AS pct2,
      COUNT(DISTINCT service_journey_id || date) AS n
    FROM delays_by_stop
    WHERE ${conds.join(" AND ")}
    GROUP BY stop_ref
    HAVING COUNT(DISTINCT service_journey_id || date) >= 5
  `, undefined, { family: "by-stop", fromDate: effectiveFrom });

  // Koordinater + navn fra artefakten
  const meta = new Map<string, { name: string | null; lat: number | null; lng: number | null }>();
  for (const row of doc.stops) {
    if (!meta.has(row[0])) meta.set(row[0], { name: row[2], lat: row[3], lng: row[4] });
  }
  return rows.map((r) => {
    const m = meta.get(r.stop_ref);
    return {
      stopRef: r.stop_ref,
      stopName: m?.name ?? null,
      avgDelayMin: r.avg_delay,
      pctDelayed2plus: r.pct2,
      numDepartures: r.n,
      lat: m?.lat ?? null,
      lng: m?.lng ?? null,
    };
  });
}

/**
 * Felles WHERE-bygging for linje-spørringene. Delt fordi daily og hourly nå er
 * to separate endepunkter (se apiLineDaily/apiLineHourly) og MÅ filtrere likt —
 * ellers ville stat-kortene og timesgrafen beskrevet ulike datasett.
 */
function lineQueryScope(lineRef: string, params: URLSearchParams) {
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 30;
  const from = params.get("from");
  const to = params.get("to");
  const direction = params.get("direction");

  const useExplicitRange = !!(from && to);
  const effectiveFrom = useExplicitRange ? from! : daysAgoFromLatest(days, "by-line");
  const effectiveTo = useExplicitRange ? to! : undefined;

  const conds: string[] = [
    `line_ref = '${esc(lineRef)}'`,
    "COALESCE(delay_departure_min, delay_arrival_min) IS NOT NULL",
    `date >= '${esc(effectiveFrom)}'`,
  ];
  if (effectiveTo) conds.push(`date <= '${esc(effectiveTo)}'`);
  if (direction) conds.push(`direction_ref = '${esc(direction)}'`);
  const dayType = dayTypeClause(params);
  if (dayType) conds.push(dayType);

  return {
    where: conds.join(" AND "),
    duckOptions: { family: "by-line" as const, fromDate: effectiveFrom, toDate: effectiveTo },
  };
}

const D_EXPR = "COALESCE(delay_departure_min, delay_arrival_min)";

/**
 * Stat-kortene for én linje, hentet fra den ferdigaggregerte stats_summary.json
 * i stedet for DuckDB. Returnerer null når artefakten ikke kan svare presist —
 * da må kalleren regne tallene fra dagsserien i stedet.
 *
 * Null-tilfellene, og hvorfor de MÅ være null og ikke en tilnærming:
 *  - Egendefinert datointervall, eller et vindu som ikke er nøyaktig 7/30/90:
 *    artefakten har bare de tre vinduene. Å snappe til nærmeste ville vist
 *    7-dagerstall under overskriften «Siste 2 uker».
 *  - Retningsfilter: artefakten aggregerer begge retninger.
 *  - Ukedagsfilter: artefakten aggregerer alle dagtyper. Uten denne sjekken
 *    ville stat-kortene vist ufiltrerte tall rett ved siden av grafer som
 *    ER filtrert — samme side, to ulike datasett, ingenting som sa fra.
 *  - Linjen mangler i vinduet: aggregate_stats.py utelater linjer med færre
 *    enn MIN_JOURNEYS_LINE (5) avganger, så lavfrekvente linjer finnes ikke her.
 */
async function apiLineSummary(lineRef: string, params: URLSearchParams) {
  if (params.get("from") || params.get("to")) return null;
  if (params.get("direction")) return null;
  if (dayTypeClause(params)) return null;

  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 30;
  const summary = await fetchSummary();
  if (!summary.windows.includes(days)) return null;

  const row = summary.lines.find(
    (l) => l.lineRef === lineRef && l.mode === "all" && l.window === days,
  );
  if (!row) return null;

  const lineNames = await fetchLineNames();
  return {
    lineRef,
    lineName: lineNames[lineRef] ?? null,
    window: days,
    avgDelayMin: row.avgDelayMin,
    pctOnTime: row.pctOnTime,
    pctDelayed10plus: row.pctDelayed10plus,
    pctEarly: row.pctEarly,
    stddevDelayMin: row.stddevDelayMin,
    totalDepartures: row.totalDepartures,
    // Dekningen kommer fra coverage_daily (via artefakten), ikke fra parquet —
    // parquet har bare sanntidsobserverte rader, så nevneren finnes ikke der.
    // Vinduene ligger i samme rekkefølge som summary.windows.
    pctRealtimeCoverage:
      summary.coverage?.[lineRef]?.[summary.windows.indexOf(days)] ?? null,
  };
}

async function apiLineDaily(lineRef: string, params: URLSearchParams) {
  await ensureParquetFilesRegistered();
  const { where, duckOptions } = lineQueryScope(lineRef, params);

  const [daily, lineNames] = await Promise.all([
    standaloneDuckQuery<Record<string, unknown>>(`
      SELECT
        date,
        ROUND(AVG(${D_EXPR}), 2)  AS avgDelayMin,
        ROUND(MAX(${D_EXPR}), 1)  AS maxDelayMin,
        ROUND(MIN(${D_EXPR}), 1)  AS minDelayMin,
        ROUND(100.0 * AVG(CASE WHEN ${D_EXPR} <= 2 THEN 1 ELSE 0 END), 1) AS pctOnTime,
        ROUND(100.0 * AVG(CASE WHEN ${D_EXPR} > 10 THEN 1 ELSE 0 END), 1)             AS pctDelayed10plus,
        ROUND(100.0 * AVG(CASE WHEN ${D_EXPR} < ${EARLY_MIN} THEN 1 ELSE 0 END), 1)   AS pctEarly,
        COUNT(DISTINCT service_journey_id) AS numDepartures,
        ROUND(STDDEV_SAMP(${D_EXPR}), 2) AS stddevDelayMin
      FROM delays_by_line
      WHERE ${where}
      GROUP BY date
      ORDER BY date
    `, undefined, duckOptions),
    fetchLineNames(),
  ]);

  return daily.map((row) => ({
    ...row,
    lineRef,
    lineName: lineNames[lineRef] ?? null,
    pctRealtimeCoverage: null,
  }));
}

async function apiLineHourly(lineRef: string, params: URLSearchParams) {
  await ensureParquetFilesRegistered();
  const { where, duckOptions } = lineQueryScope(lineRef, params);

  const hourly = await standaloneDuckQuery<Record<string, unknown>>(`
    WITH per_date_hour AS (
      SELECT date,
        CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) AS hour,
        AVG(${D_EXPR}) AS avg_delay,
        COUNT(*) AS n
      FROM delays_by_line
      WHERE ${where} AND COALESCE(aimed_departure, aimed_arrival) IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT hour,
      ROUND(AVG(avg_delay), 2) AS avgDelayMin,
      ROUND(MAX(avg_delay), 2) AS maxAvgDelayMin,
      ROUND(MIN(avg_delay), 2) AS minAvgDelayMin,
      CAST(SUM(n) AS INTEGER)  AS numSamples
    FROM per_date_hour
    GROUP BY hour
    ORDER BY hour
  `, undefined, duckOptions);

  return hourly.map((row) => ({ ...row, lineRef }));
}

// ---------------------------------------------------------------------------
// Inngangspunkt: match URL → adapter. `undefined` = ikke håndtert.
// ---------------------------------------------------------------------------

export async function statsAdapterFetch(url: string): Promise<unknown | undefined> {
  const qIdx = url.indexOf("?");
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");

  switch (path) {
    case "/api/summary":
      return apiSummary(params);
    case "/api/summary/trend":
      return apiSummaryTrend(params);
    case "/api/worst-days":
      return apiWorstBestDays(params, "worst");
    case "/api/best-days":
      return apiWorstBestDays(params, "best");
    case "/api/worst-days/excluded":
      return apiExcludedDays(params);
    case "/api/leaderboard/lines":
      return apiLeaderboardLines(params);
    case "/api/leaderboard/stops":
      return apiLeaderboardStops(params);
    case "/api/stops/map":
      return apiStopsMap(params);
    case "/api/stops/search":
      return apiStopsSearch(params);
    case "/api/stops/lookup":
      return apiStopsLookup(params);
    case "/api/lines/all":
      return apiLinesAll(params);
  }

  // Linjeanalysen henter de tre bitene hver for seg slik at de kan rendres
  // etter hvert som de blir ferdige. /summary koster ingen DuckDB-spørring i
  // det hele tatt (leser stats_summary.json), så stat-kortene står med tall
  // mens grafene fortsatt regnes. Se apiLineSummary for når den gir null.
  const lineSummaryMatch = path.match(/^\/api\/line\/([^/]+)\/summary$/);
  if (lineSummaryMatch) {
    return apiLineSummary(decodeURIComponent(lineSummaryMatch[1]), params);
  }
  const lineDailyMatch = path.match(/^\/api\/line\/([^/]+)\/daily$/);
  if (lineDailyMatch) {
    return apiLineDaily(decodeURIComponent(lineDailyMatch[1]), params);
  }
  const lineHourlyMatch = path.match(/^\/api\/line\/([^/]+)\/hourly$/);
  if (lineHourlyMatch) {
    return apiLineHourly(decodeURIComponent(lineHourlyMatch[1]), params);
  }

  const stopDirMatch = path.match(/^\/api\/stop\/([^/]+)\/directions$/);
  if (stopDirMatch) {
    return apiStopDirections(decodeURIComponent(stopDirMatch[1]), params);
  }
  const stopMatch = path.match(/^\/api\/stop\/([^/]+)$/);
  if (stopMatch) {
    return apiStopStats(decodeURIComponent(stopMatch[1]), params);
  }

  return undefined;
}
