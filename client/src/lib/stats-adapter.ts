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
  totalDepartures: number;
};

type Summary = {
  generatedAt: string;
  windows: number[];
  dates: { min: string; max: string };
  daily: DailyRow[];
  lines: LineRow[];
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

async function apiWorstBestDays(params: URLSearchParams, order: "worst" | "best") {
  const summary = await fetchSummary();
  const limit = parseInt(params.get("limit") ?? "10", 10) || 10;
  const from = params.get("from");
  const to = params.get("to");
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : null;

  let rows = Array.from(dailyByDate(summary, parseOperators(params)).values()).map(combineDaily);
  if (from) rows = rows.filter((r) => r.date >= from);
  if (to) rows = rows.filter((r) => r.date <= to);
  if (days && !from && !to) rows = rows.slice(-days);

  rows.sort((a, b) =>
    order === "worst"
      ? (b.avgDelayMin ?? -Infinity) - (a.avgDelayMin ?? -Infinity)
      : (a.avgDelayMin ?? Infinity) - (b.avgDelayMin ?? Infinity),
  );
  return rows.slice(0, limit);
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

function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** Alle quays der stopPlaceName/stopName matcher det gitte navnet nøyaktig
 *  (normalisert). Brukt som fallback når en NSR:StopPlace-ref ikke finnes i
 *  artefakten — se resolveStopQuays. */
function quaysByName(metas: Map<string, QuayMeta>, name: string): { quays: string[]; nameHint: string | null } {
  const target = normName(name);
  const quays: string[] = [];
  let found: string | null = null;
  for (const m of Array.from(metas.values())) {
    const candidate = m.stopPlaceName ?? m.stopName;
    if (candidate && normName(candidate) === target) {
      quays.push(m.stopRef);
      found = candidate;
    }
  }
  return { quays, nameHint: found };
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
): Promise<{ quays: string[]; nameHint: string | null }> {
  const doc = await fetchStops();
  const metas = quayMetaMap(doc);
  if (ref.startsWith("NSR:StopPlace:")) {
    const quays: string[] = [];
    let name: string | null = null;
    for (const m of Array.from(metas.values())) {
      if (m.stopPlaceRef === ref) {
        quays.push(m.stopRef);
        name = m.stopPlaceName ?? m.stopName ?? name;
      }
    }
    if (quays.length > 0) return { quays, nameHint: name };
    if (nameHint) return quaysByName(metas, nameHint);
    return { quays: [], nameHint: null };
  }
  return { quays: [ref], nameHint: metas.get(ref)?.stopName ?? null };
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

  const out: Array<{ stopRef: string; stopName: string | null; stopPlaceRef: string | null }> = [];
  for (const ref of refs) {
    if (expand && ref.startsWith("NSR:StopPlace:")) {
      let matched = false;
      for (const m of Array.from(metas.values())) {
        if (m.stopPlaceRef === ref) {
          out.push({ stopRef: m.stopRef, stopName: m.stopName, stopPlaceRef: m.stopPlaceRef });
          matched = true;
        }
      }
      if (!matched && nameHint) {
        const { quays } = quaysByName(metas, nameHint);
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
async function apiStopStats(ref: string, params: URLSearchParams) {
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 30;
  const from = params.get("from");
  const to = params.get("to");
  const direction = params.get("direction");
  const operators = parseOperators(params);

  const { quays, nameHint } = await resolveStopQuays(ref, params.get("name"));
  if (quays.length === 0) throw new Error("Stoppested ikke funnet");

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
  const where = conds.join(" AND ");
  const duckOptions = { family: "by-stop" as const, fromDate: effectiveFrom, toDate: to ?? undefined };

  const [daily, hourly] = await Promise.all([
    standaloneDuckQuery<{
      date: string; stopNameRow: string | null;
      avgDelayMin: number | null; maxDelayMin: number | null; minDelayMin: number | null;
      pctDelayed2plus: number | null; stddevDelayMin: number | null; numDepartures: number | null;
    }>(`
      SELECT
        date,
        MAX(stop_name)       AS stopNameRow,
        ROUND(AVG(${D}), 2)  AS avgDelayMin,
        ROUND(MAX(${D}), 1)  AS maxDelayMin,
        ROUND(MIN(${D}), 1)  AS minDelayMin,
        ROUND(100.0 * AVG(CASE WHEN ${D} > 2 THEN 1 ELSE 0 END), 1) AS pctDelayed2plus,
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

/** GET /api/stop/:ref/directions — direction_ref-verdier ved stoppet. */
async function apiStopDirections(ref: string, params: URLSearchParams) {
  const operators = parseOperators(params);
  const { quays } = await resolveStopQuays(ref, params.get("name"));
  if (quays.length === 0) return [];
  const conds: string[] = [
    `stop_ref IN (${quays.map((s) => `'${esc(s)}'`).join(", ")})`,
    "direction_ref IS NOT NULL",
  ];
  if (operators.length > 0) {
    conds.push(`split_part(line_ref, ':', 1) IN (${operators.map((o) => `'${esc(o)}'`).join(", ")})`);
  }
  const rows = await standaloneDuckQuery<{ direction_ref: string }>(`
    SELECT DISTINCT direction_ref FROM delays_by_stop
    WHERE ${conds.join(" AND ")}
    ORDER BY direction_ref
  `, undefined, { family: "by-stop" });
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

async function apiLineStats(lineRef: string, params: URLSearchParams) {
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 30;
  const from = params.get("from");
  const to = params.get("to");
  const direction = params.get("direction");

  await ensureParquetFilesRegistered();
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
  const where = conds.join(" AND ");
  const D = "COALESCE(delay_departure_min, delay_arrival_min)";
  const duckOptions = { family: "by-line" as const, fromDate: effectiveFrom, toDate: effectiveTo };

  const [daily, hourly, lineNames] = await Promise.all([
    standaloneDuckQuery<Record<string, unknown>>(`
      SELECT
        date,
        ROUND(AVG(${D}), 2)  AS avgDelayMin,
        ROUND(MAX(${D}), 1)  AS maxDelayMin,
        ROUND(MIN(${D}), 1)  AS minDelayMin,
        ROUND(100.0 * AVG(CASE WHEN ${D} <= 2 THEN 1 ELSE 0 END), 1) AS pctOnTime,
        ROUND(100.0 * AVG(CASE WHEN ${D} > 10 THEN 1 ELSE 0 END), 1)             AS pctDelayed10plus,
        COUNT(DISTINCT service_journey_id) AS numDepartures,
        ROUND(STDDEV_SAMP(${D}), 2) AS stddevDelayMin
      FROM delays_by_line
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
    `, undefined, duckOptions),
    fetchLineNames(),
  ]);

  return {
    daily: daily.map((row) => ({
      ...row,
      lineRef,
      lineName: lineNames[lineRef] ?? null,
      pctRealtimeCoverage: null,
    })),
    hourly: hourly.map((row) => ({ ...row, lineRef })),
  };
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

  const lineMatch = path.match(/^\/api\/line\/([^/]+)$/);
  if (lineMatch) {
    return apiLineStats(decodeURIComponent(lineMatch[1]), params);
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
