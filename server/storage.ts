import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc, eq, gte, lte, and, like, sql, notInArray, inArray } from "drizzle-orm";
import { resolve } from "path";
import * as schema from "@shared/schema";

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const DB_PATH = resolve(
  process.env.DATABASE_PATH ?? "./data/bussforsinkelser.db",
);

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// All vehicle modes included in aggregations. 'coach' (flybuss) is kept
// distinct from 'bus' so the trip planner can filter the two separately.
// 'ferry' is the actual vehicleMode value Skyss SIRI ET uses for boat routes
// (not 'water', which is the NeTEx/Entur transport mode name).
export const INCLUDED_MODES = ["bus", "coach", "tram", "metro", "rail", "water", "ferry"] as const;
export type VehicleMode = (typeof INCLUDED_MODES)[number];

// Day-type filter values used by the backend. 'all' (or undefined) = no filter.
export const DAY_TYPES = ["weekday", "saturday", "sunday", "holiday", "may17"] as const;
export type DayType = (typeof DAY_TYPES)[number];

/** Parse a comma-separated `?modes=` query into a validated whitelist subset. */
export function parseModes(input: string | string[] | undefined): VehicleMode[] {
  if (!input) return [...INCLUDED_MODES];
  const raw = Array.isArray(input) ? input.join(",") : input;
  if (raw === "all") return [...INCLUDED_MODES];
  const requested = raw.split(",").map((s) => s.trim().toLowerCase());
  const filtered = requested.filter((m): m is VehicleMode =>
    (INCLUDED_MODES as readonly string[]).includes(m),
  );
  return filtered.length ? filtered : [...INCLUDED_MODES];
}

/** SQL fragment listing all included vehicle modes, e.g. `'bus','coach',...`. Use as `vehicle_mode IN (${INCLUDED_MODES_SQL})`. */
export const INCLUDED_MODES_SQL = INCLUDED_MODES.map((m) => `'${m}'`).join(",");

/** Parse a comma-separated `?dayType=` query. Returns null when no filter applies. */
export function parseDayTypes(input: string | string[] | undefined): DayType[] | null {
  if (!input) return null;
  const raw = Array.isArray(input) ? input.join(",") : input;
  if (raw === "all") return null;
  const requested = raw.split(",").map((s) => s.trim().toLowerCase());
  const filtered = requested.filter((d): d is DayType =>
    (DAY_TYPES as readonly string[]).includes(d),
  );
  return filtered.length ? filtered : null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function getDailySummary(date: string, operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(
      and(
        eq(schema.dailySummary.date, date),
        eq(schema.dailySummary.operator, operator),
      ),
    )
    .get();
}

export async function getLatestSummary(operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(eq(schema.dailySummary.operator, operator))
    .orderBy(desc(schema.dailySummary.date))
    .limit(1)
    .get();
}

export async function getDailySummaryRange(fromDate: string, toDate: string, operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(
      and(
        gte(schema.dailySummary.date, fromDate),
        lte(schema.dailySummary.date, toDate),
        eq(schema.dailySummary.operator, operator),
      ),
    )
    .orderBy(schema.dailySummary.date)
    .all();
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export async function getLinesForDate(date: string, limit = 20) {
  // Aggregate across both directions to get one row per line (bus only)
  const avgExpr = sql<number>`ROUND(SUM(${schema.lineDaily.avgDelayMin} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 2)`;
  return db
    .select({
      date: schema.lineDaily.date,
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
      avgDelayMin: avgExpr,
      numDepartures: sql<number>`SUM(${schema.lineDaily.numDepartures})`,
    })
    .from(schema.lineDaily)
    .where(and(eq(schema.lineDaily.date, date), inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[])))
    .groupBy(schema.lineDaily.lineRef, schema.lineDaily.lineName)
    .orderBy(desc(avgExpr))
    .limit(limit)
    .all();
}

export async function getLineStats(lineRef: string, fromDate: string, direction?: string, toDate?: string) {
  // One aggregated row per date. When direction is a specific value (not 'all' or undefined),
  // filter to that direction only. When 'all' or undefined, aggregate all directions.
  const baseConditions = and(
    eq(schema.lineDaily.lineRef, lineRef),
    gte(schema.lineDaily.date, fromDate),
    toDate ? lte(schema.lineDaily.date, toDate) : undefined,
    inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]),
    direction && direction !== "all"
      ? eq(schema.lineDaily.directionRef, direction)
      : undefined,
  );
  return db
    .select({
      date: schema.lineDaily.date,
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
      avgDelayMin: sql<number>`ROUND(SUM(${schema.lineDaily.avgDelayMin} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 2)`,
      maxDelayMin: sql<number>`ROUND(MAX(${schema.lineDaily.maxDelayMin}), 2)`,
      minDelayMin: sql<number>`ROUND(MIN(${schema.lineDaily.minDelayMin}), 2)`,
      pctOnTime: sql<number>`ROUND(SUM(${schema.lineDaily.pctOnTime} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 1)`,
      pctDelayed10plus: sql<number>`ROUND(SUM(${schema.lineDaily.pctDelayed10plus} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 1)`,
      numDepartures: sql<number>`SUM(${schema.lineDaily.numDepartures})`,
      pctRealtimeCoverage: sql<number | null>`ROUND(SUM(CASE WHEN ${schema.lineDaily.pctRealtimeCoverage} IS NOT NULL THEN ${schema.lineDaily.pctRealtimeCoverage} * ${schema.lineDaily.numDepartures} ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN ${schema.lineDaily.pctRealtimeCoverage} IS NOT NULL THEN ${schema.lineDaily.numDepartures} ELSE 0 END), 0), 1)`,
      stddevDelayMin: sql<number | null>`ROUND(SUM(CASE WHEN ${schema.lineDaily.stddevDelayMin} IS NOT NULL THEN ${schema.lineDaily.stddevDelayMin} * ${schema.lineDaily.numDepartures} ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN ${schema.lineDaily.stddevDelayMin} IS NOT NULL THEN ${schema.lineDaily.numDepartures} ELSE 0 END), 0), 2)`,
    })
    .from(schema.lineDaily)
    .where(baseConditions)
    .groupBy(schema.lineDaily.date)
    .orderBy(schema.lineDaily.date)
    .all();
}

