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

import { PARQUET_BASE, standaloneDuckQuery } from "@/hooks/use-parquet-query";

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

// Kompakt radformat: [stopRef, operator, stopName, lat, lng, w7, w30, w90]
// der wN = [avgDelayMin, pctDelayed2plus, stddevDelayMin, totalDepartures] | null
type StopWindowStats = [number | null, number | null, number | null, number] | null;
type StopRow = [string, string, string | null, number | null, number | null, ...StopWindowStats[]];

type StopsDoc = {
  generatedAt: string;
  windows: number[];
  stops: StopRow[];
};

// ---------------------------------------------------------------------------
// Artefakt-henting (én gang per sesjon; no-store så de alltid er ferske)
// ---------------------------------------------------------------------------

let summaryPromise: Promise<Summary> | null = null;
let stopsPromise: Promise<StopsDoc> | null = null;

function fetchSummary(): Promise<Summary> {
  if (!summaryPromise) {
    summaryPromise = fetch(`${PARQUET_BASE}/stats_summary.json`, { cache: "no-store" })
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
    stopsPromise = fetch(`${PARQUET_BASE}/stats_stops_map.json`, { cache: "no-store" })
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
  totalCancellations: null;
  pctRealtimeCoverage: number | null;
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
  return {
    date: rows[0]?.date ?? "",
    avgDelayMin: w((r) => r.avgDelayMin),
    pctOnTime: w((r) => r.pctOnTime),
    pctDelayed10plus: w((r) => r.pctDelayed10plus),
    totalJourneys: rows.reduce((a, r) => a + r.totalJourneys, 0),
    totalCancellations: null,
    pctRealtimeCoverage: n > 0 ? w((r) => r.pctRealtimeCoverage) : null,
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
  const summary = await fetchSummary();
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
    lineName: null,
    avgDelayMin: l.avgDelayMin,
    stddevDelayMin: l.stddevDelayMin,
    pctOnTime: l.pctOnTime,
    pctDelayed10plus: l.pctDelayed10plus,
    totalDepartures: l.totalDepartures,
    totalCancellations: null,
  }));
}

async function apiLinesAll(params: URLSearchParams) {
  const summary = await fetchSummary();
  const operators = parseOperators(params);
  const maxWin = Math.max(...summary.windows);
  const seen = new Set<string>();
  const out: Array<{ lineRef: string; lineName: null }> = [];
  for (const l of summary.lines) {
    if (l.window !== maxWin || l.mode !== "all") continue;
    if (operators.length > 0 && !operators.includes(lineOperator(l.lineRef))) continue;
    if (seen.has(l.lineRef)) continue;
    seen.add(l.lineRef);
    out.push({ lineRef: l.lineRef, lineName: null });
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

async function apiLeaderboardStops(params: URLSearchParams) {
  const doc = await fetchStops();
  const type = params.get("type") ?? "worst";
  const operators = parseOperators(params);
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 7;
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
  const conds: string[] = [
    "COALESCE(delay_departure_min, delay_arrival_min) IS NOT NULL",
    `date >= (SELECT strftime(MAX(date)::DATE - INTERVAL ${Math.max(windowDays - 1, 0)} DAY, '%Y-%m-%d') FROM delays)`,
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
    FROM delays
    WHERE ${conds.join(" AND ")}
    GROUP BY stop_ref
    HAVING COUNT(DISTINCT service_journey_id || date) >= 5
  `);

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

  const conds: string[] = [
    `line_ref = '${esc(lineRef)}'`,
    "COALESCE(delay_departure_min, delay_arrival_min) IS NOT NULL",
  ];
  if (from) conds.push(`date >= '${esc(from)}'`);
  if (to) conds.push(`date <= '${esc(to)}'`);
  if (!from && !to) {
    conds.push(`date >= (SELECT strftime(MAX(date)::DATE - INTERVAL ${Math.max(days - 1, 0)} DAY, '%Y-%m-%d') FROM delays)`);
  }
  if (direction) conds.push(`direction_ref = '${esc(direction)}'`);
  const where = conds.join(" AND ");
  const D = "COALESCE(delay_departure_min, delay_arrival_min)";

  const [daily, hourly] = await Promise.all([
    standaloneDuckQuery<Record<string, unknown>>(`
      SELECT
        date,
        ROUND(AVG(${D}), 2)  AS avgDelayMin,
        ROUND(MAX(${D}), 1)  AS maxDelayMin,
        ROUND(MIN(${D}), 1)  AS minDelayMin,
        ROUND(100.0 * AVG(CASE WHEN ${D} BETWEEN -1 AND 3 THEN 1 ELSE 0 END), 1) AS pctOnTime,
        ROUND(100.0 * AVG(CASE WHEN ${D} > 10 THEN 1 ELSE 0 END), 1)             AS pctDelayed10plus,
        COUNT(DISTINCT service_journey_id) AS numDepartures,
        ROUND(STDDEV_SAMP(${D}), 2) AS stddevDelayMin
      FROM delays
      WHERE ${where}
      GROUP BY date
      ORDER BY date
    `),
    standaloneDuckQuery<Record<string, unknown>>(`
      WITH per_date_hour AS (
        SELECT date,
          CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) AS hour,
          AVG(${D}) AS avg_delay,
          COUNT(*) AS n
        FROM delays
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
    `),
  ]);

  return {
    daily: daily.map((row) => ({
      ...row,
      lineRef,
      lineName: null,
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
    case "/api/lines/all":
      return apiLinesAll(params);
  }

  const lineMatch = path.match(/^\/api\/line\/([^/]+)$/);
  if (lineMatch) {
    return apiLineStats(decodeURIComponent(lineMatch[1]), params);
  }

  return undefined;
}