export async function getLineHourlyProfile(lineRef: string, direction?: string, dayTypes?: DayType[] | null) {
  // When direction is a specific value (not 'all' or undefined): return that direction's profile.
  // When 'all' or undefined: aggregate all directions (weighted avg + max/min over all).
  // dayTypes filters across the day_type column (added April 2026). null/undefined = all day types.
  const dtFilter = dayTypes && dayTypes.length
    ? `AND day_type IN (${dayTypes.map((d) => `'${d}'`).join(",")})`
    : "";
  if (direction && direction !== "all") {
    return sqlite.prepare(`
      SELECT
        line_ref       AS lineRef,
        line_name      AS lineName,
        direction_ref  AS directionRef,
        hour,
        ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
        ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
        ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
        SUM(num_samples) AS numSamples
      FROM line_hourly_profile
      WHERE line_ref = ? AND direction_ref = ?
      ${dtFilter}
      GROUP BY hour
      ORDER BY hour
    `).all(lineRef, direction);
  }
  // Aggregate across both directions
  return sqlite.prepare(`
    SELECT
      line_ref       AS lineRef,
      line_name      AS lineName,
      hour,
      ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
      ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
      ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
      SUM(num_samples) AS numSamples
    FROM line_hourly_profile
    WHERE line_ref = ?
    ${dtFilter}
    GROUP BY hour
    ORDER BY hour
  `).all(lineRef);
}

// Bybanen (tram/light rail) — no SIRI ET realtime data available
const EXCLUDED_LINE_REFS = ["SKY:Line:1", "SKY:Line:2"];

export async function getAllLines(operator?: string) {
  // NOTE: We intentionally do NOT filter by operator prefix here.
  // All lines in line_daily were ingested from Skyss's SIRI ET feed (dataSource='SKY'),
  // but some have non-SKY lineRef prefixes (e.g. SOF:Line:901, FIR:Line:123 for Sogn og
  // Fjordane / Firda Billag routes operated under Skyss's contract). Filtering to SKY:%
  // would hide these lines from the picker.
  return db
    .selectDistinct({
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
    })
    .from(schema.lineDaily)
    .where(
      and(
        inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]),
        notInArray(schema.lineDaily.lineRef, EXCLUDED_LINE_REFS),
      ),
    )
    .orderBy(schema.lineDaily.lineName)
    .all();
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

export async function getStopDirections(stopRef: string, operator = "SKY"): Promise<string[]> {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `stop_ref = ?`;

  const rows = sqlite.prepare(`
    SELECT DISTINCT direction_ref AS dir
    FROM stop_daily
    WHERE ${stopFilter} AND operator = ? AND direction_ref IS NOT NULL
    ORDER BY direction_ref
  `).all(stopRef, operator) as Array<{ dir: string }>;
  return rows.map(r => r.dir);
}

export async function getStopStats(stopRef: string, fromDate: string, operator = "SKY", direction?: string, toDate?: string) {
  // stopRef can be either NSR:Quay:XXXXX (single quay) or NSR:StopPlace:XXXXX
  // (parent stop place, which groups multiple quays together in search results).
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `sd.stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `sd.stop_ref = ?`;
  const toClause = toDate ? `AND sd.date <= ?` : "";

  // 'all': aggregate across directions (and across quays if stop place)
  if (!direction || direction === "all") {
    const params = [stopRef, stopRef, fromDate, ...(toDate ? [toDate] : []), operator];
    return sqlite.prepare(`
      SELECT
        sd.date,
        ? AS stopRef,
        COALESCE(MAX(sc.stop_place_name), MAX(sc.stop_name), MAX(sd.stop_name)) AS stopName,
        ROUND(SUM(sd.avg_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS avgDelayMin,
        ROUND(MAX(sd.max_delay_min), 2) AS maxDelayMin,
        ROUND(MIN(sd.min_delay_min), 2) AS minDelayMin,
        ROUND(SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 1) AS pctDelayed2plus,
        ROUND(SUM(sd.stddev_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS stddevDelayMin,
        SUM(sd.num_departures) AS numDepartures
      FROM stop_daily sd
      LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
      WHERE ${stopFilter} AND sd.date >= ? ${toClause} AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL}) AND sd.operator = ?
      GROUP BY sd.date
      ORDER BY sd.date
    `).all(...params) as any[];
  }

  // Direction-specific: aggregate quays if stop place, keep direction filter
  const params = [stopRef, stopRef, fromDate, ...(toDate ? [toDate] : []), operator, direction];
  return sqlite.prepare(`
    SELECT
      sd.date,
      ? AS stopRef,
      COALESCE(MAX(sc.stop_place_name), MAX(sc.stop_name), MAX(sd.stop_name)) AS stopName,
      ROUND(SUM(sd.avg_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS avgDelayMin,
      ROUND(MAX(sd.max_delay_min), 2) AS maxDelayMin,
      ROUND(MIN(sd.min_delay_min), 2) AS minDelayMin,
      ROUND(SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 1) AS pctDelayed2plus,
      ROUND(SUM(sd.stddev_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS stddevDelayMin,
      SUM(sd.num_departures) AS numDepartures
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE ${stopFilter} AND sd.date >= ? ${toClause} AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL}) AND sd.operator = ? AND sd.direction_ref = ?
    GROUP BY sd.date
    ORDER BY sd.date
  `).all(...params) as any[];
}

export async function getStopHourlyProfile(stopRef: string, operator = "SKY", direction?: string, dayTypes?: DayType[] | null) {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `stop_ref = ?`;
  const dtFilter = dayTypes && dayTypes.length
    ? `AND day_type IN (${dayTypes.map((d) => `'${d}'`).join(",")})`
    : "";

  if (!direction || direction === "all") {
    return sqlite.prepare(`
      SELECT
        hour,
        ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
        ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
        ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
        SUM(num_samples) AS numSamples
      FROM stop_hourly_profile
      WHERE ${stopFilter} AND operator = ?
      ${dtFilter}
      GROUP BY hour
      ORDER BY hour
    `).all(stopRef, operator);
  }

  return sqlite.prepare(`
    SELECT
      hour,
      ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
      ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
      ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
      SUM(num_samples) AS numSamples
    FROM stop_hourly_profile
    WHERE ${stopFilter} AND operator = ? AND direction_ref = ?
    ${dtFilter}
    GROUP BY hour
    ORDER BY hour
  `).all(stopRef, operator, direction);
}

/** Batch lookup: gitt en liste stop_refs, returner navn + StopPlace-info.
 *  Brukes av klient-side DuckDB-WASM-hooks for å berike resultater med stoppnavn
 *  uten å måtte shippe stop_coords til klienten via Parquet.
 */
export async function getStopsByRefs(refs: string[]): Promise<Array<{
  stopRef: string;
  stopName: string | null;
  stopPlaceRef: string | null;
  stopPlaceName: string | null;
  lat: number | null;
  lng: number | null;
}>> {
  if (refs.length === 0) return [];
  const ph = refs.map(() => "?").join(",");
  return sqlite
    .prepare(
      `SELECT stop_ref AS stopRef,
              stop_name AS stopName,
              stop_place_ref AS stopPlaceRef,
              stop_place_name AS stopPlaceName,
              lat, lng
         FROM stop_coords
        WHERE stop_ref IN (${ph})`,
    )
    .all(...refs) as any;
}

export async function searchStops(query: string, limit = 20) {
  // Group quays by their parent stop place so "Olav Kyrres gate" appears once
  // with platform letters aggregated (e.g. "E, F, G, H, J") instead of 5× separately.
  // For quays without a stop_place_ref mapping we fall back to the quay itself.
  // quayData: "NSR:Quay:53114|J,NSR:Quay:53115|F,..." for individual platform picker.
  // Uses DISTINCT subquery on stop_daily to avoid duplicating quays across dates.
  return sqlite
    .prepare(
      `
      SELECT
        COALESCE(sc.stop_place_ref, sc.stop_ref)             AS stopRef,
        COALESCE(sc.stop_place_name, MAX(sc.stop_name))      AS stopName,
        GROUP_CONCAT(
          DISTINCT sc.platform_code
          ORDER BY sc.platform_code
        )                                                      AS platformCodes,
        GROUP_CONCAT(
          DISTINCT sc.stop_ref || '|' || sc.platform_code
          ORDER BY sc.platform_code
        )                                                      AS quayData
      FROM stop_coords sc
      INNER JOIN (SELECT DISTINCT stop_ref FROM stop_daily) sd
        ON sd.stop_ref = sc.stop_ref
      WHERE sc.stop_name LIKE ?
         OR sc.stop_place_name LIKE ?
      GROUP BY COALESCE(sc.stop_place_ref, sc.stop_ref)
      ORDER BY stopName
      LIMIT ?
      `,
    )
    .all(`%${query}%`, `%${query}%`, limit) as Array<{
      stopRef: string;
      stopName: string | null;
      platformCodes: string | null;
      quayData: string | null;
    }>;
}

export async function getStopsForMap(date: string, operator = "SKY") {
  // Aggregate over a rolling 7-day window ending on `date`
  return sqlite.prepare(`
    SELECT
      sd.stop_ref                                                     AS stopRef,
      COALESCE(MAX(sc.stop_name), MAX(sd.stop_name))                 AS stopName,
      ROUND(
        SUM(sd.avg_delay_min * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 2)                      AS avgDelayMin,
      ROUND(
        SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 1)                      AS pctDelayed2plus,
      SUM(sd.num_departures)                                         AS numDepartures,
      MAX(sc.lat)                                                    AS lat,
      MAX(sc.lng)                                                    AS lng
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE sd.date > date(?, '-7 days')
      AND sd.date <= ?
      AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL})
      AND sd.operator = ?
    GROUP BY sd.stop_ref
    HAVING SUM(sd.num_departures) > 0
  `).all(date, date, operator);
}

/**
 * Map data with optional time-of-day and weekday/weekend filters.
 * Uses stop_hourly_raw when hour filters are specified, otherwise stop_daily.
 * dayType: "all" | "weekday" | "weekend"
 * hourMin/hourMax: hour range (inclusive start, exclusive end), e.g. 7,9 for 07:00-08:59
 */
export async function getStopsForMapFiltered(
  date: string,
  operator = "SKY",
  dayType: "all" | "weekday" | "weekend" = "all",
  hourMin?: number,
  hourMax?: number,
  windowDays = 7,
) {
  const dayFilter =
    dayType === "weekday"
      ? `AND CAST(strftime('%w', t.date) AS INT) BETWEEN 1 AND 5`
      : dayType === "weekend"
      ? `AND CAST(strftime('%w', t.date) AS INT) IN (0, 6)`
      : "";

  if (hourMin != null && hourMax != null) {
    // Use stop_hourly_raw for hour filtering
    const hourFilter =
      hourMin <= hourMax
        ? `AND t.hour >= ${Math.floor(hourMin)} AND t.hour < ${Math.floor(hourMax)}`
        : `AND (t.hour >= ${Math.floor(hourMin)} OR t.hour < ${Math.floor(hourMax)})`; // wraps midnight
    return sqlite.prepare(`
      SELECT
        t.stop_ref                                                    AS stopRef,
        COALESCE(MAX(sc.stop_name), MAX(t.stop_ref))                 AS stopName,
        ROUND(
          SUM(t.avg_delay_min * t.num_samples) * 1.0
          / NULLIF(SUM(t.num_samples), 0), 2)                        AS avgDelayMin,
        SUM(t.num_samples)                                            AS numDepartures,
        MAX(sc.lat)                                                   AS lat,
        MAX(sc.lng)                                                   AS lng
      FROM stop_hourly_raw t
      LEFT JOIN stop_coords sc ON sc.stop_ref = t.stop_ref
      WHERE t.date > date(?, '-${windowDays} days')
        AND t.date <= ?
        AND t.operator = ?
        ${dayFilter}
        ${hourFilter}
      GROUP BY t.stop_ref
      HAVING SUM(t.num_samples) > 0
    `).all(date, date, operator);
  }

  // No hour filter — use stop_daily (has pct_delayed_2plus)
  const dayFilterDaily = dayFilter.replace(/t\./g, "sd.");
  return sqlite.prepare(`
    SELECT
      sd.stop_ref                                                     AS stopRef,
      COALESCE(MAX(sc.stop_name), MAX(sd.stop_name))                 AS stopName,
      ROUND(
        SUM(sd.avg_delay_min * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 2)                      AS avgDelayMin,
      ROUND(
        SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 1)                      AS pctDelayed2plus,
      SUM(sd.num_departures)                                          AS numDepartures,
      MAX(sc.lat)                                                     AS lat,
      MAX(sc.lng)                                                     AS lng
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE sd.date > date(?, '-${windowDays} days')
      AND sd.date <= ?
      AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL})
      AND sd.operator = ?
      ${dayFilterDaily}
    GROUP BY sd.stop_ref
    HAVING SUM(sd.num_departures) > 0
  `).all(date, date, operator);
}

export async function getLatestStopDate(): Promise<string | null> {
  const row = db
    .select({ date: schema.stopDaily.date })
    .from(schema.stopDaily)
    .orderBy(desc(schema.stopDaily.date))
    .limit(1)
    .get();
  return row?.date ?? null;
}

// ---------------------------------------------------------------------------
// Journey Stop Weekly — unlocks journey profile, worst stop on line, lines per stop
// ---------------------------------------------------------------------------

/** Unique journeys on a line for the journey picker dropdown.
 *
 *  serviceJourneyId in Entur SIRI ET is a *dated* journey ID (one per day),
 *  not a stable per-schedule ID. The same "05:48 outbound" run gets a new ID
 *  each day. We therefore group by (directionRef, firstStopTime) to collapse
 *  all dated variants into one logical journey entry per departure time.
 *
 *  Returns one row per unique (directionRef, firstStopTime) combination.
 *  numVariants tells you how many dated service journey IDs share that slot.
 */
// ---------------------------------------------------------------------------
// NOTE: The following 9 functions have been removed — queries now run
// client-side via DuckDB-WASM against Parquet on Cloudflare R2:
//   getJourneysForLine, getJourneyProfile, getWorstStopsForLine,
//   getRouteVariants, getLineStopProfile, getWorstJourneysForLine,
//   getBestJourneysForLine, getLineHourlyAtStop, getLinesAtStop
// See client/src/hooks/use-journey-queries.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

export async function getLeaderboardLines(type: "worst" | "best", operator?: string, limit = 10) {
  const order =
    type === "worst"
      ? desc(schema.leaderboardLines.avgDelayMin)
      : schema.leaderboardLines.avgDelayMin;
  return db
    .select()
    .from(schema.leaderboardLines)
    .where(operator ? like(schema.leaderboardLines.lineRef, `${operator}:%`) : undefined)
    .orderBy(order)
    .limit(limit)
    .all();
}

/** Reliability leaderboard: lines sorted by stddev (low = reliable, high = unpredictable). */
export async function getLeaderboardLinesByReliability(
  type: "reliable" | "unreliable",
  operator?: string,
  limit = 10,
) {
  const order =
    type === "unreliable"
      ? desc(schema.leaderboardLines.stddevDelayMin)
      : schema.leaderboardLines.stddevDelayMin;
  return db
    .select()
    .from(schema.leaderboardLines)
    .where(
      and(
        operator ? like(schema.leaderboardLines.lineRef, `${operator}:%`) : undefined,
        sql`${schema.leaderboardLines.stddevDelayMin} IS NOT NULL`,
        sql`${schema.leaderboardLines.totalDepartures} >= 500`,
      ),
    )
    .orderBy(order)
    .limit(limit)
    .all();
}

export async function getLeaderboardLinesPeriod(
  type: "worst" | "best",
  fromDate: string,
  operator?: string,
  limit = 10,
) {
  const avgExpr = sql<number>`ROUND(SUM(${schema.lineDaily.avgDelayMin} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 2)`;
  const order = type === "worst" ? desc(avgExpr) : avgExpr;

  return db
    .select({
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
      avgDelayMin: avgExpr,
      totalDepartures: sql<number>`SUM(${schema.lineDaily.numDepartures})`,
    })
    .from(schema.lineDaily)
    .where(
      operator
        ? and(gte(schema.lineDaily.date, fromDate), inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]), like(schema.lineDaily.lineRef, `${operator}:%`))
        : and(gte(schema.lineDaily.date, fromDate), inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[])),
    )
    .groupBy(schema.lineDaily.lineRef, schema.lineDaily.lineName)
    .orderBy(order)
    .limit(limit)
    .all();
}

export async function getLeaderboardStops(
  type: "worst" | "best" = "worst",
  fromDate: string,
  operator = "SKY",
  limit = 10,
  toDate?: string,
) {
  const avgExpr = sql<number>`ROUND(SUM(${schema.stopDaily.avgDelayMin} * ${schema.stopDaily.numDepartures}) * 1.0 / SUM(${schema.stopDaily.numDepartures}), 2)`;
  const pctExpr = sql<number>`ROUND(SUM(${schema.stopDaily.pctDelayed2plus} * ${schema.stopDaily.numDepartures}) * 1.0 / SUM(${schema.stopDaily.numDepartures}), 1)`;
  const order = type === "worst" ? desc(avgExpr) : avgExpr;

  const stddevExpr = sql<number | null>`ROUND(SUM(${schema.stopDaily.stddevDelayMin} * ${schema.stopDaily.numDepartures}) * 1.0 / SUM(${schema.stopDaily.numDepartures}), 2)`;

  return db
    .select({
      stopRef: schema.stopDaily.stopRef,
      stopName: sql<string>`COALESCE(MAX(${schema.stopCoords.stopName}), MAX(${schema.stopDaily.stopName}))`,
      avgDelayMin: avgExpr,
      stddevDelayMin: stddevExpr,
      pctDelayed2plus: pctExpr,
      totalDepartures: sql<number>`SUM(${schema.stopDaily.numDepartures})`,
    })
    .from(schema.stopDaily)
    .leftJoin(schema.stopCoords, eq(schema.stopCoords.stopRef, schema.stopDaily.stopRef))
    .where(
      and(
        gte(schema.stopDaily.date, fromDate),
        toDate ? lte(schema.stopDaily.date, toDate) : undefined,
        inArray(schema.stopDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]),
        eq(schema.stopDaily.operator, operator),
        like(schema.stopDaily.stopRef, "NSR:%"),
      ),
    )
    .groupBy(schema.stopDaily.stopRef)
    .having(sql`SUM(${schema.stopDaily.numDepartures}) >= 100`)
    .orderBy(order)
    .limit(limit)
    .all();
}

/**
 * Worst/best days: when from/to are set, aggregate live from daily_summary.
 * Otherwise, use the materialized worst_days table (for default all-time view).
 * dayTypes filters by day type (weekday/saturday/sunday/holiday/may17) on the materialized table.
 */
export async function getWorstDays(limit = 10, operator = "SKY", fromDate?: string, toDate?: string, dayTypes?: DayType[] | null) {
  if (fromDate || toDate) {
    return db
      .select()
      .from(schema.dailySummary)
      .where(
        and(
          eq(schema.dailySummary.operator, operator),
          fromDate ? gte(schema.dailySummary.date, fromDate) : undefined,
          toDate ? lte(schema.dailySummary.date, toDate) : undefined,
        ),
      )
      .orderBy(desc(schema.dailySummary.avgDelayMin))
      .limit(limit)
      .all();
  }
  return db
    .select()
    .from(schema.worstDays)
    .where(
      and(
        eq(schema.worstDays.operator, operator),
        dayTypes && dayTypes.length
          ? inArray(schema.worstDays.dayType, dayTypes as readonly string[] as string[])
          : undefined,
      ),
    )
    .orderBy(desc(schema.worstDays.avgDelayMin))
    .limit(limit)
    .all();
}

export async function getBestDays(limit = 10, operator = "SKY", fromDate?: string, toDate?: string) {
  return db
    .select()
    .from(schema.dailySummary)
    .where(
      and(
        eq(schema.dailySummary.operator, operator),
        fromDate ? gte(schema.dailySummary.date, fromDate) : undefined,
        toDate ? lte(schema.dailySummary.date, toDate) : undefined,
      ),
    )
    .orderBy(schema.dailySummary.avgDelayMin)
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

/** Returns data quality warnings for a given date and operator.
 *  Optionally filtered by lineRef or stopRef to show page-relevant warnings.
 *  type: 'outlier_delay' | 'missing_time'
 */
export async function getDataQuality(
  date: string,
  operator = "SKY",
  lineRef?: string,
  stopRef?: string,
): Promise<Array<{
  id: number;
  type: string;
  lineRef: string | null;
  serviceJourneyId: string | null;
  stopRef: string | null;
  aimedTime: string | null;
  delayMin: number | null;
  count: number;
  total: number | null;
  message: string;
}>> {
  const conditions: string[] = ["date = ? AND operator = ?"];
  const params: (string | null)[] = [date, operator];

  if (lineRef) {
    conditions.push("(line_ref = ? OR type = 'missing_time')");
    params.push(lineRef);
  }
  if (stopRef) {
    conditions.push("(stop_ref = ? OR type = 'missing_time')");
    params.push(stopRef);
  }

  const query = `
    SELECT id, type,
           line_ref AS lineRef,
           service_journey_id AS serviceJourneyId,
           stop_ref AS stopRef,
           aimed_time AS aimedTime,
           delay_min AS delayMin,
           count, total, message
    FROM data_quality_log
    WHERE ${conditions.join(" AND ")}
    ORDER BY type, ABS(delay_min) DESC
  `;
  return sqlite.prepare(query).all(...params) as any;
}


// ---------------------------------------------------------------------------
// Corridor comparison — multi-line delay at shared stops
// ---------------------------------------------------------------------------

// NOTE: getCorridorComparison removed — now client-side DuckDB. See use-journey-queries.ts

/** Search for stops by name — used by the trip planner stop picker.
 *  Only returns stops with a known NSR:StopPlace ref (required by Entur JP API).
 *  Groups by stop_place_ref so each StopPlace appears once.
 *  Includes quay count to help differentiate same-name StopPlaces (e.g. bybane vs buss).
 */
export async function searchStopsForCorridor(
  query: string,
  limit = 10,
): Promise<Array<{ stopRef: string; stopPlaceRef: string; stopName: string; lat: number | null; lng: number | null; quayCount: number }>> {
  return sqlite.prepare(`
    SELECT
      sc.stop_place_ref AS stopRef,
      sc.stop_place_ref AS stopPlaceRef,
      COALESCE(sc.stop_place_name, sc.stop_name) AS stopName,
      AVG(sc.lat) AS lat,
      AVG(sc.lng) AS lng,
      COUNT(sc.stop_ref) AS quayCount
    FROM stop_coords sc
    WHERE (sc.stop_name LIKE ? OR sc.stop_place_name LIKE ?)
      AND sc.stop_ref LIKE 'NSR:%'
      AND sc.stop_place_ref IS NOT NULL
    GROUP BY sc.stop_place_ref
    ORDER BY stopName, quayCount DESC
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit) as any;
}

// NOTE: getTripStopStats removed — now client-side DuckDB. See trip-planner.tsx
